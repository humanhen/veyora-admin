# 18 — B2.4A Admin Publication API

The authenticated administrative API for editing public brand, product and variation content, and
for publishing or unpublishing it through a central gate.

Scope is B2.4A only: no admin UI, no backfill, no publication of any real record, no media upload,
no content-page/policy/form administration. Nothing in this batch published anything.

---

## 1. Authentication and permission

Mounted at **`/admin/public-content`** — under the existing authenticated admin namespace, never
under `/public` (which is unauthenticated and read-only by design).

> **Superseded by B2.4P (2026-08-06).** This section described a role check. Authorisation on this
> router is now **per-account capabilities** — see
> [19_ACCOUNT_PERMISSION_SYSTEM.md](19_ACCOUNT_PERMISSION_SYSTEM.md). The current model is
> summarised in §1.1 below; the original B2.4A rationale is retained in §1.2 as the record of why
> the seam was built the way it was.

### 1.1 Current model (B2.4P)

Two layers. The router-level gate proves **identity only**; each route additionally requires a
specific capability granted to the individual account:

```js
r.use(requirePublicContentAuth());   // → requireAuth()  — NO role arguments

r.get('/brands',            canRead(),    …)   // public_content.view
r.patch('/brands/:id',      canEdit(),    …)   // public_content.edit
r.post('/brands/:id/publish', canPublish(), …) // public_content.publish
```

| Route group | Capability |
|---|---|
| all `GET` routes, and `POST …/evaluate` | `public_content.view` |
| `PATCH /{brands,products,variations}/:id` | `public_content.edit` |
| `POST …/publish`, `POST …/unpublish` | `public_content.publish` |

`requireAuth()` takes **no role arguments deliberately**. A role name here would be a bypass: it
would silently constrain who could hold a grant, and would reintroduce exactly the "every admin is
identical" property that per-account permissions exist to remove. An `admin` with no grant is
refused; a non-admin holding `public_content.edit` is allowed. `warehouse` remains excluded — not by
name, but because no fulfilment account is granted a public-content capability.

Editing and publishing are **separate, non-hierarchical capabilities**: neither implies the other.

### 1.2 Original B2.4A rationale (historical)

Management's requirement is *"specific permissions for specific accounts."* **That was not supported
at the time of B2.4A, and B2.4A did not add it.** Stated plainly because the presence of working
authentication and an admin role could easily be mistaken for it:

**What already existed (before B2.4A):**
- `users.role` — a single text column with a fixed CHECK constraint:
  `customer | special customer | agent | super-agent | warehouse | admin`.
- `requireAuth(...roles)` — middleware admitting a request if the user's single role is in a list.
- Two named groupings: `ADMIN_ROLES`, `AGENT_ROLES`.
- One ad-hoc finer check: `isFinancialActor()` in the orders router, which gates discount edits to
  `admin` — still derived from the role, not from a per-account grant.

That was **role-based access control only**. A verified search of `platform/server/api/src/**` found
no permissions table, no per-account permission column, no scope list, no capability set and no ACL
of any kind. Two accounts with role `admin` were indistinguishable in authority.

**What B2.4A added:** one named, single-point permission seam — then called
`requirePublicContentAdmin()` — applied once to the entire router. It was a role check. Its value
was that when per-account permissions landed, there would be exactly **one** function to change
rather than seventeen scattered inline checks.

**Why it was not built there.** Real per-account permissions need persistent per-account grants, and
B2.4A's brief explicitly forbade schema changes (`platform/server/db/**` is a protected path).
Faking it without persistence — an env-var account allowlist, say — would have been a second,
unreviewable authorisation system, which the brief also forbade.

**Outcome.** B2.4P delivered the outstanding work: an additive `account_permissions` table, a closed
four-key registry, a resolution service, and per-route capability enforcement. The seam held — the
router's authorisation changed without touching a single handler.

---

## 2. Route contract

