# 14 — B2.1 Schema Reference

Additive database schema and publication-governance foundation for the future public website.
Everything in this document describes **schema only** — no `/public/*` API, no serializer, no
Astro integration, no data mutation against any existing database. That is later B2 work.

---

## 1. Migration files

| File | Purpose |
|---|---|
| `platform/server/db/migrations/0007_public_site.sql` | The additive migration itself: 9 new tables, additive columns on `products`/`variations`, publication invariants, slug-change redirect triggers. Runs automatically only on a completely fresh database volume. |
| `platform/server/api/src/migrate.js` (`ensureSchema()`, appended) | The exact same statements, mirrored idempotently (`create table if not exists`, `add column if not exists`, guarded `pg_trigger`/`pg_constraint` checks). This is what an **already-deployed** database actually picks the change up through — see §9. |

### 1.1 Why two copies

Confirmed by inspecting the existing repository convention before writing anything (0005, 0006,
and every comment in `migrate.js` say so explicitly): `db/migrations/*.sql` only runs via
PostgreSQL's `docker-entrypoint-initdb.d` mechanism, which fires exactly once, on a container's
*first* boot against a completely empty data volume. An existing, already-deployed database is
never touched by files in that directory again. The repository's actual incremental-migration
mechanism is `ensureSchema()` in `api/src/migrate.js`, called from `startServer()` on every API
boot (`fail-closed` — the API will not start if it throws), containing hand-written, idempotent SQL
that mirrors every numbered migration file added after go-live. There is no ORM, no migration
framework, and no separate migration-runner tool anywhere in this repository — this project's
"migration system" is: a numbered SQL file for a fresh install, plus the same statements re-stated
idempotently in one JS function for an existing install. B2.1 follows that convention exactly and
introduces no new one.

---

## 2. New tables

All nine use the same `veyora_id(prefix)` text-primary-key convention as every existing table
(defined once in `0001_schema.sql`). New prefixes, checked against every prefix already in use
across `0001`–`0006` and `migrate.js`: `br`, `loc`, `pol`, `med`, `rdr`, `cpg`, `frm`, `fsub`, `cap`.

### 2.1 `media`

Created first — referenced by `brands.logo_media_id`/`hero_media_id` and
`variations.swatch_media_id`.

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('med')` | |
| `path` | text | — | required |
| `alt` | text | `''` | |
| `width`, `height` | int | — | nullable |
| `kind` | text | `'image'` | CHECK `in ('image','video')` |
| `rights_holder` | text | `''` | |
| `rights_expiry` | date | — | nullable |
| `owner_type`, `owner_id` | text | `''` | **deliberately no FK** — polymorphic reference, same pattern as the existing `inventory_movements` ledger (must outlive/point at rows in more than one other table) |
| `variant_sku` | text | `''` | |
| `created_at` | timestamptz | `now()` | |

Index: `media_owner_idx (owner_type, owner_id)`. No governance block — media is an asset record, not
itself a publishable fact.

### 2.2 `brands`

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('br')` | |
| `slug` | text | — | **unique**, not null |
| `name` | text | — | not null |
| `short_name`, `segment`, `headline`, `summary`, `story`, `ideal_retailer` | text | `''` | |
| `best_for`, `component_origins` | jsonb | `'[]'` | |
| `style_traits`, `approved_materials` | text[] | `'{}'` | |
| `price_tier_label`, `design_origin`, `manufacturing_origin` | text | `''` | |
| `logo_media_id`, `hero_media_id` | text FK → `media(id)` | — | `on delete set null` |
| `seo` | jsonb | `'{}'` | |
| governance block | — | — | see §4 |

Index: `brands_publication_state_idx`. Trigger: `t_brands_touch` (governance `updated_at`),
`t_brands_slug_redirect` (see §7).

