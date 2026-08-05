import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCatalogueQuery,
  buildCatalogueHref,
  CatalogueQueryError,
  SUPPORTED_FILTERS,
  SUPPORTED_SORTS,
} from '../src/lib/catalogue-query.ts';

const q = (search: string) => new URLSearchParams(search);

// ---------- defaults ----------

test('an empty query yields page 1, the default sort and no filters', () => {
  const parsed = parseCatalogueQuery(q(''));
  assert.equal(parsed.page, 1);
  assert.equal(parsed.sort, 'newest');
  assert.deepEqual(parsed.filters, {});
});

// ---------- page validation ----------

test('page must be a bare positive integer', () => {
  for (const bad of ['0', '-1', '2.5', 'abc', '2abc', '1e3']) {
    assert.throws(() => parseCatalogueQuery(q(`page=${encodeURIComponent(bad)}`)), CatalogueQueryError, `accepted "${bad}"`);
  }
});

test('an empty or whitespace-only page is treated as absent (page 1), not as an error', () => {
  // Consistent with how empty filter values are handled: `?page=` and
  // `?page=%20` are a caller supplying nothing, not supplying something
  // invalid. `?page=abc` IS invalid and still throws (above).
  assert.equal(parseCatalogueQuery(q('page=')).page, 1);
  assert.equal(parseCatalogueQuery(q('page=%20')).page, 1);
});

test('a valid page is accepted', () => {
  assert.equal(parseCatalogueQuery(q('page=3')).page, 3);
  assert.equal(parseCatalogueQuery(q('page=1')).page, 1);
});

// ---------- sort validation ----------

test('only allowlisted sorts are accepted', () => {
  for (const sort of SUPPORTED_SORTS) {
    assert.equal(parseCatalogueQuery(q(`sort=${sort}`)).sort, sort);
  }
});

test('an unsupported sort is rejected, including prototype-shaped values', () => {
  for (const bad of ['price_asc', 'random', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.throws(() => parseCatalogueQuery(q(`sort=${encodeURIComponent(bad)}`)), CatalogueQueryError, `accepted "${bad}"`);
  }
});

// ---------- filter handling ----------

test('every supported filter is read', () => {
  const search = SUPPORTED_FILTERS.map((f) => `${f}=value-${f}`).join('&');
  const parsed = parseCatalogueQuery(q(search));
  for (const filter of SUPPORTED_FILTERS) {
    assert.equal(parsed.filters[filter], `value-${filter}`);
  }
});

test('unsupported parameters are ignored, never forwarded', () => {
  const parsed = parseCatalogueQuery(q('colour=red&limit=999&utm_source=news&sort=name'));
  assert.deepEqual(Object.keys(parsed.filters), []);
  assert.equal(parsed.sort, 'name');
});

test('a repeated parameter is rejected rather than silently taking the first', () => {
  assert.throws(() => parseCatalogueQuery(q('brand=a&brand=b')), /brand must be a single value/);
  assert.throws(() => parseCatalogueQuery(q('page=1&page=2')), /page must be a single value/);
});

test('an excessively long value is rejected', () => {
  assert.throws(() => parseCatalogueQuery(q(`brand=${'x'.repeat(200)}`)), /brand is too long/);
});

test('an empty filter value is treated as absent, not as an empty filter', () => {
  const parsed = parseCatalogueQuery(q('brand=&shape=  '));
  assert.deepEqual(parsed.filters, {});
});

// ---------- forced category (the category landing routes) ----------

test('forcedCategory injects the category', () => {
  const parsed = parseCatalogueQuery(q(''), { forcedCategory: 'Optical' });
  assert.equal(parsed.filters.category, 'Optical');
});

test('forcedCategory overrides a caller-supplied category — a category page cannot be repointed by query', () => {
  const parsed = parseCatalogueQuery(q('category=Sun'), { forcedCategory: 'Optical' });
  assert.equal(parsed.filters.category, 'Optical');
});

// ---------- pagination href building ----------

test('pagination links preserve every supported filter and the sort', () => {
  const parsed = parseCatalogueQuery(q('brand=example&shape=round&sort=name&page=2'));
  const next = buildCatalogueHref('/collections/', parsed, 3);
  const url = new URL(next, 'http://x');
  assert.equal(url.pathname, '/collections/');
  assert.equal(url.searchParams.get('brand'), 'example');
  assert.equal(url.searchParams.get('shape'), 'round');
  assert.equal(url.searchParams.get('sort'), 'name');
  assert.equal(url.searchParams.get('page'), '3');
});

test('default values are omitted so page 1 of an unfiltered listing is the clean path', () => {
  const parsed = parseCatalogueQuery(q(''));
  assert.equal(buildCatalogueHref('/collections/', parsed, 1), '/collections/');
});

test('page 1 links omit the page parameter entirely (no ?page=1 duplicate URL)', () => {
  const parsed = parseCatalogueQuery(q('brand=example&page=2'));
  const previous = buildCatalogueHref('/collections/', parsed, 1);
  assert.equal(previous, '/collections/?brand=example');
});

test('a category landing route omits category from its own links — it is already in the path', () => {
  const parsed = parseCatalogueQuery(q('shape=round'), { forcedCategory: 'Optical' });
  const next = buildCatalogueHref('/collections/optical/', parsed, 2, { omitCategory: true });
  const url = new URL(next, 'http://x');
  assert.equal(url.pathname, '/collections/optical/');
  assert.equal(url.searchParams.has('category'), false);
  assert.equal(url.searchParams.get('shape'), 'round');
  assert.equal(url.searchParams.get('page'), '2');
});

test('filter values are URL-encoded in generated links', () => {
  const parsed = parseCatalogueQuery(q('brand=a%20b%26c'));
  const href = buildCatalogueHref('/collections/', parsed, 2);
  assert.ok(!href.includes('a b&c'), 'the raw value leaked into the query string');
  const url = new URL(href, 'http://x');
  assert.equal(url.searchParams.get('brand'), 'a b&c');
});
