# 15 — B2.2 Public API Contract

The unauthenticated, read-only public API boundary for the future Astro public website. Mounted at
`/public` on the existing API (`platform/server/api/src/index.js`), before the terminal 404 handler.
No authentication middleware anywhere on this router. No write methods anywhere on this router.

This document describes **only** what B2.2 implemented: the endpoints, the serializer boundary, the
publication rules, caching, and errors. It does not describe the Astro-side integration (B2.3+),
forms/CRM, or catalogue backfill — none of that exists yet.

---

## 1. Architecture summary

```
platform/server/api/src/
├── public-forbidden-keys.js   the central forbidden-key list + recursive scanner (dev/test safety net)
├── public-serialize.js        the pure allowlist serializer layer — every response is built here
├── public-cache.js            the ~60s in-process read cache
└── routes/
    └── public.js               the router: query validation, SQL, wiring
```

Every response is produced by a pure serializer function in `public-serialize.js` that constructs a
**fresh object literal** from named fields — never `{ ...row }`, never `res.json(row)`, never a
`row_to_json`/`json_agg` of an unrestricted row. `public-forbidden-keys.js` is an independent,
structurally different safety net used in tests (and importable for any future dev-mode assertion)
to catch a regression in that allowlist before it ships — it is not a production response filter and
is never invoked at request time.

