# 21 — B2.4B2A Public-Content Review and Draft-Editing Interface

The admin-panel screens for reviewing and editing public brand, product and variation content over
the B2.4A administrative API, gated by the B2.4P per-account capabilities.

Scope is B2.4B2A only: review and draft editing. **There is no publish or unpublish control, no
publication evaluation, no approval decision, no backfill, no record creation and no media upload.
No permission was granted to any real account, no bootstrap SQL was executed, and nothing was
published.**

> **Partly superseded by B2.4B2B (2026-08-06).** The publish, unpublish and evaluation controls
> deferred here were built on these same screens — see §15 and
> [22_PUBLICATION_WORKFLOW_INTERFACE.md](22_PUBLICATION_WORKFLOW_INTERFACE.md). Everything else in
> this document still describes current behaviour. Backfill, record creation and media upload remain
> out of scope, and nothing has been published.

---

## 1. A defect found and fixed

Building the editor required reading the PATCH allowlist closely, which surfaced a real hole in
B2.4A.

**Brands have no `is_published` column — `publication_state = 'published'` *is* the publication
flag**, and `routes/public.js` selects brands with exactly that predicate. But `publication_state`
was on the brand PATCH allowlist, `PUBLICATION_STATES` includes `'published'`, and PATCH requires
only `public_content.edit` and never runs the publication gate.

So an account holding only **edit** could put a brand on the live public website with:

```
PATCH /admin/public-content/brands/:id   {"publication_state": "published"}
```

bypassing all three of the `public_content.publish` capability, the publication gate, and the
`content_approvals` record that `publishEntity` writes. `publishEntity`'s own comment — *"changing
publication_state alone cannot bypass the gate"* — held for the publish endpoint but not for PATCH.

**Fix:** `assertPublicationBoundaryNotCrossed()` in `routes/admin-public-content.js`, called inside
`patchAdminEntity`'s transaction against the freshly locked row, so a concurrent publish cannot slip
underneath it. Crossing the published boundary through PATCH is refused in **either** direction with
a `400` carrying `code: 'PUBLICATION_BOUNDARY'` and a field error. Ordinary editorial transitions
(`draft → verified → approved → retired`) remain fully editable. Products are unaffected: their flag
is the separate, already-immutable `is_published` column.

This was fixed rather than merely hidden in the UI, because hiding it would have left the hole open
to anyone with a terminal while creating the impression of safety. 13 tests cover the guard.

---

## 2. Current-capability endpoint

```
GET /admin/public-content/capabilities
→ { "capabilities": { "view": false, "edit": false, "publish": false } }
```

The panel's session carries `{id, name, role}` and no capabilities. B2.4B1's trick — probe a gated
endpoint and read `200` vs `403` — cannot work here: a `200` on a read proves only `view`, and
distinguishing a viewer from an editor would mean attempting a write.

**Authentication only, deliberately no capability gate.** An authenticated account holding none of
the three must still receive an honest all-false answer, so the UI can render an accurate
access-denied state rather than a failure. It is the one route on the router without a capability
middleware, and that exemption is asserted by test in three places.

It returns **exactly three booleans about the caller** and nothing else — no user record, no role,
no grant attribution, no `permissions.manage` disclosure, nothing about any other account. It is a
fresh object literal, never a database row. Resolution goes through the existing
`getUserPermissions()`, so a revoked grant or a disabled account resolves false. No mutation, no
caching, and nothing is read from the body, query or headers — the answer is derived from
`req.user.id` alone.

---

## 3. Navigation and access model

Sidebar entry **Public Content**, shown only when `public_content.view` is held.

`App.loadCaps()` now resolves four capabilities: `permissions.manage` (via the B2.4B1 registry
probe) plus the three public-content capabilities from the endpoint above. It **clears the cached
set first**, so a failed re-probe cannot leave a previous session's capabilities in place, and
logout clears it entirely.

Every failure path fails closed. A `401`, `403`, `500`, network failure, or a malformed/partial
response leaves all three unheld — the client returns strict booleans, so `{view:'yes'}` reads as
*no capability*, never as truthy.

