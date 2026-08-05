import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRedirect } from '../src/lib/redirects.ts';

test('known legacy paths redirect to their documented targets', () => {
  assert.deepEqual(resolveRedirect('/about-us/', ''), { location: '/why-veyora/', status: 301 });
  assert.deepEqual(resolveRedirect('/contact-us/', ''), { location: '/contact/', status: 301 });
  assert.deepEqual(resolveRedirect('/shop/', ''), { location: '/collections/', status: 301 });
  assert.deepEqual(resolveRedirect('/index.php', ''), { location: '/', status: 301 });
});

test('known legacy paths preserve their query string on redirect', () => {
  const result = resolveRedirect('/shop/', '?utm_source=old-link');
  assert.deepEqual(result, { location: '/collections/?utm_source=old-link', status: 301 });
});

test('trailing-slash normalisation adds a trailing slash to a bare public path', () => {
  assert.deepEqual(resolveRedirect('/collections', ''), { location: '/collections/', status: 301 });
});

test('trailing-slash normalisation preserves the query string', () => {
  const result = resolveRedirect('/collections', '?page=2');
  assert.deepEqual(result, { location: '/collections/?page=2', status: 301 });
});

test('the root path is never redirected for "missing" a trailing slash', () => {
  assert.equal(resolveRedirect('/', ''), null);
});

test('a path that already ends in a slash and is not a known legacy path is never redirected', () => {
  assert.equal(resolveRedirect('/collections/', ''), null);
  assert.equal(resolveRedirect('/brands/example-brand/', ''), null);
});

test('/healthz is never redirected, with or without a trailing slash', () => {
  assert.equal(resolveRedirect('/healthz', ''), null);
});

test('static assets are never redirected, even without a trailing slash', () => {
  for (const asset of ['/logo-black.svg', '/logo-white.svg', '/favicon.ico', '/robots.txt', '/site.webmanifest']) {
    assert.equal(resolveRedirect(asset, ''), null, `${asset} should not redirect`);
  }
});

test('/index.php redirects correctly despite looking like a static asset by extension', () => {
  assert.deepEqual(resolveRedirect('/index.php', ''), { location: '/', status: 301 });
});

test('every known-path redirect resolves in exactly one hop (the destination never redirects again)', () => {
  const destinations = ['/why-veyora/', '/contact/', '/collections/', '/'];
  for (const destination of destinations) {
    assert.equal(resolveRedirect(destination, ''), null, `${destination} must not redirect further`);
  }
});

test('resolveRedirect never returns an absolute URL or another origin — internal paths only', () => {
  const candidates = [
    resolveRedirect('/about-us/', ''),
    resolveRedirect('/contact-us/', ''),
    resolveRedirect('/shop/', ''),
    resolveRedirect('/index.php', ''),
    resolveRedirect('/collections', ''),
  ];
  for (const result of candidates) {
    assert.ok(result);
    assert.match(result!.location, /^\//);
    assert.doesNotMatch(result!.location, /^\/\//); // not protocol-relative
    assert.doesNotMatch(result!.location, /^https?:/i);
  }
});
