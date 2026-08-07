/* Per-visitor throttling of the public enquiry forms.

   THE DEFECT: the forms work without JavaScript, so the browser POSTs to the
   Astro page and the server forwards to the API. Every enquiry therefore
   reached the API from the Astro container's address, and the API's per-IP
   throttle counted the entire internet into ONE bucket of 8 per ten minutes.

   THE HAZARD IN FIXING IT: naively trusting `X-Forwarded-For` would let anyone
   mint a fresh identity per request — the exact vulnerability the API removed
   when `trust proxy` stopped being `true`. So the visitor is derived by
   counting in from the RIGHT by the number of proxies we actually have, which
   is the same discipline, and these assertions are mostly about proving that
   the spoofing route is closed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visitorAddress, visitorKey, trustedHops } from '../src/lib/visitor-identity.ts';
import {
  throttleVisitor, ENQUIRY_THROTTLE, _resetEnquiryThrottleForTesting,
} from '../src/lib/enquiry-throttle.ts';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** A request as Caddy would present it: XFF ending in the peer it observed. */
function through(caddySaw: string, clientSent?: string): Request {
  const chain = clientSent ? `${clientSent}, ${caddySaw}` : caddySaw;
  return new Request('https://veyora.test/contact', {
    method: 'POST',
    headers: { 'x-forwarded-for': chain },
  });
}

const ONE_HOP = { TRUST_PROXY_HOPS: '1' };

test.beforeEach(() => _resetEnquiryThrottleForTesting());

/* ============ 1 — different visitors, different budgets ============ */

test('1 — two different visitors get independent rate-limit budgets', () => {
  const alice = through('203.0.113.10');
  const bob = through('198.51.100.20');

  /* Alice exhausts hers. */
  for (let i = 0; i < ENQUIRY_THROTTLE.MAX_PER_WINDOW; i += 1) {
    assert.equal(throttleVisitor(alice, { env: ONE_HOP }).throttled, false,
      `alice's submission ${i + 1} is allowed`);
  }
  assert.equal(throttleVisitor(alice, { env: ONE_HOP }).throttled, true,
    'and the next one is not');

  /* Bob is unaffected — the defect was that he would not have been. */
  assert.equal(throttleVisitor(bob, { env: ONE_HOP }).throttled, false,
    'a second visitor has their own budget');
});

/* ============ 2 — one visitor is limited ============ */

test('2 — repeated submissions by one visitor are limited', () => {
  const visitor = through('203.0.113.10');
  let allowed = 0;
  for (let i = 0; i < ENQUIRY_THROTTLE.MAX_PER_WINDOW + 5; i += 1) {
    if (!throttleVisitor(visitor, { env: ONE_HOP }).throttled) allowed += 1;
  }
  assert.equal(allowed, ENQUIRY_THROTTLE.MAX_PER_WINDOW);
});

test('2b — the budget recovers after the window, rather than blocking forever', () => {
  const visitor = through('203.0.113.10');
  const t0 = 1_000_000;
  for (let i = 0; i < ENQUIRY_THROTTLE.MAX_PER_WINDOW; i += 1) {
    throttleVisitor(visitor, { now: t0, env: ONE_HOP });
  }
  assert.equal(throttleVisitor(visitor, { now: t0, env: ONE_HOP }).throttled, true);
  assert.equal(
    throttleVisitor(visitor, { now: t0 + ENQUIRY_THROTTLE.WINDOW_MS + 1, env: ONE_HOP }).throttled,
    false, 'a visitor who waits is allowed again');
});

/* ============ 3 — spoofing cannot mint identities ============ */

test('3 — a spoofed X-Forwarded-For cannot create unlimited identities', () => {
  /* The attack: send a different fabricated left-most entry every time and
     expect a fresh bucket each request. Caddy appends the real peer, so the
     trusted entry is the right-most one and every attempt lands in the SAME
     bucket. */
  let allowed = 0;
  for (let i = 0; i < ENQUIRY_THROTTLE.MAX_PER_WINDOW + 10; i += 1) {
    const spoofed = through('203.0.113.10', `10.0.0.${i}`);
    if (!throttleVisitor(spoofed, { env: ONE_HOP }).throttled) allowed += 1;
  }
  assert.equal(allowed, ENQUIRY_THROTTLE.MAX_PER_WINDOW,
    'varying the header one per request buys nothing');
});

test('3b — every spoofed shape resolves to the address Caddy observed', () => {
  const real = '203.0.113.10';
  for (const sent of [
    '1.2.3.4',
    '1.2.3.4, 5.6.7.8',
    '  1.2.3.4  ,  5.6.7.8  ',
    'not-an-ip',
    '::1',
    '1.2.3.4, 1.2.3.4, 1.2.3.4, 1.2.3.4',
  ]) {
    assert.equal(visitorAddress(through(real, sent), ONE_HOP), real,
      `"${sent}" must not displace the observed peer`);
  }
});

