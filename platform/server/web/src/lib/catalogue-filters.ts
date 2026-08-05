/* Catalogue filter presentation (Fast-Track Phase 2).

   Pure functions turning a validated CatalogueQuery plus the API's own facet
   response into the state a server-rendered filter form needs. No fetching,
   no DOM, no Astro — so every rule below is unit-testable without a browser
   or a build.

   TWO CONSTRAINTS SHAPE THIS FILE.

   First: only choices the SERVER returned are ever offered. `getFacets()`
   provides `brands`, `categories`, `shapes` and `sizes` — and nothing else.
   The API also accepts `audience` and `material` (documented no-ops until a
   backing column exists), but returns no lists for them, so no control is
   rendered for them here. Inventing a plausible audience vocabulary would be
   making up catalogue facts. When the API starts returning those lists, the
   generic code below renders them with no further work.

   Second: a category ROUTE owns its category. /collections/sun/ must stay
   sun, so the category control is suppressed there and `omitCategory` keeps
   it out of every generated link — the path already says it. */

import {
  SUPPORTED_FILTERS, SUPPORTED_SORTS,
  buildCatalogueHref,
  type CatalogueQuery, type SupportedFilter, type SupportedSort,
} from './catalogue-query.ts';
import type { PublicFacets } from './public-types.ts';

export interface FilterOption {
  /** The value submitted to the API. */
  value: string;
  /** What a visitor reads. */
  label: string;
  selected: boolean;
}

export interface FilterGroup {
  key: SupportedFilter;
  /** The <label>/<legend> text. */
  legend: string;
  options: FilterOption[];
  /** The currently selected value, or '' for "any". */
  selected: string;
}

export interface ActiveFilter {
  key: SupportedFilter | 'sort';
  legend: string;
  value: string;
  label: string;
  /** A link to the same listing with just this one filter removed. */
  clearHref: string;
}

export interface FilterState {
  groups: FilterGroup[];
  sort: { selected: SupportedSort; options: FilterOption[] };
  active: ActiveFilter[];
  /** Present only when something is active. */
  clearAllHref: string | null;
  /** Hidden inputs the GET form must carry to preserve state it does not
   * expose as a control (currently nothing but a forced category is
   * deliberately NOT carried — see below). */
  hidden: Array<{ name: string; value: string }>;
}

const LEGENDS: Record<SupportedFilter, string> = {
  brand: 'Brand',
  category: 'Category',
  audience: 'Audience',
  shape: 'Shape',
  material: 'Material',
  size: 'Size',
};

const SORT_LABELS: Record<SupportedSort, string> = {
  newest: 'Newest first',
  name: 'Name (A–Z)',
};

/** A facet list is only offered when the API actually returned entries for
 * it. An empty list means "the API has nothing to offer here", which is not
 * the same as "offer everything" — so the control is omitted rather than
 * rendered empty. */
function optionsFrom(values: Array<{ value: string; label: string }>, selected: string): FilterOption[] {
  return values.map(({ value, label }) => ({ value, label, selected: value === selected }));
}

/**
 * Builds everything the filter form and the active-filter summary need.
 *
 * @param forcedCategory set by the three category landing routes. Their
 *   category comes from the path, so the category control is suppressed and
 *   never appears in a generated href.
 */
export function buildFilterState(
  query: CatalogueQuery,
  facets: PublicFacets | null,
  { basePath, forcedCategory }: { basePath: string; forcedCategory?: string }
): FilterState {
  const omitCategory = Boolean(forcedCategory);
  const groups: FilterGroup[] = [];

  if (facets) {
    const sources: Array<{ key: SupportedFilter; values: Array<{ value: string; label: string }> }> = [
      { key: 'brand', values: facets.brands.map((b) => ({ value: b.slug, label: b.name })) },
      { key: 'category', values: facets.categories.map((c) => ({ value: c, label: c })) },
      { key: 'shape', values: facets.shapes.map((s) => ({ value: s, label: s })) },
      { key: 'size', values: facets.sizes.map((s) => ({ value: s, label: s })) },
    ];

    for (const { key, values } of sources) {
      if (key === 'category' && omitCategory) continue;   // the path owns it
      if (values.length === 0) continue;                  // nothing to offer
      const selected = query.filters[key] ?? '';
      groups.push({ key, legend: LEGENDS[key], options: optionsFrom(values, selected), selected });
    }
  }

  /* Active summary. A filter is listed as active only if it is one this page
     can clear — a forced category is not removable, so it is not offered as
     a chip that would do nothing. */
  const active: ActiveFilter[] = [];
  for (const key of SUPPORTED_FILTERS) {
    const value = query.filters[key];
    if (!value) continue;
    if (key === 'category' && omitCategory) continue;
    active.push({
      key,
      legend: LEGENDS[key],
      value,
      label: labelFor(key, value, facets),
      clearHref: hrefWithout(basePath, query, key, { omitCategory }),
    });
  }
  if (query.sort !== 'newest') {
    active.push({
      key: 'sort',
      legend: 'Sort',
      value: query.sort,
      label: SORT_LABELS[query.sort],
      clearHref: hrefWithout(basePath, query, 'sort', { omitCategory }),
    });
  }

  return {
    groups,
    sort: {
      selected: query.sort,
      options: SUPPORTED_SORTS.map((value) => ({
        value, label: SORT_LABELS[value], selected: value === query.sort,
      })),
    },
    active,
    clearAllHref: active.length ? basePath : null,
    /* Deliberately empty. Filters this page does not expose as a control
       (audience, material) are NOT carried through as hidden inputs: a
       control-less filter that survives every form submission is invisible
       state a visitor cannot see or clear. It stays honoured on a direct
       link — the query layer still forwards it — but the form does not
       perpetuate it. */
    hidden: [],
  };
}

function labelFor(key: SupportedFilter, value: string, facets: PublicFacets | null): string {
  if (key === 'brand' && facets) {
    const match = facets.brands.find((b) => b.slug === value);
    if (match) return match.name;
  }
  return value;
}

/**
 * A link to the same listing with one filter removed.
 *
 * Always returns to page 1: the result set changes when a filter is removed,
 * so page 5 of the old set is meaningless in the new one — and far more
 * likely to be empty than useful.
 */
export function hrefWithout(
  basePath: string,
  query: CatalogueQuery,
  key: SupportedFilter | 'sort',
  { omitCategory = false }: { omitCategory?: boolean } = {}
): string {
  const filters = { ...query.filters };
  let sort = query.sort;
  if (key === 'sort') sort = 'newest';
  else delete filters[key];
  return buildCatalogueHref(basePath, { filters, sort, page: 1 }, 1, { omitCategory });
}

/** The form's own action target. A GET form serialises its controls into the
 * query string itself, so the action is just the path — and because the form
 * carries no `page` input, submitting it always lands on page 1. That is the
 * "changing a filter resets the page" rule, enforced structurally rather than
 * by remembering to strip a parameter. */
export function filterFormAction(basePath: string): string {
  return basePath;
}
