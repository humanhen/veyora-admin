import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  resolveEnv,
  DEV_DEFAULT_SITE_ORIGIN,
  DEV_DEFAULT_PORTAL_ORIGIN,
  DEV_DEFAULT_API_ORIGIN,
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

test('production: accepts a fully configured set', () => {
  // B2.3 added a third required production origin, PUBLIC_API_ORIGIN — the
  // internal address this server calls to reach /public/*. A production
  // deployment missing it would render every catalogue page as an outage,
  // so it fails closed at startup like the other two.
  const result = resolveEnv({
    NODE_ENV: 'production',
    PUBLIC_SITE_ORIGIN: 'https://example.com',
    PORTAL_ORIGIN: 'https://portal.example.com',
    PUBLIC_API_ORIGIN: 'http://api:3000',
  });
  assert.equal(result.siteOrigin, 'https://example.com');
  assert.equal(result.portalOrigin, 'https://portal.example.com');
  assert.equal(result.apiOrigin, 'http://api:3000');
});

test('production: rejects a missing PUBLIC_API_ORIGIN', () => {
  assert.throws(
    () =>
      resolveEnv({
        NODE_ENV: 'production',
        PUBLIC_SITE_ORIGIN: 'https://example.com',
        PORTAL_ORIGIN: 'https://portal.example.com',
      }),
    /PUBLIC_API_ORIGIN.*required/
  );
});

test('development: PUBLIC_API_ORIGIN falls back to a documented localhost default', () => {
  const result = resolveEnv({ NODE_ENV: 'development' });
  assert.equal(result.apiOrigin, DEV_DEFAULT_API_ORIGIN);
  assert.match(result.apiOrigin, /^http:\/\/localhost:\d+$/);
  assert.doesNotMatch(result.apiOrigin, /veyora/i);
});

test('a malformed PUBLIC_API_ORIGIN is rejected like any other origin', () => {
  assert.throws(
    () => resolveEnv({ NODE_ENV: 'development', PUBLIC_API_ORIGIN: 'not-a-url' }),
    /PUBLIC_API_ORIGIN/
  );
  assert.throws(
    () => resolveEnv({ NODE_ENV: 'development', PUBLIC_API_ORIGIN: 'ftp://api:3000' }),
    /PUBLIC_API_ORIGIN must use http or https/
  );
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

/* A wildcard host used to pass. `new URL()` accepts "https://*.example.com"
   because `*` is a legal hostname character to the parser, and every check
   above is about protocol, path, query and fragment. astro.config.mjs refused
   it when deriving security.allowedDomains — but that guard runs at BUILD
   time, so a container starting from an already-built image with a wildcard
   origin passed validation, started, and emitted canonical URLs and sitemap
   entries containing a literal "*". Found by the env-validation gate in
   scripts/verify-release.mjs. */
test('malformed origins are rejected: a wildcard host is not a host', () => {
  for (const value of ['https://*.example.com', 'https://*', 'http://*.veyora.example', 'https://ex*ample.com']) {
    assert.throws(
      () => resolveEnv({ NODE_ENV: 'development', PUBLIC_SITE_ORIGIN: value, PORTAL_ORIGIN: 'https://portal.example.com' }),
      /single concrete host/,
      `${value} must be rejected`
    );
  }
});

test('a wildcard PORTAL_ORIGIN is rejected too — one validator, both variables', () => {
  assert.throws(
    () => resolveEnv({ NODE_ENV: 'development', PUBLIC_SITE_ORIGIN: 'https://example.com', PORTAL_ORIGIN: 'https://*.example.com' }),
    /single concrete host/
  );
});

test('the resolver and the build-time config agree: both refuse a wildcard', () => {
  /* The divergence between these two is what the defect was. Asserting they
     agree is what stops it coming back — a future relaxation of either one
     fails here rather than silently reopening the gap. */
  const config = fs.readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
  assert.match(config, /hostname\.includes\('\*'\)/, 'astro.config.mjs must still refuse a wildcard host');
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
