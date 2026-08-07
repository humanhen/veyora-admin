/* ================= Admin read/write model for orders and backorders =================

   Batch 1H. The admin panel used to read a SEEDED BROWSER DATASET (js/data.js,
   localStorage key veyora_db_v2, 1,096 generated orders + 11 named ones = the
   1,107 synthetic records seen in the release candidate, ending at SO11876).
   Everything staff saw on Orders, Backorders, the dashboard and the reports was
   invented in the browser, while PostgreSQL held the 1,128 real orders.

   This module is the data contract for the replacement. It is deliberately
   DEPENDENCY-FREE — no pg, no express — so the SQL text, the row mappers, the
   list bounds and the write whitelist can all be tested without a database.
   routes/admin.js supplies the client and the transaction. */
'use strict';

/* ------------------------------------------------------------------ *
 * Display names                                                       *
 * ------------------------------------------------------------------ */

/** The admin panel's own naming rule (DB.userName in js/data.js), applied on
    the SERVER so a list row never has to hold the whole users table to render
    a customer name. */
export function displayName(u) {
  if (!u) return '';
  const full = `${u.first_name || ''} ${u.last_name || ''}`.trim();
  return String(u.business || full || u.username || '').trim();
}

/* ------------------------------------------------------------------ *
 * SQL                                                                 *
 * ------------------------------------------------------------------ */

/* Brand + model number are reconstructed by joining each line back to its
   product. `modelSku` is the PRODUCT sku — never a slice of the variation sku,
   which is wrong for dash colorways like VEDETTE-2002. */
const ITEM_IDENTITY_JOIN = `
  left join variations v on v.sku = i.sku
  left join products  p on p.id = v.product_id`;

const ORDER_ITEMS_AGG = `
  coalesce((
    select json_agg(json_build_object(
      'sku', i.sku, 'name', i.name, 'color', i.color, 'qty', i.qty,
      'modelSku', p.sku, 'brand', p.brand,
      'collected', i.collected, 'price', i.price, 'note', i.note, 'labels', i.labels
    ) order by i.created_at)
    from order_items i ${ITEM_IDENTITY_JOIN}
   where i.order_id = o.id), '[]') as items`;

/* Customer and agent are joined once per order rather than shipped as a whole
   users table. `cust_*`/`agent_*` are flattened so the mapper needs no nesting. */
const ORDER_PARTY_JOIN = `
  left join users cu on cu.id = o.customer_id
  left join users au on au.id = o.agent_id`;

const ORDER_PARTY_COLS = `
  cu.business as cust_business, cu.first_name as cust_first, cu.last_name as cust_last,
  cu.username as cust_username, cu.email as cust_email,
  cu.customer_number as cust_number, cu.country as cust_country,
  au.business as agent_business, au.first_name as agent_first, au.last_name as agent_last,
  au.username as agent_username, au.email as agent_email`;

/** Newest first by real time. The admin sorts again client-side, but ordering
    here means a bounded read returns the newest orders, never an arbitrary
    slice. `order_date` breaks ties for rows imported with the same created_at. */
export const ADMIN_ORDERS_SQL = `
  select o.*, ${ORDER_PARTY_COLS}, ${ORDER_ITEMS_AGG}
    from orders o ${ORDER_PARTY_JOIN}
   order by o.created_at desc, o.order_date desc, o.number desc
   limit $1`;

export const ADMIN_ORDERS_COUNT_SQL = `select count(*)::int as n from orders`;

/** One order by id OR by business number, so #/order/SO11889 resolves too. */
export const ADMIN_ORDER_ONE_SQL = `
  select o.*, ${ORDER_PARTY_COLS}, ${ORDER_ITEMS_AGG}
    from orders o ${ORDER_PARTY_JOIN}
   where o.id = $1 or o.number = $1
   limit 1`;

/* convertedOrderNumber: the detail modal has always tried to show the order a
   backorder became, but the snapshot only ever carried converted_order_id, so
   the field read "—" on every converted record. Joined here. */
