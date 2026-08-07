import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { q, tx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { SIMPLE_COLLECTIONS, rowToJs, jsToRow } from '../shape.js';
import { creditReviewAllowsProgress } from '../credit.js';
import { sendMail } from '../mail.js';
import { setPasswordLink } from '../authmw.js';
import { welcomeActivation, orderConfirmation, staffOrderAlert } from '../emails.js';
import { syncZohoInventory, zohoStatus, pushOrderToZoho } from '../zoho.js';
import { invalidateCatalogCache } from './catalog.js';
import { recordMovement, planSkuReservations, reserveTakes } from '../inventory.js';
import { invalidateFxCache } from '../currency.js';
import { orderAlertRecipients } from '../config.js';
/* reconcileBackorderSync, BACKORDER_LOCK_SQL, canDeleteBackorder and
   BACKORDER_DELETE_CANDIDATES_SQL are no longer imported. They existed only to
   police the generic sync's backorder writes; Batch 1H removed that write path
   entirely, so there is nothing left to police. They remain exported from
   ordering.js and covered by their own tests. */
import { orderFieldsFromBackorder, isBackorderProcessable } from '../ordering.js';
import { afterCommit, afterCommitDetached } from '../postcommit.js';
import { ADMIN_ORDERS_SQL, ADMIN_ORDERS_COUNT_SQL, ADMIN_ORDER_ONE_SQL,
         ADMIN_BACKORDERS_SQL, ADMIN_BACKORDERS_COUNT_SQL,
         orderRowToJs, backorderRowToJs, resolveLimit, listCompleteness,
         sanitizeOrderPatch, orderUpdateSql, describeOrderPatch,
         recomputeOrderTotal, checkSyncPayload,
         isFinancialActor, patchTouchesMoney } from '../admin-data.js';
import { describeAccess } from '../admin-access.js';
/* The single governed implementation of "turn an order into a debt". This
   route is one of its two entry points — see the delegation note below. */
import { issueInvoice } from './admin-finance.js';
import { pool as financePool, tx as financeTx } from '../db.js';

const financeDb = { query: (sql, params) => financePool.query(sql, params), tx: financeTx };

/* Statuses that are NOT a commercial progression: an order sitting in one of
   these has not been promised to anybody, so an order held on credit review
   may still move between them and may still be cancelled. Anything else means
   fulfilment has begun. */
const PENDING_ORDER_STATUSES = Object.freeze(['pending', 'cancelled']);

const r = Router();
r.use(requireAuth('admin', 'warehouse'));

const UPLOADS = process.env.UPLOADS_DIR || '/uploads';

/* ---- what may this session actually do? ----
 *
 * The admin panel is a whole-database editor: every screen mutates a local
 * snapshot and saves through POST /sync. Since that endpoint became
 * admin-only (finding SEC-002), a warehouse login had no way to know which of
 * its controls would work — so it discovered the answer as a 403 on save.
 *
 * This tells it, from the same constants the routes enforce with. It is a
 * RENDERING HINT: hiding a control is a courtesy, and every request is still
 * authorised server-side. Granting nothing, it is safe for any authenticated
 * admin-router caller to read about itself. */
r.get('/access', (req, res) => res.json(describeAccess(req.user)));

/* ============================ zoho sync ============================ */

r.get('/zoho/status', async (req, res, next) => {
  try { res.json(await zohoStatus()); } catch (e) { next(e); }
});
// run a sync now; ?dryRun=1 reports what would change without writing
r.post('/zoho/sync', async (req, res, next) => {
  try { res.json(await syncZohoInventory({ dryRun: req.query.dryRun === '1' })); }
  catch (e) { next(e); }
});
// (re)push an order into Zoho as a sales order — for retries/backfill
r.post('/zoho/push-order', async (req, res, next) => {
  try { res.json({ ok: true, zohoSoId: await pushOrderToZoho(String(req.body?.orderId || '')) }); }
  catch (e) { next(e); }
});
// cutover switch: pause = the platform stops following Zoho (admin edits
// become authoritative); unpause = Zoho takes back over on the next sync
r.post('/zoho/pause', async (req, res, next) => {
  try {
    const paused = !!req.body?.paused;
    await q(`update settings set data = jsonb_set(coalesce(data,'{}'::jsonb),
             '{zohoPaused}', $1::jsonb) where id=1`, [JSON.stringify(paused)]);
    await audit({ id: req.user.id, name: req.user.email, role: req.user.role },
      paused ? 'zoho sync paused (platform is source of truth)' : 'zoho sync resumed', 'zoho');
    res.json({ ok: true, paused });
  } catch (e) { next(e); }
});

/* ==================== backorder conversion ====================
   Server-authoritative replacement for the old browser-side conversion, which
   built the order in page state, called reserveStock() (which silently took
   whatever happened to exist), and created the full order even when it had
   under-reserved — while also losing the agent, source and shipping context.

   This release is ALL-OR-NOTHING: every line must be fully coverable. Partial
   conversion is out of scope, so an under-covered backorder is refused with
   exact shortages and nothing at all is changed. */
r.post('/backorders/:id/convert', async (req, res, next) => {
  try {
    const actor = { id: req.user.id, name: req.user.business || req.user.email,
                    role: req.user.role };
    const outcome = await tx(async (c) => {
      // Lock the backorder itself so two staff pressing Convert cannot race.
      const { rows: bos } = await c.query(
        `select * from backorders where id=$1 for update`, [req.params.id]);
      const bo = bos[0];
      if (!bo) return { status: 404, body: { error: 'Backorder not found' } };

      // Idempotent: a second press returns the order the first press created
      // rather than making another one.
      if (bo.status === 'converted') {
        const { rows: existing } = await c.query(
          `select id, number from orders where id=$1`, [bo.converted_order_id]);
        return { status: 200, body: { ok: true, alreadyConverted: true,
          orderId: existing[0]?.id ?? bo.converted_order_id,
          orderNumber: existing[0]?.number ?? null } };
      }
      if (bo.status === 'cancelled') {
        return { status: 409, body: { error: 'That backorder was cancelled' } };
      }
      /* Commercially authorised? Deliberately separate from "is there stock",
         which is verified below against locked rows regardless of this. */
      if (!isBackorderProcessable(bo)) {
        return { status: 409, body: { error: bo.status === 'open' || bo.status === 'approved'
          ? 'This backorder has not been authorised by the customer.'
          : `Backorder is ${bo.status}` } };
      }

      const { rows: items } = await c.query(
        `select * from backorder_items where backorder_id=$1 order by id`, [bo.id]);
      if (!items.length) {
        return { status: 409, body: { error: 'Backorder has no items' } };
      }

      // Lock the stock rows for every SKU BEFORE deciding, so the availability
      // we check is the availability we then reserve.
      const skus = [...new Set(items.map(i => i.sku))];
      const { rows: stockRows } = await c.query(`
        select v.sku, s.variation_id, s.warehouse_id, s.qty
          from stock s join variations v on v.id = s.variation_id
         where v.sku = any($1)
         order by v.sku, (s.warehouse_id = 'wh_main') desc, s.qty desc
         for update of s`, [skus]);

      const pilesBySku = new Map();
      for (const row of stockRows) {
        if (!pilesBySku.has(row.sku)) pilesBySku.set(row.sku, []);
        pilesBySku.get(row.sku).push(row);
      }

      /* AGGREGATE per SKU, then plan one reservation pass per SKU. A backorder
         may list the same SKU twice; checking each line against the full
         availability would pass two 6-unit lines against 10 units in stock and
         then hand the same pile to both. */
      const { covered, shortages, takes } = planSkuReservations(items, pilesBySku);
      if (!covered) {
        // Refuse cleanly: no order, no stock movement, backorder left open with
        // all of its context intact.
        return { status: 409, body: {
          error: 'Not enough stock to convert this backorder in full.',
          shortages, backorderNumber: bo.number } };
      }

      // Guarded decrements (`qty >= $1`). A guard failure throws a tagged 409
      // and the transaction rolls back — never a half-reserved conversion.
      const moves = await reserveTakes(c, takes);

      // ---- rebuild the order from the PRESERVED context ----
      // The browser version invented agentId=null, source='customer' and
      // freeShipping=true here regardless of how the request was really placed.
      const f = orderFieldsFromBackorder(bo, items);
      const { rows: num } = await c.query(`select 'SO' || nextval('order_number_seq') as n`);
      const { rows: ord } = await c.query(`
        insert into orders (number, customer_id, agent_id, source, status, order_date,
                            discount, free_shipping, shipping, total,
                            shipping_address, billing_address, promo,
                            currency, fx_rate, comments)
        values ($1,$2,$3,$4,'pending',current_date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        returning *`,
        [num[0].n, f.customerId, f.agentId, f.source,
         f.discount, f.freeShipping, f.shipping, f.total,
         f.shippingAddress ? JSON.stringify(f.shippingAddress) : null,
         f.billingAddress ? JSON.stringify(f.billingAddress) : null,
         f.promo ? JSON.stringify(f.promo) : null,
         f.currency, f.fxRate,
         JSON.stringify(f.comments)]);
      const order = ord[0];

      for (const i of items) {
        await c.query(`
          insert into order_items (order_id, sku, name, color, qty, collected, price)
          values ($1,$2,$3,$4,$5,0,$6)`,
          [order.id, i.sku, i.name || '', i.color || '', i.qty, i.price]);
      }
      for (const mv of moves) {
        await recordMovement(c, { ...mv, reason: 'backorder_conversion',
          refType: 'order', refId: order.number, actor,
          note: `converted from ${bo.number}` });
      }

      await c.query(`
        update backorders set status='converted', converted_order_id=$2, eligible=true
         where id=$1`, [bo.id, order.id]);

      return { status: 200, body: { ok: true, orderId: order.id, orderNumber: order.number,
        backorderNumber: bo.number, total: order.total, currency: order.currency,
        fxRate: order.fx_rate,
        reserved: moves.reduce((s, m) => s + Math.abs(m.delta), 0) },
        // carried out of the tx for post-commit work only
        _order: order, _items: items, _customerId: bo.customer_id, _agentId: bo.agent_id };
    });

    /* ---- COMMITTED. A converted backorder is a genuine new order, so it gets
       the same post-commit treatment as a normal checkout — and the same
       protection: nothing here may turn a completed conversion into an
       apparent failure. ---- */
    if (outcome.status === 200 && outcome.body.ok && !outcome.body.alreadyConverted) {
      await afterCommit('catalog cache invalidation', () => invalidateCatalogCache());
      await afterCommit(`audit 'backorder converted' ${outcome.body.backorderNumber}`, () =>
        audit(actor, 'backorder converted', outcome.body.backorderNumber,
          `-> ${outcome.body.orderNumber}, ${outcome.body.reserved} pcs allocated`));
      await afterCommit(`notify conversion ${outcome.body.orderNumber}`, () =>
        notifyConversion(outcome));
      // pushOrderToZoho already no-ops while Zoho is paused; detached so a Zoho
      // outage cannot delay or fail the response.
      afterCommitDetached(`zoho order push ${outcome.body.orderNumber}`,
        () => pushOrderToZoho(outcome.body.orderId));
    }
    res.status(outcome.status).json(outcome.body);
  } catch (e) {
    // A guarded-decrement conflict surfaces as a clean 409, not a 500.
    if (e.expose && e.status === 409) {
      return res.status(409).json({ error: e.message, shortages: e.shortages || [] });
    }
    next(e);
  }
});

/* Customer + staff notification for a converted backorder.
   Wording rule: the goods have been ALLOCATED to an order, not shipped —
   conversion reserves stock and creates a pending order, nothing has left the
   warehouse. Hide-prices customers get no money in HTML or plaintext, exactly
   as on a normal confirmation, because the same templates are used. */
async function notifyConversion(outcome) {
  const order = outcome._order;
  const items = outcome._items || [];
  const { rows: cust } = await q(
    `select id, email, first_name, business, customer_number, hide_prices
       from users where id=$1`, [outcome._customerId]);
  const customer = cust[0];
  const currency = order.currency || 'USD';
  const rate = Number(order.fx_rate) || 1;

  // Identity for every line, same shape the order templates expect.
  const { rows: lines } = await q(`
    select i.sku, i.name, i.color, i.qty, i.price, p.sku as "modelSku", p.brand
      from order_items i
      left join variations v on v.sku = i.sku
      left join products  p on p.id = v.product_id
     where i.order_id = $1 order by i.created_at`, [order.id]);
  const itemLines = lines.length ? lines : items;

  if (customer?.email) {
    const m = orderConfirmation({
      name: customer.first_name || customer.business, email: customer.email,
      hidePrices: customer.hide_prices, currency, rate,
      order: { ...order, items: itemLines },
      intro: `Good news — the pieces you had on backorder ${outcome.body.backorderNumber} `
        + `are now available and have been allocated to order ${order.number}. `
        + `They have not shipped yet; we'll let you know when they do.`,
    });
    await sendMailSafelyAdmin({ to: customer.email, subject: m.subject, html: m.html, text: m.text },
      `backorder conversion confirmation ${order.number}`);
  }

  const alertTo = orderAlertRecipients();
  if (alertTo.length) {
    const a = staffOrderAlert({
      order, backorder: null, currency, rate,
      customer: { business: customer?.business, email: customer?.email,
                  customerNumber: customer?.customer_number },
      agent: null,
      lines: itemLines.map(i => ({ ...i,
        requested: i.qty, allocated: i.qty, backordered: 0 })),
      totals: { allocatedValue: Number(order.total) || 0, backorderedValue: 0 },
    });
    await sendMailSafelyAdmin({ to: alertTo.join(', '),
      subject: `${a.subject} (from backorder ${outcome.body.backorderNumber})`,
      html: a.html, text: a.text }, 'staff conversion alert');
  }
}

/** Mail that never affects the caller — mirrors routes/orders.js sendMailSafely. */
async function sendMailSafelyAdmin(message, context) {
  try {
    const info = await sendMail(message);
    if (info?.logged) {
      console.warn(`[mail] SMTP is not configured — ${context} for ${message.to} was only logged`);
    }
  } catch (e) {
    console.error(`[mail] ${context} to ${message.to} FAILED:`, e.message);
    await audit({ id: 'system', name: 'Mailer', role: 'system' },
      'email failed', context, e.message, 'system').catch(() => {});
  }
}

/* ============================ snapshot ============================ */

const num = v => (v === '' || v == null ? null : Number(v));

async function productsSnapshot() {
  const { rows } = await q(`
    select p.*,
      coalesce((
        select json_agg(json_build_object(
          'vid', v.id, 'sku', v.sku, 'color', v.color, 'image', v.image,
          'price', v.price, 'salePrice', v.sale_price, 'stockStatus', v.stock_status,
          'isActive', v.is_active,
          'stock', coalesce((
            select json_object_agg(s.warehouse_id, json_build_object('qty', s.qty, 'shelf', s.shelf))
              from stock s where s.variation_id = v.id), '{}'::json)
        ) order by v.sku)
        from variations v where v.product_id = p.id), '[]') as variations
      from products p order by p.created_at desc`);
  return rows.map(p => ({
    id: p.id, sku: p.sku, name: p.name, description: p.description, brand: p.brand,
    size: p.size, ean: p.ean, categories: p.categories, tags: p.tags, images: p.images,
    attributes: p.attributes, price: p.price, salePrice: p.sale_price,
    productionStatus: p.production_status, estimatedArrival: p.estimated_arrival,
    isActive: p.is_active, createdAt: p.created_at, updatedAt: p.updated_at,
    variations: (p.variations || []).map(v => ({
      sku: v.sku, color: v.color, image: v.image, price: v.price, salePrice: v.salePrice,
      stockStatus: v.stockStatus, isActive: v.isActive !== false, stock: v.stock || {},
    })),
  }));
}

/* Brand + model number are reconstructed by joining each line back to its
   product, so warehouse and admin views can identify a frame without new
   columns. `modelSku` is the PRODUCT sku — never a slice of the variation sku,
   which is wrong for dash colorways like VEDETTE-2002. Still used by the
   Returns snapshot and by the dedicated order/backorder endpoints. */
const ITEM_IDENTITY_JOIN = `
  left join variations v on v.sku = i.sku
  left join products  p on p.id = v.product_id`;

/* ordersSnapshot() lived here. The generic snapshot no longer carries orders or
   backorders at all: they are read from GET /admin/orders and
   GET /admin/backorders, which are the only endpoints that return the customer
   and agent display names, the converted order number and the honest
   returned/total/complete bounds. Leaving a second, thinner copy in the
   snapshot is how the two views drifted apart in the first place. */

async function nestedNumberSnapshot(table, itemsTable, fk, itemCols, mapRow, itemJoin = '') {
  const { rows } = await q(`
    select t.*, coalesce((
      select json_agg(json_build_object(${itemCols}))
        from ${itemsTable} i ${itemJoin} where i.${fk} = t.id), '[]') as items
      from ${table} t order by t.created_at desc`);
  return rows.map(mapRow);
}

async function seqNext(name) {
  const { rows } = await q(`select last_value, is_called from ${name}`);
  return Number(rows[0].last_value) + (rows[0].is_called ? 1 : 0);
}

r.get('/snapshot', async (req, res, next) => {
  try {
    const out = {};
    for (const [name, cfg] of Object.entries(SIMPLE_COLLECTIONS)) {
      const limit = cfg.appendOnly ? 'limit 2000' : '';
      const order = cfg.fields.createdAt || cfg.appendOnly ? 'order by created_at desc' : '';
      const { rows } = await q(`select * from ${cfg.table} ${order} ${limit}`);
      out[name] = rows.map(row => rowToJs(cfg, row));
    }
    out.products = await productsSnapshot();
    /* Orders and backorders are deliberately ABSENT. They are server-managed:
       read them from GET /admin/orders and GET /admin/backorders, and write
       them only through the dedicated endpoints. */
    out.returns = await nestedNumberSnapshot('returns', 'return_items', 'return_id',
      `'sku', i.sku, 'name', i.name, 'qty', i.qty, 'price', i.price, 'resolution', i.resolution,
       'exchangeSku', i.exchange_sku, 'modelSku', p.sku, 'brand', p.brand`,
      x => ({ id: x.id, number: x.number, customerId: x.customer_id, orderNumber: x.order_number,
              status: x.status, notes: x.notes, createdAt: x.created_at, items: x.items }),
      ITEM_IDENTITY_JOIN);
    const { rows: settingsRow } = await q(`select data from settings where id=1`);
    out.settings = settingsRow[0]?.data || {};
    res.json({
      collections: out,
      meta: {
        nextOrderNumber: await seqNext('order_number_seq'),
        nextBackorderNumber: await seqNext('backorder_number_seq'),
        nextReturnNumber: await seqNext('return_number_seq'),
        nextInvoiceNumber: await seqNext('invoice_number_seq'),
        nextPoNumber: await seqNext('po_number_seq'),
        serverTime: new Date().toISOString(),
      },
    });
  } catch (e) { next(e); }
});

/* ==================== live order + backorder surfaces ====================
   Batch 1H. These are the endpoints the admin Orders list, order detail,
   Backorders, dashboard metrics, order reports and the Finance invoice rows
   read. They exist because those screens were reading a SEEDED BROWSER
   DATASET (1,107 generated records ending at SO11876) while PostgreSQL held
   the real 1,128 orders.

   Money is returned in BASE USD exactly as stored, with the order's own
   `currency` and `fxRate` alongside it. The browser converts once, at render
   (Batch 1G orderMoney). Converting here as well is the CA$91.97 bug. */

r.get('/orders', async (req, res, next) => {
  try {
    const limit = resolveLimit(req.query.limit);
    const [{ rows }, { rows: countRows }] = await Promise.all([
      q(ADMIN_ORDERS_SQL, [limit]),
      q(ADMIN_ORDERS_COUNT_SQL),
    ]);
    const orders = rows.map(orderRowToJs);
    res.json({ orders, ...listCompleteness(orders.length, countRows[0]?.n, limit), limit });
  } catch (e) { next(e); }
});

r.get('/orders/:id', async (req, res, next) => {
  try {
    const { rows } = await q(ADMIN_ORDER_ONE_SQL, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json({ order: orderRowToJs(rows[0]) });
  } catch (e) { next(e); }
});

r.get('/backorders', async (req, res, next) => {
  try {
    const limit = resolveLimit(req.query.limit);
    const [{ rows }, { rows: countRows }] = await Promise.all([
      q(ADMIN_BACKORDERS_SQL, [limit]),
      q(ADMIN_BACKORDERS_COUNT_SQL),
    ]);
    const backorders = rows.map(backorderRowToJs);
    res.json({ backorders, ...listCompleteness(backorders.length, countRows[0]?.n, limit), limit });
  } catch (e) { next(e); }
});

/* Narrow, whitelisted order write. Deliberately covers ONLY the changes that
   move no stock and re-point no identity: status, tracking, an internal
   comment, the admin discount and warehouse collection counts.

   Item add/edit/delete, merges and customer reassignment are NOT here. Those
   move stock, and doing that from browser page state is the unsafe path Batch
   1C removed for backorder conversion; the admin disables those controls
   honestly rather than appearing to succeed. Sending one of their fields is a
   400, never a silent drop.

   The total is recomputed on the server from the stored lines — the client
   never supplies money. */
r.patch('/orders/:id', async (req, res, next) => {
  try {
    const actorName = req.user.business || req.user.email;
    const patch = sanitizeOrderPatch(req.body, { actorName });
    if (!patch.ok) return res.status(400).json({ error: patch.error });

    /* MONEY IS ADMIN-ONLY, enforced here. The warehouse role reaches this
       router for fulfilment work — status, tracking, comments, collection
       counts — but a discount changes what the customer owes. The panel hides
       the control from a warehouse login; hiding a button is not a control,
       because the request can be issued without it. */
    if (patchTouchesMoney(patch) && !isFinancialActor(req.user)) {
      return res.status(403).json({
        error: 'Only an admin can change an order discount.' });
    }

    const outcome = await tx(async (c) => {
      const { rows: locked } = await c.query(
        `select * from orders where id=$1 or number=$1 for update`, [req.params.id]);
      const order = locked[0];
      if (!order) return { status: 404, body: { error: 'Order not found' } };
      /* A shipped order is a dispatched one. Re-opening it from a list screen
         would contradict what the customer has already been told. */
      if (order.status === 'shipped' && patch.fields.status
          && patch.fields.status !== 'shipped') {
        return { status: 409, body: { error: 'That order has already shipped' } };
      }

      /* ---- THE PROTECTED COMMERCIAL TRANSITION ----
         The server found this order would take the account over its credit
         limit and flagged it. Until an authorised person approves that
         exception it must not move into fulfilment, or the detection was
         decorative — the order would simply be progressed by whoever opened
         the list next, exactly as if it had passed a credit check.

         Enforced HERE, on the row we already hold locked, rather than in the
         panel: hiding a button is not a control, because the request can be
         issued without it. A DECLINED review blocks for the same reason as a
         pending one — declining is a decision to hold, not to forget.

         Deliberately narrow. Everything else this route does — tracking,
         comments, collection counts, cancelling — stays available, because a
         held order still has to be administered. */
      if (patch.fields.status
          && patch.fields.status !== order.status
          && !PENDING_ORDER_STATUSES.includes(patch.fields.status)
          && !creditReviewAllowsProgress(order.credit_review)) {
        const state = order.credit_review?.state || 'pending';
        return { status: 409, body: {
          error: state === 'declined'
            ? 'That order was declined on credit review and is on hold. It cannot be '
              + 'progressed until the decision is revisited.'
            : 'That order is awaiting a credit decision and cannot be progressed yet.',
          code: 'CREDIT_REVIEW_REQUIRED',
          creditReviewState: state,
        } };
      }

      const { sets, values, nextParam } = orderUpdateSql(patch.fields);
      if (patch.comment) {
        sets.push(`comments = coalesce(comments,'[]'::jsonb) || $${nextParam}::jsonb`);
        values.push(JSON.stringify([patch.comment]));
      }
      if (sets.length) {
        await c.query(`update orders set ${sets.join(', ')}, updated_at=now() where id=$1`,
          [order.id, ...values]);
      }

      if (patch.collected) {
        /* Collection counts only. Quantity and price are never touched here,
           so no stock moves and the ledger stays consistent. */
        for (const line of patch.collected) {
          await c.query(
            `update order_items set collected = least($3, qty)
              where order_id=$1 and sku=$2`, [order.id, line.sku, line.collected]);
        }
      }
      /* Status back to pending resets the collection, matching the panel. */
      if (patch.fields.status === 'pending') {
        await c.query(`update order_items set collected=0 where order_id=$1`, [order.id]);
      }

      const { rows: items } = await c.query(
        `select qty, price from order_items where order_id=$1`, [order.id]);
      const { rows: cur } = await c.query(
        `select discount, discount_pct from orders where id=$1`, [order.id]);
      const total = recomputeOrderTotal(items, cur[0].discount, cur[0].discount_pct);
      await c.query(`update orders set total=$2, updated_at=now() where id=$1`,
        [order.id, total]);

      const { rows: fresh } = await c.query(ADMIN_ORDER_ONE_SQL, [order.id]);
      return { status: 200, body: { ok: true, order: orderRowToJs(fresh[0]) },
        _number: order.number };
    });

    if (outcome.status === 200) {
      await afterCommit(`audit 'order updated' ${outcome._number}`, () =>
        audit({ id: req.user.id, name: actorName, role: req.user.role },
          'order updated', outcome._number, describeOrderPatch(patch)));
    }
    res.status(outcome.status).json(outcome.body);
  } catch (e) { next(e); }
});

/* Records an invoice against an order.
 *
 * DELEGATES to the single governed implementation in routes/admin-finance.js
 * (Final Handover Phase 4). It used to have its own copy of the insert, the
 * balance update and the audit line; two implementations of "turn an order
 * into a debt" is one too many, and the copy here had no structured financial
 * record at all — no prior balance, no new balance, no capability, nothing an
 * append-only ledger could be reconstructed from.
 *
 * This route keeps its ADMIN ROLE gate rather than moving to the
 * `finance.invoice` capability. That is a deliberate, documented bootstrap
 * position: no account holds the new capability until somebody grants it, and
 * silently making invoicing impossible for every existing administrator would
 * be a worse failure than the one being fixed. The capability-gated entry
 * point exists in parallel at POST /admin/finance/orders/:orderId/invoice;
 * once grants are in place this route is retired. See
 * docs/public-website-rebuild/41_FINANCE_OPERATIONS.md.
 *
 * Both paths run the same transaction, the same idempotency guard and the same
 * ledger write, so there is one guard reached two ways — never two behaviours.
 */
r.post('/orders/:id/invoice', async (req, res, next) => {
  try {
    if (!isFinancialActor(req.user)) {
      return res.status(403).json({ error: 'Only an admin can generate an invoice.' });
    }
    const result = await issueInvoice(financeDb, req.params.id, req.user,
      { capability: 'admin-role-bootstrap' });
    res.json({ ok: true, alreadyInvoiced: result.alreadyInvoiced, invoice: result.invoice });
  } catch (e) {
    if (e && e.status && e.body) return res.status(e.status).json(e.body);
    next(e);
  }
});

/* ============================ sync ============================ */

async function upsertSimple(c, cfg, obj) {
  if (!obj.id) throw new Error(`${cfg.table}: row missing id`);
  const { cols, vals } = jsToRow(cfg, obj);
  if (!cols.includes('id')) { cols.unshift('id'); vals.unshift(obj.id); }
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols.filter(x => x !== 'id').map(x => `${x}=excluded.${x}`);
  const conflict = cfg.appendOnly
    ? 'on conflict (id) do nothing'
    : `on conflict (id) do update set ${updates.join(', ')}`;
  await c.query(
    `insert into ${cfg.table} (${cols.join(',')}) values (${placeholders.join(',')}) ${conflict}`,
    vals);
}

async function upsertProduct(c, p, actor) {
  if (!p.id) throw new Error('product missing id');
  await c.query(`
    insert into products (id, sku, name, description, brand, size, ean, categories, tags,
                          images, attributes, price, sale_price, production_status,
                          estimated_arrival, is_active)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    on conflict (id) do update set
      sku=excluded.sku, name=excluded.name, description=excluded.description,
      brand=excluded.brand, size=excluded.size, ean=excluded.ean,
      categories=excluded.categories, tags=excluded.tags, images=excluded.images,
      attributes=excluded.attributes, price=excluded.price, sale_price=excluded.sale_price,
      production_status=excluded.production_status, estimated_arrival=excluded.estimated_arrival,
      is_active=excluded.is_active`,
    [p.id, String(p.sku), p.name || '', p.description || '', p.brand || '', p.size || '',
     p.ean || '', p.categories || [], p.tags || [], p.images || [],
     JSON.stringify(p.attributes || {}), num(p.price), num(p.salePrice),
     p.productionStatus || 'none', p.estimatedArrival || null, p.isActive !== false]);

  const vars = Array.isArray(p.variations) ? p.variations : [];
  const skus = vars.map(v => String(v.sku));
  await c.query(
    `delete from variations where product_id=$1 and not (sku = any($2))`, [p.id, skus]);
  for (const v of vars) {
    const { rows: vr } = await c.query(`
      insert into variations (product_id, sku, color, image, price, sale_price, stock_status, is_active)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (sku) do update set
        product_id=excluded.product_id, color=excluded.color, image=excluded.image,
        price=excluded.price, sale_price=excluded.sale_price,
        stock_status=excluded.stock_status, is_active=excluded.is_active
      returning id`,
      [p.id, String(v.sku), v.color || '', v.image || null, num(v.price), num(v.salePrice),
       v.stockStatus || 'in stock', v.isActive !== false]);
    const vid = vr[0].id;
    // Capture prior per-warehouse balances so we can log the exact delta of
    // this edit (PO receipt, transfer, manual adjustment — all land here).
    const { rows: priorStock } = await c.query(
      `select warehouse_id, qty from stock where variation_id=$1`, [vid]);
    const priorMap = new Map(priorStock.map(s => [s.warehouse_id, Number(s.qty)]));
    await c.query(`delete from stock where variation_id=$1`, [vid]);
    const seenWh = new Set();
    for (const [wh, sdata] of Object.entries(v.stock || {})) {
      const newQty = parseInt(sdata?.qty, 10) || 0;
      const { rowCount } = await c.query(`
        insert into stock (variation_id, warehouse_id, qty, shelf)
        select $1, $2, $3, $4 where exists (select 1 from warehouses where id=$2)`,
        [vid, wh, newQty, String(sdata?.shelf || '')]);
      if (!rowCount) continue; // unknown warehouse id — not written, so not logged
      seenWh.add(wh);
      await recordMovement(c, { variationId: vid, sku: String(v.sku), warehouseId: wh,
        delta: newQty - (priorMap.get(wh) || 0), balanceAfter: newQty,
        reason: 'stock_edit', refType: 'admin_sync', refId: p.sku || p.id || '', actor });
    }
    // warehouses that had stock before but are absent from the new payload → zeroed
    for (const [wh, oldQty] of priorMap) {
      if (seenWh.has(wh) || !oldQty) continue;
      await recordMovement(c, { variationId: vid, sku: String(v.sku), warehouseId: wh,
        delta: -oldQty, balanceAfter: 0,
        reason: 'stock_edit', refType: 'admin_sync', refId: p.sku || p.id || '', actor });
    }
  }
}

/** Upsert with per-row savepoint; on duplicate business number, renumber from sequence. */
async function upsertNumbered(c, obj, seqName, prefix, insertFn, remaps, collection) {
  await c.query('savepoint row_try');
  try {
    await insertFn(obj);
    await c.query('release savepoint row_try');
  } catch (e) {
    if (e.code === '23505' && String(e.constraint || '').includes('number')) {
      await c.query('rollback to savepoint row_try');
      const { rows } = await c.query(`select '${prefix}' || nextval('${seqName}') as n`);
      const renumbered = { ...obj, number: rows[0].n };
      await insertFn(renumbered);
      remaps.push({ collection, id: obj.id, number: rows[0].n });
    } else {
      throw e;
    }
  }
}

/* upsertOrder() and upsertBackorder() lived here.

   They let the generic row-diff sync write whole orders and backorders from a
   browser snapshot: replacing every line, rewriting the total, and — in the
   backorder case — needing an elaborate terminal-state guard
   (reconcileBackorderSync, BACKORDER_LOCK_SQL, canDeleteBackorder) purely to
   stop a stale tab putting `open` back over `converted` or deleting a
   backorder that had already become a real order.

   Batch 1H removed the write path instead of continuing to guard it. Orders
   and backorders are now written ONLY by:
     PATCH /admin/orders/:id
     POST  /admin/orders/:id/invoice
     POST  /admin/backorders/:id/eligibility
     POST  /admin/backorders/:id/convert
   and /admin/sync rejects the whole request if either collection appears in
   the payload — see checkSyncPayload(). The guards those helpers needed are
   unnecessary once the unsafe path does not exist. */

/* Dedicated staff operation for stock eligibility.
   Previously the admin panel toggled `eligible` in browser state and relied on
   the generic row-diff sync, which is exactly the path a stale snapshot can
   regress. This writes it directly, refuses on a terminal record, and is
   audited. It never touches status or converted_order_id — only the
   transactional conversion endpoint may set those. */
r.post('/backorders/:id/eligibility', async (req, res, next) => {
  try {
    const eligible = req.body?.eligible !== false;
    const { rows } = await q(`
      update backorders set eligible=$2
       where id=$1 and status in ('open','approved')
       returning number, status, eligible, customer_authorised`,
      [req.params.id, eligible]);
    if (!rows.length) {
      const { rows: cur } = await q(`select status from backorders where id=$1`, [req.params.id]);
      return res.status(cur.length ? 409 : 404).json({
        error: cur.length
          ? `Backorder is ${cur[0].status} — stock eligibility can no longer be changed`
          : 'Backorder not found' });
    }
    await afterCommit(`audit 'backorder eligibility' ${rows[0].number}`, () =>
      audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
        eligible ? 'backorder stock cleared' : 'backorder stock clearance removed',
        rows[0].number, 'staff stock decision — not customer authorisation'));
    res.json({ ok: true, number: rows[0].number, status: rows[0].status,
      eligible: rows[0].eligible, customerAuthorised: rows[0].customer_authorised });
  } catch (e) { next(e); }
});

async function upsertReturn(c, x) {
  await c.query(`
    insert into returns (id, number, customer_id, order_number, status, notes)
    values ($1,$2,$3,$4,$5,$6)
    on conflict (id) do update set
      number=excluded.number, customer_id=excluded.customer_id,
      order_number=excluded.order_number, status=excluded.status, notes=excluded.notes`,
    [x.id, x.number, x.customerId || null, x.orderNumber || null, x.status || 'open', x.notes || '']);
  await c.query(`delete from return_items where return_id=$1`, [x.id]);
  for (const i of (x.items || [])) {
    await c.query(`
      insert into return_items (return_id, sku, name, qty, price, resolution, exchange_sku)
      values ($1,$2,$3,$4,$5,$6,$7)`,
      [x.id, String(i.sku), i.name || '', parseInt(i.qty, 10) || 0, num(i.price) ?? 0,
       ['credit', 'exchange'].includes(i.resolution) ? i.resolution : 'credit',
       i.exchangeSku || null]);
  }
}

/* Keeps a server sequence ahead of any number a client assigned itself.
   'orders' and 'backorders' are gone: the browser no longer assigns either
   number, so there is nothing to catch up with, and order_number_seq /
   backorder_number_seq are advanced only by the endpoints that issue them.

   'invoices' is gone for the same reason as of Final Handover Phase 4: the
   generic sync can no longer write an invoice at all, so there is no
   client-assigned invoice number to catch up with. `invoice_number_seq` is
   advanced only by the governed finance route that issues one. Leaving the
   entry here would be dead code that reads like a supported path. */
const SEQ_SYNC = [
  ['returns', 'return_number_seq', 'RT'],
  ['purchaseOrders', 'po_number_seq', 'PO'],
];

r.post('/sync', async (req, res, next) => {
  try {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];

    /* STALE-CLIENT GATE — runs before the transaction opens and before any
       query. An admin tab left open across the Batch 1H deployment (or one
       served a cached copy of the previous bundle) still has `orders` and
       `backorders` in its SYNCED list, so its next debounced save carries a
       whole snapshot of order state taken BEFORE the deployment — plus a
       `deletes` list naming every id that tab has not seen.

       The entire request is refused, not just the offending collections. A
       partial write would be the worse failure: the caller would be told its
       order changes were rejected while its product changes had already
       landed, from the same stale snapshot. */
    const gate = checkSyncPayload(changes);
    if (!gate.ok) {
      console.warn(`[admin sync] refused stale server-managed payload: `
        + gate.collections.join(', '));
      return res.status(gate.status).json({
        error: gate.error, collections: gate.collections });
    }

    /* ROLE GATE — finding SEC-002.
     *
     * This endpoint is a whole-database row editor across 18 collections. It
     * previously admitted `warehouse` and gated exactly one collection
     * (`users`), leaving promotions, invoices, payments, credit notes,
     * shipping rules, settings — which carries the FX rates — and the audit
     * log writable by a fulfilment login.
     *
     * The sharpest case was `products`: receiving stock went through it, and
     * upsertProduct writes price and sale_price on the product and every
     * variation, so the same request that received a delivery could re-price
     * the catalogue.
     *
     * Warehouse staff now use the narrow workflow routes under
     * /admin/inventory (adjust, transfer), which touch quantities and nothing
     * else. The whole payload is refused rather than filtered: a partial
     * write would tell the caller its stock change was rejected while its
     * other changes had already landed. */
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'This endpoint is restricted to administrators. '
          + 'Warehouse operations use the dedicated routes under /admin/inventory.',
        code: 'ADMIN_ONLY',
      });
    }

    const remaps = [];
    const touched = new Set();
    await tx(async (c) => {
      for (const ch of changes) {
        const name = ch.collection;
        // The `warehouse` role can reach this router (for fulfilment work) but
        // must never write the users table — otherwise a warehouse login could
        // upsert its own row with role='admin' and self-escalate. Only a real
        // admin may create, modify or delete user rows.
        if (name === 'users' && req.user.role !== 'admin') {
          throw Object.assign(new Error('users: admin only'), { status: 403 });
        }
        touched.add(name);
        const upserts = Array.isArray(ch.upserts) ? ch.upserts : [];
        const deletes = Array.isArray(ch.deletes) ? ch.deletes : [];

        if (name === 'products') {
          const actor = { id: req.user.id, name: req.user.email, role: req.user.role };
          for (const p of upserts) await upsertProduct(c, p, actor);
          if (deletes.length) await c.query(`delete from products where id = any($1)`, [deletes]);
        /* No 'orders' or 'backorders' branch exists. They are rejected above,
           before this loop runs; reaching this point with either collection is
           impossible, and the `unknown collection` error below would catch it
           anyway. */
        } else if (name === 'returns') {
          for (const x of upserts) {
            await upsertNumbered(c, x, 'return_number_seq', 'RT',
              row => upsertReturn(c, row), remaps, 'returns');
          }
          if (deletes.length) await c.query(`delete from returns where id = any($1)`, [deletes]);
        } else if (name === 'settings') {
          if (upserts[0]) {
            await c.query(`update settings set data=$1 where id=1`, [JSON.stringify(upserts[0])]);
            invalidateFxCache(); // FX rates may have changed
          }
        } else if (SIMPLE_COLLECTIONS[name]) {
          const cfg = SIMPLE_COLLECTIONS[name];
          for (const obj of upserts) {
            if (cfg.sequence) {
              await upsertNumbered(c, obj, cfg.sequence.name, cfg.sequence.prefix,
                row => upsertSimple(c, cfg, row), remaps, name);
            } else {
              await upsertSimple(c, cfg, obj);
            }
          }
          if (deletes.length) {
            const guard = cfg.protectedDelete ? 'and not protected' : '';
            await c.query(`delete from ${cfg.table} where id = any($1) ${guard}`, [deletes]);
          }
        } else {
          throw Object.assign(new Error(`unknown collection: ${name}`), { status: 400 });
        }
      }
      // keep server sequences ahead of any client-assigned numbers
      for (const [coll, seq, prefix] of SEQ_SYNC) {
        if (!touched.has(coll)) continue;
        const table = SIMPLE_COLLECTIONS[coll]?.table || coll;
        await c.query(`
          select setval('${seq}', greatest(
            (select last_value from ${seq}),
            coalesce((select max(substring(number from ${prefix.length + 1})::bigint)
                        from ${table} where number ~ '^${prefix}[0-9]+$'), 0)
          ))`);
      }
    });
    // Product edits must show in the storefront immediately, not after the
    // catalog cache TTL.
    if (touched.has('products')) invalidateCatalogCache();
    res.json({ ok: true, remaps });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/* ============================ uploads ============================ */

