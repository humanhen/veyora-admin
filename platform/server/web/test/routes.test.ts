import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pagesDir = path.join(root, 'src', 'pages');

// The 24 files implementing all 25 routes in 05_ROUTE_TEMPLATE_MATRIX.md.
// `/resources/{category}/` and `/resources/{slug}/` share one dynamic file
// — see the comment in src/pages/resources/[slug]/index.astro for why
// Astro's router cannot host both as separate files.
const ROUTE_FILES = [
  'index.astro',
  'why-veyora/index.astro',
  'brands/index.astro',
  'brands/[brand]/index.astro',
  'collections/index.astro',
  'collections/optical/index.astro',
  'collections/sun/index.astro',
  'collections/kids/index.astro',
  'collections/[brand]/[model]/index.astro',
  'service-model/index.astro',
  'private-label/index.astro',
  'global-presence/index.astro',
  'resources/index.astro',
  'resources/[slug]/index.astro',
  'contact/index.astro',
  'request-b2b-account/index.astro',
  'private-label-enquiry/index.astro',
  'shipping/index.astro',
  'warranty-and-exchanges/index.astro',
  'ordering-guide/index.astro',
  'privacy-policy/index.astro',
  'terms/index.astro',
  'accessibility/index.astro',
  'sitemap/index.astro',
];

const DYNAMIC_ROUTE_FILES = [
  'brands/[brand]/index.astro',
  'collections/[brand]/[model]/index.astro',
  'resources/[slug]/index.astro',
];

function readRoute(rel: string): string {
  return fs.readFileSync(path.join(pagesDir, rel), 'utf8');
}

test('all 24 route files backing the 25 public routes exist', () => {
  for (const rel of ROUTE_FILES) {
    assert.ok(fs.existsSync(path.join(pagesDir, rel)), `missing route file: ${rel}`);
  }
});

test('dynamic route files exist at the correct Astro bracket paths', () => {
  for (const rel of DYNAMIC_ROUTE_FILES) {
    assert.ok(fs.existsSync(path.join(pagesDir, rel)), `missing dynamic route file: ${rel}`);
    assert.match(rel, /\[[a-z]+\]/, `${rel} does not look like a dynamic Astro path`);
  }
});

test('every route skeleton uses the shared Page layout', () => {
  for (const rel of ROUTE_FILES) {
    const content = readRoute(rel);
    assert.match(content, /layouts\/Page\.astro/, `${rel} does not import Page.astro`);
    assert.match(content, /<Page\b/, `${rel} does not render <Page>`);
  }
});

