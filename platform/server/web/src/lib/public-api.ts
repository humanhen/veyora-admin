/* SERVER-ONLY client for the read-only /public/* API (B2.3).

   This module must never be imported into client-side code. It reads
   env.apiOrigin (an internal, non-public address — `http://api:3000` in the
   deployed stack) and every Astro page importing it renders on the server,
   so the origin is never serialised into a browser bundle or a page.

   Design constraints, all from the B2.3 brief and all load-bearing:
     - native fetch only, no HTTP client dependency;
     - the origin comes ONLY from validated environment configuration —
       there is no parameter anywhere in this file that accepts a caller
       -supplied URL, host or absolute path, so an SSRF via a route param
       is impossible by construction, not by filtering;
     - one allowlisted function per endpoint; deliberately NO generic
       `get(path)` escape hatch;
     - every request carries an AbortController timeout;
     - the response must be JSON (content-type checked) and must match the
       documented shape (public-types.ts) — anything else is a distinct,
       named failure, never a silently-empty success.

   The four outcomes a caller must be able to tell apart are modelled as an
   explicit discriminated union rather than exceptions-for-everything,
   because the route layer has to map each one to a *different* HTTP status
   (see PUBLIC_API_FAILURE_STATUS below and src/lib/public-response.ts).
   Collapsing "upstream is down" into "nothing found" is precisely the bug
   the brief calls out — an empty catalogue rendered as though it were
   authoritative. */
import { env } from '../env.ts';
import {
  PublicShapeError,
  validateBrandListResponse,
  validateBrandDetailResponse,
  validateModelListResponse,
  validateModelDetailResponse,
  validateFacetsResponse,
  validateLocationsResponse,
  validateSitemapDataResponse,
  type PublicBrandSummary,
  type PublicBrandDetail,
  type PublicModelList,
  type PublicModelDetail,
  type PublicFacets,
  type PublicLocation,
  type PublicSitemapData,
} from './public-types.ts';

/* The origin is read through this indirection rather than straight from
   `env.apiOrigin` for one reason: `env` is a singleton evaluated when
   env.ts is first imported, and the tests need to point the client at a
   mock server whose port is only known at runtime (ephemeral ports avoid
   collisions in CI). This is a deliberate, narrow test seam, NOT a general
   configuration hook:
     - it defaults to the validated environment value;
     - no page or component can reach it (pages call listBrands() and
       friends, which take no origin argument);
     - the override still goes through the same URL construction and
       /public path assertion as production, so a test cannot accidentally
       exercise a code path production does not have.
   The alternative — accepting an origin parameter on every endpoint
   function — would put a caller-supplied URL into the production API,
   which is exactly what the B2.3 brief forbids. */
let apiOriginOverride: string | null = null;

function apiOrigin(): string {
  return apiOriginOverride ?? env.apiOrigin;
}

/** Test-only. Pass null to restore the environment-derived origin. */
export function _setApiOriginForTesting(origin: string | null): void {
  apiOriginOverride = origin;
}

const REQUEST_TIMEOUT_MS = 5_000;
/* Bounded body read: a runaway or wrong-service response should fail fast
   rather than buffer without limit. 4 MB is far above any real /public/*
   payload (a 24-item model page is a few KB) and far below anything that
   would threaten the process. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Why a call did not produce a validated result. Each maps to a distinct
 * rendered status — see PUBLIC_API_FAILURE_STATUS. */
export type PublicApiFailureKind =
  /** The API rejected our query (its own 400). A local validation bug or a
   * hand-edited URL — surfaced as 400, not 500. */
  | 'bad-request'
  /** The entity genuinely does not exist or is not published (API 404). */
  | 'not-found'
  /** Timeout, DNS/connection failure, or a 5xx from the API. Upstream is
   * unavailable — NOT an empty result. */
  | 'unavailable'
  /** A 200 whose body was not JSON, not parseable, or did not match the
   * documented shape. The API answered, but with something we cannot trust. */
  | 'malformed';

export type PublicApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: PublicApiFailureKind; detail: string };

/** The single mapping from failure kind to rendered HTTP status, so every
 * route answers identically. `malformed` is 502 (we are the gateway and the
 * upstream response was invalid); `unavailable` is 503 (upstream is down or
 * too slow). */
export const PUBLIC_API_FAILURE_STATUS: Record<PublicApiFailureKind, number> = {
  'bad-request': 400,
  'not-found': 404,
  unavailable: 503,
  malformed: 502,
};

