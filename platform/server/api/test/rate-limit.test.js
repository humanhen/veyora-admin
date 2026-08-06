/* Authentication abuse controls (Security Hardening Phase 2).

   Covers findings AUTH-004 / SEC-011. The limiter takes an injectable clock
   and store, so windows and expiry are exercised deterministically rather than
   by sleeping. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MemoryRateLimitStore,
  POLICIES,
  RATE_LIMIT_CONTRACT,
  accountKey,
  clientKey,
  rateLimit,
  resetRateLimits,
  store,
} from '../src/rate-limit.js';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** Drives a middleware and reports what it did. */
function run(mw, req) {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      set: (k, v) => { headers[k] = v; return res; },
      status: (code) => ({ json: (body) => resolve({ outcome: 'limited', code, body, headers }) }),
    };
    mw(req, res, () => resolve({ outcome: 'allowed', headers }));
  });
}

const request = (ip, body = {}) => ({ ip, body, socket: { remoteAddress: ip } });

/** A limiter with a controllable clock and its own store. */
function limiter(policy, opts = {}) {
  const limiterStore = new MemoryRateLimitStore();
  let clock = 1_000_000;
  const mw = rateLimit(policy, { ...opts, now: () => clock, limiterStore });
  return {
    mw,
    limiterStore,
    advance: (ms) => { clock += ms; },
    hit: (req) => run(mw, req),
  };
}

// ---------------------------------------------------------------------------
// 1-8 — thresholds
// ---------------------------------------------------------------------------

test('1 — attempts below the threshold are allowed', async () => {
  const l = limiter(POLICIES.login);
  for (let i = 0; i < POLICIES.login.limit; i += 1) {
    const result = await l.hit(request('203.0.113.5'));
    assert.equal(result.outcome, 'allowed', `attempt ${i + 1} should be allowed`);
  }
});

test('2 — the threshold is enforced', async () => {
  const l = limiter(POLICIES.login);
  for (let i = 0; i < POLICIES.login.limit; i += 1) await l.hit(request('203.0.113.5'));
  const blocked = await l.hit(request('203.0.113.5'));
  assert.equal(blocked.outcome, 'limited');
  assert.equal(blocked.code, 429);
});

test('3 — a 429 carries Retry-After in seconds', async () => {
  const l = limiter(POLICIES.login);
  for (let i = 0; i <= POLICIES.login.limit; i += 1) await l.hit(request('203.0.113.5'));
  const blocked = await l.hit(request('203.0.113.5'));
  const retryAfter = Number(blocked.headers['Retry-After']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0, 'Retry-After must be a positive integer');
  assert.ok(retryAfter <= POLICIES.login.windowMs / 1000);
  assert.equal(blocked.body.retryAfter, retryAfter);
});

test('4 — the window expires and access is restored', async () => {
  const l = limiter(POLICIES.login);
  for (let i = 0; i <= POLICIES.login.limit; i += 1) await l.hit(request('203.0.113.5'));
  assert.equal((await l.hit(request('203.0.113.5'))).outcome, 'limited');

  l.advance(POLICIES.login.windowMs + 1);
  assert.equal((await l.hit(request('203.0.113.5'))).outcome, 'allowed',
    'a fresh window must restore access');
});

test('5 — separate clients get separate budgets', async () => {
  const l = limiter(POLICIES.login);
  for (let i = 0; i <= POLICIES.login.limit; i += 1) await l.hit(request('203.0.113.5'));
  assert.equal((await l.hit(request('203.0.113.5'))).outcome, 'limited');
  assert.equal((await l.hit(request('198.51.100.9'))).outcome, 'allowed',
    'one client must not exhaust another client\'s budget');
});

