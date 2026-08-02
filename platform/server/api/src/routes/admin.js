import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { q, tx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { SIMPLE_COLLECTIONS, rowToJs, jsToRow } from '../shape.js';
import { sendMail } from '../mail.js';
import { setPasswordLink } from '../authmw.js';
import { welcomeActivation, orderConfirmation, staffOrderAlert } from '../emails.js';
import { syncZohoInventory, zohoStatus, pushOrderToZoho } from '../zoho.js';
import { invalidateCatalogCache } from './catalog.js';
import { recordMovement, planSkuReservations, reserveTakes } from '../inventory.js';
import { invalidateFxCache } from '../currency.js';
import { orderAlertRecipients } from '../config.js';
import { orderFieldsFromBackorder, isBackorderProcessable,
         reconcileBackorderSync, BACKORDER_LOCK_SQL,
         canDeleteBackorder, BACKORDER_DELETE_CANDIDATES_SQL } from '../ordering.js';
import { afterCommit, afterCommitDetached } from '../postcommit.js';

const r = Router();
r.use(requireAuth('admin', 'warehouse'));

const UPLOADS = process.env.UPLOADS_DIR || '/uploads';

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
   which is wrong for dash colorways like VEDETTE-2002. These keys are
   read-only: upsertOrder writes an explicit column list and ignores them. */
const ITEM_IDENTITY_JOIN = `
  left join variations v on v.sku = i.sku
  left join products  p on p.id = v.product_id`;

async function ordersSnapshot() {
  const { rows } = await q(`
    select o.*, coalesce((
      select json_agg(json_build_object(
        'sku', i.sku, 'name', i.name, 'color', i.color, 'qty', i.qty,
        'modelSku', p.sku, 'brand', p.brand,
        'collected', i.collected, 'price', i.price, 'note', i.note, 'labels', i.labels
      ) order by i.created_at)
      from order_items i ${ITEM_IDENTITY_JOIN}
     where i.order_id = o.id), '[]') as items
      from orders o order by o.created_at desc`);
  return rows.map(o => ({
    id: o.id, number: o.number, customerId: o.customer_id, agentId: o.agent_id,
    source: o.source, status: o.status, date: o.order_date,
    discount: o.discount, discountPct: o.discount_pct, freeShipping: o.free_shipping,
    shipping: o.shipping, total: o.total, tracking: o.tracking, comments: o.comments,
    invoiceId: o.invoice_id, promo: o.promo,
    currency: o.currency, fxRate: o.fx_rate,
    shippingAddress: o.shipping_address, billingAddress: o.billing_address,
    createdAt: o.created_at, items: o.items,
  }));
}

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
    out.orders = await ordersSnapshot();
    out.backorders = await nestedNumberSnapshot('backorders', 'backorder_items', 'backorder_id',
      `'sku', i.sku, 'name', i.name, 'color', i.color, 'qty', i.qty, 'price', i.price,
       'modelSku', p.sku, 'brand', p.brand`,
      b => ({ id: b.id, number: b.number, orderId: b.order_id, orderNumber: b.order_number,
              customerId: b.customer_id, status: b.status, reason: b.reason,
              eligible: b.eligible, convertedOrderId: b.converted_order_id,
              createdAt: b.created_at, items: b.items,
              // Preserved order context — a fully backordered request has no
              // orders row, so this is the only durable copy. Round-tripped by
              // upsertBackorder so an admin save cannot erase it.
              customerAuthorised: b.customer_authorised,
              agentId: b.agent_id, source: b.source,
              currency: b.currency, fxRate: b.fx_rate,
              shippingAddress: b.shipping_address, billingAddress: b.billing_address,
              promo: b.promo, discount: b.discount,
              freeShipping: b.free_shipping, shipping: b.shipping,
              comments: b.comments }),
      ITEM_IDENTITY_JOIN);
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

async function upsertOrder(c, o) {
  if (!o.id) throw new Error('order missing id');
  await c.query(`
    insert into orders (id, number, customer_id, agent_id, source, status, order_date,
                        discount, discount_pct, free_shipping, shipping, total,
                        tracking, comments, invoice_id, currency, fx_rate)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    on conflict (id) do update set
      number=excluded.number, customer_id=excluded.customer_id, agent_id=excluded.agent_id,
      source=excluded.source, status=excluded.status, order_date=excluded.order_date,
      discount=excluded.discount, discount_pct=excluded.discount_pct,
      free_shipping=excluded.free_shipping, shipping=excluded.shipping, total=excluded.total,
      tracking=excluded.tracking, comments=excluded.comments, invoice_id=excluded.invoice_id,
      currency=excluded.currency, fx_rate=excluded.fx_rate`,
    [o.id, o.number, o.customerId || null, o.agentId || null, o.source || 'customer',
     o.status || 'pending', o.date || new Date().toISOString().slice(0, 10),
     num(o.discount) ?? 0, num(o.discountPct) ?? 0, !!o.freeShipping,
     num(o.shipping) ?? 0, num(o.total) ?? 0,
     o.tracking ? JSON.stringify(o.tracking) : null,
     JSON.stringify(o.comments || []), o.invoiceId || null,
     (o.currency || 'USD'), num(o.fxRate) ?? 1]);
  await c.query(`delete from order_items where order_id=$1`, [o.id]);
  for (const i of (o.items || [])) {
    await c.query(`
      insert into order_items (order_id, sku, name, color, qty, collected, price, note, labels)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [o.id, String(i.sku), i.name || '', i.color || '', parseInt(i.qty, 10) || 0,
       parseInt(i.collected, 10) || 0, num(i.price) ?? 0, i.note || '',
       JSON.stringify(i.labels || [])]);
  }
}

/* The preserved order context is written back with coalesce(): a client that
   round-trips the row keeps it, and a client that omits a key (an older admin
   build, a hand-built payload) leaves the stored value alone instead of
   nulling it. Losing this context would make a full backorder unconvertible.

   TERMINAL STATE IS SERVER-OWNED. The admin panel holds the whole dataset in
   the browser and pushes row diffs on a debounce, so a save can carry a
   snapshot taken BEFORE the conversion endpoint ran. Without this guard that
   stale payload writes `open` over `converted`, blanks converted_order_id and
   deletes the items of a backorder that has already become a real order.
   reconcileBackorderSync() decides what the payload is allowed to change. */
async function upsertBackorder(c, b, refusals = []) {
  const has = k => Object.prototype.hasOwnProperty.call(b, k);

  /* FOR UPDATE. Without the lock this read and the write below straddle a
     window: sync reads `open`, the conversion endpoint locks the row and
     converts it, sync then wakes at its own UPDATE and writes the decision it
     made from the STALE read — putting `open` back over `converted` and
     erasing the order link. Locking here makes the state we reconcile the same
     state we write, and serialises this transaction behind any conversion. */
  const { rows: storedRows } = await c.query(
    BACKORDER_LOCK_SQL, [b.id]);
  const stored = storedRows[0] || null;
  const guard = reconcileBackorderSync(stored, b);
  if (guard.regressed.length) {
    console.warn(`[admin sync] ignored stale backorder change on ${b.id}: `
      + guard.regressed.join(', '));
    await audit({ id: 'system', name: 'Admin sync guard', role: 'system' },
      'stale backorder sync ignored', b.number || b.id,
      guard.regressed.join('; '), 'system').catch(() => {});
    // Reported back to the client, so the caller learns its write was refused
    // instead of assuming a clean save.
    refusals.push({ collection: 'backorders', id: b.id, number: b.number || null,
      suppressed: guard.regressed });
  }
  b = { ...b, status: guard.status, eligible: guard.eligible,
        convertedOrderId: guard.convertedOrderId };
  await c.query(`
    insert into backorders (id, number, order_id, order_number, customer_id, status,
                            reason, eligible, converted_order_id,
                            customer_authorised, agent_id, source, currency, fx_rate,
                            shipping_address, billing_address, promo,
                            discount, free_shipping, shipping, comments)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,
            coalesce($10,false), $11, coalesce($12,'customer'), coalesce($13,'USD'),
            coalesce($14,1), $15, $16, $17,
            coalesce($18,0), coalesce($19,false), coalesce($20,0), coalesce($21,'[]'::jsonb))
    on conflict (id) do update set
      number=excluded.number, order_id=excluded.order_id, order_number=excluded.order_number,
      customer_id=excluded.customer_id, status=excluded.status, reason=excluded.reason,
      eligible=excluded.eligible, converted_order_id=excluded.converted_order_id,
      customer_authorised = coalesce($10, backorders.customer_authorised),
      agent_id            = coalesce($11, backorders.agent_id),
      source              = coalesce($12, backorders.source),
      currency            = coalesce($13, backorders.currency),
      fx_rate             = coalesce($14, backorders.fx_rate),
      shipping_address    = coalesce($15, backorders.shipping_address),
      billing_address     = coalesce($16, backorders.billing_address),
      promo               = coalesce($17, backorders.promo),
      discount            = coalesce($18, backorders.discount),
      free_shipping       = coalesce($19, backorders.free_shipping),
      shipping            = coalesce($20, backorders.shipping),
      comments            = coalesce($21, backorders.comments)`,
    [b.id, b.number, b.orderId || null, b.orderNumber || null, b.customerId || null,
     b.status || 'open', b.reason || 'out of stock', !!b.eligible, b.convertedOrderId || null,
     has('customerAuthorised') ? !!b.customerAuthorised : null,
     b.agentId ?? null,
     has('source') ? b.source : null,
     has('currency') ? b.currency : null,
     has('fxRate') ? num(b.fxRate) : null,
     b.shippingAddress ? JSON.stringify(b.shippingAddress) : null,
     b.billingAddress ? JSON.stringify(b.billingAddress) : null,
     b.promo ? JSON.stringify(b.promo) : null,
     has('discount') ? num(b.discount) : null,
     has('freeShipping') ? !!b.freeShipping : null,
     has('shipping') ? num(b.shipping) : null,
     has('comments') ? JSON.stringify(b.comments || []) : null]);
  /* The items of a CONVERTED backorder are the record of what became an order
     and what was reserved against it. A stale snapshot must not replace or
     delete them. */
  if (!guard.itemsWritable) {
    console.warn(`[admin sync] kept items of converted backorder ${b.id} (stale payload)`);
    return;
  }
  await c.query(`delete from backorder_items where backorder_id=$1`, [b.id]);
  for (const i of (b.items || [])) {
    await c.query(`
      insert into backorder_items (backorder_id, sku, name, color, qty, price)
      values ($1,$2,$3,$4,$5,$6)`,
      [b.id, String(i.sku), i.name || '', i.color || '', parseInt(i.qty, 10) || 0, num(i.price) ?? 0]);
  }
}

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

const SEQ_SYNC = [
  ['orders', 'order_number_seq', 'SO'],
  ['backorders', 'backorder_number_seq', 'BO'],
  ['returns', 'return_number_seq', 'RT'],
  ['invoices', 'invoice_number_seq', 'IN'],
  ['purchaseOrders', 'po_number_seq', 'PO'],
];

r.post('/sync', async (req, res, next) => {
  try {
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    const remaps = [];
    /* Writes the server REFUSED to make (terminal-state protection). Returned
       to the client so a sync can never look wholly successful while state was
       silently suppressed. */
    const refusals = [];
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
        } else if (name === 'orders') {
          for (const o of upserts) {
            await upsertNumbered(c, o, 'order_number_seq', 'SO',
              row => upsertOrder(c, row), remaps, 'orders');
          }
          if (deletes.length) await c.query(`delete from orders where id = any($1)`, [deletes]);
        } else if (name === 'backorders') {
          for (const b of upserts) {
            await upsertNumbered(c, b, 'backorder_number_seq', 'BO',
              row => upsertBackorder(c, row, refusals), remaps, 'backorders');
          }
          /* Terminal records are not deletable by a generic sync. Deleting a
             converted backorder would orphan a real order and erase the record
             of the stock reserved for it; deleting a cancelled one would erase
             the decision. Live open/approved rows keep the existing behaviour. */
          if (deletes.length) {
            /* Lock EVERY requested row first, with no state predicate.
               Selecting only rows that already looked terminal left an `open`
               row unlocked, so a conversion could land between the protection
               query and the delete — and the delete would then remove a
               backorder that had just become a real order.

               With every candidate locked: if a conversion holds the row we
               wait, and after it commits we read `converted` and refuse. If we
               get the lock first on a genuinely open row we delete it, and the
               conversion then finds no row and creates nothing. */
            const { rows: candidates } = await c.query(
              BACKORDER_DELETE_CANDIDATES_SQL, [deletes]);
            const protectedRows = candidates.filter(row => !canDeleteBackorder(row));
            const blocked = new Set(protectedRows.map(x => x.id));
            for (const row of protectedRows) {
              console.warn(`[admin sync] refused delete of ${row.status} backorder `
                + `${row.number || row.id}`);
              await audit({ id: 'system', name: 'Admin sync guard', role: 'system' },
                'stale backorder delete refused', row.number || row.id,
                `status=${row.status}${row.converted_order_id ? ', linked to an order' : ''}`,
                'system').catch(() => {});
            }
            const deletable = deletes.filter(id => !blocked.has(id));
            if (deletable.length) {
              await c.query(`delete from backorders where id = any($1)`, [deletable]);
            }
            if (blocked.size) refusals.push(
              { collection: 'backorders', action: 'delete', ids: [...blocked] });
          }
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
    res.json({ ok: true, remaps, refusals });
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
