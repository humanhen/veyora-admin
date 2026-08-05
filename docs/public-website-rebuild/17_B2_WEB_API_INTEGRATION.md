# 17 — B2.3 Web ↔ Public API Integration

How the Astro public website consumes the read-only `/public/*` API (B2.2). Server-side rendering
only: no browser ever calls the API, and no client-side JavaScript is required by any integrated
route.

Scope of this document is B2.3 only. It does not cover backfill, publication, JSON-LD, XML
sitemaps or deployment — none of which B2.3 implemented.

---

## 1. Environment contract

One new variable, added to the existing contract in `platform/server/web/src/env.ts`:

| Variable | Required in production | Development fallback |
|---|---|---|
| `PUBLIC_SITE_ORIGIN` | yes | `http://localhost:4321` |
| `PORTAL_ORIGIN` | yes | `http://localhost:4322` |
| **`PUBLIC_API_ORIGIN`** | **yes — throws at startup if missing or malformed** | `http://localhost:3000` |

`PUBLIC_API_ORIGIN` is the **internal, server-side** origin this server calls to reach `/public/*`
— `http://api:3000` inside the deployed Docker stack, which `04_TARGET_ARCHITECTURE.md` §5.1
already specified for the `web` service. It is:

- validated as an absolute `http`/`https` origin with no path, query or fragment, by the same
  `normalizeOrigin()` every other origin uses;
- **never exposed to a browser** — it is read from `process.env` in a server-only module, never
  through `import.meta.env` (which is the only mechanism that would inline a value into a client
  bundle), and never rendered into any page;
- fail-closed in production, gated by the same `scripts/validate-env.mjs` that already runs before
  `astro build` and before the server binds a port.

**Name note.** Despite the `PUBLIC_` prefix, this is not a browser-exposed value. The prefix is
inherited from the name `04_TARGET_ARCHITECTURE.md` §5.1 already gave the compose service, so an
operator configures one variable rather than two under different names. Astro's client-exposure
rule applies to `import.meta.env.PUBLIC_*`, which this value is never read through.

Documented in `platform/server/web/.env.example` and `README.md`.

**Consequence for existing tests:** adding a third required production origin legitimately changed
the startup contract, so the B1.1A command-path tests and the B1.3 route-contract tests were
updated to supply it. This is a contract change, not a regression — the old tests encoded a
two-origin contract that no longer exists.

---

## 2. Client functions

`platform/server/web/src/lib/public-api.ts` — server-only, native `fetch`, no HTTP dependency.

| Function | Endpoint |
|---|---|
| `listBrands({ segment? })` | `GET /public/brands` |
| `getBrand(slug)` | `GET /public/brands/:slug` |
| `listModels(query)` | `GET /public/models` |
| `getModel(brandSlug, modelSlug)` | `GET /public/models/:brand/:slug` |
| `getFacets()` | `GET /public/facets` |
| `listLocations()` | `GET /public/locations` |
| `getSitemapData()` | `GET /public/sitemap-data` |

Guarantees, each enforced by construction rather than by convention:

- **No generic fetch-any-path export.** There is deliberately no `get(path)` escape hatch; adding
  an endpoint means adding a function. Asserted by test.
- **No caller-supplied URL.** No function takes an origin, host or absolute path. Slugs are
  `encodeURIComponent`-ed into a fixed path template, so a slug of
  `https://evil.example/steal` becomes one percent-encoded path segment, not a destination.
  `buildUrl()` additionally refuses any path not starting `/public/`.
- **Timeout.** Every request carries an `AbortController` with a 5-second timeout; an abort is
  reported as `unavailable`, never as an empty result.
- **Content-type checked.** A non-`application/json` response is `malformed`, never parsed.
- **Bounded body.** Responses over 4 MB are rejected as `malformed` (a real `/public/*` page is a
  few KB).
- **No credentials.** `credentials: 'omit'` is explicit, and `redirect: 'error'`. No cookie,
  `authorization` header or visitor identity is ever forwarded — asserted by inspecting what the
  mock server actually received.

