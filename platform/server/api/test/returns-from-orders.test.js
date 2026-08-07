/* Client feedback item B — a return is an operation on an order.

   `POST /user/returns` had NO test at all, which is how it came to accept an
   unverified order number, an arbitrary SKU, an unbounded quantity, and — the
   money bug — A PRICE FROM THE REQUEST BODY. A return is a credit note in
   waiting, so that let a browser name its own refund.

   The database double answers the four queries the module issues. It is a
   double, not a re-implementation: it stores rows and filters them, and every
   assertion below is about what `buildReturn`/`listReturnableOrders` do with
   the answers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReturn, listReturnableOrders, ReturnError, RETURNABLE_ORDER_STATUSES,
} from '../src/returns.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/* ---------- the world ---------- */

function world(overrides = {}) {
  return {
    orders: [
      { id: 'o1', number: 'SO-100', customer_id: 'cust-a', status: 'shipped', order_date: '2026-06-01' },
      { id: 'o2', number: 'SO-200', customer_id: 'cust-a', status: 'pending', order_date: '2026-07-01' },
      { id: 'o3', number: 'SO-300', customer_id: 'cust-b', status: 'shipped', order_date: '2026-06-15' },
    ],
    orderItems: [
      { order_id: 'o1', sku: '1844.1', name: 'Charlett Saint Cloud', color: 'Black', qty: 4, price: '120.00' },
      { order_id: 'o1', sku: '1844.9', name: 'Charlett Saint Cloud', color: 'Havana', qty: 2, price: '120.00' },
      { order_id: 'o2', sku: '2001.1', name: 'Kyme Ares', color: 'Gold', qty: 3, price: '90.00' },
      { order_id: 'o3', sku: '9999.1', name: 'Someone Else', color: 'Blue', qty: 5, price: '400.00' },
    ],
    returns: [],
    returnItems: [],
    variations: [{ sku: '1844.1' }, { sku: '1844.9' }, { sku: '2001.1' }, { sku: '7777.3' }],
    ...overrides,
  };
}

/** Answers the specific queries `returns.js` issues, by shape. */
function makeDb(w) {
  const db = {
    calls: [],
    async query(sql, params = []) {
      db.calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.startsWith('select o.id, o.number, o.order_date, o.status')) {
        const [cid, statuses] = params;
        return { rows: w.orders.filter(o => o.customer_id === cid && statuses.includes(o.status)) };
      }
      if (s.startsWith('select o.number as order_number')) {
        const [cid, numbers] = params;
        const mine = w.orders.filter(o => o.customer_id === cid && numbers.includes(o.number));
        const ids = new Map(mine.map(o => [o.id, o.number]));
        return {
          rows: w.orderItems.filter(i => ids.has(i.order_id))
            .map(i => ({ ...i, order_number: ids.get(i.order_id) })),
        };
      }
      if (s.startsWith('select rt.order_number, ri.sku')) {
        const [cid, numbers] = params;
        const out = new Map();
        for (const ri of w.returnItems) {
          const rt = w.returns.find(r => r.id === ri.return_id);
          if (!rt || rt.customer_id !== cid || !numbers.includes(rt.order_number)) continue;
          const key = `${rt.order_number} ${ri.sku}`;
          out.set(key, (out.get(key) || 0) + ri.qty);
        }
        return {
          rows: [...out].map(([k, returned]) => {
            const at = k.lastIndexOf(' ');
            return { order_number: k.slice(0, at), sku: k.slice(at + 1), returned };
          }),
        };
      }
      if (s.startsWith('select id, number, status from orders')) {
        const [number, cid] = params;
        return { rows: w.orders.filter(o => o.number === number && o.customer_id === cid) };
      }
      if (s.startsWith('select sku, name, color, sum(qty)')) {
        const [orderId] = params;
        const agg = new Map();
        for (const i of w.orderItems.filter(x => x.order_id === orderId)) {
          const k = `${i.sku}|${i.name}|${i.color}`;
          const at = agg.get(k);
          if (at) { at.qty += i.qty; continue; }
          agg.set(k, { sku: i.sku, name: i.name, color: i.color, qty: i.qty, price: i.price });
        }
        return { rows: [...agg.values()] };
      }
      if (s.startsWith('select ri.sku, coalesce(sum(ri.qty)')) {
        const [orderNumber, cid] = params;
        const out = new Map();
        for (const ri of w.returnItems) {
          const rt = w.returns.find(r => r.id === ri.return_id);
          if (!rt || rt.customer_id !== cid || rt.order_number !== orderNumber) continue;
          out.set(ri.sku, (out.get(ri.sku) || 0) + ri.qty);
        }
        return { rows: [...out].map(([sku, returned]) => ({ sku, returned })) };
      }
      if (s.startsWith('select v.sku from variations')) {
        const [sku] = params;
        return { rows: w.variations.filter(v => v.sku === sku) };
      }
      throw new Error(`the double was asked something unexpected: ${s.slice(0, 90)}`);
    },
  };
  return db;
}

