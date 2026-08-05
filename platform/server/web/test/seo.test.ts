import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeoHead } from '../src/lib/seo.ts';
import { STATIC_ROUTE_METADATA, NOT_FOUND_METADATA } from '../src/lib/metadata.ts';
import { NOT_FOUND_ROBOTS } from '../src/lib/indexing.ts';
import { env } from '../src/env.ts';

function q(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

test('builds title, description and canonical from the metadata record and the environment origin', () => {
  const meta = STATIC_ROUTE_METADATA['/contact/'];
  const seo = buildSeoHead({ meta, pathname: '/contact/', searchParams: q('') });
  assert.equal(seo.title, meta.title);
  assert.equal(seo.description, meta.description);
  assert.equal(seo.canonical, `${env.siteOrigin}/contact/`);
});

test('canonical origin comes only from the environment contract, never a literal', () => {
  const meta = STATIC_ROUTE_METADATA['/'];
  const seo = buildSeoHead({ meta, pathname: '/', searchParams: q('') });
  assert.ok(seo.canonical?.startsWith(env.siteOrigin));
});

test('canonical paths use the trailing-slash convention', () => {
  const meta = STATIC_ROUTE_METADATA['/collections/'];
  const seo = buildSeoHead({ meta, pathname: '/collections/', searchParams: q('') });
  assert.match(seo.canonical!, /\/collections\/$/);
});

test('query parameters are handled by indexing.ts, not blindly copied — a filter param never reaches canonical', () => {
  const meta = STATIC_ROUTE_METADATA['/collections/'];
  const seo = buildSeoHead({ meta, pathname: '/collections/', searchParams: q('brand=example&utm_source=x') });
  assert.equal(seo.canonical, `${env.siteOrigin}/collections/`);
  assert.equal(seo.robots, 'noindex, follow');
});

test('a valid page>1 state is preserved in the canonical URL', () => {
  const meta = STATIC_ROUTE_METADATA['/collections/'];
  const seo = buildSeoHead({ meta, pathname: '/collections/', searchParams: q('page=2') });
  assert.equal(seo.canonical, `${env.siteOrigin}/collections/?page=2`);
  assert.equal(seo.robots, 'index, follow');
});

test('no literal production domain ever appears in the built head', () => {
  const meta = STATIC_ROUTE_METADATA['/why-veyora/'];
  const seo = buildSeoHead({ meta, pathname: '/why-veyora/', searchParams: q('') });
  for (const value of [seo.title, seo.description, seo.canonical, seo.ogUrl, seo.ogTitle, seo.ogDescription]) {
    assert.doesNotMatch(String(value), /veyora\.(design|com)/i);
  }
});

test('produces every required OG and Twitter field', () => {
  const meta = STATIC_ROUTE_METADATA['/brands/'];
  const seo = buildSeoHead({ meta, pathname: '/brands/', searchParams: q('') });
  assert.equal(seo.ogType, 'website');
  assert.equal(seo.ogSiteName, 'Veyora');
  assert.equal(seo.ogTitle, meta.title);
  assert.equal(seo.ogDescription, meta.description);
  assert.equal(seo.ogUrl, seo.canonical);
  assert.equal(seo.twitterCard, 'summary_large_image');
  assert.equal(seo.twitterTitle, meta.title);
  assert.equal(seo.twitterDescription, meta.description);
});

test('og:image and twitter:image are optional and absent by default', () => {
  const meta = STATIC_ROUTE_METADATA['/brands/'];
  const seo = buildSeoHead({ meta, pathname: '/brands/', searchParams: q('') });
  assert.equal(seo.ogImage, undefined);
  assert.equal(seo.twitterImage, undefined);
});

test('og:image, when supplied, is carried through to both OG and Twitter', () => {
  const meta = STATIC_ROUTE_METADATA['/brands/'];
  const seo = buildSeoHead({
    meta,
    pathname: '/brands/',
    searchParams: q(''),
    ogImage: `${env.siteOrigin}/og-default.png`,
  });
  assert.equal(seo.ogImage, `${env.siteOrigin}/og-default.png`);
  assert.equal(seo.twitterImage, `${env.siteOrigin}/og-default.png`);
});

test('missing title fails clearly rather than rendering blank', () => {
  const brokenMeta = { ...STATIC_ROUTE_METADATA['/contact/'], title: '' };
  assert.throws(
    () => buildSeoHead({ meta: brokenMeta, pathname: '/contact/', searchParams: q('') }),
    /no title/
  );
});

test('missing description fails clearly rather than rendering blank', () => {
  const brokenMeta = { ...STATIC_ROUTE_METADATA['/contact/'], description: '   ' };
  assert.throws(
    () => buildSeoHead({ meta: brokenMeta, pathname: '/contact/', searchParams: q('') }),
    /no description/
  );
});

test('fixedRobots (404/500) bypasses query-state indexing and omits canonical entirely', () => {
  const seo = buildSeoHead({
    meta: NOT_FOUND_METADATA,
    pathname: '/anything/',
    searchParams: q('page=99&brand=x'),
    fixedRobots: NOT_FOUND_ROBOTS,
  });
  assert.equal(seo.robots, NOT_FOUND_ROBOTS);
  assert.equal(seo.canonical, null);
  assert.equal(seo.ogUrl, null);
});
