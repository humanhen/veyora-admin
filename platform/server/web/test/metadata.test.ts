import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATIC_ROUTE_METADATA,
  brandDetailMetadata,
  modelDetailMetadata,
  resourceMetadata,
  allRouteMetadataForTesting,
  NOT_FOUND_METADATA,
  SERVER_ERROR_METADATA,
} from '../src/lib/metadata.ts';

const STATIC_PATHS = Object.keys(STATIC_ROUTE_METADATA);

test('the static registry has all 21 fully static routes', () => {
  // 25 routes total minus 4 dynamic route NUMBERS (4, 9, 14, 15) — 14 and
  // 15 share one file/builder (resourceMetadata), so there are only 3
  // dynamic builder functions, but 21 fully static entries here.
  assert.equal(STATIC_PATHS.length, 21);
});

test('allRouteMetadataForTesting resolves to exactly 25 routes', () => {
  assert.equal(allRouteMetadataForTesting().length, 25);
});

test('every static route record has a non-empty title, description and H1', () => {
  for (const [path, meta] of Object.entries(STATIC_ROUTE_METADATA)) {
    assert.ok(meta.title?.trim(), `${path} has no title`);
    assert.ok(meta.description?.trim(), `${path} has no description`);
    assert.ok(meta.h1?.trim(), `${path} has no H1`);
    assert.ok(meta.breadcrumbLabel?.trim(), `${path} has no breadcrumb label`);
  }
});

test('every route record path field matches its registry key', () => {
  for (const [path, meta] of Object.entries(STATIC_ROUTE_METADATA)) {
    assert.equal(meta.path, path);
  }
});

test('titles are unique across all 25 routes', () => {
  const titles = allRouteMetadataForTesting().map((m) => m.title);
  assert.equal(new Set(titles).size, titles.length, 'duplicate title found');
});

test('descriptions are unique across all 25 routes', () => {
  const descriptions = allRouteMetadataForTesting().map((m) => m.description);
  assert.equal(new Set(descriptions).size, descriptions.length, 'duplicate description found');
});

test('no metadata field hard-codes a real Veyora domain', () => {
  for (const meta of allRouteMetadataForTesting()) {
    for (const field of [meta.title, meta.description, meta.h1, meta.breadcrumbLabel]) {
      assert.doesNotMatch(field, /veyora\.(design|com)/i);
    }
  }
});

test('routes documented with approved specification text are marked pendingContent: false', () => {
  const documented = [
    '/',
    '/why-veyora/',
    '/brands/',
    '/collections/',
    '/service-model/',
    '/private-label/',
    '/resources/',
    '/contact/',
    '/request-b2b-account/',
  ];
  for (const path of documented) {
    assert.equal(STATIC_ROUTE_METADATA[path].pendingContent, false, `${path} should be pendingContent: false`);
  }
});

test('routes with no approved specification text are marked pendingContent: true', () => {
  const pending = [
    '/collections/optical/',
    '/collections/sun/',
    '/collections/kids/',
    '/private-label-enquiry/',
    '/shipping/',
    '/warranty-and-exchanges/',
    '/ordering-guide/',
    '/privacy-policy/',
    '/terms/',
    '/accessibility/',
    '/sitemap/',
  ];
  for (const path of pending) {
    assert.equal(STATIC_ROUTE_METADATA[path].pendingContent, true, `${path} should be pendingContent: true`);
  }
});

test('global-presence is marked pending despite documented text, since its title carries an unresolved business decision', () => {
  assert.equal(STATIC_ROUTE_METADATA['/global-presence/'].pendingContent, true);
});

test('category-landing routes use the exact neutral labels from the B1.2 precedent', () => {
  assert.equal(STATIC_ROUTE_METADATA['/collections/optical/'].h1, 'Optical collection page');
  assert.equal(STATIC_ROUTE_METADATA['/collections/sun/'].h1, 'Sun collection page');
  assert.equal(STATIC_ROUTE_METADATA['/collections/kids/'].h1, 'Kids collection page');
});

test('dynamic brand metadata safely accepts a route parameter and marks it pending', () => {
  const meta = brandDetailMetadata('example-brand');
  assert.match(meta.title, /^Example Brand /);
  assert.match(meta.h1, /^Example Brand /);
  assert.equal(meta.pendingContent, true);
  assert.doesNotMatch(meta.title, /veyora\.(design|com)/i);
});

test('dynamic model metadata safely accepts two route parameters, interpolates both into a unique title/H1, and marks it pending', () => {
  const meta = modelDetailMetadata('example-brand', 'example-model');
  assert.equal(meta.title, 'Example Brand Example Model | Veyora');
  assert.equal(meta.h1, 'Example Brand Example Model model detail page');
  assert.match(meta.description, /Example Brand Example Model/);
  assert.equal(meta.pendingContent, true);
});

test('two different model slugs never collide on title/H1', () => {
  const a = modelDetailMetadata('brand-one', 'model-a');
  const b = modelDetailMetadata('brand-two', 'model-b');
  assert.notEqual(a.title, b.title);
  assert.notEqual(a.h1, b.h1);
});

test('dynamic resource metadata safely accepts a route parameter, interpolates it into a unique title/H1, and marks it pending', () => {
  const meta = resourceMetadata('example-slug');
  assert.equal(meta.title, 'Example Slug | Veyora');
  assert.equal(meta.h1, 'Example Slug resource page');
  assert.match(meta.description, /Example Slug/);
  assert.equal(meta.pendingContent, true);
});

test('two different resource slugs (standing in for a category and an article) never collide on title/H1', () => {
  const category = resourceMetadata('example-category');
  const article = resourceMetadata('example-slug');
  assert.notEqual(category.title, article.title);
  assert.notEqual(category.h1, article.h1);
});

test('dynamic metadata builders never invent a fact for an unusual or empty slug', () => {
  const meta = brandDetailMetadata('');
  assert.equal(meta.title, ' Wholesale Eyewear for Optical Retailers | Veyora');
  // Empty slug produces an empty humanised label, not a fabricated name —
  // documented, visible behaviour rather than a crash or a guess.
});

test('system error pages have their own fixed metadata, distinct from the 25 public routes', () => {
  assert.ok(NOT_FOUND_METADATA.title);
  assert.ok(SERVER_ERROR_METADATA.title);
  assert.equal(NOT_FOUND_METADATA.sitemapEligible, false);
  assert.equal(SERVER_ERROR_METADATA.sitemapEligible, false);
  assert.doesNotMatch(NOT_FOUND_METADATA.description, /veyora\.(design|com)/i);
  assert.doesNotMatch(SERVER_ERROR_METADATA.description, /veyora\.(design|com)/i);
});

test('every route is flagged for future-sitemap intent (structural), independent of per-request query state', () => {
  for (const meta of Object.values(STATIC_ROUTE_METADATA)) {
    assert.equal(meta.sitemapEligible, true);
  }
});