const rejects = (promise, re) => assert.rejects(promise, (e) => {
  assert.ok(e instanceof ReturnError, `expected a ReturnError, got ${e.name}: ${e.message}`);
  assert.match(e.message, re);
  return true;
});

/* ============ THE CROSS-CUSTOMER BOUNDARY ============ */

test('a return against ANOTHER customer\'s order is refused', async () => {
  const w = world();
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-300', items: [{ sku: '9999.1', qty: 1 }],
    }),
    /could not be found/);
});

test('the refusal is identical to one for an order that does not exist', async () => {
  /* Otherwise trying order numbers tells you which ones belong to somebody
     else — the same reasoning the invoice payment routes already use. */
  const w = world();
  const other = await buildReturn(makeDb(w), 'cust-a',
    { orderNumber: 'SO-300', items: [{ sku: '9999.1', qty: 1 }] }).catch(e => e);
  const absent = await buildReturn(makeDb(w), 'cust-a',
    { orderNumber: 'SO-DOES-NOT-EXIST', items: [{ sku: '9999.1', qty: 1 }] }).catch(e => e);
  assert.equal(other.status, absent.status);
  assert.equal(other.message, absent.message);
  assert.equal(other.status, 404);
});

test('another customer\'s orders never appear in the returnable list', async () => {
  const w = world();
  const mine = await listReturnableOrders(makeDb(w), 'cust-a');
  assert.deepEqual(mine.map(o => o.number), ['SO-100'], 'SO-300 belongs to cust-b');
  const theirs = await listReturnableOrders(makeDb(w), 'cust-b');
  assert.deepEqual(theirs.map(o => o.number), ['SO-300']);
});

test('the ownership boundary is in the SQL, not only in the test double', async () => {
  /* The double filters rows by customer itself, so every cross-customer test
     above would still pass if the SQL stopped scoping — the double would do
     the work the code had stopped doing. Caught exactly that: dropping
     `customer_id = $2` from the order lookup broke nothing. So the predicate
     is pinned in the query text, which is the only part a double cannot fake. */
  const w = world();
  const db = makeDb(w);
  await buildReturn(db, 'cust-a', { orderNumber: 'SO-100', items: [{ sku: '1844.1', qty: 1 }] });
  await listReturnableOrders(db, 'cust-a');

  const reads = db.calls
    .map(c => c.sql.replace(/\s+/g, ' ').trim())
    .filter(s => /\b(from|join)\s+(orders|returns)\b/.test(s));
  assert.ok(reads.length >= 4, `expected several scoped reads, saw ${reads.length}`);
  for (const sql of reads) {
    assert.match(sql, /(^|\W)(o|rt)?\.?customer_id\s*=\s*\$\d/,
      `a query reading orders or returns must scope to the caller: ${sql.slice(0, 120)}`);
  }
});

