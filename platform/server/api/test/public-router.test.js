/* Public router (B2.2) — SQL/publication boundary and endpoint behaviour.

   Two layers are exercised, matching the two things that need proving:

   1. The exported, DB-injectable logic functions (listPublishedBrands,
      getPublishedBrandBySlug, listPublishedModels, ...) are called with a
      controlled fake `db` object — `{ query(sql, params) }`, mirroring this
      repository's existing convention (see src/inventory.js's
      reserveTakes(client, ...) and test/stock-guard.test.js's fakeClient())
      — so every query's SQL text and parameters can be asserted directly,
      without a real database.

   2. The actual Express route handlers (routes/public.js's default export)
      are invoked directly — found on the real Router's internal `.stack`,
      the same object `index.js` mounts at /public — with the real `pool`
      from src/db.js monkey-patched for the duration of each test, so the
      real request/response/caching wiring is genuinely exercised, not
      re-implemented. `pool.query` is restored after every test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listPublishedBrands,
  getPublishedBrandBySlug,
  listPublishedModels,
  getPublishedModelBySlugs,
  getPublicFacets,
  listPublishedLocations,
  getSitemapData,
  PublicApiError,
} from '../src/routes/public.js';
import { scanForForbiddenKeys } from '../src/public-forbidden-keys.js';
import { pool } from '../src/db.js';
import router from '../src/routes/public.js';
import { invalidatePublicCache } from '../src/public-cache.js';

const API_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const publicRouterSource = fs.readFileSync(path.join(API_SRC, 'routes', 'public.js'), 'utf8');
const publicSerializeSource = fs.readFileSync(path.join(API_SRC, 'public-serialize.js'), 'utf8');

/* Strips comments before source-scanning tests run — this file's own
   explanatory comments legitimately name things like "never SELECT *",
   "does NOT import pricing.js", and "never `{ ...row }`" to document what
   the code deliberately avoids, and a naive scan of the raw text matches
   its own documentation. Mirrors test/admin-orders.test.js's codeOf()
   helper, the existing convention for this exact situation. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const publicRouterCode = stripComments(publicRouterSource);
const publicSerializeCode = stripComments(publicSerializeSource);

// ---------------------------------------------------------------------------
// fake db — records every query, returns canned rows by matching the SQL text
// ---------------------------------------------------------------------------

function makeFakeDb(responders) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      for (const [pattern, respond] of responders) {
        if (pattern.test(sql)) return typeof respond === 'function' ? respond(params, sql) : respond;
      }
      return { rows: [] };
    },
  };
}

const emptyDb = () => makeFakeDb([]);

// ---------------------------------------------------------------------------
// 10/12/15 — static SQL-shape checks against the real source
// ---------------------------------------------------------------------------

test('no query in routes/public.js uses SELECT * or a table-star selection', () => {
  assert.doesNotMatch(publicRouterCode, /select\s+\*/i);
  assert.doesNotMatch(publicRouterCode, /\b[a-z]\.\*/i, 'a table-qualified star (e.g. p.*) was found');
});

test('routes/public.js never references customer/order/invoice/payment/pricing tables', () => {
  for (const table of ['customers', 'orders', 'order_items', 'invoices', 'payments', 'credit_notes', 'users']) {
    // `users` legitimately appears only inside FK comments/definitions
    // elsewhere, never as a FROM/JOIN target in this file.
    assert.doesNotMatch(publicRouterCode, new RegExp(`(from|join)\\s+${table}\\b`, 'i'), `query references ${table}`);
  }
});

test('routes/public.js does not import pricing, ordering, cart, customer/admin or inventory modules', () => {
  for (const forbidden of ['pricing.js', 'ordering.js', 'cart.js', 'account.js', 'agent.js', 'admin.js', 'authmw.js']) {
    assert.doesNotMatch(publicRouterCode, new RegExp(`from\\s+['"][^'"]*${forbidden.replace('.', '\\.')}['"]`));
  }
});

test('no query anywhere in the public boundary references is_active — it is not the publication authority', () => {
  assert.doesNotMatch(publicRouterCode, /is_active/);
});

// ---------------------------------------------------------------------------
// 13/14 — every entity read requires published state
// ---------------------------------------------------------------------------

