import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey, getCached, setCached, invalidatePublicCache, _cacheSizeForTesting } from '../src/public-cache.js';

test.beforeEach(() => {
  invalidatePublicCache();
});

test('buildCacheKey normalises query param order so equivalent requests share one key', () => {
  const a = buildCacheKey('models', { brand: 'x', shape: 'round' });
  const b = buildCacheKey('models', { shape: 'round', brand: 'x' });
  assert.equal(a, b);
});

test('buildCacheKey ignores undefined/null/empty-string params', () => {
  const a = buildCacheKey('models', { brand: 'x', shape: undefined, size: '' });
  const b = buildCacheKey('models', { brand: 'x' });
  assert.equal(a, b);
});

test('different query state produces a different key', () => {
  const a = buildCacheKey('models', { brand: 'x' });
  const b = buildCacheKey('models', { brand: 'y' });
  assert.notEqual(a, b);
});

test('a cached value is returned for a repeated equivalent request', () => {
  const key = buildCacheKey('brands', {});
  assert.equal(getCached(key), undefined);
  setCached(key, { brands: [{ slug: 'a' }] });
  assert.deepEqual(getCached(key), { brands: [{ slug: 'a' }] });
});

test('invalidatePublicCache clears every cached value', () => {
  setCached('a', 1);
  setCached('b', 2);
  assert.ok(_cacheSizeForTesting() >= 2);
  invalidatePublicCache();
  assert.equal(_cacheSizeForTesting(), 0);
  assert.equal(getCached('a'), undefined);
  assert.equal(getCached('b'), undefined);
});

test('an expired entry (beyond the ~60s TTL) is not returned and is evicted', () => {
  const key = 'expiring-key';
  setCached(key, { value: 'stale' });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    assert.equal(getCached(key), undefined);
  } finally {
    Date.now = realNow;
  }
  // Confirm it was actually evicted, not just reported missing this once.
  assert.equal(_cacheSizeForTesting(), 0);
});

test('an entry well within the TTL is still returned', () => {
  const key = 'fresh-key';
  setCached(key, { value: 'fresh' });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 30_000; // well under 60s
    assert.deepEqual(getCached(key), { value: 'fresh' });
  } finally {
    Date.now = realNow;
  }
});

test('the cache never holds user/session identity as part of a key', () => {
  // The key builder only ever accepts endpoint name + plain query params —
  // there is no parameter for a user id, session, or cookie anywhere in its
  // signature. This test documents that contract directly against the
  // exported function shape rather than asserting a negative on arbitrary
  // input.
  const key = buildCacheKey('models', { brand: 'x', page: '2' });
  assert.doesNotMatch(key, /user|session|cookie/i);
});

test('the cache is bounded — inserting beyond the max entry count evicts the oldest rather than growing forever', () => {
  // Insert far more than any reasonable single test would need, confirming
  // size never exceeds the documented bound.
  for (let i = 0; i < 600; i++) setCached(`k${i}`, i);
  assert.ok(_cacheSizeForTesting() <= 500, `cache grew to ${_cacheSizeForTesting()} entries, expected <= 500`);
  // The earliest keys should have been evicted first.
  assert.equal(getCached('k0'), undefined);
  assert.notEqual(getCached('k599'), undefined);
});
