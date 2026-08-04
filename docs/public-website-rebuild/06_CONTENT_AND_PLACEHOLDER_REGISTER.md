# 06 — Content and Placeholder Register

Unapproved facts must not block development, and must not reach production. This document
defines the mechanism that makes both true at once, and registers every placeholder needed.

---

## 1. Policy

1. **One token format.** Every placeholder is `VEY_PLACEHOLDER::<KEY>`. It is greppable across
   source, content, database rows, JSON and rendered HTML with one search string.
2. **One registry.** `platform/server/web/src/content/placeholders.json` is the only place a
   placeholder is declared. Nothing may reference a key that is not registered.
3. **Every placeholder has an owner and a status.** Unowned placeholders are a registry
   validation failure, not a warning.
4. **Placeholders are visible, never plausible.** In RC they render as
   `[[ PLACEHOLDER: public brand count — owner Veyora commercial — pending ]]`. They never render
   as an invented number, date, address or claim that a reviewer could mistake for approved fact.
5. **The production build refuses to run while any blocking placeholder is unresolved.**
   `PLACEHOLDER_MODE=block` is the production setting; the gate exits non-zero.
6. **Resolution requires a named approver.** A placeholder is resolved by moving the value into
   its content record with an approver and a source, which writes a `content_approvals` row. A
   free-text "verified" note is explicitly not sufficient (`REQ-CM-026`).
7. **Nothing is invented.** Where the specification identifies a decision Veyora has not made —
   location function, brand count, warranty terms — the placeholder stays and the surrounding copy
   is written to be true without it.

---

## 2. Registry schema

```json
{
  "key": "PUBLIC_BRAND_COUNT",
  "label": "Public brand count",
  "category": "commercial-claim",
  "owner": "Veyora commercial",
  "status": "pending",
  "blocks_production": true,
  "decision_ref": "DECISION-03",
  "requirements": ["REQ-CSF-006", "REQ-BRX-010", "REQ-BRX-016"],
  "used_in": ["/", "/why-veyora/", "/brands/", "schema:Organization"],
  "rc_render": "[[ PLACEHOLDER: public brand count — Veyora commercial — pending ]]",
  "resolution_target": "brands table, derived count",
  "notes": "Must be derived from published brand records, never hard-coded."
}
```

`status` ∈ `pending` · `in-review` · `approved` · `resolved` · `deferred`.
`deferred` requires `blocks_production: false` and an explicit reason.

---

## 3. Validation gate

`platform/server/web/scripts/check-placeholders.mjs`, run in CI and as a pre-build step.

| Check | Failure |
|---|---|
| Every `VEY_PLACEHOLDER::<KEY>` in source, content or database output has a registry entry | error |
| Every registry entry has a non-empty owner | error |
| Every registry entry lists at least one requirement id | error |
| No registry entry with `blocks_production: true` is unresolved when `PLACEHOLDER_MODE=block` | **error — blocks the production build** |
| No `VEY_PLACEHOLDER::` token appears in any rendered route under `PLACEHOLDER_MODE=block` | **error** |
| No lorem ipsum, `TODO`, `TBD`, `XXX`, `Lorem`, `example.com`, `foo@bar` in rendered output | error |
| No numeric zero rendered as a dimension, count or duration | error |
| Unused registry entries | warning |
| `deferred` entries older than 90 days | warning |

The gate runs against **rendered output**, not just source, so a placeholder that reaches the
page through a database row is caught too. This is what closes `REQ-DOD-011`, `REQ-MOD-017` and
`REQ-IMP-006`.

---

## 4. The register

### 4.1 Domain and platform

| Key | Description | Owner | Blocks prod | Decision | Used in |
|---|---|---|---|---|---|
| `PUBLIC_SITE_ORIGIN` | Canonical production origin | Veyora / engineering | **Yes** | DECISION-01 | every canonical, sitemap, OG url, Organization schema |
| `PORTAL_ORIGIN` | Authenticated portal / login target | Veyora / engineering | **Yes** | DECISION-02 | header, footer, every B2B gate, model and collection notices |
| `PUBLIC_RC_DOMAIN` | Protected RC host | engineering | No | — | RC only |

Both blocking values are environment variables with **no default**; the `web` container refuses
to start in production without them.

### 4.2 Brand scope