### 2.1 The four outcomes

Modelled as an explicit discriminated union (`PublicApiResult<T>`) rather than exceptions, because
each maps to a *different* rendered HTTP status:

| Kind | Cause | Rendered status |
|---|---|---|
| `bad-request` | API returned 400 | 400 |
| `not-found` | API returned 404 (unknown or unpublished entity) | 404 |
| `unavailable` | timeout, connection failure, or API 5xx | 503 |
| `malformed` | 200 whose body was not JSON, not parseable, or the wrong shape | 502 |

`PUBLIC_API_FAILURE_STATUS` is the single mapping, so every route answers identically.

### 2.2 The test seam

`_setApiOriginForTesting()` exists because `env` is a singleton evaluated at import, and tests need
to point the client at a mock on an ephemeral port. It is a narrow, documented seam: it defaults to
the validated environment value, no page can reach it (endpoint functions take no origin argument),
and the override still goes through the same URL construction and `/public` assertion as
production. The alternative — an origin parameter on every endpoint function — would put a
caller-supplied URL into the production API, which is exactly what must not exist.

---

## 3. Public response types and runtime validation

`platform/server/web/src/lib/public-types.ts` — hand-written types plus hand-written validators.
No schema library.

**Why validate a response from our own API?** Because it crosses a process and network boundary.
"The server we called returned what we expected" is an assumption, and a version skew, a proxy
error page, or a half-deployed API can all produce a 200 with the wrong body. Validating turns that
into a clean 502 instead of a page rendering `undefined` — or, worse, rendering an unexpected
field.

Discipline, mirroring the API's own serializer layer:

- every validator builds a **fresh object from named fields** and never spreads the parsed payload,
  so an unknown field on the wire is dropped by construction, not filtered by a denylist;
- a required field arriving as the wrong primitive type is **rejected**, not coerced;
- optional strings normalise `null`/`undefined`/`''` to `null`, so templates test one thing;
- arrays are always arrays, never `null`;
- string arrays are length-bounded and item-bounded;
- an invalid date string is rejected rather than passed through;
- internal `label:*` tags are stripped from category arrays — the API already does this, but this
  layer's entire purpose is not assuming the upstream is the version we think it is.

### 3.1 Media URL safety

`path` is the one validated field that becomes an attribute a browser dereferences, so its scheme
is checked explicitly. Accepted: a rooted relative path (`/s3/…`, the normal case) or an absolute
`http`/`https` URL. Rejected — the media object is dropped entirely rather than rendered as a
broken image: `javascript:`, `data:`, `vbscript:`, protocol-relative `//host`, and bare relative
paths. Astro escapes attribute values, so this is defence against a dangerous-but-well-formed URL,
not against injection.

---

## 4. Route-to-endpoint mapping

| Route | Endpoint | Notes |
|---|---|---|
| `/brands/` | `listBrands()` | grid of published brands |
| `/brands/{brand}/` | `getBrand(slug)` | metadata + breadcrumbs from the validated record |
| `/collections/` | `listModels(query)` | via `loadCataloguePage()` |
| `/collections/optical/` | `listModels(…)` | `forcedCategory: 'Optical'` |
| `/collections/sun/` | `listModels(…)` | `forcedCategory: 'Sun'` |
| `/collections/kids/` | `listModels(…)` | `forcedCategory: 'Kids'` |
| `/collections/{brand}/{model}/` | `getModel(brand, model)` | metadata + breadcrumbs from the record |
| `/global-presence/` | `listLocations()` | published locations only |

`getFacets()` and `getSitemapData()` are implemented and tested but **not yet consumed by a
route** — faceted filter UI is B4 and XML sitemaps are B7.

### 4.1 Why the catalogue loader is a function, not a component