test('6 — the per-account budget is stricter and independent of the client', async () => {
  /* One account attacked from many addresses: the client bucket never fills,
     so only the account bucket can stop it. */
  const l = limiter(POLICIES.login, { identify: (req) => req.body.email });
  const target = 'victim@example.test';
  let limited = 0;
  for (let i = 0; i < POLICIES.login.perAccountLimit + 3; i += 1) {
    const result = await l.hit(request(`203.0.113.${i + 1}`, { email: target }));
    if (result.outcome === 'limited') limited += 1;
  }
  assert.ok(limited > 0, 'a distributed attack on one account must be limited');
});

test('7 — one client cannot spray many accounts', async () => {
  const l = limiter(POLICIES.otpRequest, { identify: (req) => req.body.email });
  let limited = 0;
  for (let i = 0; i < POLICIES.otpRequest.limit + 3; i += 1) {
    const result = await l.hit(request('203.0.113.5', { email: `person${i}@example.test` }));
    if (result.outcome === 'limited') limited += 1;
  }
  assert.ok(limited > 0, 'the client bucket must stop a spray across many accounts');
});

test('8 — the OTP verify policy is the strictest, and cannot exhaust a 6-digit space', async () => {
  const otp = POLICIES.otpVerify;
  assert.ok(otp.perAccountLimit <= 5, 'a six-digit code needs a tight per-account limit');
  /* 900,000 possible codes, expiring in 15 minutes. At this rate an exhaustive
     search is impossible by many orders of magnitude. */
  const attemptsPerCodeLifetime = otp.perAccountLimit * (15 * 60_000 / otp.windowMs);
  assert.ok(attemptsPerCodeLifetime < 100,
    `an attacker gets ${attemptsPerCodeLifetime} guesses per code lifetime, which must stay tiny`);
});

// ---------------------------------------------------------------------------
// 9-14 — no leakage, no enumeration
// ---------------------------------------------------------------------------

test('9 — account keys are hashed, never the address itself', () => {
  const key = accountKey('Person@Example.Test');
  assert.ok(!key.includes('@'), 'a limiter key must not contain an email address');
  assert.ok(!key.toLowerCase().includes('person'));
  assert.match(key, /^[0-9a-f]{24}$/);
});

test('10 — account keys are case- and whitespace-normalised', () => {
  assert.equal(accountKey('  Person@Example.Test '), accountKey('person@example.test'));
  assert.equal(accountKey(''), null);
  assert.equal(accountKey(undefined), null);
});

test('11 — the 429 body carries no account information at all', async () => {
  const l = limiter(POLICIES.login, { identify: (req) => req.body.email });
  let blocked = null;
  for (let i = 0; i < POLICIES.login.limit + 5 && !blocked; i += 1) {
    const result = await l.hit(request('203.0.113.5', { email: 'someone@example.test' }));
    if (result.outcome === 'limited') blocked = result;
  }
  assert.ok(blocked);
  const json = JSON.stringify(blocked.body);
  assert.ok(!json.includes('someone'), 'no identifier may appear in the response');
  assert.ok(!json.includes('example.test'));
  assert.deepEqual(Object.keys(blocked.body).sort(), ['error', 'retryAfter']);
});

test('12 — the limited response is identical whether or not the account exists', async () => {
  /* The limiter never looks the account up, so it cannot differ. This asserts
     the property directly: two different identifiers produce byte-identical
     responses. */
  const a = limiter(POLICIES.login, { identify: (req) => req.body.email });
  const b = limiter(POLICIES.login, { identify: (req) => req.body.email });
  const fill = async (l, email) => {
    let last = null;
    for (let i = 0; i < POLICIES.login.limit + 5; i += 1) {
      last = await l.hit(request('203.0.113.5', { email }));
    }
    return last;
  };
  const real = await fill(a, 'real@example.test');
  const fake = await fill(b, 'does-not-exist@example.test');
  assert.equal(real.outcome, 'limited');
  assert.deepEqual(real.body, fake.body);
  assert.equal(real.headers['Retry-After'], fake.headers['Retry-After']);
});