| Key | Description | Owner | Blocks prod | Decision |
|---|---|---|---|---|
| `PUBLIC_BRAND_COUNT` | The public brand count claim | Veyora commercial | **Yes** | DECISION-03 |
| `ESSEDUE_KYME_SPLIT` | Whether Essedue and Kyme are separate public brands | Veyora commercial | **Yes** | DECISION-03 |
| `EXTREME_NEXT_IN_SCOPE` | Whether Extreme Next is published this release | Veyora commercial | **Yes** | DECISION-04 |
| `BRAND_SEGMENT_LABELS` | Approved public segment labels per brand | Veyora commercial | **Yes** | DECISION-03 |
| `BRAND_TIER_LABEL_{BRAND}` | Approved public price-tier label (never a number) | Veyora commercial | **Yes** | — |
| `BRAND_POSITIONING_{BRAND}` | Distinctive positioning statement for the H1 | Veyora marketing | **Yes** | — |
| `BRAND_STORY_{BRAND}` | Unique brand story body | Veyora marketing | **Yes** | — |

Current code lists eight brands with Essedue and Kyme separate and no Extreme Next
(`PUBLIC_BRANDS` in `catalog.js`, `FILTER_BRANDS` in `pages_catalog.js`). **That is an
implementation detail, not an approved public claim**, and must not be treated as the answer.

### 4.3 Service and policy claims

| Key | Description | Owner | Blocks prod | Decision |
|---|---|---|---|---|
| `SHIPPING_WINDOW` | The shipping-speed claim | Veyora operations | **Yes** | DECISION-06 |
| `SHIPPING_SCOPE` | In-stock scope, business days, eligible destinations, cut-off | Veyora operations | **Yes** | DECISION-06 |
| `EXCHANGE_PERIOD` | Exchange window | Veyora operations | **Yes** | DECISION-07 |
| `EXCHANGE_TERMS` | One-for-one, condition, exclusions, approval, freight, geography | Veyora operations | **Yes** | DECISION-07 |
| `WARRANTY_PERIOD` | Warranty duration | Veyora operations | **Yes** | DECISION-08 |
| `WARRANTY_TERMS` | Defects covered, start date, exclusions, evidence, resolution | Veyora operations | **Yes** | DECISION-08 |
| `RESOLUTION_LOGIC_LABEL` | Customer-facing replacement for "No-Return Logic" | Veyora operations | **Yes** | DECISION-09 |
| `ORDERING_WORKFLOW` | Account approval → ordering → replenishment → support | Veyora operations | **Yes** | — |
| `RESPONSE_WINDOW` | Expected response time shown after form success | Veyora sales | No | DECISION-16 |
| `MOQ_AND_LEADTIME` | Private-label minimums and lead times | Veyora commercial | No — omitted until approved | DECISION-14 |

The specification's illustrative figures (48–72 h, six months, two years) appear in this audit
**only as quotations of the specification**. They are not approved values and must not be
hard-coded anywhere.

### 4.4 Geography

| Key | Description | Owner | Blocks prod | Decision |
|---|---|---|---|---|
| `LOCATION_FUNCTION_ITALY` | Warehouse / supply base / service hub / office / support | Veyora operations | **Yes** | DECISION-12 |
| `LOCATION_FUNCTION_GERMANY` | as above | Veyora operations | **Yes** | DECISION-12 |
| `LOCATION_FUNCTION_NEW_YORK` | as above | Veyora operations | **Yes** | DECISION-12 |
| `LOCATION_FUNCTION_MONTREAL` | as above | Veyora operations | **Yes** | DECISION-12 |
| `MARKET_COVERAGE` | Which markets receive which service level | Veyora operations | **Yes** | DECISION-12 |
| `HUB_COUNT` | Number of strategic hubs claimed | Veyora operations | **Yes** | DECISION-05 |
| `RETAILER_REACH` | Retailer or customer footprint claim | Veyora commercial | No — omitted until approved | DECISION-05 |

**Note on inconsistency in the source specification.** The Why Veyora section names *Italy, New
York and Montreal*; the Global Presence section names *Germany, New York and Montreal*. The brief
permits *Italy, Germany, New York and Montreal* with neutral wording. All four are registered.
Until resolved, regional presence is expressed as neutral presence with no implied function, and
no location card renders without an explicit function label.

### 4.5 Company and contact

