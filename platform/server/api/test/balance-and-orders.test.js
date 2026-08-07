/* Client feedback items G, H, I and J.

   G — Balance & Payments, and a credit limit where NULL means NOT CONFIGURED
   H — invoices reachable from where money questions are asked
   I — orders expand to their items, and carry the address AS IT WAS
   J — the phone nav is the five things a buyer does

   The credit-limit rule is the one worth stating twice: NULL IS NOT UNLIMITED.
   Every account in the database reads NULL the moment 0017 runs, so a build
   that treated the two as the same would grant infinite credit to the entire
   customer base in one deploy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { accountBalance, __testing } from '../src/account-balance.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const STOREFRONT = path.resolve(HERE, '..', '..', 'storefront');
const MIGRATIONS = path.resolve(HERE, '..', '..', 'db', 'migrations');
const readSf = p => fs.readFileSync(path.join(STOREFRONT, p), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/* ---------- a database double ---------- */

function db(world = {}) {
  const w = {
    users: [{
      id: 'cust-a', balance: '4000.00', credit_limit: null,
      currency: 'usd', payment_terms: 'Net 30',
    }],
    invoices: [], payments: [], credit_notes: [],
    ...world,
  };
  return {
    w,
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      const s = sql.replace(/\s+/g, ' ').trim();
      const [id] = params;
      if (s.startsWith('select id, balance, credit_limit')) {
        return { rows: w.users.filter(u => u.id === id) };
      }
      if (s.startsWith('select id, number, amount')) return { rows: w.invoices };
      if (s.startsWith('select id, amount, method')) return { rows: w.payments };
      if (s.startsWith('select id, amount, reason')) return { rows: w.credit_notes };
      throw new Error(`unexpected query: ${s.slice(0, 80)}`);
    },
  };
}

/* ============ G — the credit limit ============ */

test('an unset credit limit is reported as NOT CONFIGURED, never as unlimited', async () => {
  const b = await accountBalance(db(), 'cust-a');
  assert.equal(b.creditLimitConfigured, false);
  assert.equal(b.creditLimit, null, 'no number is invented');
  assert.equal(b.creditAvailable, null, 'and no headroom is computed from one');
  assert.equal(b.overLimit, false, 'an unset limit cannot be exceeded');
});

test('an unset limit is not silently treated as zero either', async () => {
  /* Zero would say the customer may order nothing — the opposite mistake, and
     just as wrong. */
  const b = await accountBalance(db(), 'cust-a');
  assert.notEqual(b.creditLimit, '0.00');
  assert.notEqual(b.creditAvailable, '0.00');
});

test('a configured limit produces a real headroom figure', async () => {
  const d = db({ users: [{ id: 'cust-a', balance: '4000.00', credit_limit: '10000.00', currency: 'USD', payment_terms: '' }] });
  const b = await accountBalance(d, 'cust-a');
  assert.equal(b.creditLimitConfigured, true);
  assert.equal(b.creditLimit, '10000.00');
  assert.equal(b.creditAvailable, '6000.00');
  assert.equal(b.overLimit, false);
});

test('being over the limit is reported as such', async () => {
  const d = db({ users: [{ id: 'cust-a', balance: '12500.00', credit_limit: '10000.00', currency: 'USD', payment_terms: '' }] });
  const b = await accountBalance(d, 'cust-a');
  assert.equal(b.overLimit, true);
  assert.equal(b.creditAvailable, '-2500.00', 'the shortfall is a real number, not a clamp');
});

test('a zero credit limit is configured — it is not the same as unset', async () => {
  /* 0 is a deliberate commercial decision: pro-forma only. It must not read as
     "not configured", which would invite somebody to set one that already is. */
  const d = db({ users: [{ id: 'cust-a', balance: '0.00', credit_limit: '0.00', currency: 'USD', payment_terms: '' }] });
  const b = await accountBalance(d, 'cust-a');
  assert.equal(b.creditLimitConfigured, true);
  assert.equal(b.creditLimit, '0.00');

  /* And as the NUMBER zero, not only the string. `pg` returns numeric as a
     string today, so a truthiness check passes by accident on '0.00'; it
     would report a real zero limit as unset the moment that changed. The
     check must be against null/undefined, not against falsiness. */
  const asNumber = db({ users: [{ id: 'cust-a', balance: 0, credit_limit: 0, currency: 'USD', payment_terms: '' }] });
  const n = await accountBalance(asNumber, 'cust-a');
  assert.equal(n.creditLimitConfigured, true, 'a zero limit is a decision, however it is typed');
  assert.equal(n.creditLimit, '0.00');
});