**Frontend hiding is convenience only.** A direct visit to `#/public-content/...` without `view`
renders an access-denied card and fetches nothing; the API re-authorises every request regardless.
Nothing infers authority from `users.role`, admin navigation, an account id, an email address, or
`permissions.manage`.

---

## 4. Routes

One registered route. `App.currentRoute()` splits the hash on `/`, so the route name is always the
first segment and the rest arrives as `args` — the shape `#/suitcases/<id>` already uses. Sub-screens
are dispatched from those args.

| Hash | Screen |
|---|---|
| `#/public-content` · `#/public-content/brands` | Brand list |
| `#/public-content/products` | Product list |
| `#/public-content/brands/<id>` | Brand editor |
| `#/public-content/products/<id>` | Product editor + its variations |
| `#/public-content/products/<pid>/variations/<vid>` | Variation editor |

Selection is carried entirely by the URL. Variations are reached **through their product**, never a
separate global directory — the administrative product detail already returns them.

---

## 5. API client

Narrow methods on `DB`, fixed paths, `apiCall` still private, no generic helper:

| Method | Endpoint |
|---|---|
| `DB.publicContentCapabilities()` | `GET …/capabilities` |
| `DB.adminBrands()` / `DB.adminBrand(id)` | `GET …/brands` · `…/brands/:id` |
| `DB.adminProducts(brandId?)` / `DB.adminProduct(id)` | `GET …/products` · `…/products/:id` |
| `DB.adminVariation(id)` | `GET …/variations/:id` |
| `DB.patchAdminBrand/Product/Variation(id, changes, token)` | `PATCH …/{segment}/:id` |

**Deliberately absent: publish, unpublish and evaluate.** They exist on the API but are B2.4B2B's
surface; a client function for them here would be a publish control waiting for a button.

- Every response passes through an explicit allowlist shaper (`shapeAdminBrand` and friends).
  Nothing is spread, so a field the API might add later cannot reach the screen, and a response can
  never be fed back into a request.
- A response that does not match the documented shape raises an error rather than yielding an empty
  record — rendering "no content" for a malformed payload is how an outage reads as an empty
  catalogue.
- Every PATCH body passes through `pickEditable()`, which drops every key not on the API's own
  allowlist for that entity. `is_published`, `fact_owner`, `approver_id`, `approved_at`, `id`,
  `sku`, `brand` and `price` are structurally impossible to send.
- `401`, `403`, `404`, `409`, `400` and server failure stay distinguishable via `err.status`.
- **No mutation is retried automatically.**

---

## 6. Editable-field source of truth

The API's `EDITABLE_FIELDS` in `admin-public-serialize.js` is the authority and re-checks everything.
`DB.publicContentEditable` is a frozen mirror of it, so the browser cannot even attempt a field the
API would reject, and the editors render their controls from the same list they send.

| Entity | Editable |
|---|---|
| **Brand** | `slug`, `name`, `short_name`, `segment`, `headline`, `summary`, `story`, `ideal_retailer`, `price_tier_label`, `design_origin`, `manufacturing_origin`, `style_traits`, `approved_materials`, `logo_media_id`, `hero_media_id`, plus governance |
| **Product** | `public_slug`, `name`, `brand_id`, `line`, `shape`, `segment`, `public_description`, `is_featured`, `is_discontinued`, `replacement_product_id`, plus governance |
| **Variation** | `color`, `color_code`, `swatch_media_id` |

Governance (brands and products): `publication_state`, `verification_status`, `source_reference`,
`last_reviewed_at`, `scheduled_review_at`.

**The publication-state select offers only `draft`, `verified`, `approved`, `retired`.** `published`
is absent by design — reaching it is the publish action's job, and the server guard in §1 enforces
that independently.

`price_tier_label` is a descriptive string ("Accessible luxury"), never an amount; a test asserts it
carries no digits.

---

## 7. Lists

Built on the existing `GET /brands` and `GET /products` only. No search endpoint was invented —
filtering is client-side over the loaded page, and paging reuses the panel's `paginate`/`pagerHTML`.

Each row shows name, public slug, publication state, verification status and a published indicator.
Distinct states for loading, genuinely empty, access denied, and failed load.