| Key | Description | Owner | Blocks prod | Decision |
|---|---|---|---|---|
| `LEGAL_COMPANY_NAME` | Legal entity name for the footer and Organization schema | Veyora legal | **Yes** | DECISION-10 |
| `HEADQUARTERS_ADDRESS` | Public HQ address | Veyora legal | **Yes** | DECISION-10 |
| `YEAR_ESTABLISHED` | Founding year, if published | Veyora | No | DECISION-10 |
| `SALES_EMAIL` | Public sales address | Veyora sales | **Yes** | DECISION-10 |
| `SERVICE_PHONE` | Public phone | Veyora sales | **Yes** | DECISION-10 |
| `WHATSAPP_NUMBER` | Whether the current `wa.me/16467731000` is the approved public number | Veyora sales | **Yes** | DECISION-10 |
| `BUSINESS_HOURS` | Support hours with timezone | Veyora sales | **Yes** | DECISION-10 |
| `SOCIAL_PROFILES` | Approved profiles for footer and `sameAs` | Veyora marketing | No — omitted until approved | DECISION-10 |

### 4.6 Product and material claims

| Key | Description | Owner | Blocks prod | Decision |
|---|---|---|---|---|
| `ORIGIN_CLAIMS_PERMITTED` | Whether manufacturing country may be stated publicly, and at what level | Veyora product | **Yes** | DECISION-11 |
| `MATERIAL_CLAIMS_PERMITTED` | Whether material composition may be stated publicly | Veyora product | **Yes** | DECISION-11 |
| `COMPONENT_ORIGIN_PERMITTED` | Whether component sourcing may be stated | Veyora product | **Yes** | DECISION-11 |
| `CHARLETT_ORIGIN_STATEMENT` | The specific Charlett background pending final content review | Veyora product | **Yes** | DECISION-11 |
| `MODEL_SHAPE_TAXONOMY` | The approved shape vocabulary for the filter | Veyora product | **Yes** | — |

Design origin, manufacturing origin and component origin are three separate fields with three
separate verification statuses. None renders unless `verification_status = 'verified'` **and** a
`content_approvals` row exists (`REQ-BRD-011`, `REQ-CM-025`).

### 4.7 Legal, consent and integrations

| Key | Description | Owner | Blocks prod | Decision |
|---|---|---|---|---|
| `PRIVACY_POLICY_BODY` | Approved privacy notice | Veyora legal | **Yes** | DECISION-18 |
| `TERMS_BODY` | Approved public and B2B terms | Veyora legal | **Yes** | DECISION-18 |
| `CONSENT_WORDING` | Form consent copy, versioned | Veyora legal | **Yes** | DECISION-18 |
| `COOKIE_POLICY_REQUIRED` | Whether a cookie banner is required for the operating regions | Veyora legal | **Yes** | DECISION-18 |
| `ACCESSIBILITY_STATEMENT` | Statement and contact method | Veyora | **Yes** | — |
| `CRM_TARGET` | CRM system and endpoint | Veyora | **Yes** | DECISION-17 |
| `ANALYTICS_PLATFORM` | GA4 or approved alternative | Veyora | **Yes** | DECISION-20 |
| `META_PIXEL_RETAINED` | Whether the existing Meta Pixel continues on the public site | Veyora marketing | **Yes** | DECISION-20 |
| `GPTBOT_POLICY` | Allow or disallow model-training crawling | Veyora | No — defaults to Disallow | DECISION-19 |

`META_PIXEL_RETAINED` is blocking because the current pixel fires unconditionally with no consent
gate. Carrying that onto a public marketing site in Europe is a legal exposure, not a preference.

### 4.8 Copy not supplied by the specification

| Key | Description | Owner | Blocks prod |
|---|---|---|---|
| `PH-META-CATEGORY-OPTICAL` | Title, description and H1 for `/collections/optical/` | Veyora marketing | **Yes** |
| `PH-META-CATEGORY-SUN` | as above for `/collections/sun/` | Veyora marketing | **Yes** |
| `PH-META-CATEGORY-KIDS` | as above for `/collections/kids/` | Veyora marketing | **Yes** |
| `PH-META-PRIVATE-LABEL-ENQUIRY` | Metadata for `/private-label-enquiry/` | Veyora marketing | **Yes** |
| `PH-OG-DEFAULT-IMAGE` | Designed 1200×630 default social image | Veyora design | **Yes** |
| `PH-FAVICON-SET` | Favicon, apple-touch-icon, manifest icons | Veyora design | **Yes** |
| `PH-PORTAL-SCREENSHOTS` | Approved portal preview imagery labelled as demo data | Veyora | **Yes** |
| `PH-ANSWER-BLOCK-{ROUTE}` | 40–80 word answer paragraph per key route | Veyora marketing | No |

### 4.9 Media rights

| Key | Description | Owner | Blocks prod |
|---|---|---|---|
| `MEDIA_RIGHTS_{ASSET}` | Rights holder and expiry for each campaign photograph and the Charlett video | Veyora | **Yes** for any asset used publicly |
| `MODEL_RELEASE_STATUS` | Whether the campaign portraits carry model releases for web use | Veyora legal | **Yes** |