const upload = multer({
  storage: multer.diskStorage({
    destination: (rq, f, cb) => {
      const folder = /^[a-z0-9-]+$/.test(rq.body?.folder || '') ? rq.body.folder : 'products';
      const dir = path.join(UPLOADS, folder);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (rq, f, cb) => {
      const base = path.basename(f.originalname, path.extname(f.originalname))
        .replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
      cb(null, `${base}_${crypto.randomBytes(4).toString('hex')}${path.extname(f.originalname).toLowerCase()}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (rq, f, cb) => cb(null, /image\/(jpe?g|png|webp|gif|avif)/.test(f.mimetype)),
});

r.post('/upload', upload.array('files', 20), (req, res) => {
  const files = (req.files || []).map(f =>
    `/s3/${path.basename(path.dirname(f.path))}/${f.filename}`);
  if (!files.length) return res.status(400).json({ error: 'no files' });
  res.json({ paths: files });
});

/* ============================ account invitations ============================ */

/** Send (or resend) an activation email to a customer. */
r.post('/send-activation/:userId', async (req, res) => {
  const { rows } = await q(`select * from users where id=$1`, [req.params.userId]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  const u = rows[0];
  const mail = welcomeActivation({ name: u.first_name || u.business, username: u.username,
    email: u.email, link: setPasswordLink(u.id, 'activation') });
  await sendMail({ to: u.email, subject: mail.subject, html: mail.html,
    text: `Welcome to Veyora. Set your password: ${setPasswordLink(u.id, 'activation')}` });
  res.json({ ok: true });
});

/** Bulk-send activation/welcome emails to all pending (or all) customers. */
r.post('/send-activation-bulk', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const onlyPending = req.body?.all !== true;
  const { rows } = await q(`
    select * from users where role in ('customer','special customer')
      and email not like '%@import.veyora.local' ${onlyPending ? `and status='pending'` : ''}`);
  let sent = 0;
  for (const u of rows) {
    const mail = welcomeActivation({ name: u.first_name || u.business, username: u.username,
      email: u.email, link: setPasswordLink(u.id, 'activation') });
    try { await sendMail({ to: u.email, subject: mail.subject, html: mail.html,
      text: `Welcome to Veyora. Set your password: ${setPasswordLink(u.id, 'activation')}` }); sent++; }
    catch { /* skip failures */ }
  }
  res.json({ ok: true, sent, total: rows.length });
});

/** Directly set a user's password (admin action, e.g. for staff accounts). */
r.post('/set-user-password/:userId', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { password } = req.body || {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const { rows } = await q(
    `update users set password_hash=$2, status='active' where id=$1 returning id`,
    [req.params.userId, await bcrypt.hash(String(password), 10)]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

/* ==================== inventory movements ledger ==================== */

// Read the immutable stock-movement ledger, newest first.
// Filters: ?sku= &variationId= &warehouseId= &reason= &refType= &refId= &limit=
r.get('/inventory-movements', async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    const add = (col, val) => { params.push(val); where.push(`${col} = $${params.length}`); };
    if (req.query.sku) add('sku', String(req.query.sku));
    if (req.query.variationId) add('variation_id', String(req.query.variationId));
    if (req.query.warehouseId) add('warehouse_id', String(req.query.warehouseId));
    if (req.query.reason) add('reason', String(req.query.reason));
    if (req.query.refType) add('ref_type', String(req.query.refType));
    if (req.query.refId) add('ref_id', String(req.query.refId));
    const limit = Math.min(1000, parseInt(req.query.limit, 10) || 200);
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const { rows } = await q(
      `select * from inventory_movements ${clause} order by created_at desc limit ${limit}`, params);
    res.json({ movements: rows.map(m => ({
      id: m.id, variationId: m.variation_id, sku: m.sku, warehouseId: m.warehouse_id,
      qtyDelta: m.qty_delta, balanceAfter: m.balance_after, reason: m.reason,
      refType: m.ref_type, refId: m.ref_id, actorId: m.actor_id, actorName: m.actor_name,
      actorRole: m.actor_role, note: m.note, createdAt: m.created_at,
    })) });
  } catch (e) { next(e); }
});

// Reconcile: any (variation, warehouse) where live stock disagrees with the
// ledger's running sum. Should be empty — a non-empty list means a stock write
// bypassed the ledger. Great smoke test after deploy.
r.get('/inventory-movements/reconcile', async (req, res, next) => {
  try {
    const { rows } = await q(`
      with led as (
        select variation_id, warehouse_id, sum(qty_delta) as qty
          from inventory_movements group by variation_id, warehouse_id)
      select coalesce(s.variation_id, l.variation_id) as variation_id,
             coalesce(s.warehouse_id, l.warehouse_id) as warehouse_id,
             coalesce(s.qty, 0) as stock_qty,
             coalesce(l.qty, 0) as ledger_qty
        from stock s
        full outer join led l
          on s.variation_id = l.variation_id and s.warehouse_id = l.warehouse_id
       where coalesce(s.qty, 0) <> coalesce(l.qty, 0)
       order by abs(coalesce(s.qty,0) - coalesce(l.qty,0)) desc
       limit 500`);
    res.json({
      ok: rows.length === 0,
      mismatchCount: rows.length,
      mismatches: rows.map(m => ({
        variationId: m.variation_id, warehouseId: m.warehouse_id,
        stockQty: m.stock_qty, ledgerQty: m.ledger_qty,
        drift: m.stock_qty - m.ledger_qty,
      })),
    });
  } catch (e) { next(e); }
});

export default r;
