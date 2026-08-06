/* Narrow warehouse inventory operations (Security Hardening Phase 3).
 *
 * WHY THIS EXISTS
 *
 * Finding SEC-002: the `warehouse` role reached `POST /admin/sync`, the
 * whole-database row-sync, and only `users` was gated. Every other collection
 * — promotions, invoices, payments, credit notes, shipping rules, settings
 * (which carries the FX rates) and the audit log — was writable by a
 * fulfilment login.
 *
 * The sharpest case was not on that list. Receiving stock went through the
 * `products` collection, and `upsertProduct` writes `price` and `sale_price`
 * on both the product and every variation. **The same request that received a
 * delivery could re-price the entire catalogue**, with no separation between
 * the two and nothing in the payload to distinguish them.
 *
 * THE INDUSTRY-STANDARD ANSWER
 *
 * Warehouse staff get workflow-specific operations, not a database editor.
 * This router is those operations: adjust a quantity, transfer between
 * warehouses. Each one:
 *
 *   - names exactly the fields it accepts and rejects everything else;
 *   - takes the actor from the authenticated session, never the body;
 *   - runs in a transaction;
 *   - records an inventory movement, so the ledger stays complete;
 *   - touches no price, no product identity, no commercial field at all.
 *
 * There is deliberately no route here that can create or delete a product,
 * change a price, or alter anything a customer is billed for.
 */

import { Router } from 'express';
import { pool, tx as realTx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { recordMovement } from '../inventory.js';

export class InventoryApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

/** Roles permitted to move stock. Fulfilment work is exactly what `warehouse`
 *  exists for, so both roles are admitted here — unlike the generic sync,
 *  which `warehouse` no longer reaches at all. */
export const STOCK_ROLES = Object.freeze(['admin', 'warehouse']);

/** Why a quantity changed. A closed set, because "reason" is the only field
 *  that explains a movement after the fact and free text makes the ledger
 *  unreadable. Mirrors the vocabulary already used by inventory.js. */
export const ADJUST_REASONS = Object.freeze([
  'receipt',        // a delivery arrived
  'count',          // stock count correction
  'damage',         // written off
  'return',         // customer return back to shelf
  'correction',     // fixing a previous mistake
]);

const MAX_NOTE = 500;
const MAX_ABS_DELTA = 100_000;

/* ---------------------------------------------------------------------------
   Validation — explicit request schemas
   --------------------------------------------------------------------------- */

function cleanNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const cleaned = value.normalize('NFC').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_NOTE ? null : cleaned;
}

/** Rejects any field the operation does not define, rather than ignoring it.
 *  A silently dropped field is a caller believing something happened. */
function assertNoUnknownFields(body, allowed, label) {
  const unknown = Object.keys(body || {}).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new InventoryApiError(400, {
      error: `${label}: unexpected field(s): ${unknown.sort().join(', ')}`,
      code: 'UNKNOWN_FIELD',
    });
  }
}

export function parseAdjustment(body) {
  const ALLOWED = ['sku', 'warehouseId', 'delta', 'reason', 'note'];
  assertNoUnknownFields(body, ALLOWED, 'adjustment');

  const sku = String(body?.sku ?? '').trim();
  if (!sku) throw new InventoryApiError(400, { error: 'A variation SKU is required.', code: 'INVALID' });

  const warehouseId = String(body?.warehouseId ?? '').trim();
  if (!warehouseId) throw new InventoryApiError(400, { error: 'A warehouse is required.', code: 'INVALID' });

  /* Strictly a number, not a numeric string. `Number('5')` is 5, so a lenient
     check would accept `"5"`, `" 5 "` and `"5e0"` — and a client sending a
     string here has a real misunderstanding worth surfacing rather than
     papering over. An explicit request schema means explicit types. */
  const delta = body?.delta;
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) {
    throw new InventoryApiError(400, { error: 'delta must be a non-zero whole number.', code: 'INVALID' });
  }
  if (Math.abs(delta) > MAX_ABS_DELTA) {
    throw new InventoryApiError(400, { error: 'delta is implausibly large.', code: 'INVALID' });
  }

  const reason = String(body?.reason ?? '').trim();
  if (!ADJUST_REASONS.includes(reason)) {
    throw new InventoryApiError(400, {
      error: 'Unknown reason.', code: 'INVALID_REASON', allowed: [...ADJUST_REASONS],
    });
  }

  const note = cleanNote(body?.note);
  if (note === null) {
    throw new InventoryApiError(400, { error: `A note must be text of ${MAX_NOTE} characters or fewer.`, code: 'INVALID' });
  }

  return { sku, warehouseId, delta, reason, note };
}