export const ADMIN_BACKORDERS_SQL = `
  select b.*,
         co.number as converted_order_number,
         cu.business as cust_business, cu.first_name as cust_first,
         cu.last_name as cust_last, cu.username as cust_username, cu.email as cust_email,
         au.business as agent_business, au.first_name as agent_first,
         au.last_name as agent_last, au.username as agent_username,
         coalesce((
           select json_agg(json_build_object(
             'sku', i.sku, 'name', i.name, 'color', i.color, 'qty', i.qty,
             'price', i.price, 'modelSku', p.sku, 'brand', p.brand
           ) order by i.id)
           from backorder_items i ${ITEM_IDENTITY_JOIN}
          where i.backorder_id = b.id), '[]') as items
    from backorders b
    left join orders co on co.id = b.converted_order_id
    left join users  cu on cu.id = b.customer_id
    left join users  au on au.id = b.agent_id
   order by b.created_at desc
   limit $1`;

export const ADMIN_BACKORDERS_COUNT_SQL = `select count(*)::int as n from backorders`;

/* ------------------------------------------------------------------ *
 * List bounds                                                         *
 * ------------------------------------------------------------------ */

/* The browser dataset had a hard ceiling of 1,107 because that is how many rows
   its generator produced. A real ceiling still has to exist — an unbounded
   query is a denial-of-service on a big enough table — but it must be a bound
   the caller can see, far above the live dataset, and reported honestly so the
   admin can say "showing N of M" instead of silently truncating. */
export const ORDER_LIST_MAX = 20000;
export const ORDER_LIST_DEFAULT = 20000;

