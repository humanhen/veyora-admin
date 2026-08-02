/* Who is an order actually for?

   A salesperson may build a cart and place an order on behalf of one of their
   customers. Cart preview and order placement must agree exactly on which
   customer that is and whether the actor is allowed to act for them, so the
   rule lives here once and both call it.

   The server is authoritative: the storefront's "acting for" banner is a
   convenience, and every request that carries a customerId is re-checked here.
   Mirrors the list-scoping rule in routes/agent.js (scopeClause).

   Deliberately imports no database module — the query function is passed in —
   so the authorisation rule can be tested on its own. */

/** Roles that may place an order on somebody else's behalf. */
export const ON_BEHALF_ROLES = ['agent', 'super-agent', 'admin'];
/** Roles that may be ordered FOR. */
export const ORDERABLE_ROLES = ['customer', 'special customer'];
/** Roles that reach any customer rather than only their own book. */
const UNSCOPED_ROLES = ['admin', 'super-agent'];

function deny(status, error) {
  return Object.assign(new Error(error), { status, expose: true });
}

/** May this role act for somebody else at all? */
export function canActOnBehalf(role) {
  return ON_BEHALF_ROLES.includes(role);
}

/**
 * Resolve the customer an order/preview is for.
 *
 * @param user        the authenticated actor (req.user)
 * @param requestedId raw customerId from the request (may be empty/undefined)
 * @param runQuery    the parameterised query function, normally db.q
 * @returns { customer, onBehalf } — `customer` is `user` itself when not acting
 *          on behalf of anyone.
 * @throws  a tagged error ({status, expose}) when the actor may not do this.
 */
export async function resolveOrderingCustomer(user, requestedId, runQuery) {
  const id = String(requestedId || '').trim();
  if (!id || id === user.id) return { customer: user, onBehalf: false };

  // An ordinary customer can never order as somebody else, whatever they post.
  if (!canActOnBehalf(user.role)) {
    throw deny(403, 'You cannot place an order for another account');
  }

  // Admin and super-agent reach any customer; an agent only their own.
  const { rows } = UNSCOPED_ROLES.includes(user.role)
    ? await runQuery(`select * from users where id=$1 and role = any($2)`, [id, ORDERABLE_ROLES])
    : await runQuery(`select * from users where id=$1 and agent_id=$2 and role = any($3)`,
        [id, user.id, ORDERABLE_ROLES]);

  if (!rows.length) throw deny(403, 'Not your customer');
  if (rows[0].status !== 'active') throw deny(400, 'That customer account is not active');

  return { customer: rows[0], onBehalf: true };
}

/**
 * The customer id a request is asking to act for, wherever it carries it.
 * Pure — no lookup, no authorisation; resolveOrderingCustomer decides.
 */
export function requestedCustomerId(req) {
  return req?.query?.forCustomer
      ?? req?.body?.forCustomer
      ?? req?.body?.customerId
      ?? null;
}

/**
 * The identity every priced response must be computed with.
 *
 * Assisted order  -> the TARGET CUSTOMER, with hide_prices forced off so the
 *                    salesperson can actually read the customer's prices.
 * Normal browsing -> the signed-in user, untouched.
 *
 * Catalogue, cart, promotions and checkout all call this, so they cannot
 * disagree about eligibility, price, promotion or currency.
 *
 * @param req      express request (query.forCustomer / body.customerId)
 * @param runQuery parameterised query function, normally db.q
 */
export async function pricingIdentity(req, runQuery) {
  const { customer, onBehalf } =
    await resolveOrderingCustomer(req.user, requestedCustomerId(req), runQuery);
  return {
    identity: onBehalf ? { ...customer, hide_prices: false } : req.user,
    customer,
    onBehalf,
  };
}

/** Overall checkout note: bounded so a paste can never blow up a row. */
export const ORDER_NOTE_MAX = 2000;

/** Whitespace control characters a pasted note may legitimately contain. */
const KEEP_CONTROL = ['\t', '\n', '\r'];

/**
 * Normalise the free-text order note: trim, drop the control characters a paste
 * can carry (keeping tab/newline/CR), and cap the length. It is stored and
 * rendered as TEXT — every surface escapes it — so no markup stripping is
 * attempted here; that would only give a false sense of sanitisation.
 *
 * Uses the \p{Cc} Unicode class rather than a literal character range: a range
 * written with real control bytes makes this source file binary to git, which
 * breaks plain-text diffs and review.
 */
export function sanitizeOrderNote(raw) {
  return String(raw ?? '')
    .replace(/\p{Cc}/gu, c => (KEEP_CONTROL.includes(c) ? c : ''))
    .trim()
    .slice(0, ORDER_NOTE_MAX);
}

