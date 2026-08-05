/* robots.txt, XML sitemap and JSON-LD (Fast-Track Phase 4).

   Unit rules against the real modules. Live-server behaviour and the rendered
   forbidden-data scan live in http-routes.test.ts and public-render.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSitemapEntries, renderSitemapXml, escapeXml, normaliseLastmod,
  isIndexablePath, STATIC_SITEMAP_PATHS,
} from '../src/lib/sitemap-xml.ts';
import {
  buildWebSite, buildBreadcrumbs, buildCollectionPage, buildProduct, buildBrand,
  serialiseJsonLd, FORBIDDEN_JSONLD_KEYS,
} from '../src/lib/structured-data.ts';
import { PLANTED_SECRETS } from './helpers/mock-public-api.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const robotsSource = read('src', 'pages', 'robots.txt.ts');
const sitemapSource = read('src', 'pages', 'sitemap.xml.ts');
const pageLayout = read('src', 'layouts', 'Page.astro');

const ORIGIN = 'https://example.test';

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

test('robots.txt is dynamic, text/plain, and derives its sitemap URL from the environment', () => {
  assert.match(robotsSource, /export const prerender = false/);
  assert.match(robotsSource, /'content-type': 'text\/plain; charset=utf-8'/);
  assert.match(robotsSource, /\$\{origin\}\/sitemap\.xml/);
  assert.match(robotsSource, /env\.siteOrigin/);
});

test('robots.txt hard-codes no hostname', () => {
  const code = robotsSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.doesNotMatch(code, /veyora\.(design|com|net)/i);
  /* Any address literal must be a loopback one, and may appear only in the
     non-production detector. (It is written escaped inside a regex literal,
     so the check normalises `\.` before matching.) */
  const addresses = code.replace(/\\\./g, '.').match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) ?? [];
  for (const address of addresses) {
    assert.equal(address, '127.0.0.1', `robots.txt embeds a non-loopback address: ${address}`);
  }
  assert.match(robotsSource, /looksNonProduction/, 'the only address literal belongs to the detector');
});

test('robots.txt does not advertise admin, API or upload paths as content', () => {
  assert.match(robotsSource, /Disallow: \$\{path\}/);
  assert.match(robotsSource, /const DISALLOWED = \['\/admin', '\/api\/', '\/s3\/'\]/);
  // Disallow is a crawl hint, not a control — stated in the source.
  assert.match(robotsSource, /NOT A SECURITY CONTROL/);
});

