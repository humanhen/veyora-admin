import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEnv,
  DEV_DEFAULT_SITE_ORIGIN,
  DEV_DEFAULT_PORTAL_ORIGIN,
} from '../src/env.ts';

test('development: valid origins are accepted and passed through', () => {
  const result = resolveEnv({
    NODE_ENV: 'development',
    PUBLIC_SITE_ORIGIN: 'http://localhost:5000',
    PORTAL_ORIGIN: 'http://localhost:5001',
  });
  assert.equal(result.siteOrigin, 'http://localhost:5000');
  assert.equal(result.portalOrigin, 'http://localhost:5001');
  assert.equal(result.nodeEnv, 'development');
});

test('development: missing origins fall back to documented localhost defaults', () => {
  const result = resolveEnv({ NODE_ENV: 'development' });
  assert.equal(result.siteOrigin, DEV_DEFAULT_SITE_ORIGIN);
  assert.equal(result.portalOrigin, DEV_DEFAULT_PORTAL_ORIGIN);
});

test('development: no NODE_ENV at all also uses localhost defaults, not production rules', () => {
  const result = resolveEnv({});
  assert.equal(result.nodeEnv, 'development');
  assert.equal(result.siteOrigin, DEV_DEFAULT_SITE_ORIGIN);
  assert.equal(result.portalOrigin, DEV_DEFAULT_PORTAL_ORIGIN);
});

test('development: neither default is a real Veyora domain', () => {
  for (const origin of [DEV_DEFAULT_SITE_ORIGIN, DEV_DEFAULT_PORTAL_ORIGIN]) {
    assert.match(origin, /^http:\/\/localhost:\d+$/);
    assert.doesNotMatch(origin, /veyora/i);
  }
});

test('production: rejects missing PUBLIC_SITE_ORIGIN', () => {
  assert.throws(
    () => resolveEnv({ NODE_ENV: 'production', PORTAL_ORIGIN: 'https://portal.example.com' }),
    /PUBLIC_SITE_ORIGIN.*required/
  );
});

test('production: rejects missing PORTAL_ORIGIN', () => {
  assert.throws(
    () => resolveEnv({ NODE_ENV: 'production', PUBLIC_SITE_ORIGIN: 'https://example.com' }),
    /PORTAL_ORIGIN.*required/
  );
});

test('production: rejects both missing', () => {
  assert.throws(() => resolveEnv({ NODE_ENV: 'production' }));
});

test('production: accepts a fully configured pair', () => {
  const result = resolveEnv({
    NODE_ENV: 'production',
    PUBLIC_SITE_ORIGIN: 'https://example.com',
    PORTAL_ORIGIN: 'https://portal.example.com',
  });
  assert.equal(result.siteOrigin, 'https://example.com');
  assert.equal(result.portalOrigin, 'https://portal.example.com');
});

test('production: an empty string is treated the same as missing', () => {
  assert.throws(() =>
    resolveEnv({ NODE_ENV: 'production', PUBLIC_SITE_ORIGIN: '', PORTAL_ORIGIN: 'https://portal.example.com' })
  );
});

test('malformed origins are rejected: not a URL at all', () => {
  assert.throws(() =>
    resolveEnv({ NODE_ENV: 'development', PUBLIC_SITE_ORIGIN: 'not-a-url', PORTAL_ORIGIN: 'https://portal.example.com' })
  );
});

test('malformed origins are rejected: wrong protocol', () => {
  assert.throws(() =>
    resolveEnv({ NODE_ENV: 'development', PUBLIC_SITE_ORIGIN: 'ftp://example.com', PORTAL_ORIGIN: 'https://portal.example.com' })
  );
});

test('malformed origins are rejected: contains a path', () => {
  assert.throws(() =>
    resolveEnv({ NODE_ENV: 'development', PUBLIC_SITE_ORIGIN: 'https://example.com/foo', PORTAL_ORIGIN: 'https://portal.example.com' })
  );
});

test('malformed origins are rejected: contains a query string', () => {
  assert.throws(() =>
    resolveEnv({ NODE_ENV: 'development', PUBLIC_SITE_ORIGIN: 'https://example.com/?x=1', PORTAL_ORIGIN: 'https://portal.example.com' })
  );
});

test('malformed origins are rejected: contains a fragment', () => {
  assert.throws(() =>
    resolveEnv({ NODE_ENV: 'development', PUBLIC_SITE_ORIGIN: 'https://example.com/#x', PORTAL_ORIGIN: 'https://portal.example.com' })
  );
});

test('origin normalisation is stable: with and without a trailing slash resolve identically', () => {
  const withSlash = resolveEnv({
    NODE_ENV: 'development',
    PUBLIC_SITE_ORIGIN: 'https://example.com/',
    PORTAL_ORIGIN: 'https://portal.example.com/',
  });
  const withoutSlash = resolveEnv({
    NODE_ENV: 'development',
    PUBLIC_SITE_ORIGIN: 'https://example.com',
    PORTAL_ORIGIN: 'https://portal.example.com',
  });
  assert.equal(withSlash.siteOrigin, withoutSlash.siteOrigin);
  assert.equal(withSlash.portalOrigin, withoutSlash.portalOrigin);
  assert.equal(withSlash.siteOrigin, 'https://example.com');
});

test('origin normalisation: http and https are both accepted independently', () => {
  const result = resolveEnv({
    NODE_ENV: 'development',
    PUBLIC_SITE_ORIGIN: 'http://example.com',
    PORTAL_ORIGIN: 'https://portal.example.com',
  });
  assert.equal(result.siteOrigin, 'http://example.com');
  assert.equal(result.portalOrigin, 'https://portal.example.com');
});