test('money is never routed through a float', async () => {
  /* 29.97 * 100 is 2996.9999999999995. Three invoices added as JS numbers is
     how a balance ends up at 4079.999999999999 on a customer's screen. */
  const { toCents, fromCents } = __testing;
  assert.equal(toCents('29.97'), 2997);
  assert.equal(toCents('0.1') + toCents('0.2'), toCents('0.3'));
  assert.equal(fromCents(toCents('1234.05')), '1234.05');
  assert.equal(fromCents(toCents('-2500')), '-2500.00');
  const src = fs.readFileSync(path.join(SRC, 'account-balance.js'), 'utf8');
  assert.ok(!/parseFloat/.test(strip(src)), 'no parseFloat anywhere');
});

test('outstanding excludes settled invoices but INCLUDES ones still confirming', async () => {
  /* A completed checkout is not a settled invoice until a signed webhook says
     so. Counting `processing` as settled here would contradict the one rule
     the whole payment design exists to protect. */
  const d = db({
    invoices: [
      { id: '1', number: 'A', amount: '100.00', settlement_state: 'on_terms' },
      { id: '2', number: 'B', amount: '200.00', settlement_state: 'processing' },
      { id: '3', number: 'C', amount: '400.00', settlement_state: 'paid' },
      { id: '4', number: 'D', amount: '800.00', settlement_state: 'refunded' },
      { id: '5', number: 'E', amount: '1600.00', settlement_state: 'void' },
    ],
  });
  const b = await accountBalance(d, 'cust-a');
  assert.equal(b.outstanding, '300.00', 'on_terms + processing');
  assert.deepEqual(b.invoices.filter(i => i.outstanding).map(i => i.number), ['A', 'B']);
});

test('an invoice with no settlement state counts as outstanding', async () => {
  /* Rows written before 0013 have none. Outstanding on account terms is what
     they are, and it is also the safe reading. */
  const d = db({ invoices: [{ id: '1', number: 'A', amount: '50.00', settlement_state: null }] });
  const b = await accountBalance(d, 'cust-a');
  assert.equal(b.outstanding, '50.00');
});

test('the account is read from the session id, and only that account', async () => {
  const d = db();
  await accountBalance(d, 'cust-a');
  for (const call of d.calls) {
    assert.match(call.sql, /where (customer_id|id) = \$1/,
      `every query is scoped: ${call.sql.slice(0, 80)}`);
    assert.equal(call.params[0], 'cust-a');
  }
});

test('an unknown account returns null rather than an empty-but-plausible page', async () => {
  assert.equal(await accountBalance(db(), 'nobody'), null);
});