The homepage photography is already public on the current site, which is evidence of intended
use but not a rights record. `REQ-CM-007` requires rights and expiry as first-class fields.

---

## 5. Content that can be built without approval

Real work that is not blocked, and should proceed first:

- Design token layer, layout, header, footer, breadcrumbs, navigation config
- All 25 route skeletons with real structure and lorem-free placeholder rendering
- The public API surface, serializer and forbidden-key test
- Content model migrations and the publication state machine
- Filter panel, gallery, pagination, form components — behaviour, accessibility, URL state
- Metadata framework, canonical builder, schema builders, indexing policy
- Sitemap generation, robots generation, redirect middleware
- The entire QA gate suite
- Model attribute rendering from existing data (dimensions, lens type, colours, size, categories)
- Brand page structure and every model page **for products whose data is already complete**

Roughly 70% of the engineering work has no dependency on an unapproved fact. The blocked 30% is
concentrated in claims, policies, geography and legal copy — which is exactly what the register
exists to isolate.

---

## 6. Neutral wording pattern

Where a fact is pending, copy is written so it is true without the fact and complete with it.

| Instead of | Write |
|---|---|
| "Eight premium eyewear brands" | "A curated portfolio of eyewear brands" (+ count when approved) |
| "Warehouses in Italy, Germany, New York and Montreal" | "Presence in Italy, Germany, New York and Montreal" (+ function per location when approved) |
| "48–72 hour shipping" | "Structured replenishment and dependable supply" (+ the qualified claim when approved) |
| "Two-year warranty" | "Warranty support on every frame" (+ terms when approved) |
| "Manufactured in China from cellulose acetate" | omit entirely until `ORIGIN_CLAIMS_PERMITTED` and `MATERIAL_CLAIMS_PERMITTED` are resolved |
| "Trusted by hundreds of retailers" | omit — unverified customer counts are forbidden by `REQ-HOME-009` |

**No page may depend structurally on a pending fact.** If the proof strip needs five items and
three are pending, it renders with two — it does not render with placeholder text where a
customer would read a claim.

---

## 7. Ownership summary

**Superseded by §8 — the Phase 0.1 ruling reclassified 22 of these 43.** The Phase 0 figures are
retained here as history.

| Owner | Placeholders | Blocking (Phase 0) | Blocking (Phase 0.1) |
|---|---:|---:|---:|
| Veyora commercial | 8 | 6 | 0 |
| Veyora operations | 12 | 11 | 4 |
| Veyora legal | 7 | 6 | 6 |
| Veyora sales | 5 | 4 | 1 |
| Veyora marketing | 9 | 6 | 3 |
| Veyora product | 5 | 5 | 0 |
| Veyora design | 3 | 3 | 3 |
| Engineering | 3 | 2 | 4 |
| **Total** | **52** | **43** | **21** |

---

## 8. Programme ruling — traceability correction (2026-08-04)

Sections 1–7 above are retained as written. This section takes precedence where they disagree.

### 8.1 The corrected blocking test

A placeholder blocks production **only** where omission is impossible **and** publication without
an approved value would be false, legally incomplete, unsafe, data-losing or operationally broken.

A placeholder does **not** block production merely because the specification mentions it, because
content is incomplete, because an optional claim is unavailable, or because a provider decision is
outstanding.

### 8.2 Omission-first policy

Where a fact is pending and the page can be true and complete without it, the value is **omitted
entirely** — no visible placeholder, no bracketed marker, no empty affordance. A module renders
with fewer items rather than with a slot a reader would expect to contain a claim. Visible
placeholder rendering is reserved for the RC environment and for the 21 keys that cannot be
omitted.

This replaces the Phase 0 rule that every pending fact rendered as a visible bracketed marker.

### 8.3 The 21 keys that still block production