test('a non-production origin disallows everything and offers no sitemap', () => {
  assert.match(robotsSource, /Disallow: \/'/);
  assert.match(robotsSource, /Non-production origin/);
  assert.match(robotsSource, /looksNonProduction/);
});

// ---------------------------------------------------------------------------
// sitemap: inclusion rules
// ---------------------------------------------------------------------------

test('only clean, canonical, indexable paths are accepted', () => {
  for (const good of ['/', '/brands/', '/collections/sun/', '/brands/example-brand/']) {
    assert.equal(isIndexablePath(good), true, good);
  }
  for (const bad of [
    '/collections/?brand=x', '/collections/#frag', '/collections',       // query, fragment, no slash
    '//evil.test/', '/../etc/', '/admin/', '/api/x/', '/s3/img.jpg',      // escape, traversal, private
    '/404/', '/500/', '/healthz', '/_image/', 'collections/', '/a b/',    // errors, internals, relative, space
  ]) {
    assert.equal(isIndexablePath(bad), false, bad);
  }
});

test('no filtered, sorted, paginated or error route is in the static list', () => {
  for (const p of STATIC_SITEMAP_PATHS) {
    assert.equal(isIndexablePath(p), true, p);
    assert.ok(!p.includes('?'), p);
    assert.ok(!/\/(404|500)\//.test(p), p);
  }
  assert.ok(!STATIC_SITEMAP_PATHS.includes('/404/'));
  assert.ok(!STATIC_SITEMAP_PATHS.includes('/500/'));
});

test('published brands, models and pages are included with absolute URLs', () => {
  const entries = buildSitemapEntries(
    {
      brands: [{ path: '/brands/example-brand/', contentUpdatedAt: '2026-08-01T00:00:00.000Z' }],
      models: [{ path: '/collections/example-brand/example-model/', contentUpdatedAt: null }],
      pages: [{ path: '/resources/guide/', contentUpdatedAt: '2026-07-01T00:00:00.000Z' }],
    },
    { origin: ORIGIN, now: new Date('2026-08-06T00:00:00Z') }
  );

  const locs = entries.map((e) => e.loc);
  assert.ok(locs.includes(`${ORIGIN}/brands/example-brand/`));
  assert.ok(locs.includes(`${ORIGIN}/collections/example-brand/example-model/`));
  assert.ok(locs.includes(`${ORIGIN}/resources/guide/`));
  for (const loc of locs) assert.ok(loc.startsWith(`${ORIGIN}/`), loc);
});

test('an unindexable record from upstream is dropped, not emitted', () => {
  const entries = buildSitemapEntries(
    {
      brands: [{ path: '/brands/ok/', contentUpdatedAt: null }],
      models: [
        { path: '/collections/x/?sort=name', contentUpdatedAt: null },
        { path: '//evil.test/', contentUpdatedAt: null },
        { path: '/admin/secret/', contentUpdatedAt: null },
      ],
      pages: [],
    },
    { origin: ORIGIN }
  );
  const locs = entries.map((e) => e.loc);
  assert.ok(locs.includes(`${ORIGIN}/brands/ok/`));
  for (const bad of ['sort=name', 'evil.test', '/admin/']) {
    assert.ok(!locs.some((l) => l.includes(bad)), bad);
  }
});

test('duplicates are removed and ordering is deterministic', () => {
  const data = {
    brands: [{ path: '/brands/a/', contentUpdatedAt: null }, { path: '/brands/a/', contentUpdatedAt: null }],
    models: [{ path: '/', contentUpdatedAt: null }],   // already a static route
    pages: [],
  };
  const first = buildSitemapEntries(data, { origin: ORIGIN });
  const second = buildSitemapEntries(data, { origin: ORIGIN });
  assert.deepEqual(first, second);
  assert.equal(first.filter((e) => e.loc === `${ORIGIN}/brands/a/`).length, 1);
  assert.equal(first.filter((e) => e.loc === `${ORIGIN}/`).length, 1);
});

test('lastmod is used only when valid and not in the future', () => {
  const now = new Date('2026-08-06T00:00:00Z');
  assert.equal(normaliseLastmod('2026-08-01T12:00:00.000Z', now), '2026-08-01');
  assert.equal(normaliseLastmod(null, now), null);
  assert.equal(normaliseLastmod('not-a-date', now), null);
  assert.equal(normaliseLastmod('2099-01-01T00:00:00.000Z', now), null, 'a future date must be dropped');
});

// ---------------------------------------------------------------------------
// sitemap: serialisation
// ---------------------------------------------------------------------------

test('XML special characters are escaped, ampersand first', () => {
  assert.equal(escapeXml('a&b'), 'a&amp;b');
  assert.equal(escapeXml('<x>'), '&lt;x&gt;');
  assert.equal(escapeXml(`"q" 'a'`), '&quot;q&quot; &apos;a&apos;');
  // Ampersand-first ordering: no double escaping.
  assert.equal(escapeXml('&lt;'), '&amp;lt;');
});

test('the rendered document is well-formed and deterministically parseable', () => {
  const xml = renderSitemapXml([
    { loc: `${ORIGIN}/`, lastmod: '2026-08-01' },
    { loc: `${ORIGIN}/brands/a&b/`, lastmod: null },
  ]);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(xml, /<\/urlset>\n$/);

  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, [`${ORIGIN}/`, `${ORIGIN}/brands/a&amp;b/`]);
  assert.equal((xml.match(/<url>/g) ?? []).length, 2);
  assert.equal((xml.match(/<lastmod>/g) ?? []).length, 1, 'lastmod only when known');
});

test('an upstream failure answers non-200 rather than an authoritative short sitemap', () => {
  assert.match(sitemapSource, /if \(!result\.ok\)/);
  assert.match(sitemapSource, /status: PUBLIC_API_FAILURE_STATUS\[result\.kind\]/);
  assert.match(sitemapSource, /'cache-control': 'no-store'/);
  assert.match(sitemapSource, /NEVER AN EMPTY SITEMAP/);
  assert.match(sitemapSource, /'content-type': 'application\/xml; charset=utf-8'/);
});

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

const MODEL = {
  brandSlug: 'example-brand', brandName: 'Example Brand', slug: 'example-model',
  sku: '20894', name: 'Example Model', line: 'Heritage', shape: 'aviator',
  segment: 'premium', size: 'Medium', categories: ['Optical'], isFeatured: true,
  publicDescription: 'A classic aviator silhouette.',
  primaryMedia: { path: '/s3/models/example.jpg', alt: 'Example', width: 800, height: 800, kind: 'image' as const },
  media: [], variations: [{ sku: '20894.1', colorName: 'Matte Black', colorCode: 'BLK-01', swatchMedia: null }],
  relatedModels: [], lensType: 'polarized', contentUpdatedAt: null,
} as never;

const BRAND = {
  slug: 'example-brand', name: 'Example Brand', shortName: 'Example', segment: 'premium',
  headline: 'Distinctive eyewear', priceTierLabel: 'Premium',
  logoMedia: { path: '/s3/brands/logo.svg', alt: 'logo', width: 400, height: 120, kind: 'image' as const },
  summary: 'A premium eyewear brand.', story: '', idealRetailer: '', bestFor: [], styleTraits: [],
  designOrigin: '', manufacturingOrigin: '', componentOrigins: [], approvedMaterials: [],
  heroMedia: null, featuredModels: [], contentUpdatedAt: null,
} as never;

test('every builder emits valid JSON with a schema.org context and type', () => {
  const nodes = [
    buildWebSite(ORIGIN),
    buildBreadcrumbs([{ label: 'Home', href: '/' }, { label: 'Brands', href: '/brands/' }], ORIGIN),
    buildCollectionPage({ name: 'Collections', description: 'd', path: '/collections/', items: [], origin: ORIGIN }),
    buildProduct(MODEL, ORIGIN),
    buildBrand(BRAND, ORIGIN),
  ];
  for (const node of nodes) {
    assert.ok(node, 'builder returned nothing');
    const parsed = JSON.parse(JSON.stringify(node));
    assert.equal(parsed['@context'], 'https://schema.org');
    assert.equal(typeof parsed['@type'], 'string');
  }
});

test('no builder emits an offer, price, availability, rating or unsupported claim', () => {
  const serialised = JSON.stringify([
    buildWebSite(ORIGIN),
    buildCollectionPage({ name: 'C', description: 'd', path: '/collections/', items: [], origin: ORIGIN }),
    buildProduct(MODEL, ORIGIN),
    buildBrand(BRAND, ORIGIN),
  ]);
  for (const key of FORBIDDEN_JSONLD_KEYS) {
    assert.ok(!serialised.includes(`"${key}"`), `JSON-LD emitted "${key}"`);
  }
});

test('a Product carries only published catalogue facts', () => {
  const product = buildProduct(MODEL, ORIGIN) as Record<string, unknown>;
  assert.equal(product['@type'], 'Product');
  assert.equal(product.name, 'Example Model');
  assert.equal(product.sku, '20894');
  assert.deepEqual(product.brand, { '@type': 'Brand', name: 'Example Brand' });
  assert.equal(product.url, `${ORIGIN}/collections/example-brand/example-model/`);
  assert.equal(product.image, `${ORIGIN}/s3/models/example.jpg`);
  assert.deepEqual(product.color, ['Matte Black']);
  assert.ok(!('offers' in product));
});

test('a missing or unsafe image is omitted rather than guessed', () => {
  const noImage = buildProduct({ ...MODEL, primaryMedia: null, media: [] } as never, ORIGIN) as Record<string, unknown>;
  assert.ok(!('image' in noImage));

  const unsafe = buildProduct(
    { ...MODEL, primaryMedia: { ...(MODEL as never as { primaryMedia: object }).primaryMedia, path: 'javascript:alert(1)' } } as never,
    ORIGIN
  ) as Record<string, unknown>;
  assert.ok(!('image' in unsafe), 'an unsafe scheme must never become an image URL');
});

test('breadcrumb structured data mirrors the visible trail exactly', () => {
  const items = [
    { label: 'Home', href: '/' },
    { label: 'Brands', href: '/brands/' },
    { label: 'Example Brand', href: '/brands/example-brand/' },
  ];
  const node = buildBreadcrumbs(items, ORIGIN) as Record<string, unknown>;
  const list = node.itemListElement as Array<Record<string, unknown>>;

  assert.equal(list.length, items.length);
  list.forEach((entry, i) => {
    assert.equal(entry.position, i + 1);
    assert.equal(entry.name, items[i].label);
    assert.equal(entry.item, `${ORIGIN}${items[i].href}`);
  });
});

test('a single crumb produces no breadcrumb list', () => {
  assert.equal(buildBreadcrumbs([{ label: 'Home', href: '/' }], ORIGIN), null);
  assert.equal(buildBreadcrumbs([], ORIGIN), null);
});

test('a CollectionPage counts only the items on this page', () => {
  const items = [
    { brandSlug: 'b', slug: 'm1', name: 'M1' },
    { brandSlug: 'b', slug: 'm2', name: 'M2' },
  ] as never;
  const node = buildCollectionPage({ name: 'C', description: 'd', path: '/collections/', items, origin: ORIGIN }) as Record<string, unknown>;
  const list = node.mainEntity as Record<string, unknown>;
  assert.equal(list.numberOfItems, 2, 'never a claimed catalogue total');
  assert.equal((list.itemListElement as unknown[]).length, 2);
});

test('serialisation escapes < so a value cannot close the script block', () => {
  const serialised = serialiseJsonLd({ '@type': 'Thing', name: '</script><script>alert(1)</script>' });
  assert.ok(!serialised.includes('</script>'), 'the script block could be closed early');
  assert.match(serialised, /\\u003c/);
  assert.equal((JSON.parse(serialised.replace(/\\u003c/g, '<')) as { name: string }).name,
    '</script><script>alert(1)</script>');
});

test('no planted forbidden value can reach a JSON-LD node', () => {
  /* The builders read only validated fields, so an adversarial upstream
     payload has nowhere to land. Asserted against the same planted literals
     the render tests use. */
  const poisoned = { ...(MODEL as object), ...PLANTED_SECRETS } as never;
  const serialised = JSON.stringify(buildProduct(poisoned, ORIGIN));
  for (const [key, value] of Object.entries(PLANTED_SECRETS)) {
    assert.ok(!serialised.includes(value), `JSON-LD leaked ${key} (${value})`);
  }
});

// ---------------------------------------------------------------------------
// layout wiring
// ---------------------------------------------------------------------------

test('every page emits WebSite and, where there is a trail, BreadcrumbList', () => {
  assert.match(pageLayout, /buildWebSite\(env\.siteOrigin\)/);
  assert.match(pageLayout, /buildBreadcrumbs\(breadcrumbs, env\.siteOrigin\)/);
  assert.match(pageLayout, /type="application\/ld\+json"/);
  assert.match(pageLayout, /set:html=\{serialiseJsonLd\(node\)\}/);
});

test('structured data is suppressed on a noindex page', () => {
  /* Describing a noindex page in JSON-LD asks a crawler to both ignore the
     page and treat its claims as authoritative. */
  assert.match(pageLayout, /const indexable = !seo\.robots\.startsWith\('noindex'\)/);
  assert.match(pageLayout, /const structuredData: JsonLd\[\] = indexable/);
});

test('a route supplies only its own entity node', () => {
  const model = read('src', 'pages', 'collections', '[brand]', '[model]', 'index.astro');
  const brand = read('src', 'pages', 'brands', '[brand]', 'index.astro');
  assert.match(model, /jsonLd=\{model \? buildProduct\(model, env\.siteOrigin\) : undefined\}/);
  assert.match(brand, /jsonLd=\{brand \? buildBrand\(brand, env\.siteOrigin\) : undefined\}/);
});
