/* The origin and cookie-security contract (Security Hardening Phase 1).

   Covers findings AUTH-002 (cookie security derived from an ambiguous
   variable) and SEC-004 (three R-01 link fallbacks pointing at what becomes
   the public site after the cutover).

   `resolveOrigins()` takes an environment map rather than reading process.env,
   so every rule is exercised here without mutating global state. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveOrigins,
  normalizeOrigin,
  OriginConfigError,
  DEV_DEFAULT_PORTAL_ORIGIN,
  DEV_DEFAULT_PUBLIC_SITE_ORIGIN,
} from '../src/origins.js';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/* Comments stripped before scanning. Several of these files explain in prose
   exactly what they no longer do — "this used to read process.env.PUBLIC_URL",
   "the old fallback pointed at veyora.design" — and a scan that matched the
   explanation would fail on the very comment that documents the fix. The
   assertions below are about CODE. */
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

/** A complete, valid production environment. */
const PROD = Object.freeze({
  NODE_ENV: 'production',
  PORTAL_ORIGIN: 'https://portal.example.test',
  PUBLIC_SITE_ORIGIN: 'https://www.example.test',
});

const prod = (over = {}) => resolveOrigins({ ...PROD, ...over });

// ---------------------------------------------------------------------------
// 1-8 — cookie security no longer depends on PUBLIC_URL (AUTH-002)
// ---------------------------------------------------------------------------

test('1 — production defaults to Secure cookies', () => {
  assert.equal(prod().cookieSecure, true);
});

test('2 — PUBLIC_URL no longer controls cookie security, whatever it says', () => {
  /* THE regression test for AUTH-002. Previously
     `/^https:/i.test(process.env.PUBLIC_URL)` decided this, so every one of
     these would have produced an INSECURE cookie in production. */
  for (const publicUrl of [
    undefined,
    '',
    'http://plain.example.test',
    'https://www.example.test',      // repointed at the public site
    'veyora.design',                 // no scheme
    'not a url at all',
  ]) {
    const resolved = prod({ PORTAL_ORIGIN: 'https://portal.example.test', PUBLIC_URL: publicUrl });
    assert.equal(resolved.cookieSecure, true,
      `PUBLIC_URL=${JSON.stringify(publicUrl)} must not be able to disable Secure`);
  }
});

test('3 — development defaults to insecure cookies so local HTTP works', () => {
  const dev = resolveOrigins({ NODE_ENV: 'development' });
  assert.equal(dev.cookieSecure, false);
  assert.equal(dev.portalOrigin, DEV_DEFAULT_PORTAL_ORIGIN);
  assert.equal(dev.publicSiteOrigin, DEV_DEFAULT_PUBLIC_SITE_ORIGIN);
});

test('4 — neither development default is a real Veyora host', () => {
  const dev = resolveOrigins({ NODE_ENV: 'development' });
  for (const value of [dev.portalOrigin, dev.publicSiteOrigin, dev.adminOrigin]) {
    assert.doesNotMatch(value, /veyora/i);
  }
});

test('5 — COOKIE_SECURE can be set explicitly and is parsed strictly', () => {
  assert.equal(resolveOrigins({ NODE_ENV: 'development', COOKIE_SECURE: 'true' }).cookieSecure, true);
  assert.equal(resolveOrigins({ NODE_ENV: 'development', COOKIE_SECURE: 'false' }).cookieSecure, false);
  assert.throws(() => resolveOrigins({ NODE_ENV: 'development', COOKIE_SECURE: 'maybe' }), OriginConfigError);
});

test('6 — disabling Secure in production is refused without an explicit acknowledgement', () => {
  assert.throws(() => prod({ COOKIE_SECURE: 'false' }), /would send session cookies over plain HTTP/);
  // The escape hatch exists, but it has to be typed out deliberately.
  const acknowledged = prod({
    COOKIE_SECURE: 'false',
    ALLOW_INSECURE_COOKIES: 'i-accept-plaintext-sessions',
    PORTAL_ORIGIN: 'http://internal.example.test',
  });
  assert.equal(acknowledged.cookieSecure, false);
});