/** Builds the request URL from a FIXED internal path plus optional query
 * params. `path` is only ever a literal supplied by one of the exported
 * endpoint functions below — never a caller argument — and is asserted to
 * be a rooted relative path so it cannot become an absolute URL that would
 * escape the configured origin. */
function buildUrl(path: string, params?: Record<string, string | undefined>): URL {
  if (!path.startsWith('/public/')) {
    // Defensive: only reachable if a future edit to this file passes
    // something unexpected. Never triggered by external input.
    throw new Error(`public-api: refusing non-/public path "${path}"`);
  }
  const url = new URL(path, apiOrigin());
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }
  return url;
}

/** One request path for every endpoint: timeout, status mapping,
 * content-type check, bounded read, JSON parse, shape validation. */
async function requestJson<T>(url: URL, validate: (value: unknown) => T): Promise<PublicApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
      // No credentials, no cookies, no auth header — this API is
      // unauthenticated and forwarding a visitor's identity to it would be
      // both useless and a privacy leak. `omit` is explicit so a future
      // default change cannot silently start sending them.
      credentials: 'omit',
      redirect: 'error',
    });
  } catch (err) {
    // AbortError (timeout), DNS failure, connection refused — all
    // "upstream unavailable", never "not found".
    const detail = err instanceof Error ? err.name : 'fetch failed';
    return { ok: false, kind: 'unavailable', detail };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) return { ok: false, kind: 'not-found', detail: 'upstream 404' };
  if (response.status === 400) return { ok: false, kind: 'bad-request', detail: 'upstream 400' };
  if (!response.ok) {
    return { ok: false, kind: 'unavailable', detail: `upstream ${response.status}` };
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(contentType)) {
    return { ok: false, kind: 'malformed', detail: `unexpected content-type: ${contentType || 'none'}` };
  }

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, kind: 'unavailable', detail: 'response body read failed' };
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    return { ok: false, kind: 'malformed', detail: 'response body too large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, kind: 'malformed', detail: 'response body was not valid JSON' };
  }

  try {
    return { ok: true, data: validate(parsed) };
  } catch (err) {
    if (err instanceof PublicShapeError) {
      return { ok: false, kind: 'malformed', detail: err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The allowlisted endpoint functions. There is deliberately no generic
// "fetch any path" export — adding an endpoint means adding a function here.
// ---------------------------------------------------------------------------

export async function listBrands(options: { segment?: string } = {}): Promise<PublicApiResult<PublicBrandSummary[]>> {
  return requestJson(buildUrl('/public/brands', { segment: options.segment }), validateBrandListResponse);
}

export async function getBrand(slug: string): Promise<PublicApiResult<PublicBrandDetail>> {
  // encodeURIComponent, not raw interpolation: a slug arrives from a route
  // param, so it is untrusted input even though the route pattern already
  // constrains it.
  return requestJson(buildUrl(`/public/brands/${encodeURIComponent(slug)}`), validateBrandDetailResponse);
}

export interface ListModelsQuery {
  brand?: string;
  category?: string;
  audience?: string;
  shape?: string;
  material?: string;
  size?: string;
  sort?: string;
  page?: string;
}

export async function listModels(query: ListModelsQuery = {}): Promise<PublicApiResult<PublicModelList>> {
  // Only these keys are ever forwarded. An unexpected key in `query` is
  // structurally impossible to forward because this object is rebuilt by
  // name, not spread.
  return requestJson(
    buildUrl('/public/models', {
      brand: query.brand,
      category: query.category,
      audience: query.audience,
      shape: query.shape,
      material: query.material,
      size: query.size,
      sort: query.sort,
      page: query.page,
    }),
    validateModelListResponse
  );
}

export async function getModel(brandSlug: string, modelSlug: string): Promise<PublicApiResult<PublicModelDetail>> {
  return requestJson(
    buildUrl(`/public/models/${encodeURIComponent(brandSlug)}/${encodeURIComponent(modelSlug)}`),
    validateModelDetailResponse
  );
}

export async function getFacets(): Promise<PublicApiResult<PublicFacets>> {
  return requestJson(buildUrl('/public/facets'), validateFacetsResponse);
}

export async function listLocations(): Promise<PublicApiResult<PublicLocation[]>> {
  return requestJson(buildUrl('/public/locations'), validateLocationsResponse);
}

export async function getSitemapData(): Promise<PublicApiResult<PublicSitemapData>> {
  return requestJson(buildUrl('/public/sitemap-data'), validateSitemapDataResponse);
}

/** Exposed for tests only — lets a test confirm URL construction without
 * issuing a request. Not used by any page. */
export const _buildUrlForTesting = buildUrl;