**A failed load is never rendered as an empty list.** The error card says so explicitly ("This is not
an empty catalogue") and offers a retry — including when the response body is malformed.

No price, cost, stock, availability, customer or order information appears anywhere; none of it is in
the administrative contract and none is copied by the shapers.

---

## 8. The editors

One implementation (`pcEditor`) drives all three entities — the minimum shared helpers for field
rendering, dirty comparison, field errors, conflicts and unsaved-navigation guards. It is not a form
framework.

**View/edit separation.** With `view` alone the record renders in full with every control disabled
and visibly greyed, and the screen says so. Controls become editable only with `edit`. Neither
capability implies the other, and neither implies publish. The API enforces this independently — the
`disabled` attribute is a courtesy.

**Saving.** Typing changes a local draft and nothing else; no request is made until Save. Save sends
**only the fields that actually changed** — an unchanged field is never rewritten, so
`content_updated_at` does not churn and a field the editor never touched cannot be clobbered. Save is
disabled when unchanged, while saving, and without the edit capability. Reset restores the loaded
values.

**Product context** shown read-only: the legacy imported brand text, size, and `isActiveInPortal` —
labelled explicitly as the portal's ordering flag, entirely separate from public publication. The
product screen also lists its variations with links into each.

**Variation** editing carries its parent product context and a route back, and is saved with **its
own concurrency token from its own endpoint** — never the product's.

---

## 9. Concurrency

The token from the matching `GET` is held with the loaded record and returned unchanged on `PATCH`.
Local state is replaced only from a successful response, and the returned token replaces the spent
one, so a second save carries the refreshed token.

On `409` the screen reports that **another editor changed the record**, never success, and does not
retry. It offers **Reload current version**; local edits are preserved and still flagged unsaved
until the operator explicitly reloads, which is what discards them.

A variation's token is never taken from the product it was reached through — asserted by test.

---

## 10. Validation and errors

| Status | Behaviour |
|---|---|
| `400` | Field-level messages rendered against the relevant controls (`role="alert"`, error styling on the field), plus a summary line. |
| `401` | Session expired — nothing was changed. |
| `403` | This account cannot edit public content — nothing was changed. |
| `404` | The record no longer exists (on load: a safe missing-record state, not a blank form). |
| `409` | Conflict, as §9. |
| other | "The changes could not be saved. Nothing was changed." |

Raw API bodies are **never rendered**. The only server text shown is the documented
`fieldErrors[].message`, which is type-checked before display and exists precisely to be shown. A
test feeds the screen an error containing SQL, an IP, a port and a stack and asserts none of it
reaches the operator.

A refused save leaves the record untouched and the attempted edit pending, so the operator can retry
deliberately.

---

## 11. Accessibility

Real `<label for=…>` on every control (asserted for all three editors); grouped sections; visible
`:focus-visible` outlines; disabled controls visibly distinguished so view-only reads as view-only
rather than broken; the dirty indicator is `role="status" aria-live="polite"`; field errors are
`role="alert"` and adjacent to their control; list tabs use `role="tab"` with `aria-selected`;
two-column form collapses to one at 760px. Existing admin visual system throughout — no new
component library, no redesign of unrelated screens.

---

## 12. Tests

| Suite | Tests | Covers |
|---|---|---|
| `platform/server/api/test/public-content-capabilities.test.js` | 26 | capability resolution (none/view/edit/publish/all, revoked, disabled, role-only, cross-account), response shape and non-disclosure, no mutation, no caching, forgery, route wiring, and 13 on the publication boundary guard |
| `test/public-content.test.js` | 45 | navigation, access denial, fail-closed capability loading, lists, error-vs-empty, view/edit separation, absence of publish controls, save payloads, forbidden fields, concurrency, `400`/`409`/`401`/`403`/`404`/generic handling, unsaved-change guard, accessibility |
| `test/admin-shell.test.js` | 12 | panel-wide regression and this batch's protected-path boundary |

**API suite: 823 passing, 0 failing** (797 baseline + 26). **Frontend suite: 99 passing, 0 failing**
(53 baseline + 46). Frontend tests load the real shipped `js/*.js` in the `vm` harness — no duplicate
implementation is under test.

Three earlier tests were updated, all in the same direction: two B2.4P/B2.4B1 tests that asserted
*every* route carries a capability gate now encode the `/capabilities` exemption explicitly, and one
B2.4B1 test that pinned `loadCaps()` to a single request now asserts both requests by name. The DOM
harness gained a fix: a `<textarea>`'s value is its text content, not an attribute.

---

## 13. Bootstrap prerequisite — unchanged and still blocking

**No account holds any capability.** `account_permissions` is empty, so `/capabilities` returns all
false for everyone, the **Public Content** entry is hidden for every account including every
administrator, and a direct visit is denied. This screen is currently unreachable.

It becomes usable only after the controlled bootstrap in
[19_ACCOUNT_PERMISSION_SYSTEM.md](19_ACCOUNT_PERMISSION_SYSTEM.md) §8 grants `permissions.manage` to
one reviewed account, which then uses the B2.4B1 screen to grant `public_content.view` and
`public_content.edit` to whoever will do editorial work. Nothing in this interface can perform or
bypass that.

---

## 14. Limitations and B2.4B2B deferrals

**Deferred to B2.4B2B:** publish and unpublish actions, publication-gate evaluation display,
approval decisions and the `content_approvals` history view. The API endpoints exist and are
capability-gated; this batch simply ships no control for them.

**Known limitations:**

- **Lists are a single server page.** `GET /brands` and `GET /products` cap at 200 rows, and there
  is no server-side search. Filtering is client-side over what was loaded, so a large catalogue will
  need a search endpoint — deliberately not invented here.
- **`brand_id` and `replacement_product_id` are raw ID fields.** The administrative contract returns
  no brand option list, and inventing a lookup API was out of scope.
- **Media IDs are raw identifiers with no picker or preview.** Media upload and management are
  explicitly out of scope; the fields exist because they are on the API's allowlist.
- **Variation concurrency remains weaker than brands' and products'.** `variations` has no
  `updated_at` column, so its token is derived from `created_at` plus the editable fields — the
  pre-existing limitation recorded in `18_B2_ADMIN_PUBLICATION_API.md`, unchanged here.
- **No draft/preview of how content will look** on the public site.
- **Capability state is per session.** A capability revoked mid-session is not pushed to an open tab;
  the entry stays visible and every request is refused until the next sign-in.

---

## 15. B2.4B2B update — the publication workflow landed — 2026-08-06

§14 deferred publish and unpublish controls, gate-evaluation display and approval decisions to
B2.4B2B. They are now built, on the same screens, in a **Publication** panel below the edit form —
see [22_PUBLICATION_WORKFLOW_INTERFACE.md](22_PUBLICATION_WORKFLOW_INTERFACE.md).

What changed on the screens this document describes:

- **A Publication panel** on brand, product and variation records: an explicit readiness check, and
  Publish/Unpublish decisions gated on `public_content.publish`.
- **Three client functions became nine more.** §5's deliberate omission of publish, unpublish and
  evaluate no longer applies; they are now present, each with a fixed path and a body that can carry
  only a concurrency token and an optional note.
- **`pcDescribe()` gained a `422` branch** and its wording became action-neutral, because the same
  function now serves save, evaluate, publish and unpublish. Its guarantee is unchanged: no raw API
  body, stack, SQL, hostname or port is ever rendered.
- **The dirty-state handling in §8 was extended.** Unsaved edits now also block evaluation and both
  publication decisions, and `paintDirty()` updates those controls in place so the field being typed
  into keeps the caret.
- **The publication-state select is unchanged** and still offers only `draft`, `verified`,
  `approved`, `retired`. §6's statement that this screen offers no way to publish through the form
  remains exactly true — publication happens through the governed endpoints in the panel, never
  through `PATCH`.

§12's test counts are superseded: the frontend suite is now **141 passing** (99 from B2.4B2A, 42 from
B2.4B2B), and the API suite **845 passing**.

§13's bootstrap prerequisite is **unchanged and now blocks more**: with no grants, review, editing
and publication are all unreachable by every account.

One correction to §1's account of B2.4B2A's fix: closing the PATCH publication bypass was correct,
but it turned a latent gate defect into a hard deadlock — the gate required a record to be *already
published* before permitting publication. Fixed in B2.4B2B; see
[22_PUBLICATION_WORKFLOW_INTERFACE.md](22_PUBLICATION_WORKFLOW_INTERFACE.md) §1.