test('7 — a Secure cookie with a plain-http portal is refused as contradictory', () => {
  assert.throws(() => prod({ PORTAL_ORIGIN: 'http://portal.example.test' }),
    /would never be sent back/);
});

test('8 — the live COOKIE_OPTIONS keep HttpOnly, SameSite and a host-only scope', async () => {
  const { COOKIE_OPTIONS } = await import('../src/origins.js');
  assert.equal(COOKIE_OPTIONS.httpOnly, true);
  assert.equal(COOKIE_OPTIONS.sameSite, 'lax');
  assert.equal(COOKIE_OPTIONS.path, '/');
  assert.ok(!('domain' in COOKIE_OPTIONS),
    'no domain: the cookie must stay host-only and never reach a sibling subdomain');
});

// ---------------------------------------------------------------------------
// 9-18 — origin validation
// ---------------------------------------------------------------------------

test('9 — production requires PORTAL_ORIGIN; PUBLIC_SITE_ORIGIN is optional', () => {
  assert.throws(() => resolveOrigins({ NODE_ENV: 'production', PUBLIC_SITE_ORIGIN: 'https://a.example.test' }),
    /PORTAL_ORIGIN is required/);

  /* PUBLIC_SITE_ORIGIN is deliberately NOT required by the API: no API link
     points at the public website, so requiring it would make an existing
     deployment refuse to start over a value it never uses. */
  const withoutPublicSite = resolveOrigins({ NODE_ENV: 'production', PORTAL_ORIGIN: 'https://a.example.test' });
  assert.equal(withoutPublicSite.publicSiteOrigin, null);
});