### 2.3 `locations`

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('loc')` | |
| `slug` | text | — | unique, not null |
| `name` | text | — | not null |
| `"function"` | text | `'office'` | CHECK `in ('warehouse','supply_base','service_hub','office','support')`. **Double-quoted** in both the migration and its mirror: `FUNCTION` is a non-reserved PostgreSQL keyword (valid unquoted as a column name too), but this schema was written and reviewed without a local PostgreSQL executable available to confirm interactively (see §9), so the identifier is quoted defensively. Quoting an already-lowercase identifier is a no-op for matching purposes — nothing downstream needs to change if a later batch queries it unquoted. |
| `is_public` | boolean | `false` | |
| `address`, `contact` | jsonb | `'{}'` | |
| `regions_served` | text[] | `'{}'` | |
| `hours` | text | `''` | |
| `coordinates` | jsonb | — | nullable |
| governance block | — | — | see §4 |

Index: `locations_publication_state_idx`. Trigger: `t_locations_touch`.

### 2.4 `policies`

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('pol')` | |
| `type` | text | — | **unique**, not null (e.g. `'shipping'`, `'privacy-policy'`) |
| `summary`, `terms`, `exclusions` | text | `''` | |
| `effective_date` | date | — | nullable |
| `eligible_markets` | text[] | `'{}'` | |
| `revisions` | jsonb | `'[]'` | |
| governance block | — | — | see §4 |

Index: `policies_publication_state_idx`. Trigger: `t_policies_touch`.

### 2.5 `redirects`

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('rdr')` | |
| `from_path` | text | — | **unique**, not null — the DB-level guarantee against a duplicate source path |
| `to_path` | text | `''` | CHECK `to_path = '' or to_path like '/%'` — empty (410 rows carry no destination) or an internal path; **never** an absolute URL or another host, so this table cannot become an open-redirect source by construction |
| `status` | int | `301` | CHECK `in (301, 302, 410)` |
| `reason`, `source` | text | `''` / `'manual'` | `source` distinguishes a manually-entered row from one written by the slug-change triggers (`'trigger'`) |
| `created_at` | timestamptz | `now()` | |

No governance block, no `updated_at` — a redirect is replaced or removed, not edited in place.

### 2.6 `content_pages`

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('cpg')` | |
| `route` | text | — | **unique**, not null |
| `template` | text | `''` | |
| `modules`, `seo` | jsonb | `'[]'` / `'{}'` | |
| `index_state` | text | `'noindex'` | CHECK `in ('index','noindex')` — conservative default; flipping to `'index'` is an editorial decision made alongside `publication_state` reaching `'published'`, not a migration default |
| governance block | — | — | see §4 |

Index: `content_pages_publication_state_idx`. Trigger: `t_content_pages_touch`.

### 2.7 `forms`

Form *definitions* — what fields a form has and where it routes, not individual submissions.

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('frm')` | |
| `type` | text | — | **unique**, not null |
| `fields` | jsonb | `'[]'` | |
| `consent_version` | text | `''` | |
| `crm_routing`, `confirmation` | jsonb | `'{}'` | |
| `notify_to` | text[] | `'{}'` | |
| `retention_days` | int | `365` | |
| `created_at`, `updated_at` | timestamptz | `now()` | |

No governance block — a form definition is engineering/content configuration, not a publishable
public fact. Trigger: `t_forms_touch`.

### 2.8 `form_submissions`

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('fsub')` | |
| `form_type`, `source_url`, `region`, `business_type`, `consent_version` | text | `''` | |
| `payload`, `utm` | jsonb | `'{}'` | |
| `consent_at` | timestamptz | — | nullable |
| `delivery_state` | text | `'pending'` | CHECK `in ('pending','sent','failed')` |
| `attempts` | int | `0` | |
| `last_error` | text | `''` | |
| `created_at`, `updated_at` | timestamptz | `now()` | |

Indexes: `form_submissions_form_type_idx`, `form_submissions_delivery_state_idx`. Trigger:
`t_form_submissions_touch`.

### 2.9 `content_approvals`

An immutable approval-event log — same shape as the existing `audit_log` (no `updated_at`).

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | `veyora_id('cap')` | |
| `entity_type`, `entity_id` | text | — | not null; **deliberately no FK** — polymorphic, same reasoning as `media.owner_type`/`owner_id` |
| `field`, `source_reference`, `note` | text | `''` | |
| `approver_id` | text FK → `users(id)` | — | `on delete set null` |
| `approved_at`, `created_at` | timestamptz | `now()` | |

