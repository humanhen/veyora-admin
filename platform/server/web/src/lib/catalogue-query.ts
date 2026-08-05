/* Local query validation for the catalogue routes (B2.3).

   The API validates its own input too (B2.2), but this layer exists for a
   different reason: a malformed query must produce a 400 from THIS server,
   rendered as an editorial page, without a wasted upstream round-trip —
   and only normalised, allowlisted values may ever be forwarded. Nothing
   here trusts that the API will catch it.

   The bounds intentionally mirror the API's documented contract
   (15_B2_PUBLIC_API_CONTRACT.md §2): single scalar values, 80-character
   maximum, `sort` restricted to `newest`/`name`, `page` a positive
   integer. Where the two could drift, the API remains authoritative — this
   is a fail-fast pre-check, not a second source of truth. */

export const SUPPORTED_SORTS = ['newest', 'name'] as const;
export type SupportedSort = (typeof SUPPORTED_SORTS)[number];

/** Filters this site forwards. `audience` and `material` are accepted
 * because the API accepts them (documented no-ops there until a backing
 * column exists) — forwarding them now means the day the API starts
 * honouring them, this site already does too. */
export const SUPPORTED_FILTERS = ['brand', 'category', 'audience', 'shape', 'material', 'size'] as const;
export type SupportedFilter = (typeof SUPPORTED_FILTERS)[number];

const MAX_VALUE_LENGTH = 80;

export interface CatalogueQuery {
  filters: Partial<Record<SupportedFilter, string>>;
  sort: SupportedSort;
  page: number;
}

export class CatalogueQueryError extends Error {}

/** Reads one scalar param. Rejects repeated params (`?brand=a&brand=b`)
 * and over-long values with a 400 rather than silently taking the first. */
function readScalar(params: URLSearchParams, key: string): string | undefined {
  const all = params.getAll(key);
  if (all.length === 0) return undefined;
  if (all.length > 1) throw new CatalogueQueryError(`${key} must be a single value`);
  const value = all[0].trim();
  if (!value) return undefined;
  if (value.length > MAX_VALUE_LENGTH) throw new CatalogueQueryError(`${key} is too long`);
  return value;
}

/**
 * Parses and validates a catalogue request's query string.
 *
 * `forcedCategory` is how the three category landing routes
 * (/collections/optical|sun|kids/) inject their category without
 * duplicating any fetching or validation logic — it overrides any
 * caller-supplied `category`, so a category page cannot be turned into a
 * different category by a query parameter.
 *
 * Unsupported parameters (`?colour=`, `?limit=`, `?utm_source=`) are
 * silently ignored rather than rejected: an unknown param is not an error
 * (marketing links legitimately carry `utm_*`, and indexing.ts already
 * governs how those affect canonical/robots), it simply is not forwarded.
 */
export function parseCatalogueQuery(
  params: URLSearchParams,
  { forcedCategory }: { forcedCategory?: string } = {}
): CatalogueQuery {
  const filters: Partial<Record<SupportedFilter, string>> = {};
  for (const key of SUPPORTED_FILTERS) {
    const value = readScalar(params, key);
    if (value !== undefined) filters[key] = value;
  }
  if (forcedCategory) filters.category = forcedCategory;

  const rawSort = readScalar(params, 'sort');
  let sort: SupportedSort = 'newest';
  if (rawSort !== undefined) {
    if (!(SUPPORTED_SORTS as readonly string[]).includes(rawSort)) {
      throw new CatalogueQueryError(`unsupported sort: ${rawSort}`);
    }
    sort = rawSort as SupportedSort;
  }

  const rawPage = readScalar(params, 'page');
  let page = 1;
  if (rawPage !== undefined) {
    // Bare positive-integer literal only — "2abc", "2.5", "-1", "1e3" all
    // fail here rather than being coerced by parseInt.
    if (!/^[0-9]+$/.test(rawPage)) throw new CatalogueQueryError('page must be a positive integer');
    const parsed = Number(rawPage);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new CatalogueQueryError('page must be a positive integer');
    }
    page = parsed;
  }

  return { filters, sort, page };
}

/** Builds a link back to the same route with the same supported filters,
 * at a different page — so pagination never silently drops a filter. Only
 * non-default values appear, keeping `/collections/` clean rather than
 * `/collections/?sort=newest&page=1`.
 *
 * `omitCategory` is set by the category landing routes: their category is
 * part of the PATH, so repeating it as a query param would create a
 * second, redundant URL for the same content. */
export function buildCatalogueHref(
  basePath: string,
  query: CatalogueQuery,
  page: number,
  { omitCategory = false }: { omitCategory?: boolean } = {}
): string {
  const params = new URLSearchParams();
  for (const key of SUPPORTED_FILTERS) {
    if (omitCategory && key === 'category') continue;
    const value = query.filters[key];
    if (value) params.set(key, value);
  }
  if (query.sort !== 'newest') params.set('sort', query.sort);
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