test('the order lookup locks the caller\'s own row, by customer, in one statement', async () => {
  const w = world();
  const db = makeDb(w);
  await buildReturn(db, 'cust-a', { orderNumber: 'SO-100', items: [{ sku: '1844.1', qty: 1 }] });
  const lock = db.calls.find(c => /for update/.test(c.sql));
  assert.ok(lock, 'the order row is locked');
  assert.match(lock.sql.replace(/\s+/g, ' '), /where number = \$1 and customer_id = \$2 for update/);
  assert.deepEqual(lock.params, ['SO-100', 'cust-a']);
});

test('an unauthenticated caller gets nothing rather than everything', async () => {
  const w = world();
  assert.deepEqual(await listReturnableOrders(makeDb(w), null), []);
  assert.deepEqual(await listReturnableOrders(makeDb(w), ''), []);
});

/* ============ THE MONEY ============ */

test('the price comes from the ORDER LINE, never from the request', async () => {
  const w = world();
  const plan = await buildReturn(makeDb(w), 'cust-a', {
    orderNumber: 'SO-100',
    items: [{ sku: '1844.1', qty: 1, price: '99999.00' }],
  });
  assert.equal(plan.items[0].price, '120.00',
    'a browser may not name its own refund amount');
});

test('the name comes from the order line too', async () => {
  const w = world();
  const plan = await buildReturn(makeDb(w), 'cust-a', {
    orderNumber: 'SO-100',
    items: [{ sku: '1844.1', qty: 1, name: 'A Much More Expensive Frame' }],
  });
  assert.equal(plan.items[0].name, 'Charlett Saint Cloud');
});

test('the request body cannot smuggle a price through any field name', () => {
  const src = fs.readFileSync(path.join(SRC, 'returns.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.ok(!/raw\??\.\s*price/.test(src), 'no price is ever read from the request item');
  assert.ok(!/payload\??\.\s*price/.test(src), 'nor from the payload');
});

/* ============ THE LINE MUST BE ON THE ORDER ============ */

test('a SKU that is not on the order is refused', async () => {
  const w = world();
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-100', items: [{ sku: '2001.1', qty: 1 }],
    }),
    /is not on order SO-100/);
});

test('a SKU that has never existed is refused', async () => {
  const w = world();
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-100', items: [{ sku: 'MADE-UP', qty: 1 }],
    }),
    /is not on order SO-100/);
});

/* ============ QUANTITY ============ */

test('the quantity may not exceed what was ordered', async () => {
  const w = world();
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-100', items: [{ sku: '1844.1', qty: 5 }],
    }),
    /at most 4 of 1844\.1/);
});

test('quantities already returned are subtracted', async () => {
  const w = world();
  w.returns.push({ id: 'r1', customer_id: 'cust-a', order_number: 'SO-100' });
  w.returnItems.push({ return_id: 'r1', sku: '1844.1', qty: 3 });

  const plan = await buildReturn(makeDb(w), 'cust-a', {
    orderNumber: 'SO-100', items: [{ sku: '1844.1', qty: 1 }],
  });
  assert.equal(plan.items[0].qty, 1, 'the last unit is returnable');

  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-100', items: [{ sku: '1844.1', qty: 2 }],
    }),
    /at most 1 of 1844\.1/);
});

test('a fully returned line says so plainly', async () => {
  const w = world();
  w.returns.push({ id: 'r1', customer_id: 'cust-a', order_number: 'SO-100' });
  w.returnItems.push({ return_id: 'r1', sku: '1844.9', qty: 2 });
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-100', items: [{ sku: '1844.9', qty: 1 }],
    }),
    /has already been returned/);
});

test('zero, negative and non-numeric quantities are all refused', async () => {
  const w = world();
  for (const qty of [0, -3, 'lots', null, undefined, 1.5, '3 pairs']) {
    await rejects(
      buildReturn(makeDb(w), 'cust-a', { orderNumber: 'SO-100', items: [{ sku: '1844.1', qty }] }),
      /Enter how many/);
  }
  const ok = await buildReturn(makeDb(w), 'cust-a',
    { orderNumber: 'SO-100', items: [{ sku: '1844.1', qty: '2' }] });
  assert.equal(ok.items[0].qty, 2, 'a form field arriving as a string is still fine');
});

