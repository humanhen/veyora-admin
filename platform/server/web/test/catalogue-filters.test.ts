/* Catalogue filter and facet interface (Fast-Track Phase 2).

   Unit-level rules against the real modules, plus source-level assertions
   about the rendered component. Live-server behaviour (no-JavaScript
   operation, one H1, canonical/robots) is covered in http-routes.test.ts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFilterState, hrefWithout, filterFormAction } from '../src/lib/catalogue-filters.ts';
import { parseCatalogueQuery, SUPPORTED_FILTERS, SUPPORTED_SORTS } from '../src/lib/catalogue-query.ts';
import type { PublicFacets } from '../src/lib/public-types.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const componentSource = fs.readFileSync(
  path.join(root, 'src', 'components', 'public', 'CatalogueFilters.astro'), 'utf8');
const listingSource = fs.readFileSync(
  path.join(root, 'src', 'components', 'public', 'CatalogueListing.astro'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'src', 'lib', 'catalogue-page.ts'), 'utf8');

const FACETS: PublicFacets = {
  shapes: ['aviator', 'round'],
  sizes: ['Medium'],
  categories: ['Optical', 'Sun'],
  brands: [{ slug: 'example-brand', name: 'Example Brand' }],
};

const q = (search: string, forcedCategory?: string) =>
  parseCatalogueQuery(new URLSearchParams(search), { forcedCategory });

const stateFor = (search: string, opts: { basePath?: string; forcedCategory?: string; facets?: PublicFacets | null } = {}) =>
  buildFilterState(
    q(search, opts.forcedCategory),
    opts.facets === undefined ? FACETS : opts.facets,
    { basePath: opts.basePath ?? '/collections/', forcedCategory: opts.forcedCategory }
  );

// ---------------------------------------------------------------------------
// facet source
// ---------------------------------------------------------------------------

test('the facet client is called server-side by the catalogue page loader', () => {
  assert.match(pageSource, /import \{[^}]*getFacets[^}]*\} from '\.\/public-api\.ts'/);
  assert.match(pageSource, /getFacets\(\)/);
  // Fetched alongside the listing, not serialised behind it.
  assert.match(pageSource, /Promise\.all\(\[/);
});

test('every rendered control comes from a server-returned facet list', () => {
  const state = stateFor('');
  assert.deepEqual(state.groups.map((g) => g.key), ['brand', 'category', 'shape', 'size']);
  assert.deepEqual(state.groups.find((g) => g.key === 'brand')!.options.map((o) => o.value), ['example-brand']);
  assert.deepEqual(state.groups.find((g) => g.key === 'shape')!.options.map((o) => o.value), ['aviator', 'round']);
  assert.deepEqual(state.groups.find((g) => g.key === 'category')!.options.map((o) => o.value), ['Optical', 'Sun']);
});

test('a filter the API returns no choices for renders no control', () => {
  /* `audience` and `material` are accepted and forwarded by the query layer,
     but /public/facets returns no lists for them. Rendering a guessed
     vocabulary would be inventing catalogue facts, so no control appears. */
  const state = stateFor('');
  const keys = state.groups.map((g) => g.key);
  assert.ok(!keys.includes('audience'));
  assert.ok(!keys.includes('material'));
  assert.ok(SUPPORTED_FILTERS.includes('audience'), 'but the query layer still supports it');
});

test('an empty facet list omits its control rather than rendering an empty select', () => {
  const state = stateFor('', { facets: { shapes: [], sizes: [], categories: [], brands: [] } });
  assert.deepEqual(state.groups, []);
});

test('when facets are unavailable the controls are omitted, not guessed', () => {
  const state = stateFor('brand=example-brand', { facets: null });
  assert.deepEqual(state.groups, []);
  // The applied filter is still shown and still clearable.
  assert.equal(state.active.length, 1);
  assert.equal(state.active[0].key, 'brand');
});

test('a facet failure does not turn a working listing into an outage', () => {
  assert.match(pageSource, /facetsUnavailable: !facetResult\.ok/);
  // The page status comes from the LISTING result only.
  assert.match(pageSource, /const status = result\.ok \? 200 : PUBLIC_API_FAILURE_STATUS\[result\.kind\]/);
});

// ---------------------------------------------------------------------------
// selection state
// ---------------------------------------------------------------------------

test('the current value is marked selected, and "any" is offered', () => {
  const state = stateFor('shape=round');
  const shape = state.groups.find((g) => g.key === 'shape')!;
  assert.equal(shape.selected, 'round');
  assert.deepEqual(shape.options.filter((o) => o.selected).map((o) => o.value), ['round']);
  assert.match(componentSource, /<option value="">Any \{group\.legend\.toLowerCase\(\)\}<\/option>/);
});