test('13 — no password, token or credential is ever read by the limiter', () => {
  /* Matches credential ACCESS, not the word. `passwordSet` is a policy name —
     the endpoint it guards — and says nothing about what is read. */
  const src = code('rate-limit.js');
  for (const forbidden of [
    /\.password\b/, /\bpassword_hash\b/, /\bpasswordHash\b/,
    /body\??\.\s*token/, /\bsecret\b/i, /\bbcrypt\b/,
  ]) {
    assert.ok(!forbidden.test(src), `the limiter must not read ${forbidden}`);
  }
  /* The only request fields any limiter reads are the identifiers the route
     already accepts. */
  const routes = code('routes/auth.js');
  const identifiers = [...routes.matchAll(/const \w+ = \(req\) => ([^;]+);/g)].map((m) => m[1]);
  assert.deepEqual(identifiers, ['req.body?.email', 'req.body?.email || req.body?.username']);
  for (const expr of identifiers) {
    assert.ok(!/password|token/i.test(expr), `a limiter key must not be built from ${expr}`);
  }
});

test('14 — the limiter logs nothing', () => {
  const src = code('rate-limit.js');
  assert.ok(!/console\.(log|warn|error|info)/.test(src),
    'a limiter that logs identifiers is a PII store nobody reviewed');
});

// ---------------------------------------------------------------------------
// 15-19 — proxy handling
// ---------------------------------------------------------------------------

test('15 — the client key comes from req.ip, which trust-proxy makes trustworthy', () => {
  assert.equal(clientKey({ ip: '203.0.113.5' }), 'ip:203.0.113.5');
  assert.equal(clientKey({ socket: { remoteAddress: '198.51.100.2' } }), 'ip:198.51.100.2');
});

test('16 — an unattributable request is limited, not exempted', async () => {
  /* Malformed or absent forwarding information must not be a way OUT of the
     limiter. Everything unattributable shares one bucket, which is stricter
     than being unlimited, not looser. */
  assert.equal(clientKey({}), 'ip:unknown');
  assert.equal(clientKey(null), 'ip:unknown');

  const l = limiter(POLICIES.login);
  for (let i = 0; i <= POLICIES.login.limit; i += 1) await l.hit({ body: {} });
  assert.equal((await l.hit({ body: {} })).outcome, 'limited');
});

test('17 — the limiter never reads a forwarding header itself', () => {
  /* It must rely on Express's resolved req.ip, which honours the configured
     hop count. Reading X-Forwarded-For directly would reintroduce exactly the
     spoofing the Phase 1 trust-proxy fix removed. */
  const src = code('rate-limit.js');
  assert.ok(!/x-forwarded-for/i.test(src));
  assert.ok(!/req\.headers/.test(src));
});

