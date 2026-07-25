/* Inventory movements ledger — append-only helper.
   Every runtime stock write records one signed movement here so stock changes
   have a full, immutable audit trail (receipt / reservation / release /
   transfer / adjustment / write-off / sync). The table + its immutability
   triggers are created in migrate.js. */

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
  await c.query(
    `insert into inventory_movements
       (variation_id, sku, warehouse_id, qty_delta, balance_after, reason,
        ref_type, ref_id, actor_id, actor_name, actor_role, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [m.variationId || null, m.sku || '', m.warehouseId || null, delta, balanceAfter,
     m.reason || 'adjustment', m.refType || '', m.refId || '',
     a.id || null, a.name || 'System', a.role || 'system', m.note || '']);
}