`loadCataloguePage()` (`src/lib/catalogue-page.ts`) is a plain function called from page
frontmatter, not an Astro component, because of a constraint found during testing: **setting
`Astro.response.status` from inside a nested component has no effect on the response.** An earlier
draft had the listing component set its own status; `/brands/` (which sets it in page frontmatter)
correctly returned 503 during an outage while `/collections/` returned 200. Keeping the fetch and
status in the page frontmatter, with the shared logic in one function, satisfies both "category
routes must not duplicate fetching logic" and "upstream failure must not return 200."

---

## 5. Pagination and filters

Local validation lives in `src/lib/catalogue-query.ts`, mirroring the API's documented bounds so a
malformed query fails fast without an upstream round-trip.

| Parameter | Handling |
|---|---|
| `brand`, `category`, `audience`, `shape`, `material`, `size` | forwarded verbatim; single scalar, ≤ 80 chars |
| `sort` | allowlist: `newest` (default) or `name` — anything else is 400 |
| `page` | bare positive integer literal; `2abc`, `2.5`, `-1`, `0` are all 400 |
| anything else | **ignored, never forwarded** |

- A repeated parameter (`?brand=a&brand=b`) is a 400, not a silent first-value win.
- An empty or whitespace-only value is treated as *absent*, not as invalid — `?page=` is page 1.
- Unknown parameters (including `utm_*`) are ignored rather than rejected: an unknown param is not
  an error, and `indexing.ts` already governs how those affect canonical/robots.
- `forcedCategory` **overrides** any caller-supplied `category`, so a category landing page cannot
  be repointed to a different category by query string.

Pagination is previous/next only, as plain links requiring no JavaScript. Numbered pages are not
derivable: the API returns `hasMore`, not a total (a deliberate B2.2 decision — a full count across
the catalogue is commercially useful to a competitor), so a "page N of M" label would require
inventing a total this site is not given.

Links preserve every supported filter and the sort. A category route omits `category` from its own
links because it is already in the path — repeating it would create a second URL for identical
content. Page 1 omits `page` entirely, and default sort omits `sort`, so the clean listing URL
stays clean.

Query-state canonical and robots behaviour is unchanged and still decided solely by
`src/lib/indexing.ts` — verified live: `?page=2` is `index, follow` self-canonical;
`?brand=` and `?sort=` are `noindex, follow` canonical to the clean path.

---

## 6. Status and error policy

One consistent policy across every integrated route:

| Condition | Status | Rendered |
|---|---|---|
| Success | 200 | content |
| Success, empty collection | **200** | `EmptyPublishedContent` — an authoritative "nothing published" |
| Malformed local query | **400** | error state; **the API is never called** |
| API returned 400 | 400 | error state |
| Entity not found / unpublished | **404** | `NotFound` + `noindex, follow` |
| API timeout / connection failure / 5xx | **503** | `PublicDataUnavailable` |
| Malformed successful payload | **502** | `PublicDataUnavailable` |

The two rules that matter most, both verified end-to-end over real HTTP:

1. **An outage never renders as an empty catalogue.** `PublicDataUnavailable` and
   `EmptyPublishedContent` are deliberately separate components with different wording and
   different statuses. An empty successful response says "there are no published X"; an outage says
   "temporarily unavailable" and returns 5xx.
2. **An outage never becomes a false 404.** A detail route distinguishes `not-found` (404) from
   `unavailable` (503), so a transient API failure cannot tell a crawler to drop a real, published
   brand or model from the index.

No failure page exposes the internal API origin, an upstream status code, a stack trace or SQL
detail — verified by scanning rendered failure HTML.

---

## 7. Empty-state policy