test('listPublishedBrands requires publication_state = published', async () => {
  const db = emptyDb();
  await listPublishedBrands(db, {});
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0].sql, /publication_state = 'published'/);
});

test('getPublishedBrandBySlug requires publication_state = published for both the brand and its featured models', async () => {
  const db = makeFakeDb([[/from brands/, { rows: [{ id: 'br_1', slug: 'x', content_updated_at: null }] }]]);
  await getPublishedBrandBySlug(db, 'x');
  const brandQuery = db.queries.find((q) => /from\s+brands/i.test(q.sql));
  assert.match(brandQuery.sql, /publication_state = 'published'/);
  const featuredQuery = db.queries.find((q) => /from products/i.test(q.sql));
  assert.match(featuredQuery.sql, /p\.is_published = true/);
});

test('listPublishedModels requires products.is_published and brands.publication_state', async () => {
  const db = emptyDb();
  await listPublishedModels(db, {});
  const modelsQuery = db.queries.find((q) => /from products/i.test(q.sql));
  assert.match(modelsQuery.sql, /p\.is_published = true/);
  assert.match(modelsQuery.sql, /b\.publication_state = 'published'/);
});

test('getPublishedModelBySlugs requires publication for the product AND its variations (14)', async () => {
  const db = makeFakeDb([
    [/from products p/, { rows: [{ id: 'p_1', brand_id: 'br_1', attributes: {} }] }],
  ]);
  await getPublishedModelBySlugs(db, 'brand-x', 'model-x');
  const productQuery = db.queries.find((q) => /from products p/i.test(q.sql));
  assert.match(productQuery.sql, /p\.is_published = true/);
  assert.match(productQuery.sql, /b\.publication_state = 'published'/);
  const variationQuery = db.queries.find((q) => /from variations/i.test(q.sql));
  assert.match(variationQuery.sql, /is_published = true/);
});

test('getPublicFacets derives the brand facet only from published brands', async () => {
  const db = emptyDb();
  await getPublicFacets(db);
  const brandsQuery = db.queries.find((q) => /from brands/i.test(q.sql));
  assert.match(brandsQuery.sql, /publication_state = 'published'/);
});

test('listPublishedLocations requires publication_state = published AND is_public = true', async () => {
  const db = emptyDb();
  await listPublishedLocations(db);
  assert.equal(db.queries.length, 1);
  assert.match(db.queries[0].sql, /publication_state = 'published'/);
  assert.match(db.queries[0].sql, /is_public = true/);
});

test('getSitemapData excludes draft/approved-but-unpublished/retired records for every entity', async () => {
  const db = emptyDb();
  await getSitemapData(db);
  const brandsQuery = db.queries.find((q) => /from brands/i.test(q.sql));
  const modelsQuery = db.queries.find((q) => /from products p/i.test(q.sql));
  const pagesQuery = db.queries.find((q) => /from content_pages/i.test(q.sql));
  assert.match(brandsQuery.sql, /publication_state = 'published'/);
  assert.match(modelsQuery.sql, /p\.is_published = true/);
  assert.match(modelsQuery.sql, /b\.publication_state = 'published'/);
  assert.match(pagesQuery.sql, /publication_state = 'published'/);
});

// ---------------------------------------------------------------------------
// 11/21 — every query value is parameterised, never string-concatenated
// ---------------------------------------------------------------------------

const SQL_INJECTION_PAYLOAD = "x'; drop table products; --";

test('an adversarial brand/shape/size/category filter value is never concatenated into SQL text, only passed as a parameter', async () => {
  const db = emptyDb();
  await listPublishedModels(db, {
    brand: SQL_INJECTION_PAYLOAD,
    shape: SQL_INJECTION_PAYLOAD,
    size: SQL_INJECTION_PAYLOAD,
    category: SQL_INJECTION_PAYLOAD,
  });
  const modelsQuery = db.queries.find((q) => /from products/i.test(q.sql));
  assert.doesNotMatch(modelsQuery.sql, /drop table/i, 'the payload leaked into the SQL text');
  assert.ok(modelsQuery.params.includes(SQL_INJECTION_PAYLOAD), 'the payload should appear as a bound parameter');
  assert.match(modelsQuery.sql, /\$1/, 'the query must use numbered placeholders');
});

