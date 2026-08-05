/* Shared server-side loader for every catalogue listing route (B2.3).

   This is a plain function, deliberately NOT an Astro component, because
   of a real constraint discovered while testing: setting
   `Astro.response.status` from inside a nested component does not affect
   the response — by the time a child renders, the page's status is already
   fixed. A listing that must answer 400/502/503 therefore has to set its
   status in the PAGE frontmatter.

   Keeping the fetching, query validation and pagination-link logic here
   (rather than duplicating it across /collections/ and the three category
   routes) means each page frontmatter is four lines: call this, set the
   status, hand the result to a purely presentational component. That
   satisfies "category routes must inject their category filter rather
   than duplicating fetching logic" while keeping status handling where it
   actually works. */
import { listModels, PUBLIC_API_FAILURE_STATUS, type PublicApiResult } from './public-api.ts';
import {
  parseCatalogueQuery,
  buildCatalogueHref,
  CatalogueQueryError,
  type CatalogueQuery,
} from './catalogue-query.ts';
import type { PublicModelList } from './public-types.ts';

export interface CataloguePageState {
  /** The status the page must set on Astro.response. 200 on success and
   * on a legitimately empty result. */
  status: number;
  /** Set when the local query itself was invalid — the API was not called. */
  queryError: string | null;
  result: PublicApiResult<PublicModelList> | null;
  page: number;
  hasMore: boolean;
  previousHref: string | null;
  nextHref: string | null;
}

export async function loadCataloguePage(
  url: URL,
  { basePath, forcedCategory }: { basePath: string; forcedCategory?: string }
): Promise<CataloguePageState> {
  let query: CatalogueQuery | null = null;
  try {
    query = parseCatalogueQuery(url.searchParams, { forcedCategory });
  } catch (err) {
    // A locally-invalid query is answered 400 without an upstream call.
    return {
      status: 400,
      queryError: err instanceof CatalogueQueryError ? err.message : 'invalid request',
      result: null,
      page: 1,
      hasMore: false,
      previousHref: null,
      nextHref: null,
    };
  }

  const result = await listModels({
    brand: query.filters.brand,
    category: query.filters.category,
    audience: query.filters.audience,
    shape: query.filters.shape,
    material: query.filters.material,
    size: query.filters.size,
    sort: query.sort,
    page: String(query.page),
  });

  const status = result.ok ? 200 : PUBLIC_API_FAILURE_STATUS[result.kind];
  // The API echoes the page it served; trust that over the requested value
  // so a link is never built from a page the API did not actually return.
  const page = result.ok ? result.data.page : query.page;
  const hasMore = result.ok ? result.data.hasMore : false;
  const omitCategory = Boolean(forcedCategory);

  return {
    status,
    queryError: null,
    result,
    page,
    hasMore,
    previousHref: page > 1 ? buildCatalogueHref(basePath, query, page - 1, { omitCategory }) : null,
    nextHref: hasMore ? buildCatalogueHref(basePath, query, page + 1, { omitCategory }) : null,
  };
}