Index: `content_approvals_entity_idx (entity_type, entity_id)`.

---

## 3. Additive columns

### 3.1 `products` (public-content fields)

| Column | Type | Default | Notes |
|---|---|---|---|
| `public_slug` | text | — | nullable until backfill (B2.4); **unique** index (`create unique index` — PostgreSQL unique indexes treat multiple `NULL`s as non-conflicting, so this is simultaneously "unique among real values" and "safe to leave null on every existing row") |
| `brand_id` | text FK → `brands(id)` | — | `on delete set null`; nullable during migration so the existing free-text `brand` column keeps working unchanged |
| `line`, `shape`, `segment`, `public_description` | text | `''` | |
| `is_published` | boolean | `false` | independent of the existing `is_active` (which keeps its current *ordering* meaning, untouched); see the CHECK in §5 |
| `is_featured`, `is_discontinued` | boolean | `false` | |
| `replacement_product_id` | text FK → `products(id)` | — | `on delete set null`; self-reference guarded, see §5 |
| governance block | — | — | see §4. **`content_updated_at` is new**; the existing `updated_at` column and its existing `t_products_touch` trigger are completely untouched |

Indexes: `products_public_slug_idx` (unique), `products_brand_id_idx`, `products_is_published_idx`,
`products_shape_idx`, `products_replacement_idx`.

### 3.2 `variations`

| Column | Type | Default | Notes |
|---|---|---|---|
| `color_code` | text | `''` | structured, distinct from the existing free-text `color` |
| `swatch_media_id` | text FK → `media(id)` | — | `on delete set null` |
| `is_published` | boolean | `false` | independent of the parent product's flag — see §6 for the deferred cross-row rule |

Index: `variations_is_published_idx`.

---

## 4. Governance lifecycle

Applied identically to `brands`, `locations`, `policies`, `content_pages`, and to the new columns
on `products`:

| Column | Type | Default | Notes |
|---|---|---|---|
| `publication_state` | text | `'draft'` | CHECK `in ('draft','verified','approved','published','retired')` |
| `source_reference` | text | `''` | |
| `fact_owner` | text FK → `users(id)` | — | `on delete set null` — **deleting a user never deletes public content**, it just clears the attribution |
| `verification_status` | text | `'unverified'` | CHECK `in ('unverified','sourced','verified')` |
| `last_reviewed_at`, `scheduled_review_at` | timestamptz | — | nullable |
| `content_updated_at` | timestamptz | `now()` at insert | **never** touched by any trigger in this migration — see §4.1 |
| `created_at`, `updated_at` | timestamptz | `now()` | `updated_at` is touch-maintained (see below); `products`/`variations` already had their own `created_at`/`updated_at` before this migration and keep them unchanged |

New tables get a fresh `t_<table>_touch` trigger (reusing `touch_updated_at()`, defined once in
`0001_schema.sql`) on their own `updated_at`. `products` keeps its pre-existing
`t_products_touch` trigger, untouched.

### 4.1 Why `content_updated_at` has no trigger

It exists specifically to drive a future sitemap `lastmod` (B7) without being churned by routine
operational writes — most importantly the Zoho stock sync, which updates `products.updated_at`
roughly every 30 minutes. Wiring a trigger to also bump `content_updated_at` on every row `UPDATE`
would defeat the entire purpose of having a separate column. It is set once, at `INSERT`, and is
otherwise exclusively application-managed — the future editorial surface (B2.2+) is expected to set
it explicitly, only when a *content* field actually changes.

### 4.2 Defaults and the "never auto-publish" guarantee

Every governance-bearing table defaults to `publication_state = 'draft'`,
`verification_status = 'unverified'`. No trigger, function, or default value in this migration ever
changes either field to a more-published state — that is exclusively a future application action
(B2.2+ editorial surfaces). Combined with the CHECK described in §5, this migration cannot cause
any content, existing or new, to become publicly visible.

---

## 5. Database-enforced publication invariants

