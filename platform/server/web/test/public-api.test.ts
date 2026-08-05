/* Public API client (B2.3) — exercised against a controlled local mock
   server on 127.0.0.1. No real API, database or external network is
   contacted by any test in this file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listBrands,
  getBrand,
  listModels,
  getModel,
  getFacets,
  listLocations,
  getSitemapData,
  PUBLIC_API_FAILURE_STATUS,
  _setApiOriginForTesting,
  _buildUrlForTesting,
} from '../src/lib/public-api.ts';
import { startMockApi, PLANTED_SECRETS } from './helpers/mock-public-api.ts';
import { env } from '../src/env.ts';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const clientSource = fs.readFileSync(path.join(SRC, 'lib', 'public-api.ts'), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const clientCode = stripComments(clientSource);

test.afterEach(() => {
  _setApiOriginForTesting(null);
});

// ---------- 1/2/9 — origin and endpoint allowlist ----------

test('the API origin comes from the validated server environment, not a literal', () => {
  assert.ok(env.apiOrigin, 'env.apiOrigin must be populated');
  assert.match(env.apiOrigin, /^https?:\/\//);
  assert.doesNotMatch(clientCode, /veyora\.(design|com)/i, 'no production hostname may be hard-coded');
});

test('only /public paths can be requested — a non-/public path is refused outright', () => {
  assert.throws(() => _buildUrlForTesting('/admin/users'), /refusing non-\/public path/);
  assert.throws(() => _buildUrlForTesting('/user/get-products'), /refusing non-\/public path/);
});

test('there is no generic fetch-any-path export — every endpoint is an explicit named function', async () => {
  const mod = await import('../src/lib/public-api.ts');
  const exported = Object.keys(mod).filter((k) => typeof (mod as Record<string, unknown>)[k] === 'function');
  const endpointFns = ['listBrands', 'getBrand', 'listModels', 'getModel', 'getFacets', 'listLocations', 'getSitemapData'];
  for (const fn of endpointFns) assert.ok(exported.includes(fn), `missing endpoint function ${fn}`);
  // Nothing resembling a generic request/get/fetch escape hatch.
  for (const name of exported) {
    assert.doesNotMatch(name, /^(request|get|fetch)$/i, `generic escape hatch exported: ${name}`);
  }
});

test('a caller-supplied absolute URL cannot redirect the client off-origin', async () => {
  const mock = await startMockApi();
  try {
    _setApiOriginForTesting(mock.origin);
    // A slug that looks like an absolute URL is encoded into the path, not
    // treated as a destination.
    await getBrand('https://evil.example/steal');
    const requested = mock.requests.at(-1)!.url;
    assert.ok(requested.startsWith('/public/brands/'), `unexpected path: ${requested}`);
    assert.ok(!requested.includes('evil.example/steal'), 'the URL was not encoded into a single path segment');
    assert.match(requested, /https%3A/i, 'the scheme should have been percent-encoded');
  } finally {
    await mock.close();
  }
});

// ---------- 3 — query encoding ----------

test('query parameters are encoded safely and only supported keys are forwarded', async () => {
  const mock = await startMockApi();
  try {
    _setApiOriginForTesting(mock.origin);
    await listModels({ brand: 'a b&c=d', shape: 'aviator', page: '2', sort: 'name' });
    const requested = new URL(mock.requests.at(-1)!.url, 'http://x');
    assert.equal(requested.searchParams.get('brand'), 'a b&c=d');
    assert.equal(requested.searchParams.get('shape'), 'aviator');
    assert.equal(requested.searchParams.get('page'), '2');
    assert.equal(requested.searchParams.get('sort'), 'name');
    // The raw query string must have escaped the ampersand rather than
    // creating a second parameter.
    assert.ok(!/brand=a b&c=d/.test(mock.requests.at(-1)!.url));
  } finally {
    await mock.close();
  }
});

test('empty/undefined query values are omitted rather than sent as blank params', async () => {
  const mock = await startMockApi();
  try {
    _setApiOriginForTesting(mock.origin);
    await listModels({ brand: undefined, shape: '', page: '1' });
    const requested = new URL(mock.requests.at(-1)!.url, 'http://x');
    assert.equal(requested.searchParams.has('brand'), false);
    assert.equal(requested.searchParams.has('shape'), false);
    assert.equal(requested.searchParams.get('page'), '1');
  } finally {
    await mock.close();
  }
});

// ---------- 4 — timeout ----------

test('a slow upstream aborts and reports "unavailable", never a false empty result', async () => {
  // The client's timeout is 5s; this test does not wait that long — it
  // asserts the abort path is wired by using a server that never responds
  // and a shortened wait via the client's own AbortController.
  const mock = await startMockApi({ delayMs: 30_000 });
  try {
    _setApiOriginForTesting(mock.origin);
    const started = Date.now();
    const result = await listBrands();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'unavailable');
    assert.ok(Date.now() - started < 10_000, 'the request should abort on the client timeout');
  } finally {
    await mock.close();
  }
});

// ---------- 5/6/10 — content type, JSON validity, shape ----------

test('a non-JSON response is rejected as malformed, not parsed', async () => {
  const mock = await startMockApi({ contentType: 'text/html' });
  try {
    _setApiOriginForTesting(mock.origin);
    const result = await listBrands();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'malformed');
      assert.match(result.detail, /content-type/);
    }
  } finally {
    await mock.close();
  }
});

test('a JSON content-type with an unparseable body is rejected as malformed', async () => {
  const mock = await startMockApi({ invalidJson: true });
  try {
    _setApiOriginForTesting(mock.origin);
    const result = await listBrands();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'malformed');
  } finally {
    await mock.close();
  }
});

test('valid JSON in the wrong shape is rejected as malformed, never rendered', async () => {
  const mock = await startMockApi({ malformedShape: true });
  try {
    _setApiOriginForTesting(mock.origin);
    const result = await listBrands();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'malformed');
      assert.match(result.detail, /malformed public API response/);
    }
  } finally {
    await mock.close();
  }
});

// ---------- 7 — status distinction ----------

test('API 400, 404 and 500 are distinguished as bad-request, not-found and unavailable', async () => {
  for (const [status, kind] of [
    [400, 'bad-request'],
    [404, 'not-found'],
    [500, 'unavailable'],
    [502, 'unavailable'],
  ] as const) {
    const mock = await startMockApi({ failWith: { status } });
    try {
      _setApiOriginForTesting(mock.origin);
      const result = await listBrands();
      assert.equal(result.ok, false, `status ${status} should not be ok`);
      if (!result.ok) assert.equal(result.kind, kind, `status ${status} mapped to the wrong kind`);
    } finally {
      await mock.close();
    }
  }
});

test('each failure kind maps to exactly one documented HTTP status', () => {
  assert.deepEqual(PUBLIC_API_FAILURE_STATUS, {
    'bad-request': 400,
    'not-found': 404,
    unavailable: 503,
    malformed: 502,
  });
});

test('a connection failure (nothing listening) is "unavailable", never "not-found"', async () => {
  // Start and immediately close a server so the port is almost certainly free.
  const mock = await startMockApi();
  const deadOrigin = mock.origin;
  await mock.close();
  _setApiOriginForTesting(deadOrigin);
  const result = await listBrands();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, 'unavailable');
});

// ---------- 8 — no credential forwarding ----------

test('no cookie, authorization or identity header is forwarded to the API', async () => {
  const mock = await startMockApi();
  try {
    _setApiOriginForTesting(mock.origin);
    await listBrands();
    const { headers } = mock.requests.at(-1)!;
    assert.equal(headers.cookie, undefined, 'a cookie was forwarded');
    assert.equal(headers.authorization, undefined, 'an authorization header was forwarded');
    assert.equal(headers['x-forwarded-for'], undefined);
  } finally {
    await mock.close();
  }
});

test('the client source sets credentials: omit explicitly', () => {
  assert.match(clientCode, /credentials:\s*'omit'/);
});

// ---------- happy paths for every endpoint ----------

test('every endpoint returns validated data against the mock fixtures', async () => {
  const mock = await startMockApi();
  try {
    _setApiOriginForTesting(mock.origin);

    const brands = await listBrands();
    assert.equal(brands.ok, true);
    if (brands.ok) assert.equal(brands.data[0].slug, 'example-brand');

    const brand = await getBrand('example-brand');
    assert.equal(brand.ok, true);
    if (brand.ok) assert.equal(brand.data.name, 'Example Brand');

    const models = await listModels({});
    assert.equal(models.ok, true);
    if (models.ok) {
      assert.equal(models.data.items.length, 2);
      assert.equal(models.data.page, 1);
      assert.equal(models.data.hasMore, true);
    }

    const model = await getModel('example-brand', 'example-model');
    assert.equal(model.ok, true);
    if (model.ok) assert.equal(model.data.slug, 'example-model');

    const facets = await getFacets();
    assert.equal(facets.ok, true);

    const locations = await listLocations();
    assert.equal(locations.ok, true);
    if (locations.ok) assert.equal(locations.data[0].slug, 'italy-supply-base');
  } finally {
    await mock.close();
  }
});

test('an unknown brand/model slug yields not-found, distinct from any failure', async () => {
  const mock = await startMockApi();
  try {
    _setApiOriginForTesting(mock.origin);
    const brand = await getBrand('missing-brand');
    assert.equal(brand.ok, false);
    if (!brand.ok) assert.equal(brand.kind, 'not-found');

    const model = await getModel('example-brand', 'missing-model');
    assert.equal(model.ok, false);
    if (!model.ok) assert.equal(model.kind, 'not-found');
  } finally {
    await mock.close();
  }
});

// ---------- forbidden data cannot survive the client ----------

test('validated client output contains none of the adversarial fields the mock plants', async () => {
  const mock = await startMockApi();
  try {
    _setApiOriginForTesting(mock.origin);
    const results = await Promise.all([listBrands(), getBrand('example-brand'), listModels({}), getModel('example-brand', 'example-model'), listLocations()]);
    for (const result of results) {
      assert.equal(result.ok, true);
      const json = JSON.stringify(result.ok ? result.data : {});
      for (const [name, secret] of Object.entries(PLANTED_SECRETS)) {
        assert.ok(!json.includes(secret), `validated output leaked ${name} ("${secret}")`);
      }
    }
  } finally {
    await mock.close();
  }
});

test('getSitemapData validates its own shape (mock returns 404 for it, proving no silent empty success)', async () => {
  const mock = await startMockApi();
  try {
    _setApiOriginForTesting(mock.origin);
    const result = await getSitemapData();
    // The mock does not implement /public/sitemap-data, so this must be a
    // clean not-found rather than an empty-but-ok result.
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'not-found');
  } finally {
    await mock.close();
  }
});