Every route requires an authenticated, active account **plus** the capability listed in §1.1. No
`DELETE` route exists anywhere.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/public-content/brands` | list (paged: `limit`≤200, `offset`) |
| GET | `/admin/public-content/brands/:id` | detail + gate verdict + token |
| GET | `/admin/public-content/products` | list (paged, optional `brandId`) |
| GET | `/admin/public-content/products/:id` | detail + variations + gate + advisories |
| GET | `/admin/public-content/variations/:id` | detail + gate verdict + token |
| PATCH | `/admin/public-content/{brands,products,variations}/:id` | edit allowlisted fields |
| POST | `…/:id/evaluate` | run the gate, mutate nothing |
| POST | `…/:id/publish` | gated, transactional publish |
| POST | `…/:id/unpublish` | transactional unpublish |

`PATCH` and both publication verbs require `concurrencyToken` in the body. `publish`/`unpublish`
accept an optional `note` (recorded on the approval row, truncated to 2000 chars).

---

## 3. Editable-field allowlists

Anything not listed is a `400` — never silently dropped.

**Brand:** `slug`, `name`, `short_name`, `segment`, `headline`, `summary`, `story`,
`ideal_retailer`, `price_tier_label`, `design_origin`, `manufacturing_origin`, `style_traits[]`,
`approved_materials[]`, `logo_media_id`, `hero_media_id`, `publication_state`,
`verification_status`, `source_reference`, `last_reviewed_at`, `scheduled_review_at`.

**Product:** `public_slug`, `name`, `brand_id`, `line`, `shape`, `segment`, `public_description`,
`is_featured`, `is_discontinued`, `replacement_product_id`, plus the same five governance fields.

**Variation:** `color`, `color_code`, `swatch_media_id`.

### 3.1 Explicitly immutable

`id`, `created_at`, `updated_at`, `content_updated_at`, `fact_owner`, `approver_id`, `approved_at`,
`is_active`, `sku`, `brand` (legacy free text), `price`, `sale_price`, `purchase_price`,
`zoho_item_id`, `product_id` — and **`is_published`**.

`is_published` being immutable via PATCH is the single most important rule here: publication is a
gated, transactional, approval-recorded operation with its own endpoint. Allowing it as an ordinary
field would let a caller bypass the gate entirely.

### 3.2 Validation rules

Slugs: `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤120 chars — **an empty slug is allowed while drafting** (a
record cannot publish without one, but requiring it before the name is settled would make draft
editing impossible). Text ≤200 chars (short) or ≤20 000 (long). Arrays ≤40 short-string items.
Enums checked against the schema's CHECK values. Ids must match `prefix_alphanumeric` or be `null`.
Dates must be ISO-parseable or `null`. Wrong primitive types are rejected, never coerced.

Partial bodies are fine — a one-field PATCH on a nowhere-near-publishable draft is valid.

---

## 4. Administrative response fields

Explicit serializers (`src/admin-public-serialize.js`), fresh object literals, no row spreading.
Governance **is** exposed here (editors need it) — the difference from the public serializer is
deliberate and the two are separate modules for that reason.

Returned: public-content fields, a `governance` block (`publicationState`, `verificationStatus`,
`sourceReference`, `lastReviewedAt`, `scheduledReviewAt`, `contentUpdatedAt`, `factOwnerId`),
`publicationGate` verdict, `concurrencyToken`, `isPublished`, timestamps, and — read-only, to avoid
confusing an editor — `isActiveInPortal` and `legacyBrandText`.

Never returned: passwords, tokens, customer data, payment information, prices, purchase cost,
`zoho_item_id`, or unrestricted internal attributes. `factOwnerId` is an identifier only; the
`users` table is never joined, so no name or email reaches an admin response through this path.

---

## 5. Publication gate

`src/publication-gate.js` — pure functions, no database access, no SQL. It exists because a
database CHECK can only see one row: "is the brand published", "does the replacement resolve", "is
any variation publishable" are cross-row invariants. `14_B2_SCHEMA_REFERENCE.md` §6 recorded these
as deferred application-level rules; this closes that gap.

**Shared governance (all three):** not `retired`; `publication_state = 'published'`;
`verification_status = 'verified'`; non-empty `source_reference`; `last_reviewed_at` present;
`content_updated_at` present.

**Brand also:** non-empty name; valid slug; slug unique; an approved `summary` **or** `headline`
(either satisfies it — requiring a specific one would block a brand whose approved copy lives in
the other).

**Product also:** valid unique `public_slug`; approved name; display SKU; `public_description`;
linked to a **published** brand; no self-replacement; replacement (if set) exists and is itself
published; ≥1 publishable variation unless declared non-variant; ≥1 approved media item.

**Variation also:** parent product eligible; approved colour name; colour code valid when present;
swatch media resolves when referenced. **No price, stock or availability requirement** — none of
those is public data, so gating public visibility on them would be incoherent.