export function parseTransfer(body) {
  const ALLOWED = ['sku', 'fromWarehouseId', 'toWarehouseId', 'qty', 'note'];
  assertNoUnknownFields(body, ALLOWED, 'transfer');

  const sku = String(body?.sku ?? '').trim();
  if (!sku) throw new InventoryApiError(400, { error: 'A variation SKU is required.', code: 'INVALID' });

  const fromWarehouseId = String(body?.fromWarehouseId ?? '').trim();
  const toWarehouseId = String(body?.toWarehouseId ?? '').trim();
  if (!fromWarehouseId || !toWarehouseId) {
    throw new InventoryApiError(400, { error: 'Both warehouses are required.', code: 'INVALID' });
  }
  if (fromWarehouseId === toWarehouseId) {
    throw new InventoryApiError(400, { error: 'A transfer needs two different warehouses.', code: 'INVALID' });
  }

  const qty = body?.qty;
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0 || qty > MAX_ABS_DELTA) {
    throw new InventoryApiError(400, { error: 'qty must be a positive whole number.', code: 'INVALID' });
  }

  const note = cleanNote(body?.note);
  if (note === null) {
    throw new InventoryApiError(400, { error: `A note must be text of ${MAX_NOTE} characters or fewer.`, code: 'INVALID' });
  }

  return { sku, fromWarehouseId, toWarehouseId, qty, note };
}

/* ---------------------------------------------------------------------------
   Serializer — explicit, never a spread row
   --------------------------------------------------------------------------- */

export function serializeStockLine(row) {
  return {
    sku: row.sku,
    warehouseId: row.warehouse_id,
    qty: Number(row.qty) || 0,
  };
}

/* ---------------------------------------------------------------------------
   Operations
   --------------------------------------------------------------------------- */

async function loadVariation(c, sku) {
  const { rows } = await c.query(
    `select id, sku from variations where sku = $1 limit 1`, [sku]);
  if (!rows[0]) throw new InventoryApiError(404, { error: 'Unknown SKU.', code: 'NOT_FOUND' });
  return rows[0];
}

async function assertWarehouse(c, id) {
  const { rows } = await c.query(`select id from warehouses where id = $1 limit 1`, [id]);
  if (!rows[0]) throw new InventoryApiError(404, { error: 'Unknown warehouse.', code: 'NOT_FOUND' });
}

/**
 * Applies one quantity change and records the movement.
 *
 * @param actor the AUTHENTICATED user. Attribution comes only from here.
 */
export async function adjustStock(db, input, actor) {
  const { sku, warehouseId, delta, reason, note } = parseAdjustment(input);

  const result = await db.tx(async (c) => {
    const variation = await loadVariation(c, sku);
    await assertWarehouse(c, warehouseId);

    /* Locked for the transaction so two concurrent adjustments cannot both
       read the same prior balance and write conflicting results. */
    const { rows: existing } = await c.query(
      `select qty from stock where variation_id = $1 and warehouse_id = $2 for update`,
      [variation.id, warehouseId]);
    const before = existing[0] ? Number(existing[0].qty) : 0;
    const after = before + delta;

    /* Stock cannot go negative. A correction that would take it below zero is
       a mistake worth stopping, not a number worth storing. */
    if (after < 0) {
      throw new InventoryApiError(409, {
        error: `That would take ${sku} at this warehouse to ${after}. Stock cannot go negative.`,
        code: 'NEGATIVE_STOCK',
        available: before,
      });
    }

    await c.query(
      `insert into stock (variation_id, warehouse_id, qty)
       values ($1, $2, $3)
       on conflict (variation_id, warehouse_id) do update set qty = excluded.qty`,
      [variation.id, warehouseId, after]);

    await recordMovement(c, {
      variation_id: variation.id,
      sku,
      warehouse_id: warehouseId,
      delta,
      balanceAfter: after,
      reason,
      ref_type: 'adjustment',
      ref_id: '',
      actor: { id: actor?.id, name: actor?.email || actor?.business, role: actor?.role },
      note,
    });

    return { sku, warehouse_id: warehouseId, qty: after, before, delta };
  });

  await audit(
    { id: actor?.id, name: actor?.email || actor?.business, role: actor?.role },
    'inventory.adjust',
    `sku:${sku}@${warehouseId}`,
    `${result.before} -> ${result.qty} (${delta > 0 ? '+' : ''}${delta}, ${reason})`
  ).catch(() => {});

  return serializeStockLine(result);
}

