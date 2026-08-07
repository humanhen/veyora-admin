/* ADD ONE UNIT OF A SKU TO MY CART.
 *
 * Post-handover client feedback: the product page adds one piece per click
 * straight into the real cart, and repeated clicks mean repeated units. That
 * cannot be built on POST /user/add-to-cart, which SETS an absolute quantity —
 * repeated posts of {qty:1} pin the line at one — and it cannot be built as
 * read-then-set from the browser, which is the classic lost update.
 *
 * These tests exercise the real operation. incrementCartLine() takes its query
 * function as an argument (the ordering.js pattern), so the rule is driven
 * without a database — but NOT against a hand-written stub that agrees with it
 * by construction: the fake executor below reads the ACTUAL SQL the module
 * ships and interprets the clauses that carry the guarantees. Change
 * `qty = cart_items.qty + 1` to a constant, or drop the stock predicate, and
 * these fail.
 */
import './helpers/test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  incrementCartLine, stockRefusalMessage,
  CART_INCREMENT_SQL, CART_INCREMENT_REFUSAL_SQL,
} from '../src/cart-operations.js';
import cartRouter from '../src/routes/cart.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const cartRouteSource = fs.readFileSync(path.join(SRC, 'routes', 'cart.js'), 'utf8');

/* =====================================================================
   A Postgres stand-in that OBEYS THE SHIPPED SQL
   =====================================================================

   It models the three behaviours the operation depends on:

     * ON CONFLICT DO UPDATE takes a row lock and then reads the row, so
       overlapping statements serialise and each sees the previous one's write;
     * the DO UPDATE's WHERE is evaluated on that post-lock version;
     * a statement whose WHERE is false writes nothing and returns no rows.

   The SET expression and the WHERE predicate are read out of the SQL string
   rather than assumed, which is what makes a regression in the module visible
   here instead of only in production. */

/** What `do update set qty = <expr>` does to the row's current quantity. */
function applySetExpression(sql, current) {
  const m = sql.match(/do\s+update\s+set\s+qty\s*=\s*([\s\S]+?)\s+(?:where|returning)\b/i);
  assert.ok(m, 'the increment must be an ON CONFLICT DO UPDATE on cart_items.qty');
  const expr = m[1].replace(/\s+/g, '');
  if (expr === 'cart_items.qty+1') return current + 1;      // the correct rule
  if (expr === 'excluded.qty') return 1;                    // the inserted row's qty
  if (/^\d+$/.test(expr)) return Number(expr);              // a constant — an overwrite
  throw new Error(`this fake database does not model "set qty = ${m[1]}"`);
}

/** The quantity a brand-new line is created with — read from the INSERT. */
function insertedQuantity(sql) {
  const m = sql.match(/insert\s+into\s+cart_items\s*\([^)]*\)\s*select\s+\$1,\s*v\.sku,\s*(\d+)/i);
  assert.ok(m, 'the new line must be inserted with a literal quantity');
  return Number(m[1]);
}

/** Does the DO UPDATE still refuse to pass the shelf when backorders are off? */
function capIsEnforcedOnUpdate(sql) {
  const clause = sql.slice(sql.search(/do\s+update/i));
  return /cart_items\.qty\s*\+\s*1\s*<=/i.test(clause);
}
/** …and does the INSERT path refuse to create a line for a sku with no stock? */
function capIsEnforcedOnInsert(sql) {
  const clause = sql.slice(0, sql.search(/on\s+conflict/i));
  return />=\s*1/.test(clause);
}
/** The variation must be validated by the statement, not by a hopeful caller. */
function validatesActiveVariation(sql) {
  return /from\s+variations\s+v[\s\S]*?v\.sku\s*=\s*\$2[\s\S]*?v\.is_active/i.test(sql);
}