/* ---------- customer-created backorder state ----------

   A customer who deliberately orders an unavailable quantity has ALREADY
   authorised that backorder, so there must be no second customer-approval step.
   The record is handed straight to staff as eligible.

   Why status stays 'open' rather than 'approved': the admin backorder queue
   (js/pages_sales.js) only renders its actions for an open record, and its
   status filter historically offered open/converted/cancelled only. A row
   written as 'approved' was therefore invisible to the filter AND had no
   available action — stranded.

   Why eligible is FALSE (corrected in Batch 1B): customer authorisation and
   stock eligibility are different facts.
     customer_authorised = the customer asked for it knowing it was unavailable
     eligible            = staff/stock have cleared it for conversion
   Batch 1A set eligible=true on the customer's say-so, which asserted that
   stock was available the moment the backorder was created — nobody had
   checked. The customer's intent is now recorded in its own column, and
   conversion is gated on real, locked stock by the server.

   Nothing here promises automatic fulfilment: no processor ships a backorder
   on its own, so the wording everywhere says "recorded for staff processing". */
export const CUSTOMER_BACKORDER = Object.freeze({
  status: 'open',
  /** Staff/stock gate — NOT the customer's authorisation. */
  eligible: false,
  /** The customer's own authorisation, recorded separately. */
  customerAuthorised: true,
  /** Distinct from the collection screen's 'out_of_stock' so staff can tell
      customer-created records from ones raised during warehouse collection. */
  reason: 'customer backorder',
});

/* The order context a backorder must carry. A fully backordered checkout
   creates no orders row, so these ARE the record — without them a later
   conversion could not say who placed it, in what currency, at what rate, to
   which address, under which promotion, or what the customer asked for. */
export const BACKORDER_CONTEXT_FIELDS = Object.freeze([
  'customer_id', 'agent_id', 'source', 'currency', 'fx_rate',
  'shipping_address', 'billing_address', 'promo',
  'discount', 'free_shipping', 'shipping', 'comments',
  'customer_authorised', 'created_at',
]);

/**
 * Rebuild the order fields for a backorder being converted, from the context
 * the backorder preserved. Pure — the caller does the inserting.
 *
 * This is what replaced the browser's version, which invented agentId=null,
 * source='customer' and freeShipping=true regardless of how the request was
 * actually placed.
 *
 * @param bo    the backorders row
 * @param items its backorder_items rows (locked prices)
 */
export function orderFieldsFromBackorder(bo, items) {
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const subtotal = round2((items || []).reduce(
    (s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0));
  const discount = Math.min(Number(bo.discount) || 0, subtotal);
  const shipping = Number(bo.shipping) || 0;
  return {
    customerId: bo.customer_id,
    agentId: bo.agent_id ?? null,
    source: bo.source || 'customer',
    currency: bo.currency || 'USD',
    fxRate: Number(bo.fx_rate) || 1,
    shippingAddress: bo.shipping_address ?? null,
    billingAddress: bo.billing_address ?? null,
    promo: bo.promo ?? null,
    discount,
    freeShipping: bo.free_shipping === true,
    shipping,
    comments: bo.comments || [],
    subtotal,
    total: round2(subtotal - discount + shipping),
  };
}

/* ---------- checkout submission lock ----------

   place-order prices the cart BEFORE opening its transaction, so two
   near-simultaneous POSTs could both read the same cart and both go on to
   create an order and reserve stock. The browser's disabled button is not
   server protection — a double-click, a retried request or a second tab
   defeats it.

   Locking the actor's cart rows at the TOP of the transaction serialises
   checkout per cart owner: the second request blocks here, then sees zero rows
   because the first deleted the cart inside its own transaction.

   `skip locked` is deliberately NOT used — the second request must WAIT and
   then observe the empty cart, not sail past and duplicate the order. The
   stable `order by id` keeps the lock order deterministic between concurrent
   checkouts. */
export const CART_SUBMISSION_LOCK_SQL =
  `select id, sku, qty, note, labels from cart_items
     where user_id = $1 order by id for update`;

/**
 * Take the per-cart-owner checkout lock.
 * @param c           pg client inside the checkout transaction
 * @param cartOwnerId the ACTOR — the cart belongs to them even on an assisted
 *                    order, where only the pricing belongs to the customer
 * @returns the locked cart rows (empty when an earlier submission consumed them)
 */
export async function lockCartForSubmission(c, cartOwnerId) {
  const { rows } = await c.query(CART_SUBMISSION_LOCK_SQL, [cartOwnerId]);
  return rows;
}

/* ---------- submit exactly the cart that was priced ----------

   The cart is priced OUTSIDE the transaction, so between pricing and the lock
   the customer (or another tab) can change it. Checking only that the priced
   SKUs still exist was not enough: an old quantity could be submitted, a newly
   added line could be silently dropped and then deleted with the rest of the
   cart, and a changed note or label set could be lost.

   The whole priced snapshot is now compared with the whole locked snapshot, and
   ANY difference fails the checkout closed. */

function normalizeLabels(labels) {
  if (labels == null) return [];
  let arr = labels;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return [String(labels)]; }
  }
  if (!Array.isArray(arr)) return [];
  // Order is NOT normalised away: reordering a row's labels is a change to a
  // row that was not the row we priced, and fail-closed is the rule here.
  return arr.map(x => String(x));
}