test('18 — a hostile forwarding header cannot change the key when hops are counted', () => {
  /* Express resolves req.ip by counting in from the RIGHT by the configured
     hop count, so prepended entries are ignored. This asserts the setting the
     property depends on. */
  const index = code('index.js');
  assert.match(index, /trust proxy['"],\s*origins\.trustProxyHops/);
  assert.ok(!/trust proxy['"],\s*true/.test(index));
});

test('19 — every sensitive auth route carries a limiter', () => {
  const routes = code('routes/auth.js');
  const limited = [...routes.matchAll(/r\.post\('([^']+)',\s*(limit[A-Za-z]+)/g)]
    .map((m) => [m[1], m[2]]);
  const paths = limited.map(([p]) => p).sort();
  assert.deepEqual(paths, [
    '/forgot-password',
    '/login',
    '/request-activation-otp',
    '/reset-password',
    '/set-password',
    '/verify-activation-otp',
    '/verify-forgot-otp',
  ]);
  /* /logout is deliberately unlimited: it destroys a session rather than
     granting one, and limiting it would let an attacker keep a victim signed
     in. */
  assert.match(routes, /r\.post\('\/logout', async/);
});

// ---------------------------------------------------------------------------
// 20-25 — bounded storage
// ---------------------------------------------------------------------------

test('20 — expired entries are cleaned up', () => {
  const s = new MemoryRateLimitStore();
  s.hit('a', 1000, 0);
  s.hit('b', 1000, 0);
  assert.equal(s.size, 2);
  s.hit('c', 1000, 5000);   // a write after both expired
  assert.equal(s.size, 1, 'the sweep must drop expired entries');
});

test('21 — storage is hard-capped and evicts the oldest', () => {
  const s = new MemoryRateLimitStore({ maxKeys: 10 });
  for (let i = 0; i < 500; i += 1) s.hit(`key-${i}`, 60_000, 1000);
  assert.ok(s.size <= 10, `expected at most 10 tracked keys, got ${s.size}`);
});

test('22 — an unbounded flood of distinct clients cannot exhaust memory', async () => {
  const limiterStore = new MemoryRateLimitStore({ maxKeys: 50 });
  const mw = rateLimit(POLICIES.login, { now: () => 1000, limiterStore });
  for (let i = 0; i < 5000; i += 1) {
    await run(mw, request(`203.0.113.${i % 256}.${i}`));
  }
  assert.ok(limiterStore.size <= 50, `limiter grew to ${limiterStore.size} keys`);
});

test('23 — the store can be reset deterministically for tests', () => {
  const s = new MemoryRateLimitStore();
  s.hit('a', 1000, 0);
  s.reset('a');
  assert.equal(s.size, 0);
  s.hit('a', 1000, 0); s.hit('b', 1000, 0);
  s.reset();
  assert.equal(s.size, 0);
  // and the shared process store exposes the same escape hatch
  resetRateLimits();
  assert.equal(store.size, 0);
});

test('24 — the storage is behind an adapter, so a shared store can replace it', () => {
  const src = read('rate-limit.js');
  assert.match(src, /export class MemoryRateLimitStore/);
  for (const method of ['hit(', 'reset(', 'get size(']) {
    assert.ok(src.includes(method), `the store interface needs ${method}`);
  }
  /* rateLimit() takes the store as a parameter rather than reaching for the
     module-level one, which is what makes replacement a one-class change. */
  assert.match(src, /limiterStore = store/);
});

test('25 — the single-container limitation is documented in the module itself', () => {
  const src = read('rate-limit.js');
  assert.match(src, /single-container|ONE api container/i,
    'the in-process limitation must be stated where a maintainer will see it');
  assert.equal(RATE_LIMIT_CONTRACT.storage, 'in-process fixed window; single-container topology only');
});

// ---------------------------------------------------------------------------
// 26-28 — scope
// ---------------------------------------------------------------------------

test('26 — unrelated API routes are unaffected', () => {
  /* The limiter is applied per route in routes/auth.js, never globally in
     index.js, so nothing else on the API changes behaviour. */
  assert.ok(!code('index.js').includes('rateLimit'),
    'no global rate limit — that would throttle the catalogue and the admin panel too');
  for (const file of ['routes/orders.js', 'routes/catalog.js', 'routes/admin.js', 'routes/public.js']) {
    assert.ok(!code(file).includes('rate-limit'), `${file} must not import the auth limiter`);
  }
});

test('27 — the public enquiry forms keep their own separate throttle', () => {
  /* public-forms.js has an in-process throttle of its own with different
     limits. Phase 2 does not disturb it; it is recorded as a follow-up. */
  assert.match(code('routes/public-forms.js'), /throttled\(/);
});

test('28 — the policy set is frozen and complete', () => {
  assert.throws(() => { 'use strict'; POLICIES.login = null; }, TypeError);
  assert.throws(() => { 'use strict'; POLICIES.login.limit = 9999; }, TypeError);
  for (const [name, policy] of Object.entries(POLICIES)) {
    assert.ok(policy.limit > 0, `${name} needs a positive limit`);
    assert.ok(policy.windowMs > 0, `${name} needs a positive window`);
    assert.ok(policy.name, `${name} needs a key prefix`);
  }
});
