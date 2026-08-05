/* Runtime validation of public API responses (B2.3) — including the
   forbidden-data property the whole layer exists to guarantee: an
   adversarial upstream payload cannot smuggle a private field into
   validated output, because validation builds fresh objects from named
   fields rather than spreading what arrived. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PublicShapeError,
  validateMedia,
  validateBrandSummary,
  validateBrandDetail,
  validateModelCard,
  validateModelDetail,
  validateBrandListResponse,
  validateModelListResponse,
  validateModelDetailResponse,
  validateLocationsResponse,
  validateFacetsResponse,
  validateSitemapDataResponse,
} from '../src/lib/public-types.ts';
import { PLANTED_SECRETS, FIXTURES } from './helpers/mock-public-api.ts';

// ---------- shape rejection ----------

test('a non-object response is rejected', () => {
  for (const bad of [null, undefined, 'string', 42, true, []]) {
    assert.throws(() => validateBrandListResponse(bad), PublicShapeError);
  }
});

test('a missing or non-array collection is rejected', () => {
  assert.throws(() => validateBrandListResponse({}), PublicShapeError);
  assert.throws(() => validateBrandListResponse({ brands: 'not-an-array' }), PublicShapeError);
  assert.throws(() => validateLocationsResponse({ locations: {} }), PublicShapeError);
});

test('a required string arriving as the wrong primitive type is rejected, not coerced', () => {
  assert.throws(() => validateBrandSummary({ slug: 42, name: 'X' }), /slug must be a string/);
  assert.throws(() => validateBrandSummary({ slug: 'x', name: null }), /name must be a string/);
  assert.throws(() => validateBrandSummary({ slug: '   ', name: 'X' }), /slug must not be empty/);
});

test('an optional string arriving as the wrong type is rejected', () => {
  assert.throws(
    () => validateBrandSummary({ slug: 'x', name: 'X', headline: 42 }),
    /headline must be a string or null/
  );
});

test('page must be a positive integer in a model list response', () => {
  const base = { items: [], hasMore: false };
  for (const page of [0, -1, 1.5, '1', null]) {
    assert.throws(() => validateModelListResponse({ ...base, page }), PublicShapeError);
  }
  assert.doesNotThrow(() => validateModelListResponse({ ...base, page: 1 }));
});

test('hasMore must be a real boolean, not a truthy value', () => {
  assert.throws(
    () => validateModelListResponse({ items: [], page: 1, hasMore: 'yes' }),
    /hasMore must be a boolean/
  );
});

test('an invalid date string is rejected rather than passed through', () => {
  assert.throws(
    () => validateBrandDetail({ slug: 'x', name: 'X', contentUpdatedAt: 'not-a-date' }),
    /not a valid date/
  );
});

test('an oversized array is rejected', () => {
  const huge = Array.from({ length: 500 }, () => 'x');
  assert.throws(() => validateBrandListResponse({ brands: huge }), /too many items/);
});

// ---------- media URL safety ----------

test('unsafe media URL schemes are dropped, never rendered', () => {
  for (const unsafe of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.example/x.jpg', 'relative/path.jpg']) {
    assert.equal(validateMedia({ path: unsafe, alt: 'x' }), null, `unsafe path survived: ${unsafe}`);
  }
});

test('safe media paths are accepted', () => {
  assert.equal(validateMedia({ path: '/s3/a.jpg', alt: 'a' })?.path, '/s3/a.jpg');
  assert.equal(validateMedia({ path: 'https://cdn.example/a.jpg', alt: 'a' })?.path, 'https://cdn.example/a.jpg');
  assert.equal(validateMedia({ path: 'http://cdn.example/a.jpg', alt: 'a' })?.path, 'http://cdn.example/a.jpg');
});

test('a media object with an unsafe path is dropped from a model detail media array entirely', () => {
  const detail = validateModelDetailResponse(FIXTURES.modelDetail);
  // The fixture contains one safe image and one javascript: entry.
  assert.equal(detail.media.length, 1);
  assert.equal(detail.media[0].path, '/s3/models/example.jpg');
});

test('media administrative fields never appear in validated output', () => {
  const media = validateMedia({
    path: '/s3/a.jpg',
    alt: 'a',
    width: 10,
    height: 10,
    kind: 'image',
    rightsHolder: PLANTED_SECRETS.rightsHolder,
    ownerId: 'br_secret',
  });
  assert.deepEqual(Object.keys(media!).sort(), ['alt', 'height', 'kind', 'path', 'width']);
});

// ---------- forbidden data cannot survive validation ----------

const ALL_SECRETS = Object.entries(PLANTED_SECRETS);

function assertNoSecrets(value: unknown, label: string) {
  const json = JSON.stringify(value);
  for (const [name, secret] of ALL_SECRETS) {
    assert.ok(!json.includes(secret), `${label} leaked ${name} ("${secret}")`);
  }
}

test('an adversarial brand payload cannot leak a forbidden field through validation', () => {
  assertNoSecrets(validateBrandListResponse(FIXTURES.brands), 'brand list');
  assertNoSecrets(validateBrandDetail(FIXTURES.brandDetail.brand), 'brand detail');
});

test('an adversarial model payload cannot leak price, stock, cost or Zoho id', () => {
  assertNoSecrets(validateModelListResponse(FIXTURES.models), 'model list');
  assertNoSecrets(validateModelDetailResponse(FIXTURES.modelDetail), 'model detail');
});

test('an adversarial location payload cannot leak address, contact or coordinates', () => {
  const locations = validateLocationsResponse(FIXTURES.locations);
  assertNoSecrets(locations, 'locations');
  assert.deepEqual(Object.keys(locations[0]).sort(), ['function', 'hours', 'name', 'regionsServed', 'slug']);
  assert.ok(!('address' in locations[0]));
  assert.ok(!('contact' in locations[0]));
  assert.ok(!('coordinates' in locations[0]));
});

test('internal label:* tags are stripped from categories during validation', () => {
  const card = validateModelCard({
    brandSlug: 'b',
    slug: 's',
    name: 'N',
    categories: ['Optical', 'label:internal', 'LABEL:other', 'Sun'],
  });
  assert.deepEqual(card.categories, ['Optical', 'Sun']);
});

test('a nested private object cannot ride along into validated output', () => {
  const card = validateModelCard({
    brandSlug: 'b',
    slug: 's',
    name: 'N',
    internal: { nested: { cost: PLANTED_SECRETS.cost } },
    pricing: { mode: 'tiered' },
  });
  assert.ok(!('internal' in card));
  assert.ok(!('pricing' in card));
  assertNoSecrets(card, 'model card with nested private object');
});

test('validators return a NEW object, never the input reference', () => {
  const input = { slug: 'x', name: 'X' };
  assert.notEqual(validateBrandSummary(input), input);
  const modelInput = { brandSlug: 'b', slug: 's', name: 'N' };
  assert.notEqual(validateModelCard(modelInput), modelInput);
});

test('harmless public words are not mistaken for forbidden data', () => {
  // "discontinued" contains no forbidden token by exact match, and the
  // validators do not denylist substrings at all — they allowlist fields.
  const card = validateModelCard({
    brandSlug: 'b',
    slug: 's',
    name: 'Discontinued Classic',
    categories: ['Discontinued', 'Optical'],
    line: 'Ordering Guide Line',
  });
  assert.equal(card.name, 'Discontinued Classic');
  assert.deepEqual(card.categories, ['Discontinued', 'Optical']);
  assert.equal(card.line, 'Ordering Guide Line');
});

// ---------- normalisation ----------

test('empty-string optional fields normalise to null so templates test one thing', () => {
  const brand = validateBrandSummary({ slug: 'x', name: 'X', headline: '   ', segment: '' });
  assert.equal(brand.headline, null);
  assert.equal(brand.segment, null);
});

test('missing array fields default to empty arrays, never null', () => {
  const brand = validateBrandDetail({ slug: 'x', name: 'X' });
  assert.deepEqual(brand.bestFor, []);
  assert.deepEqual(brand.styleTraits, []);
  assert.deepEqual(brand.featuredModels, []);
});

test('facets and sitemap-data validate to their documented shapes', () => {
  const facets = validateFacetsResponse(FIXTURES.facets);
  assert.deepEqual(Object.keys(facets).sort(), ['brands', 'categories', 'shapes', 'sizes']);

  const sitemap = validateSitemapDataResponse({
    brands: [{ path: '/brands/x/', contentUpdatedAt: '2026-08-01T00:00:00.000Z' }],
    models: [],
    pages: [],
  });
  assert.equal(sitemap.brands[0].path, '/brands/x/');
  assert.deepEqual(sitemap.models, []);
});
