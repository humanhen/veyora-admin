import { Router } from 'express';
import { q, tx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { round2, allocateCommercials } from '../pricing.js';
import { cartSummary } from './cart.js';
import { sendMail } from '../mail.js';
import { orderConfirmation, backorderConfirmation, staffOrderAlert } from '../emails.js';
import { pushOrderToZoho } from '../zoho.js';
import { recordMovement, planAllocation, reserveTakes } from '../inventory.js';
import { getFx, rateFor, normalizeCurrency } from '../currency.js';
import { allowCustomerBackorders, orderAlertRecipients } from '../config.js';
import { invalidateCatalogCache } from './catalog.js';
import { resolveOrderingCustomer, orderingContextShape, sanitizeOrderNote,
         CUSTOMER_BACKORDER, lockCartForSubmission, compareCartSnapshots,
         orderLinesForLocking } from '../ordering.js';
import { afterCommit, afterCommitDetached } from '../postcommit.js';

const r = Router();
r.use(requireAuth());

function orderShape(o, items) {
  return {
    id: o.id, number: o.number, customerId: o.customer_id, agentId: o.agent_id,
    source: o.source, status: o.status, date: o.order_date,
    discount: o.discount, discountPct: o.discount_pct,
    freeShipping: o.free_shipping, shipping: o.shipping, total: o.total,
    tracking: o.tracking, comments: o.comments, invoiceId: o.invoice_id,
    shippingAddress: o.shipping_address, billingAddress: o.billing_address,
    promo: o.promo, currency: o.currency, fxRate: o.fx_rate, createdAt: o.created_at,
    items: items?.map(i => ({
      id: i.id, sku: i.sku, name: i.name, color: i.color,
      // Model number is the PRODUCT sku, never a slice of the variation sku —
      // dash colorways (VEDETTE-2002) make prefix-parsing wrong.
      modelSku: i.model_sku ?? i.modelSku ?? null, brand: i.brand ?? null,
      qty: i.qty, collected: i.collected ?? 0, price: i.price,
      note: i.note, labels: i.labels,
    })),
  };
}

/* Order/backorder line items joined back to their product so brand + model
   number travel with every staff and customer surface. Reconstructed by join
   rather than duplicated into new columns — the identity is always derivable
   and this keeps the admin snapshot/sync round-trip unchanged. */
const ITEM_IDENTITY_JOIN = `
  left join variations v on v.sku = i.sku
  left join products  p on p.id = v.product_id`;

/** Send mail without ever letting a mail problem affect the caller. */
async function sendMailSafely(message, context) {
  try {
    const info = await sendMail(message);
    if (info?.logged) {
      console.warn(`[mail] SMTP is not configured — ${context} for ${message.to} was only logged, not sent`);
    }
    return true;
  } catch (e) {
    // A placed order is a committed business fact; a failed email never undoes it.
    console.error(`[mail] ${context} to ${message.to} FAILED:`, e.message);
    await audit({ id: 'system', name: 'Mailer', role: 'system' },
      'email failed', context, e.message, 'system').catch(() => {});
    return false;
  }
}

async function shippingCost(user, subtotal, promoFreeShipping) {
  if (promoFreeShipping) return { cost: 0, free: true, reason: 'promotion' };
  const dow = new Date().getDay();
  const { rows: fs } = await q(
    `select 1 from free_shipping where customer_id=$1 and day_of_week=$2 and active`,
    [user.id, dow]);
  if (fs.length) return { cost: 0, free: true, reason: 'free shipping day' };
  const { rows } = await q(
    `select threshold, cost from shipping_rules where country=$1 and active
      order by threshold desc`, [user.country]);
  for (const rule of rows) {
    if (subtotal >= rule.threshold) return { cost: 0, free: true, reason: 'over threshold' };
  }
  const base = rows.length ? rows[rows.length - 1].cost : 0;
  return { cost: round2(base), free: base === 0, reason: base ? 'standard rate' : 'no rule' };
}

/* ---------- place order ---------- */

r.post('/place-order', async (req, res, next) => {
  try {
    const user = req.user;
    const allowBackorders = allowCustomerBackorders();

    /* ---- 1. Resolve WHO the order is for, BEFORE anything is priced ----
       A salesperson may order on behalf of one of their customers. Every
       commercial decision that follows — prices, promotions, currency,
       shipping, ownership — must use that customer's context. The signed-in
       salesperson stays recorded separately as the agent/actor.

       The same resolver backs the cart preview, so preview and placement can
       never disagree about who is being priced or who is allowed. */
    const { customer, onBehalf } = await resolveOrderingCustomer(user, req.body?.customerId, q);
    // An agent ordering for anyone (including their own account) is an agent order.
    const placedByStaff = onBehalf || ['agent', 'super-agent'].includes(user.role);

    // Overall order note from checkout: trimmed, bounded, stored as text and
    // escaped wherever it is rendered. Never treated as markup.
    const note = sanitizeOrderNote(req.body?.notes);

    /* ---- 2. Price the cart with the CUSTOMER's identity ----
       The lines still come from the signed-in actor's cart; the money comes
       from the customer's pricing profile. hide_prices is forced off so the
       order is always costed, even for a hide-prices account. */
    const summary = await cartSummary(user, { ...customer, hide_prices: false });
    const usable = summary.items.filter(i => !i.missing && i.qty > 0);
    if (!usable.length) return res.status(400).json({ error: 'Cart is empty' });

    const ship = await shippingCost(customer, summary.total, summary.promotion?.freeShipping);

    // Currency the order is struck in: the account's operating currency + the
    // rate at this moment. Money is still stored in the base currency (USD);
    // this stamp makes the transaction reproducible if the rate later changes.
    const fx = await getFx();
    const orderCurrency = normalizeCurrency(customer.currency);
    const orderRate = rateFor(orderCurrency, fx);

    const result = await tx(async (c) => {
      /* ---- SUBMISSION LOCK ----
         The cart was priced above, outside this transaction. Two near-
         simultaneous checkouts could otherwise both capture it and both create
         an order. Locking the actor's cart rows serialises checkout per cart
         owner: the second request waits here, then finds the cart empty because
         the first deleted it inside its own transaction.

         The lock is on the ACTOR's cart even for an assisted order — the cart
         belongs to the salesperson; only the pricing belongs to the customer. */
      const lockedCart = await lockCartForSubmission(c, user.id);
      if (!lockedCart.length) {
        throw Object.assign(
          new Error('This cart has already been submitted or is now empty.'),
          { status: 409, expose: true, alreadySubmitted: true });
      }

      /* ---- SUBMIT EXACTLY THE CART THAT WAS PRICED ----
         The cart was priced outside this transaction, so it may have changed
         since. Checking only that the priced SKUs still exist was not enough:
         a stale quantity could be submitted, a newly added line silently
         dropped and then deleted with the rest of the cart, and a changed note
         or label set lost. Compare the WHOLE snapshot and fail closed on any
         difference — nothing is created, no stock moves, no promotion is
         consumed and the cart is left exactly as the customer left it.
         `summary.items` is the complete priced cart (not the filtered
         `usable`), so an added or removed row is detected. */
      const cartDiff = compareCartSnapshots(summary.items, lockedCart);
      if (!cartDiff.match) {
        throw Object.assign(
          new Error('Your cart changed while checkout was being prepared. '
            + 'Review it and submit again.'),
          { status: 409, expose: true, cartChanged: true, changes: cartDiff.changes });
      }

      /* The locked cart now equals the priced cart, so the priced lines are
         authoritative. `usable` drops rows whose variation no longer exists —
         they are unorderable, and were already excluded before the lock.

         Locks are then taken in one deterministic SKU order for every
         checkout, so two concurrent carts holding the same SKUs cannot each
         hold the row the other wants. */
      const lines = orderLinesForLocking(usable);

      const orderItems = [];
      const backItems = [];
      const moves = []; // stock reservations; stamped with the order number once it exists
      // Per-line record of requested vs allocated vs backordered. Drives the API
      // response, both customer emails and the staff alert, so all four agree.
      const breakdown = [];

      for (const line of lines) {
        // Lock this variation's stock rows, allocate from largest pile first.
        const { rows: stockRows } = await c.query(`
          select s.variation_id, s.warehouse_id, s.qty
            from stock s join variations v on v.id = s.variation_id
           where v.sku = $1
           order by (s.warehouse_id = 'wh_main') desc, s.qty desc
           for update of s`, [line.sku]);
        // Decide the split first (pure), then apply it to the locked rows.
        // reserveTakes issues the guarded `qty >= $1` decrement: if a pile has
        // moved despite the lock the update matches no row and the whole
        // transaction aborts, so stock can never go negative.
        // (A cart cannot repeat a SKU — cart_items is unique(user_id, sku) —
        //  so no aggregation is needed on this path, only the guard.)
        const { takes, allocated, backordered: need } = planAllocation(line.qty, stockRows);
        moves.push(...await reserveTakes(c, takes.map(t => ({ ...t, sku: line.sku }))));
        if (allocated > 0) {
          orderItems.push({ ...line, qty: allocated });
        }
        if (need > 0) {
          backItems.push({ ...line, qty: need });
          await c.query(
            `update variations set stock_status='out of stock' where sku=$1 and stock_status='in stock'`,
            [line.sku]);
        }
        breakdown.push({
          sku: line.sku, modelSku: line.modelSku, brand: line.brand,
          name: line.name, color: line.color, price: line.price,
          requested: line.qty, allocated, backordered: need,
        });
      }

      /* Backorders switched off: nothing may be promised that is not on the
         shelf. Throwing here rolls the whole transaction back, so the stock we
         just decremented is restored and the cart is left untouched for the
         customer to adjust. */
      if (!allowBackorders && backItems.length) {
        throw Object.assign(
          new Error('Some items are no longer available in the quantity you requested.'),
          {
            status: 409,
            shortages: breakdown.filter(b => b.backordered > 0).map(b => ({
              sku: b.sku, modelSku: b.modelSku, name: b.name, color: b.color,
              requested: b.requested, available: b.allocated, short: b.backordered,
            })),
          });
      }

      /* ---- split the ONE set of commercial terms the customer authorised ----
         Whether stock happened to be available must not change what they pay:
         the discount applies to the immediate order first and the remainder
         carries to the backorder (a fully backordered promoted checkout used
         to lose its discount outright), and shipping is charged exactly once. */
      const commercials = allocateCommercials({
        allocatedSubtotal: round2(orderItems.reduce((s, i) => s + i.qty * i.price, 0)),
        backorderedSubtotal: round2(backItems.reduce((s, i) => s + i.qty * i.price, 0)),
        promoDiscount: summary.promotion?.discount || 0,
        shippingCost: ship.cost,
        shippingFree: ship.free,
      });

      let order = null;
      if (orderItems.length) {
        const discount = commercials.order.discount;
        const total = commercials.order.total;
        const { rows: num } = await c.query(`select 'SO' || nextval('order_number_seq') as n`);
        const { rows: ord } = await c.query(`
          insert into orders (number, customer_id, agent_id, source, status, order_date,
                              discount, free_shipping, shipping, total,
                              shipping_address, billing_address, promo, currency, fx_rate,
                              comments)
          values ($1,$2,$3,$4,'pending',current_date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          returning *`,
          [num[0].n, customer.id, placedByStaff ? user.id : customer.agent_id,
           placedByStaff ? 'agent' : 'customer', discount,
           commercials.order.freeShipping, commercials.order.shipping, total,
           req.body?.shippingAddress ? JSON.stringify(req.body.shippingAddress) : null,
           req.body?.billingAddress ? JSON.stringify(req.body.billingAddress) : null,
           summary.promotion ? JSON.stringify(summary.promotion) : null,
           orderCurrency, orderRate,
           // The checkout note lands in the existing comments thread (shape
           // {by,text,at} — what the admin order screen already renders, with
           // escaping). No schema change, visible to staff immediately.
           JSON.stringify(note
             ? [{ by: `${customer.business || customer.email} (order note)`,
                  text: note, at: new Date().toISOString() }]
             : [])]);
        order = ord[0];
        for (const i of orderItems) {
          await c.query(`
            insert into order_items (order_id, sku, name, color, qty, collected, price, note, labels)
            values ($1,$2,$3,$4,$5,0,$6,$7,$8)`,
            [order.id, i.sku, i.name || '', i.color || '', i.qty, i.price,
             i.note || '', JSON.stringify(i.labels || [])]);
        }
        // ledger: the stock reserved above, now that the order has a number
        const mover = { id: user.id, name: user.business || user.email, role: user.role };
        for (const mv of moves) {
          await recordMovement(c, { ...mv, reason: 'order_reservation',
            refType: 'order', refId: order.number, actor: mover });
        }
      }

      let backorder = null;
      if (backItems.length) {
        const { rows: bnum } = await c.query(`select 'BO' || nextval('backorder_number_seq') as n`);
        /* The customer chose to order this knowing it was unavailable, so their
           authorisation is recorded (customer_authorised) — but eligibility for
           conversion stays with staff/stock, which the server checks under a
           lock at conversion time.

           A fully backordered request has NO orders row, so the backorder must
           carry its own durable context: who placed it, the currency and rate
           it was struck at, the addresses, the promotion, the shipping decision
           and the note. Without this, conversion could not rebuild the order. */
        const { rows: bo } = await c.query(`
          insert into backorders (number, order_id, order_number, customer_id,
                                  status, reason, eligible, customer_authorised,
                                  agent_id, source, currency, fx_rate,
                                  shipping_address, billing_address, promo,
                                  discount, free_shipping, shipping, comments)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
          returning *`,
          [bnum[0].n, order?.id ?? null, order?.number ?? null, customer.id,
           CUSTOMER_BACKORDER.status, CUSTOMER_BACKORDER.reason,
           CUSTOMER_BACKORDER.eligible, CUSTOMER_BACKORDER.customerAuthorised,
           placedByStaff ? user.id : customer.agent_id,
           placedByStaff ? 'agent' : 'customer',
           orderCurrency, orderRate,
           req.body?.shippingAddress ? JSON.stringify(req.body.shippingAddress) : null,
           req.body?.billingAddress ? JSON.stringify(req.body.billingAddress) : null,
           summary.promotion ? JSON.stringify(summary.promotion) : null,
           /* Whatever discount the immediate order could not absorb carries
              here, so a fully backordered promoted checkout keeps its discount.
              Shipping lands here only when nothing shipped now — never twice. */
           commercials.backorder.discount,
           commercials.backorder.freeShipping,
           commercials.backorder.shipping,
           JSON.stringify(note
             ? [{ by: `${customer.business || customer.email} (order note)`,
                  text: note, at: new Date().toISOString() }]
             : [])]);
        backorder = bo[0];
        for (const i of backItems) {
          await c.query(`
            insert into backorder_items (backorder_id, sku, name, color, qty, price)
            values ($1,$2,$3,$4,$5,$6)`,
            [backorder.id, i.sku, i.name || '', i.color || '', i.qty, i.price]);
        }
      }

      /* One accepted checkout consumes the promotion ONCE — whether it became
         an order, an order plus a backorder, or a backorder alone. It used to
         be counted only when an immediate order existed, so a fully
         backordered checkout consumed nothing. Conversion never counts again:
         the backorder already carries this checkout's snapshot. */
      if (summary.promotion?.id && (order || backorder)) {
        await c.query(`update promotions set used_count = used_count + 1 where id=$1`,
          [summary.promotion.id]);
      }

      // The cart always belongs to the signed-in actor, even on-behalf orders.
      await c.query(`delete from cart_items where user_id=$1`, [user.id]);
      return { order, backorder, breakdown, commercials };
    });

    /* ============================================================
       COMMITTED. From here on the order/backorder is a business fact.
       Every remaining step is best-effort bookkeeping and runs through
       afterCommit(), which logs failures and never lets one turn a committed
       order into an apparent failure — a 500 here would make the customer
       retry and order twice.
       ============================================================ */
    const { order, backorder, breakdown } = result;
    const allocatedLines = breakdown.filter(b => b.allocated > 0)
      .map(b => ({ ...b, qty: b.allocated }));
    const backorderedLines = breakdown.filter(b => b.backordered > 0)
      .map(b => ({ ...b, qty: b.backordered }));

    // Requested / allocated / backordered value, all in the base currency;
    // the display currency + stamped rate travel with them.
    const sumValue = (rows, qtyKey) =>
      round2(rows.reduce((s, b) => s + b[qtyKey] * (Number(b.price) || 0), 0));
    const totals = {
      allocatedValue: sumValue(breakdown, 'allocated'),
      backorderedValue: sumValue(breakdown, 'backordered'),
      requestedValue: sumValue(breakdown, 'requested'),
    };

    // Stock moved, so the shaped-catalog cache is stale: a frame that just sold
    // out must stop showing as orderable immediately, not up to a TTL later.
    await afterCommit('catalog cache invalidation', () => invalidateCatalogCache());

    const actor = { id: user.id, name: user.business || user.email, role: user.role };
    const onBehalfNote = onBehalf ? ` for ${customer.business || customer.email}` : '';
    if (order) {
      await afterCommit(`audit 'order placed' ${order.number}`, () =>
        audit(actor, 'order placed', order.number,
          `total ${orderCurrency} ${order.total}${onBehalfNote}`
          + (note ? ` · note: ${note.slice(0, 120)}` : '')));
    }
    if (backorder) {
      await afterCommit(`audit 'backorder created' ${backorder.number}`, () =>
        audit(actor, 'backorder created', backorder.number,
          `${backorderedLines.reduce((s, b) => s + b.qty, 0)} pcs unavailable at order time`
          + ` · authorised by customer; stock eligibility remains with staff${onBehalfNote}`
          // With no order row there is no comments thread to hold the note, so
          // the audit payload carries it (see IMPLEMENTATION_REPORT §Task 5).
          + (!order && note ? ` · note: ${note.slice(0, 120)}` : ''),
          'web',
          !order && note ? { orderNote: note } : null));
    }

    /* ---- Customer confirmation ----
       Three shapes, all of them confirmed: fully allocated, partly allocated
       (order + linked backorder) and fully backordered (no order at all).
       HTML and plaintext are produced together by the template so the two can
       never disagree about what a hide-prices customer may see. */
    const mailIdentity = { name: customer.first_name || customer.business,
      email: customer.email, hidePrices: customer.hide_prices,
      currency: orderCurrency, rate: orderRate, totals };
    if (order) {
      const m = orderConfirmation({ ...mailIdentity,
        order: { ...order, items: allocatedLines },
        backorder: backorder ? { number: backorder.number, items: backorderedLines } : null });
      sendMailSafely({ to: customer.email, subject: m.subject, html: m.html, text: m.text },
        `order confirmation ${order.number}`);
    } else if (backorder) {
      const m = backorderConfirmation({ ...mailIdentity,
        backorder: { ...backorder, items: backorderedLines } });
      sendMailSafely({ to: customer.email, subject: m.subject, html: m.html, text: m.text },
        `backorder confirmation ${backorder.number}`);
    }

    /* ---- Staff alert (opt-in via ORDER_ALERT_EMAILS) ---- */
    const alertTo = await afterCommit('read ORDER_ALERT_EMAILS', () => orderAlertRecipients(), []);
    if (alertTo.length && (order || backorder)) {
      await afterCommit('build staff order alert', () => {
        const a = staffOrderAlert({
          order, backorder, lines: breakdown, totals, note: note || null,
          customer: { business: customer.business, email: customer.email,
            customerNumber: customer.customer_number },
          agent: onBehalf ? { name: user.business || `${user.first_name} ${user.last_name}`.trim(),
            email: user.email } : null,
          currency: orderCurrency, rate: orderRate,
        });
        sendMailSafely({ to: alertTo.join(', '), subject: a.subject, html: a.html, text: a.text },
          'staff order alert');
      });
    }

    // keep Zoho's books in step while it is the system of record
    if (order) {
      afterCommitDetached(`zoho order push ${order.number}`, () => pushOrderToZoho(order.id));
    }

    res.json({
      ok: true,
      order: order ? orderShape(order, allocatedLines) : null,
      orderNumber: order?.number ?? null,
      backorder: backorder
        ? { id: backorder.id, number: backorder.number, status: backorder.status,
            eligible: backorder.eligible, reason: backorder.reason, items: backorderedLines }
        : null,
      backorderNumber: backorder?.number ?? null,
      fullyBackordered: !order && Boolean(backorder),
      partiallyBackordered: Boolean(order && backorder),
      currency: orderCurrency,
      fxRate: orderRate,
      totalQty: breakdown.reduce((s, b) => s + b.requested, 0),
      allocatedQty: breakdown.reduce((s, b) => s + b.allocated, 0),
      backorderedQty: breakdown.reduce((s, b) => s + b.backordered, 0),
      /* Requested / allocated / backordered value, base currency + the stamped
         rate. Returned regardless of hide_prices, exactly like get-order-detail
         already does: this is the customer's own order and hide_prices is a
         DISPLAY preference. The storefront honours it on screen and the email
         templates honour it strictly in both HTML and plaintext. */
      values: { ...totals, currency: orderCurrency, fxRate: orderRate },
      note: note || null,
      placedForCustomer: onBehalf ? orderingContextShape(customer) : null,
    });
  } catch (e) {
    // Stock conflict with backorders disabled: nothing was created, nothing was
    // emailed, and the cart is intact — tell the customer exactly what is short.
    if (e.status === 409 && e.shortages) {
      return res.status(409).json({ error: e.message, shortages: e.shortages });
    }
    /* Double submission: the second request waited on the cart lock and found
       it empty. Nothing was created, no stock moved — the transaction rolled
       back — so the customer must not be told to retry. */
    if (e.alreadySubmitted) {
      return res.status(409).json({ error: e.message, alreadySubmitted: true });
    }
    /* The cart changed between pricing and submission. The transaction rolled
       back, so the cart is intact and untouched — the customer reviews it and
       submits again. */
    if (e.cartChanged) {
      return res.status(409).json({ error: e.message, cartChanged: true,
        changes: e.changes || [] });
    }
    // Not-your-customer / inactive-customer from resolveOrderingCustomer.
    if (e.expose) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

/* ---------- order list / detail ---------- */

r.get('/get-user-orders', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(100, parseInt(req.query.perPage, 10) || 20);
  const { rows } = await q(`
    select o.*, count(*) over() as total_count,
           (select count(*) from order_items oi where oi.order_id = o.id) as item_count,
           u.business as customer_business
      from orders o left join users u on u.id = o.customer_id
     where o.customer_id = $1 or o.agent_id = $1
     order by o.created_at desc
     limit $2 offset $3`, [req.user.id, perPage, (page - 1) * perPage]);
  res.json({
    orders: rows.map(o => ({ ...orderShape(o), itemCount: Number(o.item_count), customerBusiness: o.customer_business })),
    total: rows[0]?.total_count ?? 0, page, perPage,
  });
});

r.get('/get-order-detail/:id', async (req, res) => {
  const { rows } = await q(`
    select * from orders where (id=$1 or number=$1) and (customer_id=$2 or agent_id=$2)`,
    [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const { rows: items } = await q(
    `select i.*, p.sku as model_sku, p.brand
       from order_items i ${ITEM_IDENTITY_JOIN}
      where i.order_id=$1 order by i.created_at`, [rows[0].id]);
  res.json({ order: orderShape(rows[0], items) });
});

r.post('/repeat-order', async (req, res) => {
  const { rows } = await q(`
    select o.id from orders o
     where (o.id=$1 or o.number=$1) and (o.customer_id=$2 or o.agent_id=$2)`,
    [req.body?.orderId, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Order not found' });
  const { rows: items } = await q(`select sku, qty from order_items where order_id=$1`, [rows[0].id]);
  for (const it of items) {
    await q(`
      insert into cart_items (user_id, sku, qty)
      select $1, $2, $3 where exists (select 1 from variations where sku=$2 and is_active)
      on conflict (user_id, sku) do update set qty = cart_items.qty + excluded.qty`,
      [req.user.id, it.sku, it.qty]);
  }
  res.json(await cartSummary(req.user));
});

/** Remove an item from a still-pending order (restores stock). */
r.delete('/orders/:orderId/items/:itemId', async (req, res, next) => {
  try {
    const result = await tx(async (c) => {
      const { rows: ord } = await c.query(`
        select * from orders where id=$1 and (customer_id=$2 or agent_id=$2)
          and status in ('pending','processing') for update`,
        [req.params.orderId, req.user.id]);
      if (!ord.length) return null;
      const { rows: item } = await c.query(
        `delete from order_items where id=$1 and order_id=$2 returning *`,
        [req.params.itemId, ord[0].id]);
      if (!item.length) return null;
      // restore stock to main warehouse
      const { rows: restored } = await c.query(`
        insert into stock (variation_id, warehouse_id, qty)
        select v.id, 'wh_main', $2 from variations v where v.sku = $1
        on conflict (variation_id, warehouse_id) do update set qty = stock.qty + excluded.qty
        returning variation_id, qty`,
        [item[0].sku, item[0].qty]);
      if (restored.length) {
        await recordMovement(c, { variationId: restored[0].variation_id, sku: item[0].sku,
          warehouseId: 'wh_main', delta: item[0].qty, balanceAfter: restored[0].qty,
          reason: 'order_release', refType: 'order', refId: ord[0].number,
          actor: { id: req.user.id, name: req.user.business || req.user.email, role: req.user.role } });
      }
      const { rows: tot } = await c.query(
        `select coalesce(sum(qty*price),0) as subtotal from order_items where order_id=$1`, [ord[0].id]);
      const total = round2(Number(tot[0].subtotal) - Number(ord[0].discount) + Number(ord[0].shipping));
      await c.query(`update orders set total=$2 where id=$1`, [ord[0].id, Math.max(0, total)]);
      return { number: ord[0].number, sku: item[0].sku };
    });
    if (!result) return res.status(404).json({ error: 'Not found or order already processed' });
    // Committed: the item is gone and the stock is back. Bookkeeping from here
    // must not report a failure for work that actually succeeded.
    await afterCommit('catalog cache invalidation', () => invalidateCatalogCache());
    await afterCommit(`audit 'order item removed' ${result.number}`, () =>
      audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
        'order item removed', result.number, result.sku));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- backorders ---------- */

r.get('/backorders', async (req, res) => {
  const { rows } = await q(`
    select b.*, coalesce((
      select json_agg(json_build_object('sku', i.sku, 'name', i.name, 'color', i.color,
                                        'modelSku', p.sku, 'brand', p.brand,
                                        'qty', i.qty, 'price', i.price))
        from backorder_items i ${ITEM_IDENTITY_JOIN}
       where i.backorder_id = b.id), '[]') as items
      from backorders b where b.customer_id=$1 order by b.created_at desc`, [req.user.id]);
  res.json({
    backorders: rows.map(b => ({
      id: b.id, number: b.number, orderNumber: b.order_number, status: b.status,
      reason: b.reason, eligible: b.eligible, createdAt: b.created_at, items: b.items,
      customerAuthorised: b.customer_authorised,
      // Its own stamped money, so the customer sees the currency it was struck
      // in rather than whatever the current viewer happens to be set to.
      currency: b.currency, fxRate: b.fx_rate,
    })),
  });
});

/* Retained for compatibility with any client that still calls it.

   A CUSTOMER action may only record the customer's own authorisation. It must
   never set `eligible`, which is the STAFF/STOCK gate — a customer confirming
   their own request cannot assert that stock exists. Conversion verifies full
   locked stock independently regardless of what is set here.

   It also no longer writes status='approved': the admin queue's actions and
   filter were built around 'open', so that state stranded the record. Leaving
   it 'open' keeps it processable. */
r.post('/backorders/:id/approve', async (req, res) => {
  const { rows } = await q(`
    update backorders set customer_authorised=true, status='open'
     where id=$1 and customer_id=$2 and status in ('open','approved')
     returning number, status, eligible, customer_authorised`,
    [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Backorder not found or already processed' });
  await afterCommit(`audit 'backorder confirmed' ${rows[0].number}`, () =>
    audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
      'backorder authorised by customer', rows[0].number,
      'customer authorisation only — stock eligibility remains with staff'));
  res.json({ ok: true, status: rows[0].status,
    customerAuthorised: rows[0].customer_authorised, eligible: rows[0].eligible });
});

r.post('/backorders/:id/cancel', async (req, res) => {
  const { rows } = await q(`
    update backorders set status='cancelled'
     where id=$1 and customer_id=$2 and status in ('open','approved') returning number`,
    [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Backorder not found' });
  await afterCommit(`audit 'backorder cancelled' ${rows[0].number}`, () =>
    audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
      'backorder cancelled', rows[0].number));
  res.json({ ok: true });
});

/* ---------- returns ---------- */

r.get('/returns', async (req, res) => {
  const { rows } = await q(`
    select rt.*, coalesce((
      select json_agg(json_build_object('sku', ri.sku, 'name', ri.name, 'qty', ri.qty,
                                        'price', ri.price, 'resolution', ri.resolution,
                                        'exchangeSku', ri.exchange_sku))
        from return_items ri where ri.return_id = rt.id), '[]') as items
      from returns rt where rt.customer_id=$1 order by rt.created_at desc`, [req.user.id]);
  res.json({
    returns: rows.map(x => ({
      id: x.id, number: x.number, orderNumber: x.order_number, status: x.status,
      notes: x.notes, createdAt: x.created_at, items: x.items,
    })),
  });
});

r.get('/returns/:id', async (req, res) => {
  const { rows } = await q(
    `select * from returns where id=$1 and customer_id=$2`, [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Return not found' });
  const { rows: items } = await q(`select * from return_items where return_id=$1`, [rows[0].id]);
  res.json({ return: { ...rows[0], items } });
});

r.post('/returns', async (req, res, next) => {
  try {
    const { orderNumber, items, notes } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items required' });
    }
    const created = await tx(async (c) => {
      const { rows: num } = await c.query(`select 'RT' || nextval('return_number_seq') as n`);
      const { rows: ret } = await c.query(`
        insert into returns (number, customer_id, order_number, status, notes)
        values ($1,$2,$3,'open',$4) returning *`,
        [num[0].n, req.user.id, orderNumber || null, String(notes || '')]);
      for (const it of items) {
        const { rows: v } = await c.query(`
          select v.sku, p.name, coalesce(v.sale_price, v.price, p.sale_price, p.price, 0) as price
            from variations v join products p on p.id=v.product_id where v.sku=$1`, [it.sku]);
        const resolution = ['credit', 'exchange'].includes(it.resolution) ? it.resolution : 'credit';
        await c.query(`
          insert into return_items (return_id, sku, name, qty, price, resolution, exchange_sku)
          values ($1,$2,$3,$4,$5,$6,$7)`,
          [ret[0].id, it.sku, v[0]?.name || it.name || '', Math.max(1, parseInt(it.qty, 10) || 1),
           it.price ?? v[0]?.price ?? 0, resolution,
           resolution === 'exchange' ? String(it.exchangeSku || '').slice(0, 40) || null : null]);
      }
      return ret[0];
    });
    // Committed: the return exists whether or not the audit row lands.
    await afterCommit(`audit 'return created' ${created.number}`, () =>
      audit({ id: req.user.id, name: req.user.business || req.user.email, role: req.user.role },
        'return created', created.number));
    res.json({ ok: true, return: { id: created.id, number: created.number } });
  } catch (e) { next(e); }
});

/* ---------- invoices ---------- */

r.get('/invoices', async (req, res) => {
  const { rows } = await q(
    `select * from invoices where customer_id=$1 order by issued_on desc`, [req.user.id]);
  res.json({
    invoices: rows.map(i => ({
      id: i.id, number: i.number, orderNumber: i.order_number, amount: i.amount,
      provider: i.provider, status: i.status, issuedOn: i.issued_on,
    })),
  });
});

r.get('/invoice/:id', async (req, res) => {
  const { rows } = await q(
    `select * from invoices where (id=$1 or number=$1) and customer_id=$2`,
    [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
  res.json({ invoice: rows[0] });
});

export default r;