function fakeDb({ variations = {}, cart = {}, allowBackorders = true } = {}) {
  const state = {
    /** sku -> {active, stock} */
    variations: { ...variations },
    /** "user|sku" -> qty */
    cart: { ...cart },
    calls: [],
  };
  /** One in-flight statement per cart line — Postgres' row lock. */
  const locks = new Map();

  async function withRowLock(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    locks.set(key, new Promise(r => { release = r; }));
    await previous;
    try { return await fn(); } finally { release(); }
  }

  async function runQuery(sql, params) {
    state.calls.push({ sql, params });
    await Promise.resolve();                       // a statement is never instant

    if (/insert\s+into\s+cart_items/i.test(sql)) {
      const [userId, sku, allowBo] = params;
      const v = state.variations[sku];
      if (!validatesActiveVariation(sql)) return { rows: [] };
      if (!v || !v.active) return { rows: [] };     // unknown or de-activated
      const key = `${userId}|${sku}`;
      return withRowLock(key, async () => {
        const current = state.cart[key];
        if (current == null) {                      // the INSERT path
          if (!allowBo && capIsEnforcedOnInsert(sql) && v.stock < 1) return { rows: [] };
          state.cart[key] = insertedQuantity(sql);
          return { rows: [{ qty: state.cart[key] }] };
        }
        // the ON CONFLICT path — read AFTER the lock, exactly as Postgres does
        const next = applySetExpression(sql, current);
        if (!allowBo && capIsEnforcedOnUpdate(sql) && current + 1 > v.stock) {
          return { rows: [] };                      // predicate false: nothing written
        }
        state.cart[key] = next;
        return { rows: [{ qty: next }] };
      });
    }

    if (/from\s+variations\s+v/i.test(sql) && /coalesce/i.test(sql)) {
      const [userId, sku] = params;
      const v = state.variations[sku];
      if (!v || !v.active) return { rows: [] };
      return { rows: [{ available: v.stock, qty: state.cart[`${userId}|${sku}`] || 0 }] };
    }
    throw new Error(`unexpected statement: ${sql}`);
  }

  return { state, runQuery, allowBackorders,
    qtyOf: (user, sku) => state.cart[`${user}|${sku}`] ?? null };
}

const BLACK = '1844.1';
const HAVANA = '1844.9';
const stocked = (stock, active = true) => ({ active, stock });
const shop = (over = {}) => fakeDb({
  variations: { [BLACK]: stocked(44), [HAVANA]: stocked(0), 'GONE.1': stocked(5, false) },
  ...over,
});
const addOne = (db, sku, user = 'u_dana') =>
  incrementCartLine(db.runQuery, user, sku, { allowBackorders: db.allowBackorders });

/* =====================================================================
   1-3. one click, one piece
   ===================================================================== */

test('the first click on a colour creates a line of exactly one', async () => {
  const db = shop();
  const r = await addOne(db, BLACK);
  assert.deepEqual(r, { sku: BLACK, qty: 1 });
  assert.equal(db.qtyOf('u_dana', BLACK), 1);
});

test('a second click on a line that already holds one makes it two', async () => {
  const db = shop({ cart: { [`u_dana|${BLACK}`]: 1 } });
  assert.equal((await addOne(db, BLACK)).qty, 2);
  assert.equal(db.qtyOf('u_dana', BLACK), 2);
});

test('five sequential clicks are five pieces, not one and not six', async () => {
  const db = shop();
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push((await addOne(db, BLACK)).qty);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.equal(db.qtyOf('u_dana', BLACK), 5);
});

test('an existing quantity is added to, never replaced', async () => {
  const db = shop({ cart: { [`u_dana|${BLACK}`]: 7 } });
  assert.equal((await addOne(db, BLACK)).qty, 8);
});

test('one colour never moves another colour', async () => {
  const db = shop({ cart: { [`u_dana|${HAVANA}`]: 2 } });
  await addOne(db, BLACK);
  await addOne(db, BLACK);
  assert.equal(db.qtyOf('u_dana', BLACK), 2);
  assert.equal(db.qtyOf('u_dana', HAVANA), 2, 'Havana was not touched');
});

test("one account's cart never moves another account's", async () => {
  const db = shop({ cart: { [`u_rey|${BLACK}`]: 3 } });
  await addOne(db, BLACK, 'u_dana');
  assert.equal(db.qtyOf('u_dana', BLACK), 1);
  assert.equal(db.qtyOf('u_rey', BLACK), 3);
});

/* =====================================================================
   4. concurrency — no lost updates
   ===================================================================== */