Unknown inputs **fail closed**: an unchecked slug uniqueness, an uncounted variation set or an
unevaluated parent each produce their own `*_UNKNOWN` blocking reason rather than being assumed
fine.

### 5.1 Reason codes

Stable strings, returned sorted so two evaluations of the same record are byte-identical.
`BRAND_*`: `NOT_FOUND, RETIRED, STATE_NOT_PUBLISHED, NOT_VERIFIED, NO_SOURCE_REFERENCE,
NOT_REVIEWED, NO_CONTENT_DATE, NO_NAME, INVALID_SLUG, SLUG_NOT_UNIQUE,
SLUG_UNIQUENESS_UNKNOWN, NO_PUBLIC_DESCRIPTION`.
`PRODUCT_*`: the same governance set plus `NO_NAME, INVALID_SLUG, SLUG_NOT_UNIQUE,
SLUG_UNIQUENESS_UNKNOWN, NO_DISPLAY_SKU, NO_PUBLIC_DESCRIPTION, NO_BRAND, BRAND_MISSING,
BRAND_NOT_PUBLISHED, REPLACEMENT_SELF, REPLACEMENT_MISSING, REPLACEMENT_NOT_PUBLISHED,
NO_PUBLISHABLE_VARIATION, VARIATION_COUNT_UNKNOWN, NO_APPROVED_MEDIA, MEDIA_COUNT_UNKNOWN`.
`VARIATION_*`: `NOT_FOUND, PARENT_UNKNOWN, PARENT_NOT_ELIGIBLE, NO_COLOUR_NAME,
INVALID_COLOUR_CODE, MEDIA_MISSING`.

**Advisories** (`PRODUCT_DISCONTINUED_NO_REPLACEMENT`, `PRODUCT_FEATURED_WITHOUT_VARIATIONS`) are
informational and never affect `allowed` — kept separate so eligibility never depends on a
judgement call.

### 5.2 State change alone cannot bypass the gate

`publication_state` is one *input* to the verdict, not the verdict. Setting it to `published` via
PATCH leaves every other requirement reporting, and the publish endpoint re-evaluates the gate
**inside the transaction against the freshly locked row** — not against whatever the caller last
saw.

---

## 6. Concurrency

The repository had no optimistic-concurrency convention; the closest thing was `select … for
update` row locking, which prevents interleaved writes but not a lost update (a second admin
overwriting a value they never saw). Both are now used together.

Token format: `entityType:id:version`. Binding the type and id means a token issued for one record
cannot be replayed against another. It is not a secret and needs no signature — it protects against
a lost update, not against an authorised admin.

Version source: `updated_at` for brands and products (trigger-maintained, no schema change).
**`variations` has no `updated_at` column**, so its token is derived from `created_at` plus the
fields this API can change (`color`, `color_code`, `swatch_media_id`, `is_published`). This is a
real limitation: a change to a variation column outside that set would not invalidate the token.
Recorded rather than hidden; adding `updated_at` to `variations` is an additive schema change for a
later batch.

`GET` returns a token. `PATCH`/`publish`/`unpublish` require one. A stale, missing or malformed
token is a `409` **and the transaction rolls back, writing nothing**.

---

## 7. Transactions and approval recording

Publish and unpublish run inside `tx()`:

1. `select … for update` the row;
2. verify the concurrency token → `409` if stale;
3. (publish only) re-evaluate the gate against the locked row → `422` with reasons if it fails;
4. update publication fields;
5. insert a `content_approvals` row;
6. re-read and return the record.

Any throw rolls the whole thing back, so a failed gate or a mid-transaction database error writes
**neither** the content change **nor** a partial approval row — both asserted by test.

**Actor identity comes only from `req.user`** (the authenticated session). The router passes
`actor: req.user` and nothing reads an actor from `req.body`, so an approval cannot be attributed to
someone else by a crafted request.

Products set `is_published` and `publication_state` in the same statement, because B2.1's CHECK
requires them to agree — moving one without the other would be rejected by the constraint.

**Unpublish is deliberately not gated.** Removing something from public view must always be
possible immediately, even for a record that could never pass the publish gate. Content is
preserved (nothing is deleted) and redirects/slug history are untouched, so a later republish keeps
its URLs.

---

## 8. Cache invalidation