test('3c — a visitor cannot escape into the shared bucket either', () => {
  /* Resolving to '' would be worse than useless: unattributable traffic must
     be limited MORE, not exempted. */
  const noHeader = new Request('https://veyora.test/contact', { method: 'POST' });
  assert.equal(visitorKey(noHeader, ONE_HOP), 'ip:unknown');
  let allowed = 0;
  for (let i = 0; i < ENQUIRY_THROTTLE.MAX_PER_WINDOW + 5; i += 1) {
    if (!throttleVisitor(noHeader, { env: ONE_HOP }).throttled) allowed += 1;
  }
  assert.equal(allowed, ENQUIRY_THROTTLE.MAX_PER_WINDOW, 'the unknown bucket is limited too');
});

/* ============ 4 — the real configured topology ============ */

test('4 — the approved one-hop topology resolves the visitor', () => {
  assert.equal(visitorAddress(through('203.0.113.10'), ONE_HOP), '203.0.113.10');
  assert.equal(visitorKey(through('203.0.113.10'), ONE_HOP), 'ip:203.0.113.10');
});

test('4b — the hop count is the SAME variable the API reads', () => {
  /* Two independent numbers would drift in a deployment and nobody would
     notice until throttling silently collapsed again. */
  assert.equal(trustedHops({}), 1, 'the approved topology is the default');
  assert.equal(trustedHops({ TRUST_PROXY_HOPS: '2' }), 2);
  const compose = fs.readFileSync(
    path.resolve(SRC, '..', '..', 'docker-compose.yml'), 'utf8');
  assert.match(compose, /TRUST_PROXY_HOPS/,
    'the variable is declared in the deployment topology');
});

test('4c — two trusted hops read one further left', () => {
  const req = new Request('https://veyora.test/contact', {
    method: 'POST',
    headers: { 'x-forwarded-for': 'spoof, 203.0.113.10, 10.0.0.1' },
  });
  assert.equal(visitorAddress(req, { TRUST_PROXY_HOPS: '2' }), '203.0.113.10');
});

test('4d — an unparseable hop count falls back to the approved topology, not to zero', () => {
  /* Falling back to 0 would ignore the header entirely, make every visitor
     look like Caddy, and silently re-create the shared bucket. */
  for (const raw of ['', 'lots', '-1', '99', undefined]) {
    assert.equal(trustedHops({ TRUST_PROXY_HOPS: raw }), 1, `"${raw}" falls back to 1`);
  }
});

/* ============ 5 — untrusted callers fail safely ============ */

test('5 — with no proxy configured the header is ignored entirely', () => {
  /* TRUST_PROXY_HOPS=0 means nothing is in front of us, so X-Forwarded-For is
     wholly attacker-controlled and must not be consulted at all. */
  const req = through('203.0.113.10', 'anything');
  assert.equal(visitorAddress(req, { TRUST_PROXY_HOPS: '0' }), '');
  assert.equal(visitorKey(req, { TRUST_PROXY_HOPS: '0' }), 'ip:unknown');
});

test('5b — a chain shorter than the trusted hops refuses to guess', () => {
  /* The request did not come through the topology we expect. Picking the
     left-most entry "to have something" is exactly the spoofable behaviour
     this module exists to avoid. */
  const req = through('203.0.113.10');
  assert.equal(visitorAddress(req, { TRUST_PROXY_HOPS: '3' }), '');
});

test('5c — the throttle is applied BEFORE the submission is forwarded', () => {
  const page = fs.readFileSync(path.join(SRC, 'lib', 'enquiry-page.ts'), 'utf8');
  const throttleAt = page.indexOf('throttleVisitor(request)');
  const submitAt = page.indexOf('await submitEnquiry(');
  assert.ok(throttleAt > 0 && submitAt > 0);
  assert.ok(throttleAt < submitAt,
    'a throttled visitor must not reach the API at all');
});

/* ============ 6 — the duplicate guard is untouched ============ */

test('6 — enquiry duplicate protection remains separate and unchanged', () => {
  /* Two different controls answering two different questions: "is this the
     same enquiry twice?" lives in the API with the database; "is this too many
     enquiries?" lives here. Neither may be implemented in terms of the other. */
  const throttle = fs.readFileSync(path.join(SRC, 'lib', 'enquiry-throttle.ts'), 'utf8');
  for (const forbidden of [/dedupe/i, /fingerprint/i, /duplicate/i]) {
    const code = throttle.replace(/\/\*[\s\S]*?\*\//g, ' ');
    assert.ok(!forbidden.test(code), `the throttle must not implement ${forbidden}`);
  }

  /* And the API's own guard is still where it was — in the route module, on
     the INSERT, where the database can enforce it. */
  const api = path.resolve(SRC, '..', '..', 'api', 'src', 'routes', 'public-forms.js');
  const forms = fs.readFileSync(api, 'utf8');
  assert.match(forms, /on conflict \(dedupe_fingerprint\)/,
    'the server-side duplicate guard is unchanged');
  assert.match(forms, /submissionFingerprint\(/);
});

test('6b — the API limiter is left in place as defence in depth', () => {
  /* POST /api/forms/... reaches the API directly through Caddy with the real
     visitor address, so the API's limiter is correct for that path and must
     not have been removed in favour of this one. */
  const api = path.resolve(SRC, '..', '..', 'api', 'src', 'routes', 'public-forms.js');
  const code = fs.readFileSync(api, 'utf8');
  assert.match(code, /if \(throttled\(key\)\)/, 'the API still throttles');
  assert.match(code, /req\.ip/, 'and still keys on the address it observes');
});
