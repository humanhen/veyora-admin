import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveIndexing,
  NOT_FOUND_ROBOTS,
  SERVER_ERROR_ROBOTS,
  SUPPORTED_FILTER_PARAMS,
} from '../src/lib/indexing.ts';

function q(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

// ---------- the five isolated states, 05_ROUTE_TEMPLATE_MATRIX.md §2/§9 ----------

test('1. clean public route: index, follow, self-canonical, sitemap eligible', () => {
  const result = resolveIndexing('/collections/', q(''));
  assert.deepEqual(result, { robots: 'index, follow', canonicalPath: '/collections/', inSitemap: true });
});

test('2. ?page=N (N>1): index, follow, self-canonical including page, not sitemap eligible', () => {
  const result = resolveIndexing('/collections/', q('page=2'));
  assert.deepEqual(result, { robots: 'index, follow', canonicalPath: '/collections/?page=2', inSitemap: false });
});

test('3. any supported filter parameter: noindex, follow, canonical to the clean unfiltered path', () => {
  for (const key of SUPPORTED_FILTER_PARAMS) {
    const result = resolveIndexing('/collections/', q(`${key}=example`));
    assert.deepEqual(
      result,
      { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false },
      `filter param "${key}" did not resolve correctly`
    );
  }
});

test('4. sort-only state: noindex, follow, canonical to the unsorted path', () => {
  const result = resolveIndexing('/collections/', q('sort=name'));
  assert.deepEqual(result, { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false });
});

test('5. /search/: noindex, follow, not sitemap eligible, regardless of query', () => {
  assert.deepEqual(resolveIndexing('/search/', q('')), {
    robots: 'noindex, follow',
    canonicalPath: '/search/',
    inSitemap: false,
  });
  assert.deepEqual(resolveIndexing('/search/', q('q=frames')), {
    robots: 'noindex, follow',
    canonicalPath: '/search/',
    inSitemap: false,
  });
});

// ---------- system responses ----------

test('6. 404 uses the fixed NOT_FOUND_ROBOTS constant: noindex, follow', () => {
  assert.equal(NOT_FOUND_ROBOTS, 'noindex, follow');
});

test('7. 500 uses the fixed SERVER_ERROR_ROBOTS constant: noindex, nofollow', () => {
  assert.equal(SERVER_ERROR_ROBOTS, 'noindex, nofollow');
});

// ---------- edge cases within each isolated state ----------

test('page=1 is treated as clean, not as a paginated state', () => {
  const result = resolveIndexing('/collections/', q('page=1'));
  assert.deepEqual(result, { robots: 'index, follow', canonicalPath: '/collections/', inSitemap: true });
});

test('a non-numeric page value is treated as clean', () => {
  const result = resolveIndexing('/collections/', q('page=abc'));
  assert.deepEqual(result, { robots: 'index, follow', canonicalPath: '/collections/', inSitemap: true });
});

test('a negative or zero page value is treated as clean', () => {
  assert.equal(resolveIndexing('/collections/', q('page=0')).canonicalPath, '/collections/');
  assert.equal(resolveIndexing('/collections/', q('page=-3')).canonicalPath, '/collections/');
});

test('an unsupported/unknown query parameter never triggers filter behaviour', () => {
  const result = resolveIndexing('/collections/', q('foo=bar'));
  assert.deepEqual(result, { robots: 'index, follow', canonicalPath: '/collections/', inSitemap: true });
});

test('marketing/tracking parameters alone do not make a clean page noindex, and never enter the canonical URL', () => {
  for (const utm of ['utm_source=newsletter', 'utm_campaign=spring', 'gclid=abc123', 'fbclid=xyz']) {
    const result = resolveIndexing('/collections/', q(utm));
    assert.equal(result.robots, 'index, follow', `${utm} incorrectly affected robots`);
    assert.equal(result.canonicalPath, '/collections/', `${utm} leaked into the canonical URL`);
    assert.equal(result.inSitemap, true);
  }
});

// ---------- combinations, not only isolated parameters ----------

test('combination: filter + sort — filter takes precedence, still canonical to the clean path', () => {
  const result = resolveIndexing('/collections/', q('brand=example&sort=name'));
  assert.deepEqual(result, { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false });
});

test('combination: filter + page>1 — filter takes precedence over pagination', () => {
  const result = resolveIndexing('/collections/', q('brand=example&page=2'));
  assert.deepEqual(result, { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false });
});

test('combination: sort + page>1 — sort takes precedence, canonical strips both', () => {
  const result = resolveIndexing('/collections/', q('sort=name&page=2'));
  assert.deepEqual(result, { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false });
});

test('combination: filter + sort + page>1 — filter still wins', () => {
  const result = resolveIndexing('/collections/', q('brand=example&sort=name&page=2'));
  assert.deepEqual(result, { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false });
});

test('combination: marketing param + filter — filter still governs, marketing param still stripped', () => {
  const result = resolveIndexing('/collections/', q('utm_source=ad&brand=example'));
  assert.deepEqual(result, { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false });
});

test('combination: marketing param + page>1 — page state still governs, marketing param stripped from canonical', () => {
  const result = resolveIndexing('/collections/', q('utm_source=ad&page=3'));
  assert.deepEqual(result, { robots: 'index, follow', canonicalPath: '/collections/?page=3', inSitemap: false });
});

test('combination: marketing param + sort — sort state still governs', () => {
  const result = resolveIndexing('/collections/', q('utm_source=ad&sort=name'));
  assert.deepEqual(result, { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false });
});

test('combination: unknown param + supported filter — only the supported one governs', () => {
  const result = resolveIndexing('/collections/', q('foo=bar&brand=example'));
  assert.deepEqual(result, { robots: 'noindex, follow', canonicalPath: '/collections/', inSitemap: false });
});

test('the rule is path-agnostic: the same query-state logic applies to any pathname, not only /collections/', () => {
  assert.equal(resolveIndexing('/brands/', q('sort=name')).robots, 'noindex, follow');
  assert.equal(resolveIndexing('/contact/', q('')).robots, 'index, follow');
});