`invalidatePublicCache()` is called after — and only after — a transaction commits. Not on a
validation failure, not on a `409`, not on a `422`, not on a rollback. All five cases are asserted
by test.

**Scope limitation:** the public cache is an in-process `Map`, so invalidation affects only the API
process that handled the mutation. A multi-process or multi-container deployment would need a
shared invalidation signal. Not addressed here — B2.4A changed no deployment or Zoho architecture.

---

## 9. Errors

| Condition | Status |
|---|---|
| Unauthenticated | `401 { error: 'unauthorized' }` (existing behaviour) |
| Authenticated, wrong role | `403 { error: 'forbidden' }` (existing behaviour) |
| Malformed input | `400 { error, fieldErrors: [{ field, code, message }] }` |
| Unknown record | `404 { error: '<Entity> not found' }` |
| Stale token | `409 { error, code: 'STALE_TOKEN' }` |
| Gate failure | `422 { error, code: 'PUBLICATION_GATE_FAILED', reasons: [...] }` |
| Internal | existing safe `500` handler |

No error body contains SQL, a stack trace, an internal host or a secret — asserted by test. A failed
publication is never a `200`.

---

## 10. Security boundaries

- No write route under `/public` (asserted against the public router's source).
- No `DELETE` route anywhere on this router (asserted against the live router stack).
- Every query lists explicit columns — no `SELECT *`, no table-star.
- Every value is a bound parameter; the only SQL interpolations are module constants
  (`*_COLUMNS`, `meta.table` from a fixed map) and column names originating from this module's own
  allowlist specs. No request-derived value reaches SQL text — verified by search.
- No `users`, `orders`, `order_items`, `invoices`, `payments`, `credit_notes`, `carts` or `stock`
  table is queried.
- No pricing, ordering, inventory, cart or Zoho module is imported.
- Existing `/public` response shapes are unchanged.

---

## 11. Known schema limitations

Declared in code as `DEFERRED_GATES` so they cannot be quietly forgotten:

| Code | Limitation |
|---|---|
| `DEFERRED_NON_VARIANT_FLAG` | No `is_non_variant` column, so "a model with legitimately no colourways" cannot be distinguished from "a model whose variations are not ready". Callers may pass `isNonVariant: true`; nothing persists it. |
| `DEFERRED_MEDIA_APPROVAL_STATE` | `media` has no approval state, so "approved public media" currently means only "media rows exist". Per-asset approval and rights-expiry enforcement need a schema addition. |
| `DEFERRED_FIELD_LEVEL_APPROVAL` | `content_approvals` records events, but nothing yet *requires* an approval row before a state change. The gate checks governance columns, not the approval ledger. |

Plus: **`variations` has no `updated_at`** (see §6), and **account-specific permissions do not
exist** (see §1.1). All four need additive schema work that B2.4A was forbidden from doing.

---

## 12. Deferred to B2.4B–B2.4D

- **Per-account permissions** — migration, resolution helper, capability check in the existing seam,
  assignment surface, tests. (Possibly its own batch given management priority.)
- **Admin UI** for all of the above.
- **Catalogue backfill** — `public_slug` generation and `brand_id` mapping across 1,318 products
  (WP-08), still not started.
- **Brand record seeding** — no brand rows exist, so nothing has been publishable in practice.
- **Media upload and per-asset approval.**
- **Content-page, policy and form administration.**
- **Cross-process cache invalidation** and Zoho-sync invalidation wiring.

---

## 13. Example payloads

All fictional; no real production data.

**PATCH** `/admin/public-content/brands/br_example`
```json
{ "concurrencyToken": "brand:br_example:2026-08-06T10:00:00.000Z",
  "headline": "Distinctive eyewear for modern retail",
  "verification_status": "verified",
  "source_reference": "Brand book p12, approved 2026-08-01" }
```

**422** from `POST …/publish`
```json
{ "error": "This record does not meet the publication requirements.",
  "code": "PUBLICATION_GATE_FAILED",
  "reasons": [
    { "code": "PRODUCT_NO_APPROVED_MEDIA", "message": "At least one approved public image is required.", "field": "media" },
    { "code": "PRODUCT_NO_PUBLISHABLE_VARIATION", "message": "At least one publishable variation is required.", "field": "variations" }
  ] }
```

**409** from a stale token
```json
{ "error": "This record changed since you loaded it. Reload and reapply your edit.",
  "code": "STALE_TOKEN" }
```