export function resolveLimit(raw, { max = ORDER_LIST_MAX, fallback = ORDER_LIST_DEFAULT } = {}) {
  if (raw == null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Did the query see everything? `rows === limit` means it may have been cut. */
export function listCompleteness(returned, total, limit) {
  const t = Number.isFinite(total) ? total : returned;
  return { returned, total: t, complete: returned >= t && returned < limit + 1 && t <= limit };
}

/* ------------------------------------------------------------------ *
 * Row mappers                                                         *
 * ------------------------------------------------------------------ */

const numOrNull = v => (v == null ? null : Number(v));

/** orders row -> the shape the admin pages already read.
    Money stays in BASE USD exactly as stored; `currency` + `fxRate` travel with
    it so orderMoney() converts once at render (Batch 1G). Nothing is converted
    here — a converted amount reaching a converting renderer is the CA$91.97
    double-conversion bug. */
export function orderRowToJs(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    customerId: row.customer_id,
    customerName: displayName({
      business: row.cust_business, first_name: row.cust_first,
      last_name: row.cust_last, username: row.cust_username }),
    customerEmail: row.cust_email || '',
    customerNumber: row.cust_number || '',
    customerCountry: row.cust_country || '',
    agentId: row.agent_id,
    agentName: row.agent_id ? displayName({
      business: row.agent_business, first_name: row.agent_first,
      last_name: row.agent_last, username: row.agent_username }) : '',
    agentEmail: row.agent_email || '',
    source: row.source,
    status: row.status,
    date: row.order_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    currency: row.currency || 'USD',
    fxRate: numOrNull(row.fx_rate) ?? 1,
    discount: Number(row.discount) || 0,
    discountPct: Number(row.discount_pct) || 0,
    shipping: Number(row.shipping) || 0,
    freeShipping: !!row.free_shipping,
    total: Number(row.total) || 0,
    invoiceId: row.invoice_id || null,
    tracking: row.tracking || null,
    comments: row.comments || [],
    billingAddress: row.billing_address || null,
    shippingAddress: row.shipping_address || null,
    promo: row.promo || null,
    items: (row.items || []).map(i => ({
      sku: i.sku, name: i.name, color: i.color,
      qty: Number(i.qty) || 0, collected: Number(i.collected) || 0,
      price: Number(i.price) || 0, note: i.note || '', labels: i.labels || [],
      modelSku: i.modelSku || '', brand: i.brand || '',
    })),
  };
}

export function backorderRowToJs(row) {
  if (!row) return null;
  return {
    id: row.id,
    number: row.number,
    orderId: row.order_id,
    orderNumber: row.order_number,
    customerId: row.customer_id,
    customerName: displayName({
      business: row.cust_business, first_name: row.cust_first,
      last_name: row.cust_last, username: row.cust_username }),
    customerEmail: row.cust_email || '',
    agentId: row.agent_id,
    agentName: row.agent_id ? displayName({
      business: row.agent_business, first_name: row.agent_first,
      last_name: row.agent_last, username: row.agent_username }) : '',
    source: row.source || 'customer',
    status: row.status,
    reason: row.reason,
    eligible: !!row.eligible,
    customerAuthorised: !!row.customer_authorised,
    convertedOrderId: row.converted_order_id || null,
    convertedOrderNumber: row.converted_order_number || null,
    currency: row.currency || 'USD',
    fxRate: numOrNull(row.fx_rate) ?? 1,
    discount: Number(row.discount) || 0,
    shipping: Number(row.shipping) || 0,
    freeShipping: !!row.free_shipping,
    shippingAddress: row.shipping_address || null,
    billingAddress: row.billing_address || null,
    promo: row.promo || null,
    comments: row.comments || [],
    createdAt: row.created_at,
    items: (row.items || []).map(i => ({
      sku: i.sku, name: i.name, color: i.color,
      qty: Number(i.qty) || 0, price: Number(i.price) || 0,
      modelSku: i.modelSku || '', brand: i.brand || '',
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Server-managed collections — stale-client protection                *
 * ------------------------------------------------------------------ */

/* Orders and backorders are written ONLY by their dedicated endpoints. The
   generic row-diff sync must never touch them.

   This is not merely a client concern. Until Batch 1H the deploy-time admin
   overlay had both collections in its SYNCED list, so a browser tab that was
   already open — or one serving a cached copy of the old bundle — can still
   POST a whole snapshot of order and backorder state taken before the
   deployment. Accepting it would overwrite real PostgreSQL rows with a stale
   browser view, and its `deletes` list (every id the tab has not seen) would
   remove orders and backorders outright.

   So the server refuses the WHOLE request, before it opens a transaction and
   before it runs any query. A partial write would be worse than none: the
   caller would be told its order changes failed while its product changes had
   silently landed. */
export const SERVER_MANAGED_COLLECTIONS = ['orders', 'backorders'];

/* MONEY DOES NOT MOVE THROUGH A ROW DIFF (Final Handover, Phase 4).
 *
 * `invoices`, `payments` and `creditNotes` were in the generic sync path. That
 * meant a browser holding the whole dataset could create, edit or DELETE a
 * payment as an ordinary row — and could do it as a side effect of a stale tab
 * posting a snapshot taken before a real payment arrived, silently reversing
 * it. None of it produced a record naming the actor, the prior value, the new
 * value and the reason, because a row diff has no such concept.
 *
 * These three are now written ONLY by the governed finance routes
 * (src/routes/admin-finance.js), each of which is capability-gated,
 * transactional, idempotent and writes an append-only `finance_events` row.
 *
 * They remain READABLE in the snapshot: the finance screens still need the
 * data. What is refused is a WRITE arriving through the generic path.
 */
export const FINANCE_COLLECTIONS = ['invoices', 'payments', 'creditNotes'];

export const SERVER_MANAGED_SYNC_ERROR =
  'Orders and backorders are server-managed. Hard refresh the admin panel.';

export const FINANCE_SYNC_ERROR =
  'Invoices, payments and credit notes are recorded through the finance screens, '
  + 'not through a general save. Hard refresh the admin panel.';

/* Columns on an otherwise-syncable collection that money depends on.
 *
 * `users` is legitimately synced — names, addresses, terms, pricing mode. But
 * `balance` is the running total of what a customer owes, and it is derived
 * from invoices, payments and credit notes. A browser setting it directly is
 * not an edit, it is an assertion that the ledger is wrong, and it leaves no
 * trace of what it replaced.
 */
export const FINANCE_FIELDS = Object.freeze({ users: ['balance'] });

export const FINANCE_FIELD_SYNC_ERROR =
  'A customer balance is derived from invoices, payments and credit notes and '
  + 'cannot be set directly. Record the payment or credit note instead.';

/**
 * Inspect a complete /admin/sync payload before anything is written.
 *
 * The WHOLE request is refused, before a transaction is opened and before any
 * query runs. A partial write would be worse than none: the caller would be
 * told its payment changes failed while its product changes had silently
 * landed.
 *
 * @returns {{ok: true} | {ok: false, status: number, error: string, collections?: string[], fields?: string[]}}
 */
export function checkSyncPayload(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const offending = [];
  const finance = [];
  const financeFields = [];

  for (const ch of list) {
    const name = ch && ch.collection;
    if (SERVER_MANAGED_COLLECTIONS.includes(name) && !offending.includes(name)) {
      offending.push(name);
    }
    /* A finance collection is refused if the payload carries ANY write for it —
       an upsert or a delete. A `deletes` list is the dangerous half: it is
       "every id this tab has not seen", so an out-of-date browser would remove
       every payment recorded since it loaded. */
    if (FINANCE_COLLECTIONS.includes(name) && !finance.includes(name)) {
      const writes = (Array.isArray(ch.upserts) && ch.upserts.length)
        || (Array.isArray(ch.deletes) && ch.deletes.length);
      if (writes) finance.push(name);
    }
    const guardedFields = FINANCE_FIELDS[name];
    if (guardedFields) {
      for (const row of (Array.isArray(ch.upserts) ? ch.upserts : [])) {
        for (const field of guardedFields) {
          /* `hasOwnProperty`, not truthiness: sending `balance: 0` is exactly
             as much of a balance write as sending `balance: 5000`. */
          if (row && Object.prototype.hasOwnProperty.call(row, field)
            && !financeFields.includes(`${name}.${field}`)) {
            financeFields.push(`${name}.${field}`);
          }
        }
      }
    }
  }

  if (offending.length) {
    return { ok: false, status: 409, error: SERVER_MANAGED_SYNC_ERROR, collections: offending };
  }
  if (finance.length) {
    return { ok: false, status: 409, error: FINANCE_SYNC_ERROR, collections: finance };
  }
  if (financeFields.length) {
    return { ok: false, status: 409, error: FINANCE_FIELD_SYNC_ERROR, fields: financeFields };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Write whitelist                                                     *
 * ------------------------------------------------------------------ */

export const ORDER_STATUSES = ['pending', 'processing', 'approved', 'collecting',
  'collected', 'completed', 'shipped', 'cancelled'];

/* ---------------------------------------------------------------------------
   The order transition contract
   ---------------------------------------------------------------------------

   `sanitizeOrderPatch` checked that a status was one of the eight, and nothing
   checked it against the status the order already had. So `PATCH /admin/orders`
   would move an order anywhere: a cancelled order could be revived into
   processing, and a completed one sent back to pending as though nothing had
   happened. (`shipped` was already guarded separately, so the specific
   `pending → shipped → pending` example in the older handover notes has not
   been reachable for some time — the class of defect was real, that instance
   was not.)

   THIS IS NOT A NEW LIFECYCLE. It is the smallest closed contract that admits
   exactly the workflows already implemented, using only the existing statuses:

     - the warehouse flow the panel drives:
         pending → collecting → collected → completed → shipped
     - the free status dropdown staff use to correct a mis-set status;
     - the deliberate collection reset — `admin.js` clears collected counts
       when an order goes back to `pending`, which the panel relies on;
     - cancellation, from anywhere.

   THE WORKING SET is the five states before an order is finished. They are
   freely interchangeable on purpose: a status set in error must be correctable,
   and being stricter here would break the dropdown that operations use daily.

   COMPLETED is progress. It may still go forward to `shipped`, or be
   `cancelled`, but not back into the working set — "this order is finished"
   is not something a list screen should be able to quietly retract.

   TERMINAL states are `shipped` and `cancelled`. A shipped order has been
   dispatched and the customer told; a cancelled one must not silently revive.
   Neither has an exit here. Reversing one is a real commercial event that
   deserves a deliberate, audited action of its own — not a dropdown. */

const ORDER_WORKING_SET = Object.freeze(
  ['pending', 'processing', 'approved', 'collecting', 'collected']);

export const TERMINAL_ORDER_STATUSES = Object.freeze(['shipped', 'cancelled']);

export const ORDER_TRANSITIONS = Object.freeze({
  pending: Object.freeze([...ORDER_WORKING_SET, 'completed', 'shipped', 'cancelled']),
  processing: Object.freeze([...ORDER_WORKING_SET, 'completed', 'shipped', 'cancelled']),
  approved: Object.freeze([...ORDER_WORKING_SET, 'completed', 'shipped', 'cancelled']),
  collecting: Object.freeze([...ORDER_WORKING_SET, 'completed', 'shipped', 'cancelled']),
  collected: Object.freeze([...ORDER_WORKING_SET, 'completed', 'shipped', 'cancelled']),
  completed: Object.freeze(['completed', 'shipped', 'cancelled']),
  shipped: Object.freeze(['shipped']),
  cancelled: Object.freeze(['cancelled']),
});

/**
 * May an order move from `from` to `to`?
 *
 * Staying put is always allowed — a patch that sets the status it already has
 * is a no-op, not a violation, and refusing it would make an idempotent retry
 * an error.
 *
 * An UNKNOWN current status is refused rather than allowed. A row in a state
 * this build does not recognise is not one it should be moving.
 */
export function canTransitionOrder(from, to) {
  const current = String(from ?? '').toLowerCase();
  const next = String(to ?? '').toLowerCase();
  if (!ORDER_STATUSES.includes(next)) return false;
  if (current === next) return true;
  const allowed = ORDER_TRANSITIONS[current];
  return Array.isArray(allowed) && allowed.includes(next);
}

/** The sentence a refused transition gets. Says what is possible, not just no. */
export function transitionRefusal(from, to) {
  const current = String(from ?? '').toLowerCase();
  if (TERMINAL_ORDER_STATUSES.includes(current)) {
    return current === 'shipped'
      ? 'That order has already shipped'
      : 'That order was cancelled and cannot be reopened from here.';
  }
  if (current === 'completed') {
    return 'That order is completed. It can still be shipped or cancelled, but not '
      + 'returned to an earlier stage from here.';
  }
  return `An order cannot move from ${current || 'an unknown state'} to ${String(to ?? '')}.`;
}

export const TRACKING_CARRIERS = ['UPS', 'DHL', 'GLS'];

/* Keys a caller might send that this endpoint must NEVER apply. Item lines,
   prices, quantities and the total move STOCK or MONEY and belong to the
   ordering/allocation path, not to a general-purpose order patch; identity
   fields would silently re-point an order at another account. Sending one is
   a hard 400 rather than a quiet drop, so a mistaken client cannot believe it
   succeeded. */
export const FORBIDDEN_ORDER_PATCH_KEYS = ['items', 'total', 'price', 'qty',
  'customerId', 'agentId', 'number', 'currency', 'fxRate', 'invoiceId', 'id',
  'source', 'promo', 'shipping', 'freeShipping'];

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

/** Exactly the admin panel's DB.orderTotal, computed on the SERVER from the
    stored lines. The client never supplies a total. */
export function recomputeOrderTotal(items, discount, discountPct) {
  const t = (items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  let disc = Number(discount) || 0;
  if (discountPct) disc += t * (Number(discountPct) || 0) / 100;
  return Math.max(0, round2(t - disc));
}

/**
 * Validate an order patch. Returns { ok, error, fields, comment, collected }.
 * `fields` holds only column values that were actually supplied — an absent key
 * leaves the stored value untouched.
 */
export function sanitizeOrderPatch(body, { actorName = 'System' } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  for (const k of FORBIDDEN_ORDER_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(b, k)) {
      return { ok: false, error: `'${k}' cannot be changed through this endpoint` };
    }
  }
  const fields = {};
  let comment = null;
  let collected = null;

  if (Object.prototype.hasOwnProperty.call(b, 'status')) {
    const s = String(b.status || '').toLowerCase();
    if (!ORDER_STATUSES.includes(s)) return { ok: false, error: `Unknown status '${b.status}'` };
    fields.status = s;
  }

  if (Object.prototype.hasOwnProperty.call(b, 'tracking')) {
    if (b.tracking === null) {
      fields.tracking = null;
    } else {
      const t = b.tracking || {};
      const company = String(t.company || '').toUpperCase();
      const number = String(t.number || '').trim();
      if (!TRACKING_CARRIERS.includes(company)) {
        return { ok: false, error: `Unknown carrier '${t.company}'` };
      }
      if (!number) return { ok: false, error: 'A tracking number is required' };
      if (number.length > 60) return { ok: false, error: 'Tracking number is too long' };
      fields.tracking = { company, number };
    }
  }

  if (Object.prototype.hasOwnProperty.call(b, 'discount')) {
    const v = Number(b.discount);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: 'Discount must be zero or more' };
    fields.discount = round2(v);
    fields.discount_pct = 0;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'discountPct')) {
    const v = Number(b.discountPct);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return { ok: false, error: 'Percentage discount must be between 0 and 100' };
    }
    fields.discount_pct = round2(v);
    fields.discount = 0;
  }

  if (Object.prototype.hasOwnProperty.call(b, 'comment')) {
    const text = String(b.comment || '').trim();
    if (!text) return { ok: false, error: 'A comment cannot be empty' };
    if (text.length > 2000) return { ok: false, error: 'Comment is too long' };
    comment = { by: String(actorName || 'System'), text, at: new Date().toISOString() };
  }

  if (Object.prototype.hasOwnProperty.call(b, 'collected')) {
    if (!Array.isArray(b.collected)) return { ok: false, error: 'collected must be a list' };
    collected = [];
    for (const c of b.collected) {
      const sku = String(c?.sku || '').trim();
      const n = parseInt(c?.collected, 10);
      if (!sku) return { ok: false, error: 'A collected entry is missing its SKU' };
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, error: `Collected count for ${sku} must be zero or more` };
      }
      collected.push({ sku, collected: n });
    }
  }

  if (!Object.keys(fields).length && !comment && !collected) {
    return { ok: false, error: 'Nothing to change' };
  }
  return { ok: true, fields, comment, collected };
}

/* ------------------------------------------------------------------ *
 * Financial authority                                                 *
 * ------------------------------------------------------------------ */

/* The admin router admits both `admin` and `warehouse` so the warehouse can do
   its job: read orders, record collection counts, move an order through the
   permitted statuses, enter tracking, leave operational comments and act on
   backorders. Money is different. Discounts change what a customer owes and an
   invoice moves their balance, so both are admin-only — enforced HERE, not by
   a hidden button. A disabled control is a UI convenience; anyone can issue the
   request without it. */
export const FINANCIAL_ROLES = ['admin'];

export function isFinancialActor(user) {
  return !!user && FINANCIAL_ROLES.includes(user.role);
}

/** Does this validated patch change money? */
export function patchTouchesMoney(patch) {
  const f = (patch && patch.fields) || {};
  return Object.prototype.hasOwnProperty.call(f, 'discount')
      || Object.prototype.hasOwnProperty.call(f, 'discount_pct');
}

/** Human summary for the audit trail — one line, no secrets. */
export function describeOrderPatch(patch) {
  const bits = [];
  if (patch.fields.status) bits.push(`status → ${patch.fields.status}`);
  if (patch.fields.tracking) {
    bits.push(`tracking ${patch.fields.tracking.company} ${patch.fields.tracking.number}`);
  } else if (Object.prototype.hasOwnProperty.call(patch.fields, 'tracking')) {
    bits.push('tracking cleared');
  }
  if (patch.fields.discount) bits.push(`discount ${patch.fields.discount} USD`);
  if (patch.fields.discount_pct) bits.push(`discount ${patch.fields.discount_pct}%`);
  if (patch.comment) bits.push('comment posted');
  if (patch.collected) bits.push(`collection updated (${patch.collected.length} line(s))`);
  return bits.join(', ') || 'no change';
}

/** UPDATE fragment for the whitelisted fields. Only ever emits known columns. */
export function orderUpdateSql(fields, firstParam = 2) {
  const sets = [];
  const values = [];
  let i = firstParam;
  if (Object.prototype.hasOwnProperty.call(fields, 'status')) {
    sets.push(`status = $${i++}`); values.push(fields.status);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'tracking')) {
    sets.push(`tracking = $${i++}`);
    values.push(fields.tracking ? JSON.stringify(fields.tracking) : null);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'discount')) {
    sets.push(`discount = $${i++}`); values.push(fields.discount);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'discount_pct')) {
    sets.push(`discount_pct = $${i++}`); values.push(fields.discount_pct);
  }
  return { sets, values, nextParam: i };
}