test('9b — a public-site link fails closed when the origin is not configured', async () => {
  /* The requirement lives at the point of use. A missing variable must surface
     as a named error, never as a broken URL in a customer's email. */
  const src = code('origins.js');
  assert.match(src, /export function publicSiteLink/);
  assert.match(src, /PUBLIC_SITE_ORIGIN is not configured/);
  assert.ok(!/publicSiteLink = \(path/.test(src), 'must not silently interpolate a null origin');
});

test('10 — malformed origins are rejected: not a URL, wrong protocol', () => {
  assert.throws(() => prod({ PORTAL_ORIGIN: 'not-a-url' }), /absolute http\(s\) URL/);
  assert.throws(() => prod({ PORTAL_ORIGIN: 'ftp://portal.example.test' }), /must use http or https/);
  assert.throws(() => prod({ PORTAL_ORIGIN: 'javascript:alert(1)' }), OriginConfigError);
});

test('11 — embedded credentials are rejected', () => {
  assert.throws(() => prod({ PORTAL_ORIGIN: 'https://user:pass@portal.example.test' }),
    /must not contain embedded credentials/);
});

test('12 — fragments and query strings are rejected', () => {
  assert.throws(() => prod({ PORTAL_ORIGIN: 'https://portal.example.test/#/x' }), /must not contain a fragment/);
  assert.throws(() => prod({ PORTAL_ORIGIN: 'https://portal.example.test?a=1' }), /must not contain a query string/);
});

test('13 — a wildcard host is not a host', () => {
  for (const value of ['https://*.example.test', 'https://*', 'https://ex*ample.test']) {
    assert.throws(() => prod({ PORTAL_ORIGIN: value }), /single concrete host/, `${value} must be rejected`);
  }
});

test('14 — an unexpected path is rejected where an origin must be origin-only', () => {
  assert.throws(() => prod({ PORTAL_ORIGIN: 'https://portal.example.test/portal' }),
    /must be an origin with no path/);
  // A trailing slash is normalised away rather than rejected.
  assert.equal(prod({ PORTAL_ORIGIN: 'https://portal.example.test/' }).portalOrigin,
    'https://portal.example.test');
});

test('15 — ADMIN_ORIGIN may carry a path, and defaults to /admin on the portal host', () => {
  assert.equal(prod().adminOrigin, 'https://portal.example.test/admin');
  assert.equal(prod({ ADMIN_ORIGIN: 'https://admin.example.test' }).adminOrigin, 'https://admin.example.test');
  assert.equal(prod({ ADMIN_ORIGIN: 'https://portal.example.test/backoffice/' }).adminOrigin,
    'https://portal.example.test/backoffice');
});

test('16 — INTERNAL_API_ORIGIN is validated when present and null when absent', () => {
  assert.equal(prod().internalApiOrigin, null);
  assert.equal(prod({ INTERNAL_API_ORIGIN: 'http://api:3000' }).internalApiOrigin, 'http://api:3000');
  assert.throws(() => prod({ INTERNAL_API_ORIGIN: 'nonsense' }), OriginConfigError);
});

test('17 — PUBLIC_URL still works as a deprecated portal fallback, and says so', () => {
  /* An existing deployment sets PUBLIC_URL and not PORTAL_ORIGIN. Its current
     value IS the portal, so honouring it is correct today — but the fallback
     announces itself so it cannot quietly become wrong at the cutover. */
  const resolved = prod({ PORTAL_ORIGIN: undefined, PUBLIC_URL: 'https://legacy.example.test' });
  assert.equal(resolved.portalOrigin, 'https://legacy.example.test');
  assert.equal(resolved.deprecations.length, 1);
  assert.match(resolved.deprecations[0], /PUBLIC_URL/);
  // And an explicit PORTAL_ORIGIN wins with no deprecation notice.
  assert.deepEqual(prod({ PUBLIC_URL: 'https://legacy.example.test' }).deprecations, []);
});

test('18 — normalizeOrigin rejects an empty or non-string value', () => {
  for (const value of [undefined, null, '', '   ', 42, {}]) {
    assert.throws(() => normalizeOrigin(value, 'X'), OriginConfigError);
  }
});

// ---------------------------------------------------------------------------
// 19-22 — reverse-proxy trust
// ---------------------------------------------------------------------------

test('19 — proxy trust defaults to exactly one hop', () => {
  assert.equal(prod().trustProxyHops, 1);
});

test('20 — proxy hop count is explicit and bounded', () => {
  assert.equal(prod({ TRUST_PROXY_HOPS: '0' }).trustProxyHops, 0);
  assert.equal(prod({ TRUST_PROXY_HOPS: '2' }).trustProxyHops, 2);
  for (const bad of ['-1', '11', 'true', 'many', '1.5']) {
    assert.throws(() => prod({ TRUST_PROXY_HOPS: bad }), /TRUST_PROXY_HOPS/, `${bad} must be rejected`);
  }
});

test('21 — the app never trusts every proxy hop', () => {
  /* `trust proxy: true` lets a client set X-Forwarded-For and choose its own
     req.ip, which would make every IP-keyed rate limit bypassable. */
  const index = code('index.js');
  assert.ok(!/trust proxy['"],\s*true/.test(index), "trust proxy must not be `true`");
  assert.match(index, /trust proxy['"],\s*origins\.trustProxyHops/);
});

test('22 — a hostile X-Forwarded-For cannot reach through more hops than configured', () => {
  /* Express resolves req.ip by counting in from the RIGHT of the header by
     the configured hop count, so a client prepending entries cannot displace
     the address the proxy observed. This asserts the contract we depend on
     rather than re-implementing Express. */
  const hops = prod().trustProxyHops;
  assert.equal(hops, 1);
  assert.ok(Number.isInteger(hops) && hops >= 0, 'the hop count must be a number, never a boolean');
});

// ---------------------------------------------------------------------------
// 23-30 — R-01 links resolve to the right destination (SEC-004)
// ---------------------------------------------------------------------------

test('23 — no source file reads PUBLIC_URL for a link or a security decision', () => {
  /* origins.js is the ONE place allowed to look at it, and only as a
     deprecated fallback for PORTAL_ORIGIN. */
  const offenders = [];
  for (const file of ['authmw.js', 'emails.js', 'routes/catalog.js', 'index.js']) {
    if (code(file).includes('PUBLIC_URL')) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'PUBLIC_URL must only be read by src/origins.js');
});

test('24 — no hard-coded production hostname survives in the link paths', () => {
  for (const file of ['authmw.js', 'emails.js', 'routes/catalog.js', 'origins.js']) {
    assert.doesNotMatch(code(file), /veyora\.design|veyora\.com/i,
      `${file} still contains a hard-coded production hostname`);
  }
});

test('25 — the set-password link is a PORTAL link', async () => {
  const { portalLink } = await import('../src/origins.js');
  const link = portalLink('/#/set-password/TOKEN');
  assert.match(link, /^https?:\/\/[^/]+\/#\/set-password\/TOKEN$/);
  assert.match(code('authmw.js'), /portalLink\(`\/#\/set-password\//);
});

test('26 — order and backorder emails link to the PORTAL, admin alerts to ADMIN', () => {
  const emails = code('emails.js');
  assert.match(emails, /PORTAL\(`\/#\/order\/\$\{order\.id\}`\)/);
  assert.match(emails, /PORTAL\(`\/#\/backorders`\)/);
  assert.match(emails, /ADMIN\(`\/#\/orders`\)/);
  // and none of them goes to the public website
  assert.ok(!/publicSiteLink/.test(emails), 'no transactional email links to the public site');
});

test('27 — the shared-list URL is a PORTAL link', () => {
  /* 04_TARGET_ARCHITECTURE.md §8.1 keeps shared lists on the portal host: they
     show customer pricing, so they must never move to the public site. */
  assert.match(code('routes/catalog.js'), /portalLink\(`\/#\/list\/\$\{slug\}`\)/);
});

test('28 — every destination stays correct when the public site takes the catch-all', () => {
  /* The cutover: PUBLIC_SITE_ORIGIN becomes the apex host and the portal moves
     to its own name. Every portal and admin link must follow the portal. */
  const after = resolveOrigins({
    NODE_ENV: 'production',
    PUBLIC_SITE_ORIGIN: 'https://apex.example.test',      // the public site takes the apex
    PORTAL_ORIGIN: 'https://portal.example.test',          // portal moved to its own host
  });
  assert.equal(after.portalOrigin, 'https://portal.example.test');
  assert.equal(after.adminOrigin, 'https://portal.example.test/admin');
  assert.equal(after.publicSiteOrigin, 'https://apex.example.test');
  assert.notEqual(after.portalOrigin, after.publicSiteOrigin,
    'the portal and the public site must be distinguishable after the cutover');
});

test('29 — the internal API origin is never a link destination', () => {
  const resolved = prod({ INTERNAL_API_ORIGIN: 'http://api:3000' });
  assert.equal(resolved.internalApiOrigin, 'http://api:3000');
  // No link helper can produce it.
  assert.notEqual(resolved.portalOrigin, resolved.internalApiOrigin);
  assert.notEqual(resolved.adminOrigin, resolved.internalApiOrigin);
  assert.notEqual(resolved.publicSiteOrigin, resolved.internalApiOrigin);
  for (const file of ['emails.js', 'authmw.js', 'routes/catalog.js']) {
    assert.ok(!code(file).includes('internalApiOrigin'),
      `${file} must not be able to render the internal API origin`);
  }
});

test('30 — the resolved contract is frozen', () => {
  const resolved = prod();
  assert.throws(() => { 'use strict'; resolved.cookieSecure = false; }, TypeError);
  assert.throws(() => { 'use strict'; resolved.portalOrigin = 'https://evil.example.test'; }, TypeError);
});