| Key | Owner | Why omission is impossible |
|---|---|---|
| `PUBLIC_SITE_ORIGIN` | Engineering | Every canonical, sitemap and OG URL depends on it |
| `PORTAL_ORIGIN` | Engineering | Every login control and B2B gate depends on it |
| `LEGAL_COMPANY_NAME` | Veyora legal | Mandatory in the footer legal row and Organization schema |
| `PRIVACY_POLICY_BODY` | Veyora legal | Mandatory legal content alongside public lead-capture forms |
| `TERMS_BODY` | Veyora legal | Mandatory legal content |
| `CONSENT_WORDING` | Veyora legal | A form cannot capture consent without versioned wording |
| `COOKIE_POLICY_REQUIRED` | Veyora legal | Determines whether a consent gate is legally required |
| `MODEL_RELEASE_STATUS` | Veyora legal | Campaign portraits cannot be published without release status |
| `SHIPPING_SCOPE` | Veyora operations | Only if a shipping claim is published; the claim itself may be omitted |
| `EXCHANGE_TERMS` | Veyora operations | Only if an exchange claim is published |
| `WARRANTY_TERMS` | Veyora operations | Only if a warranty claim is published |
| `ORDERING_WORKFLOW` | Veyora operations | `/ordering-guide/` is a required route with no omissible body |
| `SALES_EMAIL` | Veyora sales | The site must offer at least one working sales contact route |
| `PH-META-CATEGORY-OPTICAL` | Veyora marketing | A P0 indexable route cannot ship without a title and H1 |
| `PH-META-CATEGORY-SUN` | Veyora marketing | as above |
| `PH-META-CATEGORY-KIDS` | Veyora marketing | as above |
| `PH-META-PRIVATE-LABEL-ENQUIRY` | Engineering | Required route metadata |
| `PH-OG-DEFAULT-IMAGE` | Veyora design | Social cards otherwise render the white logo SVG unusably |
| `PH-FAVICON-SET` | Veyora design | `favicon.svg` is referenced today and absent from the repository |
| `ACCESSIBILITY_STATEMENT` | Veyora design | `/accessibility/` is a required route with no omissible body |
| `MEDIA_RIGHTS_{ASSET}` | Veyora legal | Only for assets actually used publicly; unrighted assets are omitted |

### 8.4 The 22 keys reclassified as non-blocking

| Key | New policy | Ruling |
|---|---|---|
| `PUBLIC_BRAND_COUNT` | `CONFIGURABLE` — derived from published records | 7 |
| `ESSEDUE_KYME_SPLIT` | `CONFIGURABLE` | 8 |
| `EXTREME_NEXT_IN_SCOPE` | `CONFIGURABLE` — unpublished by default | 9 |
| `BRAND_SEGMENT_LABELS`, `BRAND_TIER_LABEL_*`, `BRAND_POSITIONING_*`, `BRAND_STORY_*` | `OMIT_UNTIL_APPROVED` | 3, 13 |
| `SHIPPING_WINDOW`, `EXCHANGE_PERIOD`, `WARRANTY_PERIOD`, `RESOLUTION_LOGIC_LABEL` | `OMIT_UNTIL_APPROVED` — the claim is omitted, not placeheld | 13 |
| `LOCATION_FUNCTION_ITALY/GERMANY/NEW_YORK/MONTREAL`, `MARKET_COVERAGE`, `HUB_COUNT` | `NEUTRAL_WORDING` | 5, 6 |
| `HEADQUARTERS_ADDRESS`, `SERVICE_PHONE`, `WHATSAPP_NUMBER`, `BUSINESS_HOURS` | `OMIT_UNTIL_APPROVED` | 13 |
| `ORIGIN_CLAIMS_PERMITTED`, `MATERIAL_CLAIMS_PERMITTED`, `COMPONENT_ORIGIN_PERMITTED`, `CHARLETT_ORIGIN_STATEMENT`, `MODEL_SHAPE_TAXONOMY` | `OMIT_UNTIL_APPROVED` | 13 |
| `CRM_TARGET` | `CONFIGURABLE` — durable store plus operations alert satisfies the requirement | 10 |
| `ANALYTICS_PLATFORM` | `CONFIGURABLE` — disabled by default | 11 |
| `META_PIXEL_RETAINED` | `CONFIGURABLE` — removed by default | 12 |
| `PH-PORTAL-SCREENSHOTS` | `OMIT_UNTIL_APPROVED` — the module is omitted | 13 |

Already non-blocking in Phase 0 and unchanged: `PUBLIC_RC_DOMAIN`, `YEAR_ESTABLISHED`,
`SOCIAL_PROFILES`, `RESPONSE_WINDOW`, `MOQ_AND_LEADTIME`, `RETAILER_REACH`, `GPTBOT_POLICY`,
`PH-ANSWER-BLOCK-{ROUTE}`.

### 8.5 Consequence

Twenty-one blocking placeholders, of which **six sit with Veyora legal, four with operations, three
with design, three with marketing, one with sales and four with engineering**. Commercial and
product now hold **zero** blocking placeholders — every brand, tier, origin and material decision
resolves through omission or configuration.

That is the honest measure of the content-approval work standing between a complete build and a
production launch. It is not a reason to delay engineering; it is the reason the gate exists.