/** Moves stock between two warehouses atomically. Two movements, one
 *  transaction — a transfer that half-applied would be worse than one that
 *  failed. */
export async function transferStock(db, input, actor) {
  const { sku, fromWarehouseId, toWarehouseId, qty, note } = parseTransfer(input);

  const result = await db.tx(async (c) => {
    const variation = await loadVariation(c, sku);
    await assertWarehouse(c, fromWarehouseId);
    await assertWarehouse(c, toWarehouseId);

    /* Locked in a stable order so two transfers moving stock in opposite
       directions between the same pair cannot deadlock. */
    const ids = [fromWarehouseId, toWarehouseId].sort();
    const { rows: locked } = await c.query(
      `select warehouse_id, qty from stock
        where variation_id = $1 and warehouse_id = any($2) order by warehouse_id for update`,
      [variation.id, ids]);
    const balances = new Map(locked.map((r) => [r.warehouse_id, Number(r.qty)]));

    const fromBefore = balances.get(fromWarehouseId) ?? 0;
    if (fromBefore < qty) {
      throw new InventoryApiError(409, {
        error: `Only ${fromBefore} of ${sku} at the source warehouse.`,
        code: 'INSUFFICIENT_STOCK',
        available: fromBefore,
      });
    }
    const toBefore = balances.get(toWarehouseId) ?? 0;

    for (const [warehouseId, after, delta] of [
      [fromWarehouseId, fromBefore - qty, -qty],
      [toWarehouseId, toBefore + qty, qty],
    ]) {
      await c.query(
        `insert into stock (variation_id, warehouse_id, qty)
         values ($1, $2, $3)
         on conflict (variation_id, warehouse_id) do update set qty = excluded.qty`,
        [variation.id, warehouseId, after]);
      await recordMovement(c, {
        variation_id: variation.id,
        sku,
        warehouse_id: warehouseId,
        delta,
        balanceAfter: after,
        reason: 'transfer',
        ref_type: 'transfer',
        ref_id: '',
        actor: { id: actor?.id, name: actor?.email || actor?.business, role: actor?.role },
        note,
      });
    }

    return { from: fromBefore - qty, to: toBefore + qty };
  });

  await audit(
    { id: actor?.id, name: actor?.email || actor?.business, role: actor?.role },
    'inventory.transfer',
    `sku:${sku}`,
    `${qty} from ${fromWarehouseId} to ${toWarehouseId}`
  ).catch(() => {});

  return {
    sku,
    from: { warehouseId: fromWarehouseId, qty: result.from },
    to: { warehouseId: toWarehouseId, qty: result.to },
  };
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();
r.use(requireAuth(...STOCK_ROLES));

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof InventoryApiError) return res.status(err.status).json(err.body);
      next(err);
    });
}

r.post('/adjust', (req, res, next) =>
  send(res, next, adjustStock(liveDb, req.body, req.user), (stock) => ({ stock })));

r.post('/transfer', (req, res, next) =>
  send(res, next, transferStock(liveDb, req.body, req.user), (transfer) => ({ transfer })));

/* No route creates or deletes a product, changes a price, or alters anything
   a customer is billed for. That is the whole point of this router existing. */

export default r;