test('the same SKU twice in one return is refused rather than double-counted', async () => {
  /* Two lines of 3 against a line of 4 would each pass a per-line check. */
  const w = world();
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-100',
      items: [{ sku: '1844.1', qty: 3 }, { sku: '1844.1', qty: 3 }],
    }),
    /listed twice/);
});

/* ============ WHICH ORDERS CAN BE RETURNED ============ */

test('an order that has not shipped cannot be returned against', async () => {
  const w = world();
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-200', items: [{ sku: '2001.1', qty: 1 }],
    }),
    /has not shipped yet/);
});

test('the returnable statuses are the ones where goods have left', () => {
  assert.deepEqual([...RETURNABLE_ORDER_STATUSES].sort(),
    ['collected', 'completed', 'shipped']);
  for (const never of ['pending', 'processing', 'approved', 'collecting', 'cancelled']) {
    assert.ok(!RETURNABLE_ORDER_STATUSES.includes(never), `${never} has not shipped`);
  }
});

/* ============ AN ORDER IS NOW REQUIRED AT ALL ============ */

test('a return with no order number is refused', async () => {
  const w = world();
  for (const orderNumber of ['', '   ', null, undefined]) {
    await rejects(
      buildReturn(makeDb(w), 'cust-a', { orderNumber, items: [{ sku: '1844.1', qty: 1 }] }),
      /Choose the order/);
  }
});

test('a return with no items is refused', async () => {
  const w = world();
  for (const items of [[], null, undefined, 'nope']) {
    await rejects(
      buildReturn(makeDb(w), 'cust-a', { orderNumber: 'SO-100', items }),
      /at least one item/);
  }
});

/* ============ EXCHANGES ============ */

test('an exchange must name a frame Veyora actually stocks', async () => {
  const w = world();
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-100',
      items: [{ sku: '1844.1', qty: 1, resolution: 'exchange', exchangeSku: 'NOT-A-FRAME' }],
    }),
    /is not a frame we stock/);
});

test('an exchange with no replacement chosen is refused', async () => {
  const w = world();
  await rejects(
    buildReturn(makeDb(w), 'cust-a', {
      orderNumber: 'SO-100',
      items: [{ sku: '1844.1', qty: 1, resolution: 'exchange', exchangeSku: '  ' }],
    }),
    /Choose the frame you would like instead/);
});

test('an exchange for a stocked frame is accepted, and need not be on the order', async () => {
  /* The whole point of an exchange is swapping for something different. */
  const w = world();
  const plan = await buildReturn(makeDb(w), 'cust-a', {
    orderNumber: 'SO-100',
    items: [{ sku: '1844.1', qty: 1, resolution: 'exchange', exchangeSku: '7777.3' }],
  });
  assert.equal(plan.items[0].resolution, 'exchange');
  assert.equal(plan.items[0].exchangeSku, '7777.3');
});

test('a credit carries no exchange SKU even if one was sent', async () => {
  const w = world();
  const plan = await buildReturn(makeDb(w), 'cust-a', {
    orderNumber: 'SO-100',
    items: [{ sku: '1844.1', qty: 1, resolution: 'credit', exchangeSku: '7777.3' }],
  });
  assert.equal(plan.items[0].exchangeSku, null);
});

test('an unrecognised resolution falls back to credit, not to exchange', async () => {
  const w = world();
  const plan = await buildReturn(makeDb(w), 'cust-a', {
    orderNumber: 'SO-100',
    items: [{ sku: '1844.1', qty: 1, resolution: 'refund_to_card_immediately' }],
  });
  assert.equal(plan.items[0].resolution, 'credit');
});

/* ============ THE LIST THE FORM IS BUILT FROM ============ */