test('every route skeleton supplies a central metadata record, which is where its H1 now comes from', () => {
  // As of B1.3, no route file writes its own <h1> literal any more —
  // Page.astro renders exactly one <h1>{meta.h1}</h1> from the metadata
  // record every route passes in (src/lib/metadata.ts), which is the
  // stronger, structural version of "exactly one H1": it is no longer
  // possible for a route file to define zero, two, or a drifted H1, since
  // there is nowhere in the route file to put one at all.
  for (const rel of ROUTE_FILES) {
    const content = readRoute(rel);
    assert.match(content, /meta=\{/, `${rel} does not pass a meta prop to <Page>`);
    assert.doesNotMatch(content, /<h1\b/, `${rel} defines its own <h1> instead of using the central metadata H1`);
  }
});

test('Page layout renders exactly one <h1>, from meta.h1, for every route', () => {
  const pageLayout = fs.readFileSync(path.join(root, 'src', 'layouts', 'Page.astro'), 'utf8');
  const matches = pageLayout.match(/<h1\b/g) ?? [];
  assert.equal(matches.length, 1, 'Page.astro must render exactly one <h1>');
  assert.match(pageLayout, /<h1>\{meta\.h1\}<\/h1>/);
});

test('no route skeleton contains lorem ipsum placeholder text', () => {
  for (const rel of ROUTE_FILES) {
    assert.doesNotMatch(readRoute(rel).toLowerCase(), /lorem ipsum/, `${rel} contains lorem ipsum`);
  }
});

test('no route skeleton hard-codes veyora.design or veyora.com', () => {
  for (const rel of ROUTE_FILES) {
    assert.doesNotMatch(readRoute(rel), /veyora\.(design|com)/i, `${rel} hard-codes a real Veyora domain`);
  }
});

test('no route skeleton imports portal or storefront CSS or JS', () => {
  for (const rel of ROUTE_FILES) {
    const content = readRoute(rel);
    assert.doesNotMatch(content, /storefront/i, `${rel} references the storefront`);
    assert.doesNotMatch(content, /\.\.\/(\.\.\/)*storefront/i, `${rel} reaches into the storefront by relative path`);
  }
});

/* B2.3 replaced the placeholder body of six routes with real, API-backed
   content. Those routes no longer show a development notice — showing one
   alongside genuine published data would be misleading. Every OTHER route
   is still a skeleton and must still say so, which is what the assertion
   below now checks. This list shrinks as later batches integrate more
   routes; it is deliberately explicit so integrating a route without
   removing its notice fails here. */
const API_BACKED_ROUTES = [
  'brands/index.astro',
  'brands/[brand]/index.astro',
  'collections/index.astro',
  'collections/optical/index.astro',
  'collections/sun/index.astro',
  'collections/kids/index.astro',
  'collections/[brand]/[model]/index.astro',
  'global-presence/index.astro',
];

test('every route that is still a skeleton shows the development-only content notice', () => {
  for (const rel of ROUTE_FILES) {
    if (API_BACKED_ROUTES.includes(rel)) continue;
    assert.match(readRoute(rel), /SkeletonNotice/, `${rel} does not render SkeletonNotice`);
  }
});

test('an API-backed route shows no development-only notice alongside real published data', () => {
  for (const rel of API_BACKED_ROUTES) {
    assert.doesNotMatch(
      readRoute(rel),
      /SkeletonNotice/,
      `${rel} is API-backed but still renders the development placeholder`
    );
  }
});

test('every API-backed route sets its response status from the API result', () => {
  // The status must be set in the PAGE frontmatter: Astro ignores
  // Astro.response.status set from inside a nested component, so a route
  // that delegated it would silently answer 200 during an outage.
  for (const rel of API_BACKED_ROUTES) {
    assert.match(
      readRoute(rel),
      /Astro\.response\.status\s*=/,
      `${rel} does not set a response status from its API result`
    );
  }
});

test('category-landing routes reference their own central metadata record', () => {
  // The actual title/H1 text (neutral labels, not approved marketing
  // copy) is asserted against src/lib/metadata.ts directly in
  // test/metadata.test.ts — this only checks each page file is wired to
  // the correct record, since B1.3 moved the text itself out of these files.
  const optical = readRoute('collections/optical/index.astro');
  const sun = readRoute('collections/sun/index.astro');
  const kids = readRoute('collections/kids/index.astro');
  assert.match(optical, /STATIC_ROUTE_METADATA\['\/collections\/optical\/'\]/);
  assert.match(sun, /STATIC_ROUTE_METADATA\['\/collections\/sun\/'\]/);
  assert.match(kids, /STATIC_ROUTE_METADATA\['\/collections\/kids\/'\]/);
});

test('dynamic routes read their params and pass them through only as an echoed note, not an invented fact', () => {
  /* B2.3: the brand and model routes now look their slug up through the
     public API and build metadata from the VALIDATED record instead of
     humanising the slug. The humanised-slug fallback survives only for
     the non-404 failure page (a 503 still needs a title, and inventing a
     brand name for one would be worse than a neutral label) — so these
     two now assert the API lookup is what drives the page, which is the
     stronger property. */
  const brand = readRoute('brands/[brand]/index.astro');
  assert.match(brand, /Astro\.params/);
  assert.match(brand, /getBrand\(/);
  assert.match(brand, /brandDetailMetadataFromRecord/);

  const model = readRoute('collections/[brand]/[model]/index.astro');
  assert.match(model, /Astro\.params/);
  assert.match(model, /getModel\(/);
  assert.match(model, /modelDetailMetadataFromRecord/);

  const resource = readRoute('resources/[slug]/index.astro');
  assert.match(resource, /Astro\.params/);
  assert.match(resource, /humanizeSlug/);
});

test('home page omits breadcrumbs; every other route supplies them', () => {
  const home = readRoute('index.astro');
  assert.doesNotMatch(home, /breadcrumbs=/);

  for (const rel of ROUTE_FILES) {
    if (rel === 'index.astro') continue;
    assert.match(readRoute(rel), /breadcrumbs=\{/, `${rel} does not supply breadcrumbs`);
  }
});

test('no route skeleton or component introduces a non-zero border-radius', () => {
  const dir = path.join(root, 'src');
  const offenders: string[] = [];
  function walk(p: string) {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.astro')) {
        const content = fs.readFileSync(full, 'utf8');
        for (const m of content.matchAll(/border-radius:\s*([^;]+);/g)) {
          const value = m[1].trim();
          if (value !== '0') offenders.push(`${path.relative(root, full)}: border-radius: ${value}`);
        }
      }
    }
  }
  walk(dir);
  assert.deepEqual(offenders, [], `non-zero border-radius found: ${offenders.join(' | ')}`);
});

test('no route skeleton or component introduces an --accent token or new colour system', () => {
  const dir = path.join(root, 'src');
  const offenders: string[] = [];
  function walk(p: string) {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.astro') || entry.name.endsWith('.css')) {
        const content = fs.readFileSync(full, 'utf8');
        if (/--accent\b/.test(content)) offenders.push(path.relative(root, full));
      }
    }
  }
  walk(dir);
  assert.deepEqual(offenders, [], `--accent token found in: ${offenders.join(', ')}`);
});
