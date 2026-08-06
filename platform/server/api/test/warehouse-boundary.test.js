/* The warehouse authorisation boundary (Security Hardening Phase 3).

   Finding SEC-002: the `warehouse` role could write 17 of 18 collections
   through the whole-database sync endpoint, including the one that carries
   prices.

   Real handlers against a controlled database double. No live database. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import inventoryRouter, {
  ADJUST_REASONS,
  InventoryApiError,
  STOCK_ROLES,
  adjustStock,
  parseAdjustment,
  parseTransfer,
  transferStock,
} from '../src/routes/admin-inventory.js';
import { SIMPLE_COLLECTIONS } from '../src/shape.js';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const WAREHOUSE = { id: 'u_wh', role: 'warehouse', email: 'wh@example.test' };
const ADMIN = { id: 'u_admin', role: 'admin', email: 'admin@example.test' };

/** Fake db with a stock table and a movement ledger. */
function makeDb({ stock = [], variations = [{ id: 'v1', sku: 'SKU-1' }], warehouses = ['wh_main', 'wh_reserve'] } = {}) {
  const statements = [];
  let rows = stock.map((s) => ({ ...s }));
  const movements = [];
  let rolledBack = false;

  async function query(sql, params = []) {
    statements.push({ sql, params });

    if (/from variations where sku/i.test(sql)) {
      const v = variations.find((x) => x.sku === params[0]);
      return { rows: v ? [{ ...v }] : [] };
    }
    if (/from warehouses where id/i.test(sql)) {
      return { rows: warehouses.includes(params[0]) ? [{ id: params[0] }] : [] };
    }
    if (/from stock where variation_id = \$1 and warehouse_id = \$2/i.test(sql)) {
      const row = rows.find((r) => r.variation_id === params[0] && r.warehouse_id === params[1]);
      return { rows: row ? [{ qty: row.qty }] : [] };
    }
    if (/from stock\s+where variation_id = \$1 and warehouse_id = any/i.test(sql)) {
      const list = rows.filter((r) => r.variation_id === params[0] && params[1].includes(r.warehouse_id));
      return { rows: list.map((r) => ({ warehouse_id: r.warehouse_id, qty: r.qty })) };
    }
    if (/^\s*insert into stock/i.test(sql)) {
      const [variationId, warehouseId, qty] = params;
      const row = rows.find((r) => r.variation_id === variationId && r.warehouse_id === warehouseId);
      if (row) row.qty = qty; else rows.push({ variation_id: variationId, warehouse_id: warehouseId, qty });
      return { rows: [] };
    }
    if (/^\s*insert into inventory_movements/i.test(sql)) {
      movements.push(params);
      return { rows: [] };
    }
    if (/^\s*insert into audit_log/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }

  return {
    statements, movements,
    get rows() { return rows; },
    get rolledBack() { return rolledBack; },
    query,
    async tx(fn) {
      const snapshot = rows.map((r) => ({ ...r }));
      try {
        return await fn({ query });
      } catch (err) {
        rows = snapshot;
        rolledBack = true;
        throw err;
      }
    },
    qtyAt: (warehouseId) => (rows.find((r) => r.warehouse_id === warehouseId)?.qty ?? 0),
  };
}

async function rejects(promise) {
  try { await promise; return null; } catch (err) { return err; }
}

// ---------------------------------------------------------------------------
// 1-8 — the generic sync no longer admits warehouse
// ---------------------------------------------------------------------------

test('1 — the generic sync refuses every non-admin caller', () => {
  const admin = code('routes/admin.js');
  const sync = admin.slice(admin.indexOf("r.post('/sync'"));
  assert.match(sync, /req\.user\.role !== 'admin'/);
  assert.match(sync, /ADMIN_ONLY/);
  /* The gate must run BEFORE the transaction opens, so a refused payload
     writes nothing at all. */
  assert.ok(sync.indexOf('ADMIN_ONLY') < sync.indexOf('await tx('),
    'the role gate must precede the transaction');
});

test('2 — warehouse can no longer write ANY administrative collection', () => {
  /* Previously exactly one collection (`users`) was gated. The check is now
     on the endpoint, so every collection is covered by construction — this
     enumerates them so a regression naming a specific collection is visible. */
  const admin = code('routes/admin.js');
  const sync = admin.slice(admin.indexOf("r.post('/sync'"));
  const gateAt = sync.indexOf("req.user.role !== 'admin'");
  assert.ok(gateAt > -1);
  for (const collection of Object.keys(SIMPLE_COLLECTIONS)) {
    const at = sync.indexOf(`'${collection}'`);
    if (at > -1) {
      assert.ok(gateAt < at, `the role gate must precede any handling of '${collection}'`);
    }
  }
});

test('3 — the collections a warehouse login could previously rewrite are named', () => {
  /* Regression guard on the finding itself: these are commercial or evidential
     and must never be reachable by a fulfilment role. */
  for (const collection of ['promotions', 'invoices', 'payments', 'creditNotes',
                            'shippingRules', 'freeShipping', 'users']) {
    assert.ok(collection in SIMPLE_COLLECTIONS, `${collection} should still exist as a collection`);
  }
  /* `audit` was on this list too. Phase 4 removed it from the syncable set
     entirely rather than merely gating it — see SEC-015. */
  assert.ok(!('audit' in SIMPLE_COLLECTIONS),
    'the audit log must not be a syncable collection');
  const sync = code('routes/admin.js');
  assert.match(sync, /restricted to administrators/);
});

test('4 — the per-collection users check is still there as defence in depth', () => {
  assert.match(code('routes/admin.js'), /name === 'users' && req\.user\.role !== 'admin'/);
});

test('5 — settings, which carries the FX rates, is behind the same gate', () => {
  const admin = code('routes/admin.js');
  const sync = admin.slice(admin.indexOf("r.post('/sync'"));
  assert.ok(sync.indexOf("req.user.role !== 'admin'") < sync.indexOf("name === 'settings'"));
});

test('6 — the refusal names where warehouse work should go instead', () => {
  assert.match(code('routes/admin.js'), /\/admin\/inventory/);
});

test('7 — the whole payload is refused, never partially applied', () => {
  const admin = code('routes/admin.js');
  const start = admin.indexOf("r.post('/sync'");
  const sync = admin.slice(start);
  const gateAt = sync.indexOf("req.user.role !== 'admin'");
  const txAt = sync.indexOf('await tx(');
  assert.ok(gateAt > -1 && txAt > -1);
  assert.ok(gateAt < txAt, 'the refusal must happen before the transaction opens');
  assert.match(sync.slice(gateAt, txAt), /return res\.status\(403\)/);
});

test('8 — the inventory router is mounted before the general admin router', () => {
  const index = code('index.js');
  const inventory = index.indexOf("app.use('/admin/inventory'");
  const general = index.indexOf("app.use('/admin', adminRoutes)");
  assert.ok(inventory > -1 && general > -1);
  assert.ok(inventory < general, 'the narrow router must not be shadowed by the general one');
});

// ---------------------------------------------------------------------------
// 9-16 — the narrow warehouse operations work
// ---------------------------------------------------------------------------

test('9 — warehouse and admin may both move stock', () => {
  assert.deepEqual([...STOCK_ROLES].sort(), ['admin', 'warehouse']);
  assert.match(code('routes/admin-inventory.js'), /requireAuth\(\.\.\.STOCK_ROLES\)/);
});

test('10 — a receipt increases stock and records a movement', async () => {
  const db = makeDb({ stock: [{ variation_id: 'v1', warehouse_id: 'wh_main', qty: 5 }] });
  const result = await adjustStock(db, {
    sku: 'SKU-1', warehouseId: 'wh_main', delta: 12, reason: 'receipt', note: 'PO 4471',
  }, WAREHOUSE);
  assert.deepEqual(result, { sku: 'SKU-1', warehouseId: 'wh_main', qty: 17 });
  assert.equal(db.qtyAt('wh_main'), 17);
  assert.equal(db.movements.length, 1, 'every quantity change must reach the ledger');
});

test('11 — a negative adjustment is allowed down to zero and refused below it', async () => {
  const db = makeDb({ stock: [{ variation_id: 'v1', warehouse_id: 'wh_main', qty: 3 }] });
  await adjustStock(db, { sku: 'SKU-1', warehouseId: 'wh_main', delta: -3, reason: 'damage' }, WAREHOUSE);
  assert.equal(db.qtyAt('wh_main'), 0);

  const err = await rejects(adjustStock(db, {
    sku: 'SKU-1', warehouseId: 'wh_main', delta: -1, reason: 'damage',
  }, WAREHOUSE));
  assert.equal(err.status, 409);
  assert.equal(err.body.code, 'NEGATIVE_STOCK');
  assert.equal(db.qtyAt('wh_main'), 0, 'the refused adjustment must not apply');
});

test('12 — a transfer moves stock atomically and records both movements', async () => {
  const db = makeDb({ stock: [{ variation_id: 'v1', warehouse_id: 'wh_main', qty: 10 }] });
  const result = await transferStock(db, {
    sku: 'SKU-1', fromWarehouseId: 'wh_main', toWarehouseId: 'wh_reserve', qty: 4,
  }, WAREHOUSE);
  assert.equal(result.from.qty, 6);
  assert.equal(result.to.qty, 4);
  assert.equal(db.movements.length, 2, 'a transfer is two ledger movements');
});

test('13 — a transfer with insufficient stock fails and rolls back', async () => {
  const db = makeDb({ stock: [{ variation_id: 'v1', warehouse_id: 'wh_main', qty: 2 }] });
  const err = await rejects(transferStock(db, {
    sku: 'SKU-1', fromWarehouseId: 'wh_main', toWarehouseId: 'wh_reserve', qty: 5,
  }, WAREHOUSE));
  assert.equal(err.status, 409);
  assert.equal(err.body.code, 'INSUFFICIENT_STOCK');
  assert.ok(db.rolledBack);
  assert.equal(db.qtyAt('wh_main'), 2);
  assert.equal(db.qtyAt('wh_reserve'), 0);
});

test('14 — an unknown SKU or warehouse is a 404', async () => {
  const db = makeDb();
  const badSku = await rejects(adjustStock(db, {
    sku: 'NOPE', warehouseId: 'wh_main', delta: 1, reason: 'receipt' }, WAREHOUSE));
  assert.equal(badSku.status, 404);
  const badWh = await rejects(adjustStock(db, {
    sku: 'SKU-1', warehouseId: 'wh_nowhere', delta: 1, reason: 'receipt' }, WAREHOUSE));
  assert.equal(badWh.status, 404);
});

test('15 — stock rows are locked for the transaction', async () => {
  const db = makeDb({ stock: [{ variation_id: 'v1', warehouse_id: 'wh_main', qty: 5 }] });
  await adjustStock(db, { sku: 'SKU-1', warehouseId: 'wh_main', delta: 1, reason: 'count' }, WAREHOUSE);
  assert.ok(db.statements.some((s) => /for update/i.test(s.sql)),
    'a concurrent adjustment must not read the same prior balance');
});

test('16 — a transfer locks both warehouses in a stable order', () => {
  /* Two transfers moving stock in opposite directions between the same pair
     must not deadlock. */
  assert.match(code('routes/admin-inventory.js'), /\.sort\(\)/);
  assert.match(code('routes/admin-inventory.js'), /order by warehouse_id for update/);
});

// ---------------------------------------------------------------------------
// 17-24 — the narrow routes cannot become a back door
// ---------------------------------------------------------------------------

test('17 — no inventory route can touch a price or any commercial field', () => {
  const src = code('routes/admin-inventory.js');
  /* Money-specific terms. `balances` is deliberately not on this list: it is a
     Map of STOCK quantities per warehouse inside transferStock, and banning
     the substring would ban the word for its ordinary inventory meaning. */
  for (const forbidden of [/\bprice\b/, /sale_price/, /salePrice/, /\bdiscount\b/, /\binvoice\b/i,
                           /\bpayment\b/i, /users\.balance/, /\bpromotion\b/i, /payment_terms/]) {
    assert.ok(!forbidden.test(src), `the inventory router must not touch ${forbidden}`);
  }
  /* It writes exactly ONE table directly — `stock`. The ledger entry goes
     through inventory.js's recordMovement(), the established writer, rather
     than a second hand-rolled INSERT that could drift from it. */
  const writes = [...src.matchAll(/insert into (\w+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(writes)].sort(), ['stock']);
  assert.match(src, /recordMovement\(c, \{/, 'the ledger must go through the shared writer');
});

test('18 — no inventory route can create, rename or delete a product', () => {
  const src = code('routes/admin-inventory.js');
  assert.ok(!/insert into products/i.test(src));
  assert.ok(!/update products/i.test(src));
  assert.ok(!/delete from/i.test(src), 'nothing here deletes anything');
  assert.ok(!/insert into variations/i.test(src));
});

test('19 — the actor comes from the session and can never be forged', () => {
  const src = code('routes/admin-inventory.js');
  assert.match(src, /adjustStock\(liveDb, req\.body, req\.user\)/);
  assert.match(src, /transferStock\(liveDb, req\.body, req\.user\)/);
  assert.ok(!/req\.body\.actor/.test(src));
  assert.ok(!/body\??\.\s*role/.test(src));
});

test('20 — an unexpected field is rejected, not ignored', () => {
  for (const body of [
    { sku: 'SKU-1', warehouseId: 'wh_main', delta: 1, reason: 'receipt', price: 9.99 },
    { sku: 'SKU-1', warehouseId: 'wh_main', delta: 1, reason: 'receipt', role: 'admin' },
  ]) {
    const err = (() => { try { parseAdjustment(body); return null; } catch (e) { return e; } })();
    assert.ok(err instanceof InventoryApiError, 'an unknown field must be refused');
    assert.equal(err.body.code, 'UNKNOWN_FIELD');
  }
});

test('21 — the reason is a closed allowlist', () => {
  assert.deepEqual([...ADJUST_REASONS].sort(),
    ['correction', 'count', 'damage', 'receipt', 'return']);
  const err = (() => {
    try { parseAdjustment({ sku: 'S', warehouseId: 'w', delta: 1, reason: 'because' }); return null; }
    catch (e) { return e; }
  })();
  assert.equal(err.body.code, 'INVALID_REASON');
});

test('22 — quantities are validated', () => {
  const bad = [
    { delta: 0 }, { delta: 1.5 }, { delta: '5' }, { delta: 1e9 }, { delta: NaN },
  ];
  for (const over of bad) {
    assert.throws(
      () => parseAdjustment({ sku: 'S', warehouseId: 'w', reason: 'count', ...over }),
      InventoryApiError, `delta ${over.delta} must be rejected`);
  }
  assert.throws(() => parseTransfer({ sku: 'S', fromWarehouseId: 'a', toWarehouseId: 'a', qty: 1 }),
    /two different warehouses/);
  assert.throws(() => parseTransfer({ sku: 'S', fromWarehouseId: 'a', toWarehouseId: 'b', qty: -1 }),
    InventoryApiError);
});

test('23 — the serializer is a fixed object literal, never a spread row', () => {
  const src = code('routes/admin-inventory.js');
  assert.match(src, /export function serializeStockLine/);
  assert.ok(!/\.\.\.row/.test(src), 'a database row must never be spread into a response');
});

test('24 — the router exposes exactly the two intended routes', () => {
  const routes = [...code('routes/admin-inventory.js').matchAll(/r\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(routes.sort(), ['POST /adjust', 'POST /transfer']);
  assert.equal(typeof inventoryRouter, 'function');
});

// ---------------------------------------------------------------------------
// 25-27 — existing admin behaviour is unchanged
// ---------------------------------------------------------------------------

test('25 — order fulfilment stays available to warehouse through its own route', () => {
  /* PATCH /admin/orders/:id already existed and is how a warehouse login sets
     status, tracking, comments and collection counts. Nothing in this phase
     narrows it. */
  const admin = code('routes/admin.js');
  assert.match(admin, /r\.patch\('\/orders\/:id'/);
  assert.match(admin, /requireAuth\('admin', 'warehouse'\)/);
});

test('26 — order money was ALREADY admin-only, and still is', () => {
  /* Verified rather than changed: `patchTouchesMoney` + `isFinancialActor`
     predate this phase and correctly stop a warehouse login altering a
     discount. Recorded so the check is not mistaken for a gap. */
  const admin = code('routes/admin.js');
  assert.match(admin, /patchTouchesMoney\(patch\) && !isFinancialActor\(req\.user\)/);
  assert.match(admin, /Only an admin can change an order discount/);
});

test('27 — administrators keep full sync access', () => {
  const admin = code('routes/admin.js');
  const sync = admin.slice(admin.indexOf("r.post('/sync'"));
  /* The gate is a role check on non-admins only; an admin falls straight
     through to the existing behaviour. */
  assert.match(sync, /if \(req\.user\.role !== 'admin'\)/);
  assert.ok(!/req\.user\.role === 'admin'.*return res\.status\(403\)/s.test(sync));
});