test('five OVERLAPPING clicks are five pieces — no increment is lost', async () => {
  const db = shop();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => addOne(db, BLACK)));
  assert.equal(db.qtyOf('u_dana', BLACK), 5);
  assert.deepEqual(results.map(r => r.qty).sort((a, b) => a - b), [1, 2, 3, 4, 5],
    'every request saw a distinct quantity — none read a stale one');
});

test('twenty overlapping clicks across two colours land exactly', async () => {
  const db = shop({ variations: { [BLACK]: stocked(99), [HAVANA]: stocked(99) } });
  await Promise.all([
    ...Array.from({ length: 12 }, () => addOne(db, BLACK)),
    ...Array.from({ length: 8 }, () => addOne(db, HAVANA)),
  ]);
  assert.equal(db.qtyOf('u_dana', BLACK), 12);
  assert.equal(db.qtyOf('u_dana', HAVANA), 8);
});

test('the increment is ONE statement — there is no read-then-write window', async () => {
  const db = shop();
  await addOne(db, BLACK);
  assert.equal(db.state.calls.length, 1,
    'a successful add must not read the cart first and write it back afterwards');
  assert.match(db.state.calls[0].sql, /insert\s+into\s+cart_items/i);
});

/* =====================================================================
   5-6. the sku must be real and active
   ===================================================================== */

test('an unknown sku is refused, and nothing is written', async () => {
  const db = shop();
  await assert.rejects(() => addOne(db, 'NOT-A-SKU'),
    e => e.status === 404 && e.expose === true && /unknown sku/.test(e.message));
  assert.deepEqual(db.state.cart, {});
});

test('a de-activated variation is refused like an unknown one', async () => {
  const db = shop();
  await assert.rejects(() => addOne(db, 'GONE.1'), e => e.status === 404);
  assert.equal(db.qtyOf('u_dana', 'GONE.1'), null);
});

test('a de-activated variation cannot be topped up either', async () => {
  const db = shop({ cart: { 'u_dana|GONE.1': 2 } });
  await assert.rejects(() => addOne(db, 'GONE.1'), e => e.status === 404);
  assert.equal(db.qtyOf('u_dana', 'GONE.1'), 2, 'the line is left exactly as it was');
});

test('a missing or blank sku is a 400, not a silent no-op', async () => {
  const db = shop();
  for (const bad of [undefined, null, '', '   ']) {
    await assert.rejects(() => incrementCartLine(db.runQuery, 'u_dana', bad, {}),
      e => e.status === 400);
  }
  assert.equal(db.state.calls.length, 0, 'nothing reaches the database');
});

test('the statement validates the variation itself', () => {
  assert.ok(validatesActiveVariation(CART_INCREMENT_SQL),
    'sku existence and is_active must be part of the write, not a prior check '
    + 'a caller could forget');
});

/* =====================================================================
   7. authentication
   ===================================================================== */

test('the cart router refuses an unauthenticated add-one outright', async () => {
  const captured = {};
  const res = {
    status(code) { captured.code = code; return this; },
    json(body) { captured.body = body; return this; },
    cookie() { return this; },
  };
  await new Promise(resolve => {
    cartRouter.handle(
      { method: 'POST', url: '/add-one-to-cart', cookies: {}, headers: {}, body: { sku: BLACK } },
      res,
      () => resolve(),        // next() would mean it fell through unauthenticated
    );
    setTimeout(resolve, 50);
  });
  assert.equal(captured.code, 401);
  assert.deepEqual(captured.body, { error: 'unauthorized' });
});

test('the auth middleware sits in FRONT of every cart route', () => {
  const layers = cartRouter.stack;
  const firstRoute = layers.findIndex(l => l.route);
  assert.ok(firstRoute > 0, 'a route is declared before any middleware');
  assert.ok(layers.slice(0, firstRoute).length >= 1);
  assert.match(cartRouteSource, /^r\.use\(requireAuth\(\)\);$/m);
  const paths = layers.filter(l => l.route).map(l => l.route.path);
  assert.ok(paths.includes('/add-one-to-cart'), 'the new route is on the guarded router');
});

/* =====================================================================
   8-10. the stock contract
   ===================================================================== */

test('BACKORDERS ON: a colour with nothing on the shelf is still addable', async () => {
  const db = shop();
  db.allowBackorders = true;
  assert.equal((await addOne(db, HAVANA)).qty, 1);
  assert.equal((await addOne(db, HAVANA)).qty, 2);
});

