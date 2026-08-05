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

test('every route skeleton defines exactly one H1', () => {
  for (const rel of ROUTE_FILES) {
    const content = readRoute(rel);
    const matches = content.match(/<h1\b/g) ?? [];
    assert.equal(matches.length, 1, `${rel} defines ${matches.length} <h1> elements, expected exactly 1`);
  }
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

test('every route skeleton shows the development-only content notice', () => {
  for (const rel of ROUTE_FILES) {
    assert.match(readRoute(rel), /SkeletonNotice/, `${rel} does not render SkeletonNotice`);
  }
});

test('category-landing routes use neutral temporary labels, not approved marketing copy', () => {
  const optical = readRoute('collections/optical/index.astro');
  const sun = readRoute('collections/sun/index.astro');
  const kids = readRoute('collections/kids/index.astro');
  assert.match(optical, /Optical collection page/);
  assert.match(sun, /Sun collection page/);
  assert.match(kids, /Kids collection page/);
});

test('dynamic routes read their params and pass them through only as an echoed note, not an invented fact', () => {
  const brand = readRoute('brands/[brand]/index.astro');
  assert.match(brand, /Astro\.params/);
  assert.match(brand, /humanizeSlug/);

  const model = readRoute('collections/[brand]/[model]/index.astro');
  assert.match(model, /Astro\.params/);
  assert.match(model, /humanizeSlug/);

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