Every SQL query in `routes/public.js` lists its selected columns explicitly, is parameterised, and
carries an explicit publication filter. `is_active` (the portal's ordering/availability flag) is
never the publication authority anywhere in this router — `publication_state = 'published'` and
`products.is_published = true` / `variations.is_published = true` are.

This router does not import `pricing.js`, `ordering.js`, `cart.js`, `authmw.js`, or the
`account`/`agent`/`admin` routers, and never queries `users`, `orders`, `order_items`, `invoices`,
`payments`, or `credit_notes`.

---

## 2. Endpoints

### `GET /public/brands`

**Auth:** none. **Cache:** ~60s, keyed by `segment`.

| Query param | Required | Notes |
|---|---|---|
| `segment` | no | exact match against `brands.segment`; a single scalar value, max 80 chars |

**Response `200`:**
```json
{
  "brands": [
    {
      "slug": "example-brand",
      "name": "Example Brand",
      "shortName": "Example",
      "segment": "premium",
      "headline": "Distinctive eyewear for modern retail",
      "priceTierLabel": "Premium",
      "logoMedia": { "path": "/s3/brands/example-logo.svg", "alt": "Example Brand logo", "width": 400, "height": 120, "kind": "image" }
    }
  ]
}
```

**Publication requirement:** `brands.publication_state = 'published'`.

---

### `GET /public/brands/:slug`

**Auth:** none. **Cache:** not cached (single-record lookup, param-keyed — low cache value, kept simple in B2.2).

**Response `200`:**
```json
{
  "brand": {
    "slug": "example-brand",
    "name": "Example Brand",
    "shortName": "Example",
    "segment": "premium",
    "headline": "Distinctive eyewear for modern retail",
    "priceTierLabel": "Premium",
    "logoMedia": null,
    "summary": "A premium eyewear brand built for independent retailers.",
    "story": "Founded in ...",
    "idealRetailer": "Independent optical retailers",
    "bestFor": ["Statement pieces", "Boutique assortments"],
    "styleTraits": ["Bold", "Colourful"],
    "designOrigin": "Italy",
    "manufacturingOrigin": "Italy",
    "componentOrigins": ["Italy", "Japan"],
    "approvedMaterials": ["Acetate", "Titanium"],
    "heroMedia": null,
    "featuredModels": [
      { "brandSlug": "example-brand", "brandName": "Example Brand", "slug": "aviator-classic", "sku": "20894", "name": "Aviator Classic", "line": "Heritage", "shape": "aviator", "segment": "premium", "size": "Medium", "categories": ["Optical"], "isFeatured": true, "primaryMedia": null }
    ],
    "contentUpdatedAt": "2026-08-01T00:00:00.000Z"
  }
}
```

**Errors:** unknown or unpublished slug → `404 { "error": "brand not found" }`.

**Publication requirement:** the brand row requires `publication_state = 'published'`; each featured
model additionally requires `products.is_published = true`.

---

### `GET /public/models`

**Auth:** none. **Cache:** ~60s, keyed by the full normalised query state.

| Query param | Required | Notes |
|---|---|---|
| `brand` | no | brand **slug**, exact match |
| `category` | no | matches if `products.categories` contains the value |
| `audience` | no | **accepted but currently a no-op** — see §6 |
| `shape` | no | exact match against `products.shape` |
| `material` | no | **accepted but currently a no-op** — see §6 |
| `size` | no | exact match against `products.size` |
| `sort` | no | `newest` (default) or `name` — anything else is `400` |
| `page` | no | positive integer, default `1` — anything else is `400` |

Every filter value is a single scalar (an array, e.g. `?brand=a&brand=b`, is rejected `400`), max 80
characters.

**Page size** is a fixed internal constant (24) — there is no caller-controlled page-size
parameter.

**Response `200`:**
```json
{
  "items": [
    { "brandSlug": "example-brand", "brandName": "Example Brand", "slug": "aviator-classic", "sku": "20894", "name": "Aviator Classic", "line": "Heritage", "shape": "aviator", "segment": "premium", "size": "Medium", "categories": ["Optical"], "isFeatured": true, "primaryMedia": null }
  ],
  "page": 1,
  "hasMore": false
}
```

Deliberately **no total catalogue-size field** — `hasMore` only, per the B2.2 brief ("default to
`hasMore` rather than a commercially useful full-count disclosure").

**Ordering:** deterministic. `newest` orders by `content_updated_at desc, id asc`; `name` orders by
`name asc, id asc`. The `id` tie-breaker guarantees a stable order even when many rows share the
same `content_updated_at`/`name` — without it, page boundaries could shift between requests.

**Publication requirement:** `products.is_published = true` and `brands.publication_state =
'published'`.

---

### `GET /public/models/:brand/:slug`

`:brand` is the brand slug, `:slug` is the product's `public_slug`. **Auth:** none. **Cache:** not
cached (single-record lookup).

**Response `200`:**
```json
{
  "model": {
    "brandSlug": "example-brand", "brandName": "Example Brand",
    "slug": "aviator-classic", "sku": "20894", "name": "Aviator Classic",
    "line": "Heritage", "shape": "aviator", "segment": "premium", "size": "Medium",
    "categories": ["Optical"], "isFeatured": true, "primaryMedia": null,
    "publicDescription": "A classic aviator silhouette.",
    "lensType": "polarized",
    "variations": [
      { "sku": "20894.1", "colorName": "Matte Black", "colorCode": "BLK-01", "swatchMedia": null }
    ],
    "media": [],
    "relatedModels": [],
    "contentUpdatedAt": "2026-08-01T00:00:00.000Z"
  }
}
```

**No availability field anywhere** — not a boolean, not a stock count, not a "ships in N days"
placeholder. This is deliberate: per `04_TARGET_ARCHITECTURE.md` §4.2, live inventory belongs to the
authenticated portal only.

`lensType` is the **only** value pulled out of the existing `products.attributes` jsonb bag, and
only when it is itself a string — the bag itself is never attached to the response.

**Errors:** unknown or unpublished brand/model slug pair → `404 { "error": "model not found" }`.

**Publication requirement:** the product requires `is_published = true` and the brand
`publication_state = 'published'`; each returned variation additionally requires
`variations.is_published = true`.

---

### `GET /public/facets`

**Auth:** none. **Cache:** ~60s.

**Response `200`:**
```json
{
  "shapes": ["aviator", "round", "square"],
  "sizes": ["Medium", "Large", "Small"],
  "categories": ["Optical", "Sun"],
  "brands": [{ "slug": "example-brand", "name": "Example Brand" }]
}
```

No price ranges, no stock counts, no hidden (unpublished) brand names — `shapes`/`sizes`/
`categories` are derived only from `is_published = true` products; `brands` is derived only from
`publication_state = 'published'` brands.

---

### `GET /public/locations`

**Auth:** none. **Cache:** ~60s.

**Response `200`:**
```json
{
  "locations": [
    { "slug": "italy-supply-base", "name": "Italy Supply Base", "function": "supply_base", "regionsServed": ["Europe"], "hours": "" }
  ]
}
```

**Deliberately narrow.** `address`, `contact`, and `coordinates` are never returned — see §6.

**Publication requirement:** `locations.publication_state = 'published' AND locations.is_public =
true` (both, not either).

---

### `GET /public/sitemap-data`

**Auth:** none. **Cache:** ~60s.

**Response `200`:**
```json
{
  "brands": [{ "path": "/brands/example-brand/", "contentUpdatedAt": "2026-08-01T00:00:00.000Z" }],
  "models": [{ "path": "/collections/example-brand/aviator-classic/", "contentUpdatedAt": "2026-08-01T00:00:00.000Z" }],
  "pages": []
}
```

Only canonical public paths and `content_updated_at` for **published, indexable** records — never
draft, approved-but-unpublished, or retired ones. `pages` is empty until `content_pages` rows exist
and are both `publication_state = 'published'` and `index_state = 'index'`.

---

## 3. Errors

All errors are JSON. This router never returns HTML.

| Condition | Status | Body |
|---|---|---|
| Malformed `page` (non-integer, `<1`, array) | `400` | `{ "error": "page must be a positive integer" }` |
| Unsupported `sort` | `400` | `{ "error": "unsupported sort: <value>" }` |
| A filter value is an array or exceeds 80 characters | `400` | `{ "error": "<field> must be a single value" }` / `{ "error": "<field> is too long" }` |
| Unknown/unpublished brand or model | `404` | `{ "error": "brand not found" }` / `{ "error": "model not found" }` |
| Internal query failure | existing API error handler (`index.js`) | `{ "error": "internal error" }` — no SQL detail, no stack trace |
| `POST`/`PUT`/`PATCH`/`DELETE` on any `/public/*` path | Express default (no route matches; falls through to the app's terminal 404) | — |

---

## 4. Caching

An in-process `Map`, `public-cache.js`, TTL ≈ 60 seconds:

- Cached: `/public/brands`, `/public/models`, `/public/facets`, `/public/locations`,
  `/public/sitemap-data` — successful reads only.
- **Not cached:** `/public/brands/:slug`, `/public/models/:brand/:slug` (single-record lookups —
  kept simple in B2.2 rather than cache-keyed per slug), validation errors (`400`), 404s, and any
  server error. A failed or invalid request always re-attempts the database on the next call.
- Cache keys include the endpoint name and every (sorted, normalised) query parameter — never a
  user/session identity, since this router has no identity to key on.
- Bounded to 500 entries; the oldest is evicted first if that bound is reached.
- `invalidatePublicCache()` is exported and clears every cached entry. **Not called from any admin
  or Zoho module in this batch** — wiring a real publish/unpublish action (or the Zoho sync) to call
  it is explicitly deferred to B2.4+.

---

## 5. Explicit forbidden data

Never present in any `/public/*` response, enforced by the serializer's allowlist design and
independently checked by `public-forbidden-keys.js` in tests: `price`, `sale_price`,
`purchase_price`, `cost`, `margin`, `wholesale`, `discount`, `promotion`, `qty`/`quantity`, `stock`,
`stockStatus`, `onHand`, `available`/`availability`, `warehouse`, `shelf`, any customer/user/agent/
lead identity (`customer`, `customerNumber`, `customer_id`, `user_id`, `email`, `phone`, `tax_id`,
`balance`, `payment_terms`, `agent_id`), `pricing`, `hide_prices`, `order`/`order_id`, `invoice`,
`credit`, `zoho_item_id`, purchase-order identifiers, `fact_owner`/`approver_id`, `rights_holder`/
`rights_expiry`, and any tag beginning `label:`. No internal database id is exposed unless a
demonstrated public need exists (none did, in B2.2 — every response uses slugs).

## 6. Fields deliberately omitted (not the same as "forbidden")

- **`audience` and `material` query parameters** on `/public/models` are accepted (validated, never
  erroring) but currently a no-op: no `audience` or `material` column exists in the B2.1 schema.
  Accepted now for forward compatibility with the route matrix's documented facet set; will start
  filtering once a later batch adds the backing column(s).
- **`locations.address`, `.contact`, `.coordinates`** — never returned. The B2.1 schema has only a
  row-level publication signal (`publication_state` + `is_public`), with no per-field marker to
  confirm an address or contact block was individually reviewed for public disclosure. Omitted until
  a later batch adds that finer-grained approval.
- **Total catalogue size** on `/public/models` — `hasMore` only, deliberately, per the B2.2 brief.

---

## 7. Known limitations

- **No live database was contacted to validate any of this.** Every test uses a fake `db` object
  (`{ query(sql, params) }`) or a monkey-patched `pool.query`, per this repository's existing testing
  convention (see `test/stock-guard.test.js`'s `fakeClient()`) and per the B2.2 brief's low-storage
  constraint (no PostgreSQL, no Docker). The SQL has been carefully reviewed but not executed against
  a real PostgreSQL instance.
- **No cache invalidation wiring exists yet.** `invalidatePublicCache()` is exported and tested in
  isolation but nothing calls it — a stale response can persist up to ~60s after a hypothetical
  future publish/unpublish action. Wiring it to the admin/Zoho side is explicitly B2.4+.
- **`/public/brands/:slug` and `/public/models/:brand/:slug` are not cached.** Simple to add later
  (the same `buildCacheKey`/`getCached`/`setCached` mechanism already used elsewhere), deliberately
  left out of B2.2 to keep the single-record-lookup code paths easy to reason about.
- **No data exists to test any of this against real rows.** B2.1 left every table empty and every
  existing product `is_published = false` — B2.2 did not seed, backfill, or publish anything (per
  the brief). Every response shown in this document is a fixture, not a live example.

## 8. Invalidation hook — deferred

`invalidatePublicCache()` (`public-cache.js`) is the intended integration point for B2.4+: an admin
publish/unpublish action, or the Zoho sync's own cache-invalidation call (mirroring
`invalidateCatalogCache()` in `routes/catalog.js`), should call it so a change is visible within one
request rather than waiting out the TTL. Not wired to either in this batch.