test('BACKORDERS ON: the quantity may pass what is available', async () => {
  const db = fakeDb({ variations: { [BLACK]: stocked(2) }, allowBackorders: true });
  db.allowBackorders = true;
  for (let i = 0; i < 5; i++) await addOne(db, BLACK);
  assert.equal(db.qtyOf('u_dana', BLACK), 5, '3 of them are a backorder, and that is the point');
});

test('BACKORDERS OFF: the cart may not pass what is on the shelf', async () => {
  const db = fakeDb({ variations: { [BLACK]: stocked(2) } });
  db.allowBackorders = false;
  assert.equal((await addOne(db, BLACK)).qty, 1);
  assert.equal((await addOne(db, BLACK)).qty, 2);
  await assert.rejects(() => addOne(db, BLACK), e =>
    e.status === 409
    && e.message === 'Only 2 left in stock for 1844.1.'
    && e.data.available === 2 && e.data.requested === 3 && e.data.sku === BLACK);
  assert.equal(db.qtyOf('u_dana', BLACK), 2, 'the refused click changed nothing');
});

test('BACKORDERS OFF: an out-of-stock colour cannot be added at all', async () => {
  const db = shop();
  db.allowBackorders = false;
  await assert.rejects(() => addOne(db, HAVANA), e =>
    e.status === 409 && e.message === '1844.9 is out of stock.' && e.data.available === 0);
  assert.equal(db.qtyOf('u_dana', HAVANA), null);
});

test('BACKORDERS OFF: overlapping clicks cannot BOTH take the last piece', async () => {
  const db = fakeDb({ variations: { [BLACK]: stocked(1) } });
  db.allowBackorders = false;
  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, () => addOne(db, BLACK)));
  const won = outcomes.filter(o => o.status === 'fulfilled');
  assert.equal(won.length, 1, 'exactly one request may have the single piece');
  assert.equal(db.qtyOf('u_dana', BLACK), 1, 'the cap held under concurrency');
  for (const lost of outcomes.filter(o => o.status === 'rejected')) {
    assert.equal(lost.reason.status, 409);
    assert.match(lost.reason.message, /left in stock|out of stock/);
  }
});

test('BACKORDERS OFF: ten overlapping clicks stop exactly at the shelf', async () => {
  const db = fakeDb({ variations: { [BLACK]: stocked(4) } });
  db.allowBackorders = false;
  await Promise.allSettled(Array.from({ length: 10 }, () => addOne(db, BLACK)));
  assert.equal(db.qtyOf('u_dana', BLACK), 4);
});

test('the stock cap is a predicate in the SQL, not a decision in JavaScript', () => {
  assert.ok(capIsEnforcedOnUpdate(CART_INCREMENT_SQL),
    'the limit must be re-evaluated against the LOCKED row, or a second request '
    + 'slips past a limit the first one just consumed');
  assert.ok(capIsEnforcedOnInsert(CART_INCREMENT_SQL),
    'a line must not be created for a sku with nothing on the shelf');
  // …and it must be conditional on the policy, not unconditional.
  assert.match(CART_INCREMENT_SQL, /\$3::boolean/,
    'the backorder policy is a parameter of the statement');
});

test('the refusal wording is written once and reads plainly', () => {
  assert.equal(stockRefusalMessage('X.1', 3), 'Only 3 left in stock for X.1.');
  assert.equal(stockRefusalMessage('X.1', 0), 'X.1 is out of stock.');
  assert.match(cartRouteSource, /error: stockRefusalMessage\(sku, available\)/,
    'the absolute-set endpoint must use the same sentence, not a second copy');
});

test('the refusal probe only runs when the write was actually refused', async () => {
  const db = shop();
  await addOne(db, BLACK);
  const before = db.state.calls.length;
  db.allowBackorders = false;
  await assert.rejects(() => addOne(db, HAVANA));
  assert.equal(before, 1, 'the happy path stayed at one statement');
  assert.equal(db.state.calls.length, 3, 'the refused path asks why, once');
  assert.match(db.state.calls[2].sql, /from\s+variations\s+v/i);
});