/** One cart row reduced to the fields a submission must match on. */
export function normalizeCartRow(row = {}) {
  return {
    id: row.id == null ? null : String(row.id),
    sku: String(row.sku ?? ''),
    qty: Math.trunc(Number(row.qty) || 0),
    note: String(row.note ?? ''),
    labels: normalizeLabels(row.labels),
  };
}

const cartRowKey = r => (r.id ? `id:${r.id}` : `sku:${r.sku}`);
const sameLabels = (a, b) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Does the locked cart still equal the cart that was priced?
 *
 * Pure. Row ORDER is irrelevant (rows are keyed, not positional); everything
 * else — membership, sku, qty, note, labels — must match exactly.
 *
 * @returns { match, changes: [{type, key, sku, field?, from?, to?}] }
 */
export function compareCartSnapshots(priced, locked) {
  const p = new Map((priced || []).map(normalizeCartRow).map(r => [cartRowKey(r), r]));
  const l = new Map((locked || []).map(normalizeCartRow).map(r => [cartRowKey(r), r]));
  const changes = [];

  for (const [key, before] of p) {
    const after = l.get(key);
    if (!after) { changes.push({ type: 'removed', key, sku: before.sku }); continue; }
    if (before.sku !== after.sku) {
      changes.push({ type: 'changed', key, sku: after.sku, field: 'sku',
        from: before.sku, to: after.sku });
    }
    if (before.qty !== after.qty) {
      changes.push({ type: 'changed', key, sku: after.sku, field: 'qty',
        from: before.qty, to: after.qty });
    }
    if (before.note !== after.note) {
      changes.push({ type: 'changed', key, sku: after.sku, field: 'note' });
    }
    if (!sameLabels(before.labels, after.labels)) {
      changes.push({ type: 'changed', key, sku: after.sku, field: 'labels' });
    }
  }
  for (const [key, after] of l) {
    if (!p.has(key)) changes.push({ type: 'added', key, sku: after.sku });
  }
  return { match: changes.length === 0, changes };
}

/**
 * Deterministic SKU order for taking stock locks.
 *
 * Two checkouts holding the same SKUs in opposite cart order could otherwise
 * each hold the row the other wants and deadlock. Locking in one agreed order
 * for every checkout removes the cycle. Returns a COPY — the caller's array
 * and any client-supplied ordering are left untouched.
 */