test('each line reports what remains returnable', async () => {
  const w = world();
  w.returns.push({ id: 'r1', customer_id: 'cust-a', order_number: 'SO-100' });
  w.returnItems.push({ return_id: 'r1', sku: '1844.1', qty: 1 });

  const [order] = await listReturnableOrders(makeDb(w), 'cust-a');
  assert.equal(order.number, 'SO-100');
  const line = order.lines.find(l => l.sku === '1844.1');
  assert.deepEqual(
    { qty: line.qty, returnedQty: line.returnedQty, returnableQty: line.returnableQty },
    { qty: 4, returnedQty: 1, returnableQty: 3 });
});

test('a fully returned line stays visible with zero remaining', async () => {
  /* "You have already returned this" beats a frame silently missing. */
  const w = world();
  w.returns.push({ id: 'r1', customer_id: 'cust-a', order_number: 'SO-100' });
  w.returnItems.push({ return_id: 'r1', sku: '1844.9', qty: 2 });

  const [order] = await listReturnableOrders(makeDb(w), 'cust-a');
  const line = order.lines.find(l => l.sku === '1844.9');
  assert.ok(line, 'the line is still listed');
  assert.equal(line.returnableQty, 0);
});

test('un-shipped orders are not offered for return', async () => {
  const w = world();
  const orders = await listReturnableOrders(makeDb(w), 'cust-a');
  assert.ok(!orders.some(o => o.number === 'SO-200'), 'SO-200 is still pending');
});

test('the list carries the price so the form can show what a credit is worth', async () => {
  const w = world();
  const [order] = await listReturnableOrders(makeDb(w), 'cust-a');
  assert.equal(order.lines.find(l => l.sku === '1844.1').price, '120.00');
});

/* ============ THE ROUTE USES IT ============ */

test('the route validates inside the transaction, with the transaction client', () => {
  /* Validating on the pool while inserting on a transaction client would read
     quantities the insert does not hold, so two returns could both spend the
     last unit. */
  const route = fs.readFileSync(path.join(SRC, 'routes', 'orders.js'), 'utf8');
  const post = route.slice(route.indexOf("r.post('/returns'"));
  const body = post.slice(0, post.indexOf('\nr.'));
  assert.match(body, /await tx\(async \(c\) => \{[\s\S]*?buildReturn\(c,/,
    'buildReturn must be called with the transaction client');
  assert.ok(body.indexOf('buildReturn') < body.indexOf('insert into returns'),
    'and before anything is written');
});

test('the route reads nothing out of the request body itself', () => {
  /* `it.price` still appears in the route — but `it` now iterates the
     VALIDATED plan, not the request. The property that matters is therefore
     not the absence of a string: it is that `req.body` is touched exactly
     once, to hand it to the validator. */
  const route = fs.readFileSync(path.join(SRC, 'routes', 'orders.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const post = route.slice(route.indexOf("r.post('/returns'"));
  const body = post.slice(0, post.indexOf('\nr.'));

  const uses = body.match(/req\.body[^\s)]*/g) ?? [];
  assert.deepEqual(uses, ['req.body'], 'req.body is never destructured or indexed');
  assert.match(body, /buildReturn\(c, req\.user\.id, req\.body \|\| \{\}\)/,
    'its only use is being handed to the validator');
  assert.match(body, /for \(const it of plan\.items\)/,
    'and the insert loop walks the validated plan');
});

test('the order lock is taken before the quantities are read', async () => {
  const w = world();
  const db = makeDb(w);
  await buildReturn(db, 'cust-a', { orderNumber: 'SO-100', items: [{ sku: '1844.1', qty: 1 }] });
  const lockAt = db.calls.findIndex(c => /for update/.test(c.sql));
  const qtyAt = db.calls.findIndex(c => /sum\(qty\)/.test(c.sql));
  assert.ok(lockAt >= 0, 'the order row is locked');
  assert.ok(lockAt < qtyAt, 'and the lock is held before the quantities are read');
});