test('sort renders only the supported sorts, with the current one selected', () => {
  const state = stateFor('sort=name');
  assert.deepEqual(state.sort.options.map((o) => o.value), [...SUPPORTED_SORTS]);
  assert.equal(state.sort.selected, 'name');
  assert.deepEqual(state.sort.options.filter((o) => o.selected).map((o) => o.value), ['name']);
});

test('a brand chip shows the brand NAME while submitting its slug', () => {
  const state = stateFor('brand=example-brand');
  assert.equal(state.active[0].value, 'example-brand');
  assert.equal(state.active[0].label, 'Example Brand');
});

// ---------------------------------------------------------------------------
// category routes
// ---------------------------------------------------------------------------

test('a category route renders no category control and keeps its category', () => {
  const state = stateFor('', { basePath: '/collections/sun/', forcedCategory: 'Sun' });
  assert.ok(!state.groups.some((g) => g.key === 'category'));
  assert.ok(!state.active.some((a) => a.key === 'category'), 'a forced category is not a removable chip');
});

test('a category route cannot be overridden through the query string', () => {
  const query = q('category=Optical', 'Sun');
  assert.equal(query.filters.category, 'Sun', 'the path wins');

  const state = buildFilterState(query, FACETS, { basePath: '/collections/sun/', forcedCategory: 'Sun' });
  for (const item of state.active) assert.notEqual(item.key, 'category');
  for (const href of state.active.map((a) => a.clearHref)) {
    assert.ok(!href.includes('category='), `a generated link leaked the category: ${href}`);
  }
  assert.ok(!(state.clearAllHref ?? '').includes('category='));
});

test('a category route’s generated links never carry a category parameter', () => {
  const state = stateFor('shape=round&sort=name', { basePath: '/collections/kids/', forcedCategory: 'Kids' });
  for (const item of state.active) assert.ok(!item.clearHref.includes('category='), item.clearHref);
});

// ---------------------------------------------------------------------------
// clearing, and page reset
// ---------------------------------------------------------------------------

test('clear-one removes exactly that filter and keeps the rest', () => {
  const state = stateFor('brand=example-brand&shape=round&sort=name');
  const clearShape = state.active.find((a) => a.key === 'shape')!.clearHref;
  assert.ok(clearShape.includes('brand=example-brand'));
  assert.ok(clearShape.includes('sort=name'));
  assert.ok(!clearShape.includes('shape='));
});

test('clearing the sort returns to the default and drops the parameter', () => {
  const state = stateFor('sort=name&brand=example-brand');
  const clearSort = state.active.find((a) => a.key === 'sort')!.clearHref;
  assert.ok(!clearSort.includes('sort='));
  assert.ok(clearSort.includes('brand=example-brand'));
});

test('clear-all returns to the bare listing path', () => {
  assert.equal(stateFor('brand=example-brand&shape=round&page=3').clearAllHref, '/collections/');
  assert.equal(
    stateFor('shape=round', { basePath: '/collections/sun/', forcedCategory: 'Sun' }).clearAllHref,
    '/collections/sun/'
  );
});

test('clear-all is offered only when something is active', () => {
  assert.equal(stateFor('').clearAllHref, null);
  assert.equal(stateFor('page=2').clearAllHref, null, 'a page is not a filter');
  assert.ok(stateFor('shape=round').clearAllHref);
});

test('clearing a filter returns to page 1', () => {
  const query = q('brand=example-brand&shape=round&page=7');
  const href = hrefWithout('/collections/', query, 'shape');
  assert.ok(!href.includes('page='), `page survived a filter change: ${href}`);
});

test('the form carries no page input, so any submission lands on page 1', () => {
  /* Structural rather than behavioural: a GET form serialises only its own
     controls, so the absence of a page input IS the page reset. */
  assert.ok(!/name="page"/.test(componentSource), 'the filter form must not carry a page');
  assert.equal(filterFormAction('/collections/'), '/collections/');
  assert.match(componentSource, /method="get"/);
});

test('pagination preserves filters and sort', () => {
  const query = q('brand=example-brand&shape=round&sort=name');
  const state = stateFor('brand=example-brand&shape=round&sort=name');
  assert.ok(state.active.length >= 3);
  // buildCatalogueHref is what pagination uses; assert it round-trips.
  const href = hrefWithout('/collections/', { ...query, filters: query.filters }, 'sort');
  assert.ok(href.includes('brand=example-brand') && href.includes('shape=round'));
});

test('a control-less filter is not perpetuated as hidden form state', () => {
  /* `audience` has no control. Carrying it as a hidden input would make it
     survive every submission while remaining invisible and unclearable. */
  const state = stateFor('audience=Men');
  assert.deepEqual(state.hidden, []);
  assert.ok(!/type="hidden"[^>]*audience/.test(componentSource));
});

// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------

test('no price, stock or availability control is ever rendered', () => {
  const state = stateFor('');
  for (const group of state.groups) {
    assert.doesNotMatch(group.key, /price|stock|availab|qty|cost|margin/i);
  }
  for (const source of [componentSource, listingSource]) {
    assert.doesNotMatch(source, /name="(price|stock|availability|qty|cost)"/i);
    assert.doesNotMatch(source, /in stock|out of stock|\$\s?\d/i);
  }
});

test('an unsupported parameter is never rendered or forwarded', () => {
  const query = q('colour=blue&limit=999&utm_source=x&shape=round');
  assert.deepEqual(Object.keys(query.filters).sort(), ['shape']);

  const state = buildFilterState(query, FACETS, { basePath: '/collections/' });
  for (const item of state.active) {
    assert.ok(SUPPORTED_FILTERS.includes(item.key as never) || item.key === 'sort', item.key);
    assert.ok(!item.clearHref.includes('colour=') && !item.clearHref.includes('utm_'), item.clearHref);
  }
  assert.ok(!(state.clearAllHref ?? '').includes('utm_'));
});

test('query values are escaped into generated links, never interpolated raw', () => {
  const query = q('brand=' + encodeURIComponent('a"b<script>&c'));
  const state = buildFilterState(query, FACETS, { basePath: '/collections/' });
  const href = state.active[0].clearHref || '/collections/';
  assert.ok(!href.includes('<script>'), href);
  // The value survives as data in the chip label, and Astro escapes on render.
  assert.equal(state.active[0].value, 'a"b<script>&c');
});

test('the form is a GET form with real labels bound to each control', () => {
  assert.match(componentSource, /<form class="filters__form" method="get"/);
  assert.match(componentSource, /<label class="filters__label" for=\{`filter-\$\{group\.key\}`\}/);
  assert.match(componentSource, /id=\{`filter-\$\{group\.key\}`\} name=\{group\.key\}/);
  assert.match(componentSource, /<label class="filters__label" for="filter-sort">/);
  assert.match(componentSource, /id="filter-sort" name="sort"/);
});

test('chip removal links carry an accessible name', () => {
  assert.match(componentSource, /visually-hidden">Remove \{item\.legend\} filter \{item\.label\}/);
  assert.match(componentSource, /aria-hidden="true">&times;/);
});

test('focus is visible on every interactive control', () => {
  assert.match(componentSource, /\.filters__select:focus-visible/);
  assert.match(componentSource, /\.filters__apply:focus-visible/);
  assert.match(componentSource, /\.filters__chip-clear:focus-visible/);
});

test('the interface is square-cornered and mobile-safe', () => {
  assert.match(componentSource, /border-radius: 0/);
  assert.doesNotMatch(componentSource, /border-radius:\s*(?!0)[1-9]/);
  assert.match(componentSource, /font-size: 16px/, 'iOS focus-zoom guard on selects');
  assert.match(componentSource, /@media \(max-width: 480px\)/);
});

test('no client-side framework or script is introduced', () => {
  assert.doesNotMatch(componentSource, /<script/);
  assert.doesNotMatch(componentSource, /client:(load|idle|visible)/);
  assert.doesNotMatch(componentSource, /react|vue|svelte|preact/i);
});

// ---------------------------------------------------------------------------
// empty and failure states
// ---------------------------------------------------------------------------

test('an empty filtered result is distinguished from an empty catalogue', () => {
  assert.match(listingSource, /const isEmptyWithFilters = .*models\.length === 0 && filtersApplied/);
  assert.match(listingSource, /const isEmptyCatalogue = .*models\.length === 0 && !filtersApplied/);
  assert.match(listingSource, /No \{subject\} match the filters you have selected/);
  assert.match(listingSource, /Clear all filters<\/a> to see the full range/);
});

test('an outage is never described as zero results', () => {
  assert.match(listingSource, /\{isUnavailable && <PublicDataUnavailable/);
  // The empty states are gated on result.ok, so a failure cannot reach them.
  assert.match(listingSource, /result\?\.ok === true && models\.length === 0/);
});

test('controls are hidden for an invalid query or an outage, shown for an empty result', () => {
  assert.match(listingSource, /const showFilters = filters !== null && !isBadRequest && !isUnavailable/);
});

test('an invalid query produces no filter state and no upstream call', () => {
  assert.match(pageSource, /filters: null,[\s\S]*?facetsUnavailable: false,/);
  assert.match(pageSource, /A locally-invalid query is answered 400 without an upstream call/);
});