export function orderLinesForLocking(lines) {
  return [...(lines || [])].sort((a, b) => {
    const x = String(a?.sku ?? ''), y = String(b?.sku ?? '');
    // plain code-point compare: locale rules must not make the order vary
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/* ---------- backorder state machine ---------- */

/** States from which a backorder can still be converted. */
export const PROCESSABLE_BACKORDER_STATUSES = Object.freeze(['open', 'approved']);
/** States that are final — a stale client payload must never move them back. */
export const TERMINAL_BACKORDER_STATUSES = Object.freeze(['converted', 'cancelled']);

export function isTerminalBackorderStatus(status) {
  return TERMINAL_BACKORDER_STATUSES.includes(status);
}

/**
 * Is this backorder commercially authorised for staff to convert?
 *
 * Deliberately NOT "is there stock" — conversion always verifies full locked
 * stock independently. This answers only "may staff act on it at all":
 *   - it came from a real order (already commercially authorised), or
 *   - the customer authorised it by ordering an unavailable quantity, or
 *   - it is a legacy 'approved' row from the old customer-approve flow, which
 *     must stay recoverable rather than stranded.
 */
export function isBackorderProcessable(bo) {
  if (!bo || !PROCESSABLE_BACKORDER_STATUSES.includes(bo.status)) return false;
  return Boolean(bo.order_id) || bo.customer_authorised === true || bo.status === 'approved';
}

/**
 * Decide what a generic admin-sync payload is allowed to write over a stored
 * backorder row.
 *
 * The admin panel holds the whole dataset in the browser and pushes row diffs.
 * A delayed save can therefore carry a snapshot taken BEFORE the transactional
 * conversion endpoint ran, and the generic upsert would happily write `open`
 * over `converted` and blank the converted_order_id. Terminal state is
 * server-owned; only the conversion endpoint may set it.
 *
 * @param stored   the current DB row (null when inserting)
 * @param incoming the client's version
 * @returns { status, eligible, convertedOrderId, itemsWritable, regressed[] }
 */
/* The LOCKING read that makes reconcile-then-write atomic.

   Without FOR UPDATE the pair straddles a window: sync reads `open`, the
   conversion endpoint locks the row and converts it, sync then wakes at its own
   UPDATE and writes the decision it made from the stale read — putting `open`
   back over `converted` and erasing the order link. With the lock, this read
   blocks behind any in-flight conversion, so the state reconciled is the state
   written. Lives here, beside the rule it protects and free of any DB import,
   so the guard can be asserted in tests. */
export const BACKORDER_LOCK_SQL =
  `select status, eligible, converted_order_id from backorders where id=$1 for update`;

export function reconcileBackorderSync(stored, incoming = {}) {
  const regressed = [];

  if (!stored) {
    /* A brand-new row may never arrive already converted. Only the conversion
       endpoint creates that state, and it does so against a row it has locked;
       a sync that could insert one would fabricate a conversion with no order,
       no reservation and no inventory movements behind it. */
    let status = incoming.status || 'open';
    if (status === 'converted') {
      regressed.push('insert as converted (only the convert endpoint may do that)');
      status = 'open';
    }
    if (incoming.convertedOrderId) {
      regressed.push('insert with converted_order_id');
    }
    return {
      status,
      eligible: !!incoming.eligible,
      convertedOrderId: null,          // never created by a sync
      itemsWritable: true,
      deletable: true,
      regressed,
    };
  }

  let status = incoming.status || stored.status;
  if (isTerminalBackorderStatus(stored.status) && status !== stored.status) {
    regressed.push(`status ${stored.status} -> ${status}`);
    status = stored.status;                       // terminal state wins
  }
  /* A live record may not be driven to 'converted' by a sync either: that
     state means "an order exists and stock was reserved for it", which only the
     transactional endpoint can make true. */
  if (!isTerminalBackorderStatus(stored.status) && status === 'converted') {
    regressed.push('sync attempted to mark a live backorder converted');
    status = stored.status;
  }

  /* converted_order_id is a hard link to a real order. A sync may PRESERVE one
     that already exists; it may never create, replace or erase one. */
  let convertedOrderId = stored.converted_order_id ?? null;
  const incomingLink = incoming.convertedOrderId ?? null;
  if (stored.converted_order_id) {
    if (incomingLink && incomingLink !== stored.converted_order_id) {
      regressed.push('converted_order_id overwrite');
    } else if (!incomingLink && 'convertedOrderId' in incoming) {
      regressed.push('converted_order_id erase');
    }
  } else if (incomingLink) {
    regressed.push('converted_order_id introduced by sync');
  }

  // Eligibility on a converted record is meaningless and must not be toggled
  // back by a stale snapshot.
  let eligible = incoming.eligible === undefined ? stored.eligible : !!incoming.eligible;
  if (stored.status === 'converted' && eligible !== stored.eligible) {
    regressed.push('eligible toggle after conversion');
    eligible = stored.eligible;
  }

  return {
    status, eligible, convertedOrderId,
    // Items of a converted backorder are the record of what became an order.
    itemsWritable: stored.status !== 'converted',
    deletable: canDeleteBackorder(stored),
    regressed,
  };
}

/**
 * May a generic sync DELETE this backorder?
 *
 * No, once it is terminal or linked to an order: deleting a converted record
 * would orphan a real order and erase the audit trail of the stock that was
 * reserved for it; deleting a cancelled one would erase the decision. Live
 * open/approved records keep the repository's existing delete behaviour.
 */
/* Locks every requested delete candidate BEFORE any of them is judged.
   Deliberately carries NO state predicate: filtering to already-terminal rows
   in the locking SELECT leaves an `open` row unlocked, so a conversion can slip
   in between the check and the delete. `order by id` keeps the lock order
   deterministic against other transactions taking the same rows. */
export const BACKORDER_DELETE_CANDIDATES_SQL =
  `select id, number, status, converted_order_id from backorders
     where id = any($1) order by id for update`;

export function canDeleteBackorder(stored) {
  if (!stored) return true;                       // nothing to protect
  if (isTerminalBackorderStatus(stored.status)) return false;
  if (stored.converted_order_id) return false;
  return true;
}

/** The minimum a storefront needs to show "Ordering for: X". No PII beyond it. */
export function orderingContextShape(customer) {
  return {
    id: customer.id,
    business: customer.business,
    customerNumber: customer.customer_number,
  };
}