`EmptyPublishedContent` states only that there is nothing published, with no count, no launch date
and no "coming soon" — none of which is an approved fact
(`06_CONTENT_AND_PLACEHOLDER_REGISTER.md`'s rule that nothing is invented). It appears only on a
**successful** API response, so it is always an authoritative statement rather than a guess.

---

## 8. Rendered forbidden-data controls

Three independent layers, and the third is the one that actually proves the property:

1. **The API** (B2.2) serializes through a pure allowlist and never sends a private field.
2. **This site's validators** rebuild fresh objects from named fields, so an unexpected field
   cannot survive even if the API sent one.
3. **Rendered-HTML tests** request real routes over HTTP from the built server against a mock API
   whose fixtures deliberately carry price, sale price, purchase cost, margin, wholesale, qty,
   stock status, warehouse, shelf, Zoho id, fact-owner id, approver id, a customer email, a
   `label:*` tag, media rights holder, a street address and coordinates — and assert none of those
   distinctive planted literals appears anywhere in the HTML.

The assertions match **distinctive planted values** (e.g. `zoho_SECRET_999`), never generic English
words, so a legitimate product named "Discontinued Classic" or a link labelled "Ordering Guide"
cannot trip them.

Also verified in rendered model-detail HTML: no availability wording, no order control, no form, no
login-dependent UI, and no unsafe media URL.

**JSON-LD remains out of scope.** B2.3 renders no structured data, so the forbidden-key scan still
does not cover a JSON-LD surface. **R-06 therefore cannot close** — see
`08_RISKS_AND_OPEN_DECISIONS.md`.

---

## 9. Tests

**310/310 web tests passing** (221 pre-existing B1 tests, all still green, plus 89 new or updated).

| File | Count | Covers |
|---|---|---|
| `test/public-api.test.ts` | 19 | origin from env, endpoint allowlist, no absolute-URL destination, query encoding, timeout, content-type, invalid JSON, shape rejection, 400/404/5xx distinction, no credential forwarding, no forbidden data in validated output |
| `test/public-types.test.ts` | 22 | shape rejection, wrong primitive types, media URL schemes, adversarial payloads, label stripping, fresh-object guarantee, no false positives on harmless words |
| `test/catalogue-query.test.ts` | 18 | page/sort validation, repeated and over-long params, unsupported params ignored, forced category, pagination href building |
| `test/public-render.test.ts` | 25 | end-to-end rendered HTML against a mock API: every integrated route, 404s, 400s, empty states, 503/502 failure modes, no planted secret in HTML, no hash routing |
| updated: `env`, `command-paths`, `http-routes`, `routes` | — | third required origin; skeleton vs API-backed route expectations |

No test contacts a real API, database or external network — everything runs against a controlled
mock on `127.0.0.1`.

---

## 10. Known limitations

- **No real data exists.** Every table is empty and every product is `is_published = false`
  (B2.1/B2.2 published nothing), so all verification is against fixtures. The integration has never
  rendered a real Veyora brand or model.
- **`audience` and `material` are forwarded but currently no-ops** — the API accepts and validates
  them, but no backing column exists yet. Forwarding them now means the day the API honours them,
  this site already does.
- **`getFacets()` and `getSitemapData()` are unused by any route** — implemented and tested,
  consumed in B4 (faceted filtering) and B7 (XML sitemaps).
- **No faceted filter UI.** Filters work by URL only. There is no rendered filter panel; that is
  B4's `FilterPanel` island.
- **Single-record routes are uncached on both sides** — the API does not cache them (B2.2) and this
  site adds no cache of its own. Every brand/model detail request is a live upstream call.
- **The 5-second client timeout is a fixed constant**, not configurable per environment.
- **No JSON-LD**, no XML sitemap, no image optimisation — media is referenced, never downloaded or
  processed.

---

## 11. Deferred to B2.4 and later

- **B2.4:** product `public_slug`/`brand_id` backfill and slug generation; admin editing surfaces
  for brand/location/policy/publication; the application-level publication gate; wiring
  `invalidatePublicCache()` to admin publish/unpublish and the Zoho sync.
- **B4:** faceted filter island consuming `getFacets()`, the collections/brand template work, and
  the shape facet.
- **B7:** JSON-LD builders, XML sitemaps consuming `getSitemapData()`, and the responsive image
  pipeline.
- **B9:** extending the forbidden-key scan across rendered HTML and JSON-LD as a wired merge gate —
  the remaining precondition for closing R-06.
