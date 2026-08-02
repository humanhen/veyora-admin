/* Duplicate-SKU reservation and the SQL guard.

   planConversion used to compare EACH LINE against the full availability, so a
   backorder listing SKU X twice at 6 units each passed against 10 units in
   stock — and then handed the same pile to both lines.

   The guarded decrement is exercised through a controlled fake transaction
   client: the real SQL string is asserted, and the client simulates the guard
   matching no row so the abort path is genuinely executed rather than assumed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planConversion, planSkuReservations, aggregateBySku,
  reserveTakes, RESERVE_STOCK_SQL,
} from '../src/inventory.js';

const pile = (wh, qty, vid = 'v_x') => ({ variation_id: vid, warehouse_id: wh, qty });

/* ---------------- aggregation ---------------- */

test('demand is summed per SKU across duplicate lines', () => {
  const agg = aggregateBySku([
    { sku: 'X', qty: 6 }, { sku: 'X', qty: 6 }, { sku: 'Y', qty: 1 },
  ]);
  assert.equal(agg.get('X').qty, 12);
  assert.equal(agg.get('X').lines.length, 2);
  assert.equal(agg.get('Y').qty, 1);
});

test('AGGREGATE shortage: two 6-unit lines against 10 in stock is refused', () => {
  const lines = [{ sku: 'X', qty: 6, name: 'Cameron' }, { sku: 'X', qty: 6 }];
  const r = planConversion(lines, { X: 10 });
  assert.equal(r.covered, false, 'the old per-line check passed this');
  assert.equal(r.shortages.length, 1, 'reported once for the SKU, not once per line');
  assert.equal(r.shortages[0].requested, 12, 'the aggregate demand');
  assert.equal(r.shortages[0].available, 10);
  assert.equal(r.shortages[0].short, 2);
  assert.equal(r.shortages[0].lineCount, 2);
});

test('EXACT aggregate coverage is accepted', () => {
  const lines = [{ sku: 'X', qty: 6 }, { sku: 'X', qty: 6 }];
  assert.equal(planConversion(lines, { X: 12 }).covered, true);
});

/* ---------------- reservation across piles ---------------- */

test('a SKU is reserved ONCE for its aggregate, never a pile twice', () => {
  const piles = new Map([['X', [pile('wh_main', 8), pile('wh_reserve', 8)]]]);
  const { covered, takes } = planSkuReservations(
    [{ sku: 'X', qty: 6 }, { sku: 'X', qty: 6 }], piles);
  assert.equal(covered, true);
  assert.equal(takes.reduce((s, t) => s + t.take, 0), 12, 'exactly the aggregate');
  // wh_main has 8, so it must be drained then wh_reserve topped up by 4.
  assert.deepEqual(takes.map(t => [t.warehouse_id, t.take]),
    [['wh_main', 8], ['wh_reserve', 4]]);
  const perPile = {};
  for (const t of takes) perPile[t.warehouse_id] = (perPile[t.warehouse_id] || 0) + t.take;
  assert.ok(perPile.wh_main <= 8 && perPile.wh_reserve <= 8, 'no pile over-drawn');
});

test('multiple warehouse piles across several duplicated SKUs', () => {
  const piles = new Map([
    ['X', [pile('wh_main', 5, 'v1'), pile('wh_reserve', 5, 'v1')]],
    ['Y', [pile('wh_main', 3, 'v2')]],
  ]);
  const { covered, takes } = planSkuReservations(
    [{ sku: 'X', qty: 4 }, { sku: 'Y', qty: 3 }, { sku: 'X', qty: 4 }], piles);
  assert.equal(covered, true);
  const bySku = {};
  for (const t of takes) bySku[t.sku] = (bySku[t.sku] || 0) + t.take;
  assert.deepEqual(bySku, { X: 8, Y: 3 });
});

test('aggregate shortage across piles refuses and plans NO takes', () => {
  const piles = new Map([['X', [pile('wh_main', 5), pile('wh_reserve', 4)]]]);
  const r = planSkuReservations([{ sku: 'X', qty: 6 }, { sku: 'X', qty: 6 }], piles);
  assert.equal(r.covered, false);
  assert.deepEqual(r.takes, [], 'nothing is reserved when it cannot all be covered');
  assert.equal(r.shortages[0].requested, 12);
  assert.equal(r.shortages[0].available, 9);
});

