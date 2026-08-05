/* THE single indexing authority. Every route's robots directive, canonical
   query-state and future-sitemap eligibility is decided here, from a path
   and its query string, and nowhere else — no per-template judgement calls.
   Mirrors the rules in docs/public-website-rebuild/05_ROUTE_TEMPLATE_MATRIX.md
   §2 and §9.

   Precedence when multiple query states are present at once (the
   specification names five states in isolation; this is the documented
   resolution for combinations, since a request can carry more than one):

     1. an explicit supported filter param, if any            -> noindex, follow
     2. else a `sort` param, if any                            -> noindex, follow
     3. else a valid `page` param > 1                          -> index, follow (self-canonical incl. page)
     4. else clean                                             -> index, follow

   Unknown parameters (anything not in the filter allowlist, and not `sort`
   or `page`) are never treated as a filter — including marketing/tracking
   parameters like `utm_source`. They are silently dropped from the
   canonical URL and never affect the robots decision, so a shared link
   with tracking params still indexes as its clean page. */

export const NOT_FOUND_ROBOTS = 'noindex, follow';
export const SERVER_ERROR_ROBOTS = 'noindex, nofollow';

/** Explicit allowlist, not "every unknown query parameter is a filter" —
 * the facets the current catalogue system and specification name (lens
 * type/shape, gender, size, material) plus the brand facet, per
 * 02_VISUAL_SYSTEM_INVENTORY.md §4.3 and 05_ROUTE_TEMPLATE_MATRIX.md §2. */
export const SUPPORTED_FILTER_PARAMS: readonly string[] = [
  'brand',
  'shape',
  'material',
  'gender',
  'size',
  'lens_type',
];

export interface IndexingResult {
  robots: string;
  /** Relative path + query, e.g. "/collections/" or "/collections/?page=2". */
  canonicalPath: string;
  inSitemap: boolean;
}

function isSupportedFilterKey(key: string): boolean {
  return SUPPORTED_FILTER_PARAMS.includes(key);
}

/** The five states in 05_ROUTE_TEMPLATE_MATRIX.md §2, plus their
 * combinations, for any ordinary content route. `/search/`, 404 and 500
 * are handled by the caller using the exported constants above — they are
 * not "a path with a query", they are distinct response types. */
export function resolveIndexing(pathname: string, searchParams: URLSearchParams): IndexingResult {
  if (pathname === '/search/') {
    return { robots: 'noindex, follow', canonicalPath: pathname, inSitemap: false };
  }

  const filterKeys = [...searchParams.keys()].filter(isSupportedFilterKey);
  if (filterKeys.length > 0) {
    return { robots: 'noindex, follow', canonicalPath: pathname, inSitemap: false };
  }

  if (searchParams.has('sort')) {
    return { robots: 'noindex, follow', canonicalPath: pathname, inSitemap: false };
  }

  const rawPage = searchParams.get('page');
  if (rawPage !== null) {
    const pageNumber = Number(rawPage);
    if (Number.isInteger(pageNumber) && pageNumber > 1) {
      return {
        robots: 'index, follow',
        canonicalPath: `${pathname}?page=${pageNumber}`,
        inSitemap: false,
      };
    }
    // page=1, non-numeric, or otherwise invalid: falls through to clean —
    // there is nothing left to canonicalise away, the plain path already
    // represents the same content.
  }

  return { robots: 'index, follow', canonicalPath: pathname, inSitemap: true };
}
