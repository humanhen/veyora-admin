import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLegacyHashRedirect, LEGACY_HASH_ALLOWED_PREFIXES } from '../src/lib/legacy-hash-bridge.ts';

const PORTAL_ORIGIN = 'http://127.0.0.1:4322';

test('every allowed prefix redirects to PORTAL_ORIGIN with the fragment preserved verbatim', () => {
  for (const prefix of LEGACY_HASH_ALLOWED_PREFIXES) {
    const hash = `#/${prefix}`;
    assert.equal(resolveLegacyHashRedirect(hash, PORTAL_ORIGIN), `${PORTAL_ORIGIN}${hash}`, `prefix "${prefix}" did not redirect`);
  }
});

test('an allowed prefix with a deeper token/slug path preserves the entire fragment', () => {
  const hash = '#/set-password/abc123-token';
  assert.equal(resolveLegacyHashRedirect(hash, PORTAL_ORIGIN), `${PORTAL_ORIGIN}${hash}`);
});

test('an allowed prefix with a trailing slash (empty final segment) still redirects, unchanged', () => {
  const hash = '#/list/';
  assert.equal(resolveLegacyHashRedirect(hash, PORTAL_ORIGIN), `${PORTAL_ORIGIN}${hash}`);
});

test('an unknown prefix performs no redirect', () => {
  assert.equal(resolveLegacyHashRedirect('#/unknown-route', PORTAL_ORIGIN), null);
});

test('an empty prefix (just "#/") performs no redirect', () => {
  assert.equal(resolveLegacyHashRedirect('#/', PORTAL_ORIGIN), null);
});

test('a hash not beginning with "#/" is ignored entirely', () => {
  assert.equal(resolveLegacyHashRedirect('#login', PORTAL_ORIGIN), null);
  assert.equal(resolveLegacyHashRedirect('', PORTAL_ORIGIN), null);
  assert.equal(resolveLegacyHashRedirect('#', PORTAL_ORIGIN), null);
});

test('protocol-relative injection ("#//evil.example") performs no redirect', () => {
  assert.equal(resolveLegacyHashRedirect('#//evil.example', PORTAL_ORIGIN), null);
});

test('absolute URL injection performs no redirect', () => {
  assert.equal(resolveLegacyHashRedirect('#/http://evil.example', PORTAL_ORIGIN), null);
  assert.equal(resolveLegacyHashRedirect('#/https://evil.example/login', PORTAL_ORIGIN), null);
});

test('mixed-case bypass attempts are rejected — matching is strict and case-sensitive', () => {
  assert.equal(resolveLegacyHashRedirect('#/LOGIN', PORTAL_ORIGIN), null);
  assert.equal(resolveLegacyHashRedirect('#/Login', PORTAL_ORIGIN), null);
  assert.equal(resolveLegacyHashRedirect('#/Set-Password', PORTAL_ORIGIN), null);
});

test('percent-encoded bypass attempts are rejected — no decoding is ever performed', () => {
  assert.equal(resolveLegacyHashRedirect('#/%6c%6fgin', PORTAL_ORIGIN), null);
  assert.equal(resolveLegacyHashRedirect('#/login%2f..', PORTAL_ORIGIN), null); // fails equality, not decoded
});

test('a prefix that only partially matches an allowed word performs no redirect', () => {
  assert.equal(resolveLegacyHashRedirect('#/logingoeswrong', PORTAL_ORIGIN), null);
  assert.equal(resolveLegacyHashRedirect('#/loginx', PORTAL_ORIGIN), null);
});

test('an unrecognised nested path under a plausible-looking but wrong first segment performs no redirect', () => {
  assert.equal(resolveLegacyHashRedirect('#/portal/login', PORTAL_ORIGIN), null);
});

test('every non-null result begins with exactly the configured PORTAL_ORIGIN', () => {
  for (const prefix of LEGACY_HASH_ALLOWED_PREFIXES) {
    const destination = resolveLegacyHashRedirect(`#/${prefix}/token`, PORTAL_ORIGIN);
    assert.ok(destination);
    assert.ok(destination!.startsWith(PORTAL_ORIGIN));
  }
});

test('no redirect is performed when PORTAL_ORIGIN is absent (null or undefined)', () => {
  assert.equal(resolveLegacyHashRedirect('#/login', null), null);
  assert.equal(resolveLegacyHashRedirect('#/login', undefined), null);
  assert.equal(resolveLegacyHashRedirect('#/login', ''), null);
});

test('a custom allowlist can be supplied and is honoured exactly', () => {
  assert.equal(resolveLegacyHashRedirect('#/custom', PORTAL_ORIGIN, ['custom']), `${PORTAL_ORIGIN}#/custom`);
  assert.equal(resolveLegacyHashRedirect('#/login', PORTAL_ORIGIN, ['custom']), null);
});

test('the destination is never anything other than portalOrigin + the original hash — no rebuilding', () => {
  const hash = '#/orders/12345?ref=email';
  assert.equal(resolveLegacyHashRedirect(hash, PORTAL_ORIGIN), PORTAL_ORIGIN + hash);
});