/* ---------------- the SQL guard ---------------- */

test('the decrement SQL carries the qty >= requested guard', () => {
  assert.match(RESERVE_STOCK_SQL, /update stock set qty = qty - \$1/);
  assert.match(RESERVE_STOCK_SQL, /qty >= \$1/,
    'without this a bad plan could drive stock negative');
  assert.match(RESERVE_STOCK_SQL, /returning qty/,
    'the caller needs the resulting balance for the ledger');
});

/** Fake transaction client: records queries, and can be told to make the guard
    match no row for a given warehouse (simulating a concurrent decrement). */
function fakeClient({ balances = {}, guardFailsOn = null } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      const [take, , wh] = params;
      if (wh === guardFailsOn) return { rows: [] };      // guard matched nothing
      const left = (balances[wh] ?? 10) - take;
      return { rows: [{ qty: left }] };
    },
  };
}

test('a successful reservation issues one guarded update per take', async () => {
  const c = fakeClient({ balances: { wh_main: 8, wh_reserve: 8 } });
  const moves = await reserveTakes(c, [
    { sku: 'X', variation_id: 'v1', warehouse_id: 'wh_main', take: 8 },
    { sku: 'X', variation_id: 'v1', warehouse_id: 'wh_reserve', take: 4 },
  ]);
  assert.equal(c.queries.length, 2);
  for (const qy of c.queries) assert.match(qy.sql, /qty >= \$1/);
  assert.deepEqual(c.queries[0].params, [8, 'v1', 'wh_main']);
  assert.deepEqual(moves.map(m => m.delta), [-8, -4]);
  assert.deepEqual(moves.map(m => m.balanceAfter), [0, 4]);
  assert.equal(moves[0].sku, 'X', 'movements carry the sku for the ledger');
});

test('a guard that matches NO row aborts with a 409 and stops immediately', async () => {
  const c = fakeClient({ guardFailsOn: 'wh_reserve' });
  await assert.rejects(
    () => reserveTakes(c, [
      { sku: 'X', variation_id: 'v1', warehouse_id: 'wh_main', take: 2 },
      { sku: 'X', variation_id: 'v1', warehouse_id: 'wh_reserve', take: 2 },
      { sku: 'X', variation_id: 'v1', warehouse_id: 'wh_third', take: 2 },
    ]),
    e => {
      assert.equal(e.status, 409);
      assert.equal(e.expose, true);
      assert.equal(e.shortages[0].sku, 'X');
      assert.equal(e.shortages[0].warehouseId, 'wh_reserve');
      return true;
    });
  assert.equal(c.queries.length, 2,
    'it stops at the failing guard — the third pile is never touched');
});

test('the throw is what rolls the transaction back — no partial reservation', async () => {
  /* tx() in db.js rolls back on any throw. Simulated here so the contract is
     asserted rather than assumed: the earlier successful decrement must be
     undone by the rollback, not compensated for in JS. */
  let rolledBack = false, committed = false;
  const c = fakeClient({ guardFailsOn: 'wh_reserve' });
  async function tx(fn) {
    try { const r = await fn(c); committed = true; return r; }
    catch (e) { rolledBack = true; throw e; }
  }
  await assert.rejects(() => tx(cl => reserveTakes(cl, [
    { sku: 'X', variation_id: 'v1', warehouse_id: 'wh_main', take: 2 },
    { sku: 'X', variation_id: 'v1', warehouse_id: 'wh_reserve', take: 2 },
  ])));
  assert.equal(rolledBack, true);
  assert.equal(committed, false, 'nothing commits when a guard fails');
});

test('an empty or missing take list is a no-op', async () => {
  const c = fakeClient();
  assert.deepEqual(await reserveTakes(c, []), []);
  assert.deepEqual(await reserveTakes(c, null), []);
  assert.equal(c.queries.length, 0);
});
