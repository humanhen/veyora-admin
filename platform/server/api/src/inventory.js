/* Inventory movements ledger — append-only helper.
   Every runtime stock write records one signed movement here so stock changes
   have a full, immutable audit trail (receipt / reservation / release /
   transfer / adjustment / write-off / sync). The table + its immutability
   triggers are created in migrate.js. */

/**
 * Decide how much of `need` each stock pile covers, in the order given.
 *
 * Pure: takes no client and writes nothing, so the order-splitting rule that
 * decides what ships and what backorders can be reasoned about (and tested)
 * on its own. The caller applies `takes` to the locked stock rows.
 *
 * @param need  units requested for one variation
 * @param piles [{ variation_id, warehouse_id, qty }] already ordered by
 *              preference (main warehouse first, then largest pile)
 * @returns { takes: [{...pile, take}], allocated, backordered }
 *          allocated + backordered always equals `need`.
 */
export function planAllocation(need, piles) {
  const takes = [];
  let remaining = Math.max(0, Math.trunc(Number(need) || 0));
  const requested = remaining;
  for (const pile of piles || []) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, Math.trunc(Number(pile.qty) || 0)));
    if (take > 0) {
      takes.push({ ...pile, take });
      remaining -= take;
    }
  }
  return { takes, allocated: requested - remaining, backordered: remaining };
}

/**
 * Can every line be covered in full from the stock currently on hand?
 *
 * Pure. Used by backorder conversion, which for this release is all-or-nothing:
 * partial conversion is out of scope, so an under-covered request must be
 * rejected cleanly rather than quietly creating an under-reserved order.
 *
 * @param lines     [{ sku, qty, ... }] what the backorder asks for
 * @param availableBySku Map|object of sku -> units available right now
 * @returns { covered, shortages: [{ sku, requested, available, short }] }
 */
export function planConversion(lines, availableBySku) {
  const get = sku => {
    const v = availableBySku instanceof Map
      ? availableBySku.get(sku) : availableBySku?.[sku];
    return Math.max(0, Math.trunc(Number(v) || 0));
  };
  const shortages = [];
  // AGGREGATE per SKU. A backorder may list the same SKU on more than one line
  // (merged requests, separate notes); comparing each line against the full
  // availability would pass two 6-unit lines against 10 units in stock.
  for (const [sku, demand] of aggregateBySku(lines)) {
    const available = get(sku);
    if (available < demand.qty) {
      const first = demand.lines[0] || {};
      shortages.push({
        sku, name: first.name ?? null, color: first.color ?? null,
        requested: demand.qty, available, short: demand.qty - available,
        lineCount: demand.lines.length,
      });
    }
  }
  return { covered: shortages.length === 0, shortages };
}

/**
 * Total demand per SKU across all lines.
 * @returns Map sku -> { sku, qty, lines: [...] }
 */
export function aggregateBySku(lines) {
  const bySku = new Map();
  for (const line of lines || []) {
    const qty = Math.max(0, Math.trunc(Number(line.qty) || 0));
    const cur = bySku.get(line.sku);
    if (cur) { cur.qty += qty; cur.lines.push(line); }
    else bySku.set(line.sku, { sku: line.sku, qty, lines: [line] });
  }
  return bySku;
}

/**
 * Reservation plan for a whole backorder: ONE pass per SKU over its piles, so
 * the same pile can never be handed to two lines.
 *
 * @param lines      backorder items (a SKU may repeat)
 * @param pilesBySku Map sku -> [{variation_id, warehouse_id, qty}] in draw order
 * @returns { covered, shortages, takes: [{sku, variation_id, warehouse_id, take}] }
 */