| Rule | Mechanism |
|---|---|
| Valid `publication_state` values | CHECK on every governance-bearing table/column set |
| Valid `verification_status` values | CHECK, ditto |
| Redirect status restricted to supported codes | CHECK `redirects.status in (301, 302, 410)` |
| Form delivery states restricted to safe values | CHECK `form_submissions.delivery_state in ('pending','sent','failed')` |
| No duplicate redirect source path | `redirects.from_path` UNIQUE |
| Redirect destination is always internal | CHECK `redirects_to_path_internal` |
| No invalid product self-replacement | CHECK `products_replacement_not_self` |
| **A product cannot be publicly visible without being in the `published` governance state** | CHECK `products_published_requires_state`: `is_published = false or publication_state = 'published'` |
| Unique route/slug keys | `brands.slug`, `locations.slug`, `policies.type`, `content_pages.route`, `forms.type`, `products.public_slug` all UNIQUE |

`products_published_requires_state` is the strongest guarantee in this batch: since every existing
product row keeps `is_published` at its default (`false`), the constraint cannot reject any current
data, and it makes "no current product becomes publicly published through this migration" a
database fact, not merely a claim about what the migration's `INSERT`/`UPDATE` statements happen
not to do.

---

## 6. Application-level rules deferred to B2.2/B2.4

Not database constraints, because the data or workflow they depend on does not exist yet, or
because enforcing them at the database level would require a cross-row trigger disproportionate to
this batch:

- **A variation should not be publicly visible while its parent product is unpublished.**
  `variations.is_published` has no CHECK tying it to `products.is_published` — doing so safely would
  need a trigger re-validating on every product state change, which is real complexity with no
  current caller. Deferred to the B2.2/B2.4 publication gate (the same gate that will also decide
  when `is_published` is allowed to flip to `true` in the first place).
- **A brand's `publication_state` reaching `'published'` requires an approval record.** The schema
  supports this (`content_approvals`, `brands.publication_state`) but nothing yet requires a
  matching `content_approvals` row before the state can change — that gate is B2.2's editorial
  workflow, per `06_CONTENT_AND_PLACEHOLDER_REGISTER.md`'s resolution rule (`REQ-CM-026`: "a
  free-text 'verified' note is explicitly not sufficient").
- **Product `public_slug`/`brand_id` backfill** for the 1,318 existing products is explicitly out of
  scope for B2.1 (per the task brief) and remains a separate, reviewed B2.4 batch.
- **A redirect-collision alert.** The slug-change triggers (§7) silently skip inserting a redirect
  when one already exists at that exact `from_path`, rather than overwriting it. Detecting and
  surfacing that collision (so a human notices) is an application-level concern for B2.2+, not a
  database one.
- **Shape-facet coverage and category classification** — unchanged from `04_TARGET_ARCHITECTURE.md`
  §7.4 (`REQ-COL-003`), still a B2.4 content task, not a schema one.

---

## 7. Slug-change and redirect-trigger behaviour

Two triggers, both `BEFORE UPDATE`, both additive:

- **`t_brands_slug_redirect`** on `brands` — fires `record_brand_slug_redirect()`. If the row being
  updated was already `publication_state = 'published'` **and** `slug` is actually changing, inserts
  `('/brands/<old slug>/', '/brands/<new slug>/', 301, 'brand slug change', 'trigger')` into
  `redirects`.
- **`t_products_slug_redirect`** on `products` — fires `record_product_slug_redirect()`. If the row
  being updated was already `is_published = true`, had a non-null `public_slug`, **and**
  `public_slug` is actually changing, looks up the product's brand slug and inserts
  `('/collections/<brand>/<old slug>/', '/collections/<brand>/<new slug>/', 301, 'product slug
  change', 'trigger')`.

Both use `on conflict (from_path) do nothing`: a pre-existing redirect at that exact path is left
untouched rather than silently overwritten. This is a deliberate trade-off, recorded here rather
than left implicit — the **older** redirect wins, and nothing in this batch alerts a human to the
collision (§6).