test('an adversarial brand slug in getPublishedBrandBySlug is only ever a parameter', async () => {
  const db = emptyDb();
  await getPublishedBrandBySlug(db, SQL_INJECTION_PAYLOAD).catch(() => {});
  const brandQuery = db.queries.find((q) => /from brands/i.test(q.sql));
  assert.doesNotMatch(brandQuery.sql, /drop table/i);
  assert.ok(brandQuery.params.includes(SQL_INJECTION_PAYLOAD));
});

// ---------------------------------------------------------------------------
// 16/17 — brands endpoint behaviour
// ---------------------------------------------------------------------------

test('listPublishedBrands returns only safe, serialized records', async () => {
  const db = makeFakeDb([[
    /from brands/,
    {
      rows: [
        { slug: 'a', name: 'A', short_name: '', segment: 'core', headline: '', price_tier_label: '', logo_media_id: null },
      ],
    },
  ]]);
  const out = await listPublishedBrands(db, {});
  assert.equal(out.length, 1);
  assert.deepEqual(scanForForbiddenKeys(out), []);
});

test('getPublishedBrandBySlug throws a 404 PublicApiError for an unknown/unpublished slug', async () => {
  const db = emptyDb(); // no rows for any query -> brand not found
  await assert.rejects(() => getPublishedBrandBySlug(db, 'does-not-exist'), (err) => {
    assert.ok(err instanceof PublicApiError);
    assert.equal(err.status, 404);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 18/19/20 — models validation and ordering
// ---------------------------------------------------------------------------

test('models validates page: rejects non-integer, negative, zero and array values', async () => {
  const db = emptyDb();
  for (const bad of ['abc', '-1', '0', '2.5', ['1', '2']]) {
    await assert.rejects(() => listPublishedModels(db, { page: bad }), (err) => {
      assert.ok(err instanceof PublicApiError);
      assert.equal(err.status, 400);
      return true;
    });
  }
});

test('models accepts a valid positive integer page', async () => {
  const db = emptyDb();
  const out = await listPublishedModels(db, { page: '3' });
  assert.equal(out.page, 3);
});

test('models validates sort: rejects an unsupported value, accepts the allowlisted ones', async () => {
  const db = emptyDb();
  await assert.rejects(() => listPublishedModels(db, { sort: 'price_asc' }), (err) => {
    assert.ok(err instanceof PublicApiError);
    assert.equal(err.status, 400);
    return true;
  });
  await assert.doesNotReject(() => listPublishedModels(db, { sort: 'newest' }));
  await assert.doesNotReject(() => listPublishedModels(db, { sort: 'name' }));
});

test('models uses deterministic ordering with a stable tie-breaker for every allowed sort', async () => {
  const db = emptyDb();
  await listPublishedModels(db, { sort: 'newest' });
  await listPublishedModels(db, { sort: 'name' });
  const [q1, q2] = db.queries;
  assert.match(q1.sql, /order by p\.content_updated_at desc, p\.id/);
  assert.match(q2.sql, /order by p\.name asc, p\.id/);
});

test('models rejects an over-long or array filter value cleanly (400), not a crash', async () => {
  const db = emptyDb();
  await assert.rejects(() => listPublishedModels(db, { brand: 'x'.repeat(500) }), (err) => {
    assert.ok(err instanceof PublicApiError);
    assert.equal(err.status, 400);
    return true;
  });
  await assert.rejects(() => listPublishedModels(db, { brand: ['a', 'b'] }), (err) => {
    assert.ok(err instanceof PublicApiError);
    assert.equal(err.status, 400);
    return true;
  });
});

test('audience/material are accepted (forward-compatible) but validated the same way as other filters', async () => {
  const db = emptyDb();
  await assert.doesNotReject(() => listPublishedModels(db, { audience: 'women' }));
  await assert.rejects(() => listPublishedModels(db, { audience: ['a', 'b'] }), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 22/23 — model detail
// ---------------------------------------------------------------------------

test('model detail returns only published variations and contains no availability field anywhere', async () => {
  const db = makeFakeDb([
    [/from products p/, { rows: [{ id: 'p_1', brand_id: 'br_1', public_slug: 'model-x', sku: '100', name: 'Model X', attributes: {}, content_updated_at: null }] }],
    [/from variations/, { rows: [{ id: 'v_1', sku: '100.1', color: 'Black', color_code: 'BLK', swatch_media_id: null }] }],
  ]);
  const out = await getPublishedModelBySlugs(db, 'brand-x', 'model-x');
  const variationQuery = db.queries.find((q) => /from variations/i.test(q.sql));
  assert.match(variationQuery.sql, /is_published = true/);
  assert.deepEqual(scanForForbiddenKeys(out), []);
  const json = JSON.stringify(out).toLowerCase();
  assert.ok(!json.includes('availab'), 'the model detail response must never mention availability');
});

test('an unknown/unpublished model returns a 404 PublicApiError', async () => {
  const db = emptyDb();
  await assert.rejects(() => getPublishedModelBySlugs(db, 'brand-x', 'no-such-model'), (err) => {
    assert.ok(err instanceof PublicApiError);
    assert.equal(err.status, 404);
    return true;
  });
});

// ---------------------------------------------------------------------------
// 24/25/26 — facets, locations, sitemap-data safety
// ---------------------------------------------------------------------------

test('facets contain no prices, stock counts or a hidden (unpublished) brand roster', async () => {
  const db = makeFakeDb([[/from brands/, { rows: [{ slug: 'a', name: 'A' }] }]]);
  const out = await getPublicFacets(db);
  assert.deepEqual(Object.keys(out).sort(), ['brands', 'categories', 'shapes', 'sizes']);
  assert.deepEqual(scanForForbiddenKeys(out), []);
});

test('locations return only safe published fields', async () => {
  const db = makeFakeDb([[
    /from locations/,
    { rows: [{ slug: 'italy', name: 'Italy', function: 'supply_base', regions_served: ['Europe'], hours: '' }] },
  ]]);
  const out = await listPublishedLocations(db);
  assert.deepEqual(scanForForbiddenKeys(out), []);
  assert.deepEqual(Object.keys(out[0]).sort(), ['function', 'hours', 'name', 'regionsServed', 'slug']);
});

test('sitemap-data excludes unpublished records and contains only path + contentUpdatedAt shapes', async () => {
  const db = makeFakeDb([
    [/from brands/, { rows: [{ slug: 'a', content_updated_at: '2026-01-01T00:00:00Z' }] }],
  ]);
  const out = await getSitemapData(db);
  assert.deepEqual(Object.keys(out).sort(), ['brands', 'models', 'pages']);
  for (const entry of out.brands) assert.deepEqual(Object.keys(entry).sort(), ['contentUpdatedAt', 'path']);
  assert.deepEqual(scanForForbiddenKeys(out), []);
});

// ---------------------------------------------------------------------------
// 27/28/29 — cache behaviour at the real router-wiring level
// ---------------------------------------------------------------------------

function findRouteHandler(routePath, method = 'get') {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[0].handle;
}

function invoke(handler, { query = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = { query, params };
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(body) { resolve({ status, body }); },
    };
    const next = (err) => resolve({ status: err?.status || 500, error: err });
    handler(req, res, next);
  });
}

test.beforeEach(() => {
  invalidatePublicCache();
});

test('an equivalent repeated /public/brands request is served from cache — the database is queried only once', async (t) => {
  let calls = 0;
  const originalQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    calls++;
    return { rows: [] };
  };
  t.after(() => { pool.query = originalQuery; });

  const handler = findRouteHandler('/brands');
  const first = await invoke(handler, { query: {} });
  const second = await invoke(handler, { query: {} });

  assert.equal(calls, 1, 'the second equivalent request must not hit the database again');
  assert.deepEqual(first.body, second.body);
});

test('invalidatePublicCache clears the cache so the next request queries again', async (t) => {
  let calls = 0;
  const originalQuery = pool.query.bind(pool);
  pool.query = async () => { calls++; return { rows: [] }; };
  t.after(() => { pool.query = originalQuery; });

  const handler = findRouteHandler('/brands');
  await invoke(handler, { query: {} });
  invalidatePublicCache();
  await invoke(handler, { query: {} });

  assert.equal(calls, 2);
});

test('a failed database read is never cached — the next request tries again', async (t) => {
  let calls = 0;
  const originalQuery = pool.query.bind(pool);
  pool.query = async () => {
    calls++;
    if (calls === 1) throw new Error('simulated transient failure');
    return { rows: [] };
  };
  t.after(() => { pool.query = originalQuery; });

  const handler = findRouteHandler('/brands');
  const first = await invoke(handler, { query: {} });
  assert.ok(first.error, 'the first call should have failed');

  const second = await invoke(handler, { query: {} });
  assert.equal(calls, 2, 'a failure must not be cached — the second call must hit the database again');
  assert.ok(!second.error);
});

test('a validation error (bad page) is never cached', async (t) => {
  let calls = 0;
  const originalQuery = pool.query.bind(pool);
  pool.query = async () => { calls++; return { rows: [] }; };
  t.after(() => { pool.query = originalQuery; });

  const handler = findRouteHandler('/models');
  const first = await invoke(handler, { query: { page: 'not-a-number' } });
  assert.equal(first.status, 400);
  assert.equal(calls, 0, 'a validation error must fail before any query, and must not populate the cache');
});

// ---------------------------------------------------------------------------
// 30 — no write methods anywhere on this router
// ---------------------------------------------------------------------------

test('the public router defines no POST/PUT/PATCH/DELETE handler', () => {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      assert.ok(['get', 'head'].includes(method), `unexpected write method ${method.toUpperCase()} on ${layer.route.path}`);
    }
  }
});

test('routes/public.js source never calls r.post/r.put/r.patch/r.delete', () => {
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    assert.doesNotMatch(publicRouterSource, new RegExp(`r\\.${verb}\\(`));
  }
});

// ---------------------------------------------------------------------------
// 31 — every successful response fixture passes the forbidden-key scan
// ---------------------------------------------------------------------------

test('every endpoint\'s example successful response passes the forbidden-key scan end to end', async () => {
  const brandsDb = makeFakeDb([[/from brands/, { rows: [{ slug: 'a', name: 'A', short_name: '', segment: '', headline: '', price_tier_label: '', logo_media_id: null }] }]]);
  const modelsDb = emptyDb();
  const facetsDb = emptyDb();
  const locationsDb = emptyDb();
  const sitemapDb = emptyDb();

  const fixtures = await Promise.all([
    listPublishedBrands(brandsDb, {}),
    listPublishedModels(modelsDb, {}),
    getPublicFacets(facetsDb),
    listPublishedLocations(locationsDb),
    getSitemapData(sitemapDb),
  ]);
  for (const fixture of fixtures) {
    assert.deepEqual(scanForForbiddenKeys(fixture), []);
  }
});

// ---------------------------------------------------------------------------
// 33 — /user route mounting is unchanged by this batch
// ---------------------------------------------------------------------------

test('index.js still mounts every pre-existing /user router unchanged, alongside the new /public mount', () => {
  const indexSource = fs.readFileSync(path.join(API_SRC, 'index.js'), 'utf8');
  assert.match(indexSource, /app\.use\('\/user', catalogRoutes\)/);
  assert.match(indexSource, /app\.use\('\/user', cartRoutes\)/);
  assert.match(indexSource, /app\.use\('\/user', orderRoutes\)/);
  assert.match(indexSource, /app\.use\('\/user', accountRoutes\)/);
  assert.match(indexSource, /app\.use\('\/user', agentRoutes\)/);
  assert.match(indexSource, /app\.use\('\/public', publicRoutes\)/);
});

// ---------------------------------------------------------------------------
// serializer boundary re-asserted from the router's own source (defence in depth)
// ---------------------------------------------------------------------------

test('public-serialize.js never contains a raw object spread of a row (the `{ ...row }` shape)', () => {
  // `{ ...card }` / `{ ...summary }` (spreading an ALREADY-serialized safe
  // object into a richer safe shape) is fine and used deliberately;
  // spreading something literally named row/product/variation/brand is not.
  assert.doesNotMatch(publicSerializeCode, /\.\.\.(row|product|variation|brand|location)\b/);
});