export function planSkuReservations(lines, pilesBySku) {
  const piles = pilesBySku instanceof Map ? pilesBySku : new Map();
  const availableBySku = new Map();
  for (const [sku, list] of piles) {
    availableBySku.set(sku, (list || []).reduce(
      (s, p) => s + Math.max(0, Math.trunc(Number(p.qty) || 0)), 0));
  }
  const { covered, shortages } = planConversion(lines, availableBySku);
  if (!covered) return { covered, shortages, takes: [] };

  const takes = [];
  for (const [sku, demand] of aggregateBySku(lines)) {
    // One walk for the SKU's TOTAL requirement, not one walk per line.
    const plan = planAllocation(demand.qty, piles.get(sku) || []);
    if (plan.backordered > 0) {
      // Unreachable after the coverage check; never reserve a partial set.
      return { covered: false, takes: [], shortages: [{
        sku, requested: demand.qty,
        available: demand.qty - plan.backordered, short: plan.backordered }] };
    }
    for (const t of plan.takes) takes.push({ sku, ...t });
  }
  return { covered: true, shortages: [], takes };
}

/** The guarded stock decrement. `qty >= $1` is the last line of defence: even
    if the plan were wrong, the row simply does not update and stock can never
    go negative. Exported so the guard itself can be asserted in tests. */
export const RESERVE_STOCK_SQL =
  `update stock set qty = qty - $1
     where variation_id = $2 and warehouse_id = $3 and qty >= $1
     returning qty`;

/**
 * Apply a reservation plan inside a transaction, guarded.
 *
 * Every decrement carries `qty >= $1`. An update that touches NO row means the
 * pile moved under us despite the row lock, so we throw a tagged 409 and the
 * caller's transaction rolls back — nothing is half-reserved.
 *
 * @param c     pg client inside a transaction
 * @param takes output of planSkuReservations().takes
 * @returns moves ready for recordMovement()
 * @throws  {status:409, expose:true, shortages:[...]} on a guard failure
 */
export async function reserveTakes(c, takes) {
  const moves = [];
  for (const t of takes || []) {
    const { rows } = await c.query(RESERVE_STOCK_SQL,
      [t.take, t.variation_id, t.warehouse_id]);
    if (!rows.length) {
      throw Object.assign(
        new Error('Stock changed while reserving; nothing was changed.'),
        { status: 409, expose: true, shortages: [{
          sku: t.sku, requested: t.take, available: null, short: t.take,
          warehouseId: t.warehouse_id }] });
    }
    moves.push({ variationId: t.variation_id, sku: t.sku,
      warehouseId: t.warehouse_id, delta: -t.take, balanceAfter: rows[0].qty });
  }
  return moves;
}

/**
 * Append one movement row. Call with the transaction client `c` that performs
 * the stock write, so the movement commits atomically with it.
 *
 * @param c pg client (inside a tx)
 * @param m {
 *   variationId, sku, warehouseId,
 *   delta,          signed int (+receipt / -shipment); zero-delta is ignored
 *   balanceAfter,   resulting qty in that warehouse (optional but recommended)
 *   reason,         e.g. 'order_reservation','order_release','stock_edit','zoho_sync'
 *   refType, refId, what caused it, e.g. ('order','SO11884')
 *   actor: {id,name,role},
 *   note
 * }
 */
export async function recordMovement(c, m) {
  const delta = Math.trunc(Number(m.delta) || 0);
  if (!delta) return; // no-op stock writes don't belong in the ledger
  const a = m.actor || {};
  const balanceAfter = m.balanceAfter == null ? null : Math.trunc(Number(m.balanceAfter));
  /* An idempotency key, when the caller supplies one (Final Handover Phase 7).
     `on conflict do nothing` means a duplicated adjustment writes no second
     ledger row — which matters more here than almost anywhere, because this
     table is append-only and a duplicate could never be corrected, only
     offset. Nullable and partial-indexed: the ordering and sync paths pass
     none and must not start colliding with one another.

     Returns whether a row was actually written, so a caller can tell a fresh
     movement from a refused replay. */
  const { rows } = await c.query(
    `insert into inventory_movements
       (variation_id, sku, warehouse_id, qty_delta, balance_after, reason,
        ref_type, ref_id, actor_id, actor_name, actor_role, note, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (idempotency_key) where idempotency_key is not null do nothing
     returning id`,
    [m.variationId || null, m.sku || '', m.warehouseId || null, delta, balanceAfter,
     m.reason || 'adjustment', m.refType || '', m.refId || '',
     a.id || null, a.name || 'System', a.role || 'system', m.note || '',
     m.idempotencyKey || null]);
  return { recorded: rows.length > 0 };
}