test('the response is a fresh literal — no database row is spread into it', async () => {
  const d = db({ users: [{ id: 'cust-a', balance: '1.00', credit_limit: null, currency: 'USD', payment_terms: '', password_hash: 'SECRET', role: 'customer' }] });
  const b = await accountBalance(d, 'cust-a');
  assert.ok(!('password_hash' in b));
  assert.ok(!('role' in b));
  assert.ok(!('id' in b));
  const src = strip(fs.readFileSync(path.join(SRC, 'account-balance.js'), 'utf8'));
  assert.ok(!/\.\.\.u\b|\.\.\.rows|\.\.\.users\[/.test(src), 'no row is spread');
});

/* ============ the customer may never set it ============ */

test('there is no write route for the credit limit', () => {
  const account = strip(fs.readFileSync(path.join(SRC, 'routes', 'account.js'), 'utf8'));
  assert.ok(!/credit_limit/.test(account), 'the route module never names the column');
  assert.match(account, /r\.get\('\/balance'/, 'the only balance route is a GET');
  const balanceRoutes = [...account.matchAll(/r\.(get|post|put|patch|delete)\('\/balance/g)]
    .map(m => m[1]);
  assert.deepEqual(balanceRoutes, ['get'], 'read-only');
});

test('the generic admin sync cannot write a credit limit', () => {
  /* A credit limit must move through a deliberate action, not a whole-row diff
     posted by a browser that happened to have the account loaded. */
  const shape = fs.readFileSync(path.join(SRC, 'shape.js'), 'utf8');
  const users = shape.slice(shape.indexOf('users: {'), shape.indexOf('promotions: {'));
  assert.ok(!/credit_limit|creditLimit/.test(users),
    'credit_limit is deliberately absent from the users sync collection');
  assert.match(users, /balance: 'balance'/, 'the collection is otherwise intact');
});

test('the storefront never offers to edit it', () => {
  const page = strip(readSf('js/pages_balance.js'));
  assert.ok(!/API\.(post|put|patch|del)/.test(page), 'the page never writes');
  assert.ok(!/<input|<select|<textarea/.test(page), 'and offers no field to write with');
});

test('the migration is additive and says what NULL means', () => {
  const sql = fs.readFileSync(path.join(MIGRATIONS, '0017_credit_limit.sql'), 'utf8');
  const statements = sql.replace(/^\s*--[^\n]*$/gm, ' ');
  assert.match(statements, /add column if not exists credit_limit/i);
  for (const destructive of [/drop\s+table/i, /drop\s+column/i, /alter\s+column/i,
    /truncate/i, /delete\s+from/i, /\bupdate\s+users\b/i]) {
    assert.doesNotMatch(statements, destructive, `0017 must not ${destructive}`);
  }
  assert.ok(!/default/i.test(statements.split('comment on')[0]),
    'no default — a backfilled number would be an invented commercial decision');
  assert.match(sql, /NULL (means|IS NOT)/i, 'the meaning of NULL is recorded in the migration');
});

test('the storefront says "not configured" in those words', () => {
  const page = readSf('js/pages_balance.js');
  assert.match(page, /Not configured/);
  assert.match(page, /No credit limit has been set for this account/);
  assert.ok(!/unlimited/i.test(strip(page)), 'and never the word unlimited');
});

/* ============ H — invoices are reachable ============ */

test('Balance & Invoices is in the main navigation', () => {
  const app = readSf('js/app.js');
  assert.match(app, /\{ hash: '#\/balance',\s*label: 'Balance & Invoices' \}/);
});

test('the balance page is registered and loaded', () => {
  assert.match(readSf('js/pages_balance.js'), /Routes\['#\/balance'\]/);
  assert.match(readSf('index.html'), /js\/pages_balance\.js/);
});

test('the balance page reuses the one payment control', () => {
  /* Two implementations of "which invoice is payable" is how two screens come
     to disagree about it. */
  const page = readSf('js/pages_balance.js');
  assert.match(page, /payButton\(i\)/);
  assert.match(page, /startInvoicePayment\(btn, btn\.dataset\.pay\)/);
  assert.ok(!/settlementState !== 'on_terms'/.test(page),
    'the payability rule is not re-implemented here');
});

/* ============ I — orders expand, and carry the address as it was ============ */

test('an order stamps a complete address snapshot, never NULL', () => {
  const orders = fs.readFileSync(path.join(SRC, 'routes', 'orders.js'), 'utf8');
  assert.match(orders, /JSON\.stringify\(stampAddress\(customer, req\.body\?\.shippingAddress\)\)/);
  assert.ok(!/req\.body\?\.shippingAddress \? JSON\.stringify/.test(orders),
    "the browser's word for it is no longer stored raw");
});

test('the snapshot is built from the customer, with the request only overriding', () => {
  const orders = fs.readFileSync(path.join(SRC, 'routes', 'orders.js'), 'utf8');
  const fn = orders.slice(orders.indexOf('function stampAddress'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /customer\?\.\[field\]/, 'the customer record is the base');
  assert.match(body, /ADDRESS_FIELDS/, 'and only address fields are copied');
  assert.match(body, /slice\(0, 200\)/, 'each field is bounded');
  assert.match(body, /stampedAt/, 'the snapshot records when it was taken');
});

test('the storefront never falls back to the current profile address', () => {
  /* A customer who moves must not see historical orders redirected to their
     new premises. */
  const page = readSf('js/pages_orders.js');
  const fn = page.slice(page.indexOf('function stampedAddress'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(!/Store\.session/.test(body), 'the session profile is never consulted');
  assert.ok(!/get-addresses|shipping-info/.test(body), 'nor is the address endpoint');
  assert.match(body, /No delivery address was recorded with this order/,
    'an order with no stamped address says so');
});

test('order lines carry an image, from the variation join', () => {
  const orders = fs.readFileSync(path.join(SRC, 'routes', 'orders.js'), 'utf8');
  assert.match(orders, /image: i\.image \?\? null/);
  assert.match(orders, /select i\.\*, p\.sku as model_sku, p\.brand, v\.image/);
});

test('an order row expands in place, and does not fetch until it is opened', () => {
  const page = readSf('js/pages_orders.js');
  assert.match(page, /aria-expanded="false"/, 'the toggle declares its state');
  assert.match(page, /if \(detail\) \{ detail\.hidden = false; return; \}/,
    'a second expand reuses what was fetched');
  const fn = page.slice(page.indexOf('function bindOrderRows'));
  assert.ok(fn.indexOf("toggle.onclick") < fn.indexOf('get-order-detail'),
    'the fetch happens inside the click, not during render');
});

test('expanding does not also open the order', () => {
  const page = readSf('js/pages_orders.js');
  assert.match(page, /if \(e\.target\.closest\('\.ord-toggle'\)\) return;/,
    'the row click stands down for the caret');
});

/* ============ J — the phone nav ============ */

function loadNav() {
  const ctx = { console, location: { hash: '#/' }, history: {}, setTimeout };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSf('js/icons.js'), ctx, { filename: 'icons.js' });
  const app = readSf('js/app.js');
  vm.runInContext(app.slice(0, app.indexOf('function shell(')), ctx, { filename: 'app.js' });
  /* `const` at the top level of a plain browser script is not a property of
     the global object, so these are read by evaluating their names rather than
     plucked off the context — which would silently be undefined. */
  /* Round-tripped through JSON as well, because an array built inside the vm
     has that realm's prototype and `deepEqual` refuses to match it against a
     plain one — a failure that looks like a content mismatch and is not. */
  const lift = name => JSON.parse(JSON.stringify(vm.runInContext(name, ctx)));
  ctx.BOTTOM_NAV = lift('BOTTOM_NAV');
  ctx.NAVICON = lift('NAVICON');
  return ctx;
}

test('the phone nav is Home, Products, Orders, Cart, Account', () => {
  const { BOTTOM_NAV } = loadNav();
  assert.deepEqual(BOTTOM_NAV.map(n => n.label),
    ['Home', 'Products', 'Orders', 'Cart', 'Account']);
  assert.deepEqual(BOTTOM_NAV.map(n => n.hash),
    ['#/', '#/products', '#/orders', '#/cart', '#/dashboard']);
});

test('every phone nav icon exists in the registry', () => {
  const { BOTTOM_NAV, NAVICON } = loadNav();
  for (const n of BOTTOM_NAV) {
    assert.ok(NAVICON[n.icon], `${n.label} needs the "${n.icon}" icon`);
    assert.match(NAVICON[n.icon], /<svg/, `${n.icon} renders`);
  }
});

test('Spare Parts is moved out of the phone nav but KEPT everywhere else', () => {
  /* Moved, not removed: the route, the side-nav entry and the page all stay. */
  const { BOTTOM_NAV } = loadNav();
  assert.ok(!BOTTOM_NAV.some(n => n.hash === '#/spare-parts'),
    'it no longer occupies one of five phone slots');

  const app = readSf('js/app.js');
  assert.match(app, /\{ hash: '#\/spare-parts', label: 'Spare Parts' \}/,
    'but it is still in the main navigation');
  const files = fs.readdirSync(path.join(STOREFRONT, 'js'));
  const registered = files.some(f => readSf(`js/${f}`).includes("Routes['#/spare-parts']"));
  assert.ok(registered, 'and the route still exists');
});

test('the new screen has a Back destination like every other', () => {
  const { backTarget } = loadNav();
  assert.equal(backTarget('#/balance'), '#/dashboard');
});