/* =====================================================================
   11. the ABSOLUTE endpoint is untouched
   ===================================================================== */

test('/user/add-to-cart still means SET THIS LINE TO THIS QUANTITY', () => {
  const body = cartRouteSource.slice(
    cartRouteSource.indexOf(`r.post('/add-to-cart'`),
    cartRouteSource.indexOf(`r.post('/add-one-to-cart'`));
  assert.match(body, /on conflict \(user_id, sku\) do update set qty = \$3/,
    'an absolute set, not an increment');
  assert.ok(!/cart_items\.qty \+ 1/.test(body),
    'the absolute endpoint must never have become an increment');
  assert.match(body, /if \(n <= 0\) \{[\s\S]*?delete from cart_items where user_id=\$1 and sku=\$2/,
    'setting a line to zero still removes it');
});

/* The route is a thin shell over incrementCartLine() by design: every
   guarantee above — the lock, the re-read, the stock predicate, the sku
   validation — lives in that one statement. A route that assembled its own
   cart write would be a second, unguarded increment path that none of these
   tests reach, so the delegation is pinned here rather than assumed. */
test('the add-one route delegates to the atomic operation and writes nothing itself', () => {
  const body = cartRouteSource.slice(
    cartRouteSource.indexOf(`r.post('/add-one-to-cart'`),
    cartRouteSource.indexOf(`r.get('/get-cart'`));
  assert.ok(body.length > 100, 'the route must exist');
  assert.match(body, /await incrementCartLine\(q, req\.user\.id, req\.body\?\.sku,/,
    'the increment rule lives in one place, and the route must use it');
  assert.match(body, /allowBackorders: allowCustomerBackorders\(\)/,
    'the backorder policy is the SERVER\'s, not the request\'s');
  assert.ok(!/insert into cart_items|update cart_items|delete from cart_items/i.test(body),
    'a cart write inside the route would bypass the locked, capped statement');
  assert.ok(!/req\.body\??\.qty/.test(body),
    'a client-supplied quantity has no place in "add one"');
  assert.match(body, /res\.json\(await cartSummary\(req\.user\)\)/,
    'the reply must be the authoritative cart, so the browser derives nothing');
});

test('/user/add-one-to-cart is a SEPARATE route, not an overload', () => {
  const paths = cartRouter.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(paths.includes('/add-to-cart'));
  assert.ok(paths.includes('/add-one-to-cart'));
  // Same path under two verbs is legitimate (GET/POST /cart/drafts); the same
  // verb twice would mean one handler silently shadowing another.
  const handlers = cartRouter.stack.filter(l => l.route)
    .flatMap(l => Object.keys(l.route.methods).map(m => `${m} ${l.route.path}`));
  assert.equal(new Set(handlers).size, handlers.length, 'no handler is declared twice');
});

test('the increment never SETS an absolute quantity from the request', () => {
  assert.ok(!/qty\s*=\s*\$[0-9]/.test(CART_INCREMENT_SQL),
    'a client-supplied quantity has no place in "add one"');
  assert.equal(applySetExpression(CART_INCREMENT_SQL, 4), 5);
  assert.equal(insertedQuantity(CART_INCREMENT_SQL), 1,
    'a first click adds ONE piece — not a batch');
});

/* =====================================================================
   12. decrement to zero still empties the line
   ===================================================================== */

test('the cart still has a way to remove a line by setting it to zero', () => {
  assert.match(cartRouteSource,
    /delete from cart_items where user_id=\$1 and sku=\$2/,
    'the storefront cart decrements 1 -> 0 through the absolute endpoint');
  assert.ok(cartRouter.stack.some(l => l.route && l.route.path === '/delete-cart-item'),
    'and the explicit Remove control keeps its own route');
});

/* =====================================================================
   the shape of the refusal probe
   ===================================================================== */

test('the probe reports both the shelf and the line, for a truthful message', () => {
  assert.match(CART_INCREMENT_REFUSAL_SQL, /as available/);
  assert.match(CART_INCREMENT_REFUSAL_SQL, /as qty/);
  assert.match(CART_INCREMENT_REFUSAL_SQL, /v\.is_active/,
    'a de-activated variation must probe as unknown, not as out of stock');
});