**Why these cannot affect any existing row today:** both are `BEFORE UPDATE` triggers, so creating
them changes nothing until a row is actually updated. `brands` is a brand-new, empty table. Every
existing `products` row has `is_published = false` (the column's default, untouched by this
migration), so `record_product_slug_redirect()`'s `old.is_published` guard is false for every one
of them — the trigger exists, but has nothing to fire on until B2.2+ actually publishes a product
with a real `public_slug` and later changes it.

Product public-slug backfill is explicitly **not** part of this migration (per the task brief).

---

## 8. Safe rollback approach

Both copies are purely additive (new tables, new nullable/defaulted columns, new triggers/
functions, new indexes) — nothing here can be "rolled back" in the sense of restoring lost data,
because no existing data is touched. If a rollback is ever needed:

1. **Fresh/dev database:** drop the nine new tables and the two new trigger functions, and run
   `alter table products drop column ...` / `alter table variations drop column ...` for the
   additive columns — safe because nothing else references them yet (no application code in this
   repository reads or writes any of them; the public API surface that would is B2.2+).
2. **An already-deployed database (hypothetically, since none was touched by this batch — see §9):**
   the same drop statements, run manually, since `ensureSchema()` has no "down" migration
   mechanism (consistent with the rest of the repository — there is no down-migration convention
   for `0001`–`0006` either). Because every new column is nullable-or-defaulted and no existing
   column changed, a rollback is a pure subtraction with no data-loss risk beyond the new tables'
   own (empty, in this batch) rows.

---

## 9. Database-executable validation — limitation

No PostgreSQL executable, Docker image, or other SQL engine was installed or is already present on
this machine (checked: no `psql`/`postgres` on `PATH`, no `C:\Program Files\PostgreSQL`). Per the
B2.1 task brief, none was installed or downloaded for this run. **This means neither
`0007_public_site.sql` nor the mirrored statements in `migrate.js` were executed against a real
PostgreSQL instance in this batch** — there is no automated proof the SQL parses and applies
cleanly beyond careful manual review (performed, and re-performed once — see the `"function"`
quoting note in §2.3, added defensively during that review) and the static/semantic tests described
in §10, which read both files as text and assert on their structure. This is a real gap, not
concealed: the strongest available validation given the constraint is static and semantic, not
executable, and that is what was used.

---

## 10. Tests

`platform/server/api/test/public-schema.test.js` (new) — see the file for full detail. Structural/
semantic assertions against both `0007_public_site.sql` and `migrate.js`'s new section, following
the existing repository convention (`module-wiring.test.js` already reads source as text rather
than loading modules that need a live database). Covers: every new table present in both files;
every additive product/variation field present in both files; no existing column dropped or
renamed anywhere in the diff; publication/verification CHECK constraints contain the required
states; `is_published` defaults `false`; new governance-bearing records default
`draft`/`unverified`; redirect and form-delivery CHECK constraints present; `public_slug`/`brand_id`
are nullable (no `not null`); both slug-change triggers exist and are gated on `old.publication_state
= 'published'` / `old.is_published`; unpublished and unchanged-slug cases are excluded by the
trigger conditions themselves (read from source, since there is no live database to exercise them
against); redirect targets are constrained to internal paths; no `DROP COLUMN`, `DROP TABLE`, or
other destructive statement appears anywhere in either file; the existing API test suite is
unaffected.

---

## 11. Production migration mechanism / gap

**Mechanism, if this were ever shipped:** `deploy.sh` ships the `db/` directory to the VPS unchanged
(it does today, for every existing migration) and restarts the `api` container via
`docker compose up -d --build`, which runs `ensureSchema()` — now including this batch's additive
statements — before the API starts serving traffic (fail-closed `startServer()`). No manual `psql`
step is required, consistent with how `0005`/`0006` already reached production.

**Gap, explicit:** this run did not connect to any live database, apply any migration, or contact
the VPS — per the task brief, that remains out of scope for B2.1. The mechanism above is unchanged
from the existing repository convention, not a new one invented for this batch, but its *use*
(actually deploying this schema to the real production database) is deliberately left to B10 or a
separately reviewed migration runbook, exactly as the task brief requires.
