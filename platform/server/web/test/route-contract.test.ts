/* Route-contract suite: walks all 25 route definitions from the central
   metadata registry (src/lib/metadata.ts) and, for each, builds its head
   via buildSeoHead() exactly as Page.astro does, then asserts the full
   B1.3 contract. This is the source-level companion to
   test/http-routes.test.ts's live HTTP checks — this file proves the
   metadata/SEO/indexing wiring is correct for every route without needing
   a running server for each one. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { allRouteMetadataForTesting } from '../src/lib/metadata.ts';
import { buildSeoHead } from '../src/lib/seo.ts';
import { env } from '../src/env.ts';

function q(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

const routes = allRouteMetadataForTesting();

test('sanity: exactly 25 route definitions are under contract', () => {
  assert.equal(routes.length, 25);
});

test('every route has exactly one intended H1 (a single non-empty string)', () => {
  for (const meta of routes) {
    assert.equal(typeof meta.h1, 'string');
    assert.ok(meta.h1.trim().length > 0, `${meta.path} has an empty H1`);
  }
});

test('every route has a non-empty title and description', () => {
  for (const meta of routes) {
    assert.ok(meta.title.trim().length > 0, `${meta.path} has an empty title`);
    assert.ok(meta.description.trim().length > 0, `${meta.path} has an empty description`);
  }
});

test('titles and descriptions are unique across all 25 routes', () => {
  const titles = routes.map((m) => m.title);
  const descriptions = routes.map((m) => m.description);
  assert.equal(new Set(titles).size, titles.length, 'a title is duplicated');
  assert.equal(new Set(descriptions).size, descriptions.length, 'a description is duplicated');
});

test('every route resolves an absolute canonical using the configured environment origin', () => {
  for (const meta of routes) {
    // Dynamic routes carry a `:param` pattern in `path`; resolve against a
    // concrete example path the same way the real page file would.
    const examplePath = meta.path.replace(/:\w+/g, 'example').replace(/\/{2,}/g, '/');
    const seo = buildSeoHead({ meta, pathname: examplePath, searchParams: q('') });
    assert.ok(seo.canonical, `${meta.path} produced no canonical`);
    assert.ok(seo.canonical!.startsWith(env.siteOrigin), `${meta.path} canonical does not use the configured origin`);
    assert.match(seo.canonical!, /\/$/, `${meta.path} canonical does not end in a trailing slash`);
  }
});

test('every route produces the complete required OG and Twitter field set', () => {
  for (const meta of routes) {
    const examplePath = meta.path.replace(/:\w+/g, 'example').replace(/\/{2,}/g, '/');
    const seo = buildSeoHead({ meta, pathname: examplePath, searchParams: q('') });
    assert.equal(seo.ogType, 'website');
    assert.equal(seo.ogSiteName, 'Veyora');
    assert.ok(seo.ogTitle);
    assert.ok(seo.ogDescription);
    assert.ok(seo.ogUrl);
    assert.equal(seo.twitterCard, 'summary_large_image');
    assert.ok(seo.twitterTitle);
    assert.ok(seo.twitterDescription);
  }
});

test('every route resolves to index, follow on its clean canonical request', () => {
  for (const meta of routes) {
    const examplePath = meta.path.replace(/:\w+/g, 'example').replace(/\/{2,}/g, '/');
    const seo = buildSeoHead({ meta, pathname: examplePath, searchParams: q('') });
    assert.equal(seo.robots, 'index, follow', `${meta.path} did not resolve to index, follow`);
  }
});

test('no route metadata hard-codes a real Veyora production domain', () => {
  for (const meta of routes) {
    for (const field of [meta.title, meta.description, meta.h1]) {
      assert.doesNotMatch(field, /veyora\.(design|com)/i);
    }
  }
});

test('every route carries the correct structural sitemap-intent flag', () => {
  // All 25 public routes are structurally sitemap-eligible (their CLEAN
  // canonical form belongs in a future sitemap) — query-state eligibility
  // is a separate, per-request concern computed by indexing.ts.
  for (const meta of routes) {
    assert.equal(meta.sitemapEligible, true, `${meta.path} should be sitemapEligible`);
  }
});

test('metadata and H1 are drawn only from the central registry — every record has the shape Page.astro expects', () => {
  for (const meta of routes) {
    assert.ok('breadcrumbLabel' in meta);
    assert.ok('indexingCategory' in meta);
    assert.ok('pendingContent' in meta);
    assert.equal(typeof meta.pendingContent, 'boolean');
  }
});
