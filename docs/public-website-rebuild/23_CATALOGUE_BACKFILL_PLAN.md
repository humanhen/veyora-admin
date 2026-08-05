# 23 — B2.4C1 Catalogue Readiness Audit and Dry-Run Backfill Planner

A deterministic, read-only tool that reads an exported catalogue fixture and answers one question per
model: **what would have to be true before a human could sensibly start editorial work on this?**

**No real catalogue data was processed during this batch.** Every run was over synthetic fixtures.
No database was contacted, no record was created, updated, deleted or published, no permission was
granted, and no bootstrap SQL was executed.

---

## 1. Purpose and the non-mutation boundary

B2.4A–B2.4B2B built the governed way to edit and publish public content. What none of them
established is *how much of the existing 1,300-model catalogue is anywhere near ready*, or what a
backfill would actually involve. Guessing that from a spreadsheet is how a backfill goes wrong.

This tool produces the evidence. It is deliberately the weakest thing that could answer the question:

| It does | It never does |
|---|---|
| Read a local JSON export | Connect to a database |
| Classify readiness | Create, update or delete anything |
| Propose mechanical field changes | Apply a change |
| Report what a human must supply | Invent what a human must supply |
| Emit JSON and CSV reports | Emit SQL |

**Structural guarantees, asserted by test:** no module under `src/catalogue-audit/` imports `pg` or
`../db.js`, reads `process.env`, or performs network access. The CLI accepts no URL. No report
contains an SQL keyword. Nothing proposes `is_published` or `publication_state`.

The tool is `platform/server/api/src/catalogue-audit/` with a CLI at
`platform/server/api/scripts/audit-public-catalogue.js`.

---

## 2. The catalogue model it plans against

Recorded from the schema, because the planner's correctness depends on it.

| Concept | Where it lives | Status |
|---|---|---|
| Model identity | `products.id`, `products.sku` (unique) | **Authoritative** — never proposed |
| Display name | `products.name` | Authoritative; the slug is derived from it |
| Legacy brand | `products.brand` (free text, from the Zoho/old-site import) | Authoritative input to mapping |
| Public brand link | `products.brand_id` → `brands(id)` (B2.1) | **Derived** — proposed when it matches exactly |
| Public URL | `products.public_slug` (unique index) | **Derived** — proposed, existing valid slugs preserved |
| Public copy | `products.public_description` | **Human only** — never proposed |
| Colourways | `variations` (`color` free text, `color_code`, `swatch_media_id`) | `color_code` normalisation is derived |
| Images | `media` where `owner_type='product'` | Counted; never invented |
| Portal ordering flag | `products.is_active` | Authoritative; inactive models are excluded |
| Publication | `products.is_published` + `publication_state`; for **brands**, `publication_state` alone | **Never proposed under any circumstances** |
| Governance | `source_reference`, `verification_status`, `last_reviewed_at`, `fact_owner` | **Human only** |

Brands have no `is_published` column — `publication_state = 'published'` is their live flag (see
[18_B2_ADMIN_PUBLICATION_API.md](18_B2_ADMIN_PUBLICATION_API.md) §14–15). That is precisely why the
planner treats both fields as untouchable.

---

## 3. Safe input contract

A closed allowlist, in both directions. Top level: `exportedAt`, `source`, `brands`, `products`,
`variations`, `media`.

**Unknown fields are REJECTED, not ignored.** An export carrying data it should not is a mistake at
the point it was produced; silently dropping the extra fields would let that mistake travel, and a
later export from a slightly different pipeline could start leaking. Refusing the file surfaces the
problem where it can still be fixed.

| Collection | Admitted fields |
|---|---|
| `brands` | `id`, `slug`, `name`, `publicationState`, `verificationStatus`, `hasSourceReference` |
| `products` | `id`, `sku`, `name`, `brand`, `brandId`, `categories`, `line`, `shape`, `segment`, `publicSlug`, `hasPublicDescription`, `isActive`, `isPublished`, `isFeatured`, `isDiscontinued`, `replacementProductId`, `publicationState`, `verificationStatus`, `hasSourceReference`, `lastReviewedAt`, `scheduledReviewAt`, `contentUpdatedAt` |
| `variations` | `id`, `productId`, `sku`, `colorName`, `colorCode`, `isActive`, `isPublished`, `hasSwatchMedia` |
| `media` | `id`, `ownerType`, `ownerId`, `kind` |

### Excluded, by name and with a reason

`price`, `salePrice`, `purchasePrice`, `cost`, `margin`, `stock`, `stockStatus`, `qty`, `quantity`,
`warehouse`, `zohoItemId`, `factOwner`, `rightsHolder`, `rightsExpiry`, `tags`, `images`, `ean`,
plus every key on the public boundary's existing forbidden list (customer identity, order records,
credentials). Rejection reuses `src/public-forbidden-keys.js` — the repository's single authority on
what "forbidden" means — rather than a second, divergent list.

**Two exclusions deserve their reasoning stated:**

- **`attributes` (jsonb)** is excluded wholesale, not filtered. It is unrestricted by construction —
  nothing stops a future import putting anything in it — so no allowlist over its contents could be
  trusted.
- **Description and source text** are excluded in favour of `hasPublicDescription` and
  `hasSourceReference` booleans. The planner never proposes copy, so it only ever needs to know
  whether approved copy exists. Carrying the text would put editorial content into review CSVs for
  no benefit.

---

## 4. Normalisation and slug rules

Every helper is pure and deterministic: no clock, no randomness, no locale-dependent behaviour, no
I/O. Two runs over the same file produce byte-identical output — verified, not asserted.

- **Unicode** is normalised to NFC on input, so composed and decomposed spellings of the same string
  compare equal. Slug generation decomposes to NFKD and strips combining marks so accents fold to
  their ASCII base letters.
- **Case folding is ASCII-only**, done by explicit code-point arithmetic rather than
  `toLowerCase()`, which is locale-sensitive for a handful of characters.
- **Ordering is byte-wise**, never `localeCompare` — that is ICU-version dependent and could order
  two runs differently on two machines.

### Slug rules

Lowercase ASCII, digits and single hyphens (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤120 chars) — the same
rule the publication gate enforces, so the planner can never propose a slug the gate would reject.
A test asserts the two agree.

- Unsafe punctuation is removed; `&` becomes `and`; elisions join (`Men's` → `mens`).
- Repeated separators collapse; leading and trailing hyphens are trimmed.
- **An empty result is rejected.** There is no fallback to an internal id: a slug like `p-a1b2c3` is
  a public URL that tells a visitor nothing and pins an internal identifier into the site's address
  space permanently. A record that cannot produce a meaningful slug is a review item.
- **Reserved public route names are rejected** — `brands`, `collections`, `contact`, `sitemap`,
  `terms`, `admin`, `api`, `s3` and the rest of the Astro route tree. A collision would shadow a
  real page.
- **An existing valid, unique slug is preserved unchanged.** Approved public URLs are never churned.
- **Duplicates get a deterministic numeric suffix** (`aviator-2`), and any suffixed proposal is
  marked `review_required`: the suffix is mechanical, but *which* model deserves the bare slug is an
  editorial call.

---

## 5. Brand mapping

The catalogue's free-text `brand` column is grouped by comparison key and classified:

| Classification | Meaning | Auto-applicable |
|---|---|---|
| `EXACT_MATCH` | Identical to an existing brand name after cleaning | Yes |
| `NORMALISED_MATCH` | Differs only by case, accents or punctuation | Yes, and flagged so the inconsistency is visible |
| `PROPOSED_NEW_BRAND` | No existing brand matches | **No** — a human must create the brand |
| `AMBIGUOUS` | Two existing brands normalise to the same key | **No** — a human must choose |
| `MISSING` | No brand value at all | **No** |
| `UNUSABLE` | No usable slug can be derived from the value | **No** |

**There is no fuzzy matching.** No edit distance, no token overlap, no "closest match wins" — a test
asserts the module contains no such machinery. Two brand names differing by one character stay two
review items. On a public site, a mis-attached model means the wrong logo on a product page, which
nobody notices; a failed lookup is noticed immediately.

Spelling variants of one value are collected with their counts, so a reviewer can see that the
import contains `Kyme`, `KYME` and `kyme` and decide once.

**Essedue, Kyme and Extreme Next are not treated specially and are not assumed publishable.** They
appear in the report only if the source export contains them, classified by the same rules.

---

## 6. Readiness classification

Exactly one top-level outcome per model, plus **all** secondary reason codes.

Priority (first match wins): `INACTIVE_OR_EXCLUDED` → `DUPLICATE_OR_COLLISION` →
`MANUAL_REVIEW_REQUIRED` → `NEEDS_BRAND_MAPPING` → `NEEDS_SLUG_REVIEW` → `NEEDS_VARIATION_REVIEW` →
`NEEDS_MEDIA` → `NEEDS_DESCRIPTION` → `NEEDS_GOVERNANCE` → `READY_FOR_EDITORIAL_REVIEW`.

Integrity problems outrank missing content because a collision or a broken reference has to be
resolved before editorial work is worth doing. An excluded record outranks everything because no work
is wanted on it at all.

### What "ready" means, and what it does not

**`READY_FOR_EDITORIAL_REVIEW` means only that the deterministic structural prerequisites are
present.** It is not a publication verdict and confers nothing.

Publication needs approved copy, a verified source reference, a review date and an approval decision
— judgements a planner cannot make. The publication gate remains the sole authority, it runs
server-side against stored data at the moment of publication, and nothing here can grant, imply or
shortcut it. **No record is ever classified as publishable, and `publicationsProposed` is `0` in
every report.**

---

## 7. Collision and integrity detection

Duplicate model SKU · duplicate colourway SKU · duplicate existing public slug · duplicate *proposed*
slug · proposed slug colliding with a brand slug · brand slug collision · self-replacement · missing
replacement target · orphaned colourway · duplicate colour within a model · missing colour name ·
malformed colour code · inactive-but-published · published flag inconsistent with governance state ·
discontinued without a coherent replacement.

Each finding carries a stable code, the affected record ids and the field. **Nothing is silently
repaired.** The duplicate-proposed-slug check exists even though proposals are collision-free by
construction — it asserts that invariant rather than assuming it, so a future change to the planner
cannot quietly start emitting duplicates.

---

## 8. Dry-run plan format

Each proposed change carries: `recordType`, `recordId`, `field`, `currentValue`, `proposedValue`,
`reasonCode`, `confidence` (`deterministic` | `review_required`), `dependsOn`, `requiresHumanApproval`
and a `note`.

**Permitted proposals:** `brand_id` (exact/normalised matches only), `public_slug`, whitespace
normalisation of `line`/`shape`/`segment`, and `color_code` normalisation.

**Forbidden proposals — enforced in code, not by convention.** `plan.js` throws if any code path
tries to propose one:

`is_published` · `publication_state` · `verification_status` · `source_reference` ·
`last_reviewed_at` · `scheduled_review_at` · `public_description` · `fact_owner` · `approver_id` ·
`approved_at` · `replacement_product_id` · `price` · `sale_price`.

A planner that could propose these would be manufacturing exactly the editorial and governance
judgements the whole B2.4 sequence exists to keep in human hands. They appear in the plan only as
**missing** — named so a reviewer knows what to supply, and never filled in.

A proposed new brand carries **name and slug only**; every editorial field is listed under
`fieldsRequiringHumanInput` so nobody mistakes it for optional. Excluded (inactive) models generate
no proposals at all — work on a model nobody intends to publish is noise that hides the real work.

---

## 9. Outputs

Written into an explicitly named directory:

| File | Contents |
|---|---|
| `summary.json` | Counts, and the guarantees the run makes |
| `audit-detail.json` | The complete machine-readable audit |
| `product-readiness.csv` | One row per model, outcome and reason codes |
| `proposed-changes.csv` | Every proposed field change |
| `brand-mapping-review.csv` | Free-text brand values and their classification |
| `integrity-findings.csv` | Duplicates, collisions and broken references |

### CSV safety

CSV is a hostile format and is treated as one. Commas, quotes and line breaks are quoted and escaped
per RFC 4180 (CRLF line endings). A leading `=`, `+`, `-`, `@`, tab or carriage return is
**neutralised with a leading apostrophe**, because a spreadsheet will otherwise interpret the cell as
a formula — a catalogue value like `=cmd|'/c calc'!A1` is remote code execution the moment a reviewer
opens the report in Excel. Neutralisation happens *before* quoting, so the guard character is inside
the quoted field where a parser returns it as data.

**Nothing is written into a tracked source directory by default** — the output directory is required,
never defaulted. **Existing files are not overwritten** without `--overwrite`, and every target is
checked before any file is written: a half-written report set is worse than none, because a reviewer
cannot tell which files are current. This protects annotations made against yesterday's report.

---

## 10. CLI

```
node scripts/audit-public-catalogue.js --input <export.json> --output <directory> [--overwrite] [--quiet]
node scripts/audit-public-catalogue.js --help
```

Local `.json` files only — **a URL is rejected**, because fetching would let the tool reach a
production export or an attacker-controlled host. No database connection, no environment-derived
configuration, no stdin execution. `path.resolve` normalises Windows separators and drive letters, so
the same command works from Git Bash and PowerShell.

Dry-run terminology throughout; the output opens with *"DRY RUN. Nothing was created, updated,
deleted or published"* and closes with *"Nothing has been applied."*

Exit codes: `0` completed · `1` invalid arguments, unreadable input, or refusing to overwrite ·
`2` the export failed the input contract.

---

## 11. Deterministic guarantees

- Same input → **byte-identical** output, verified by running the same fixture twice and diffing.
- Input order is irrelevant: records are processed in a fixed order (`sku`, then `id`), so which
  model wins a contested slug is stable.
- Summary object keys are sorted, so JSON serialisation cannot vary by insertion order.
- Every outcome and brand classification appears in the summary **including zeros**, so a count never
  silently disappears between runs.

---

## 12. Tests

`platform/server/api/test/catalogue-audit.test.js` — **78 tests**, covering input safety (unknown,
forbidden and malformed fields; URL rejection; no database import), normalisation and slug rules,
brand-mapping classification, readiness outcomes, integrity detection, plan safety (no publication
proposal, no fabrication, no SQL), and output (CSV escaping and formula neutralisation, overwrite
refusal, stable ordering, CLI behaviour).

**Full API suite: 923 passing, 0 failing** (845 baseline + 78). All fixtures are synthetic.

---

## 13. Review workflow — B2.4C2

The reports are the input to a human review, not a decision:

1. **`brand-mapping-review.csv` first.** Resolve every `AMBIGUOUS`, `MISSING` and `UNUSABLE` value,
   and decide which `PROPOSED_NEW_BRAND` entries are real brands. Brand decisions gate everything
   else, because a model cannot be published without a published brand.
2. **`integrity-findings.csv` next.** Duplicate SKUs, self-replacements and broken references are
   data problems that no amount of editorial work fixes.
3. **`product-readiness.csv`** to size the work: how many models are structurally ready, and what the
   long tail actually needs.
4. **`proposed-changes.csv`** line by line. Everything marked `review_required` needs a decision;
   everything marked `deterministic` still needs sign-off before anything is applied.
5. **The missing list** names what a human must author: descriptions, source references, review
   dates, verification, media.

Nothing in this batch applies any of it.

---

## 14. Controlled mutation requirements — B2.4C3

When an approved plan is eventually applied, it must go **through the governed administrative API**,
not through direct SQL:

- Every field change through `PATCH /admin/public-content/…`, which enforces the editable-field
  allowlist, the concurrency token and the publication boundary guard.
- Under `public_content.edit`, held by a specific account — which means the **bootstrap in
  [19_ACCOUNT_PERMISSION_SYSTEM.md](19_ACCOUNT_PERMISSION_SYSTEM.md) §8 must happen first**.
- Publication, if any, only through the publish endpoint under `public_content.publish`, one record
  at a time, with the gate and the approval record.
- Idempotent and resumable, because a 1,300-model run will be interrupted.
- Against a plan file whose hash matches what was reviewed — applying a plan nobody approved is the
  failure mode worth designing against.

**Applying a plan by direct `UPDATE` would bypass the boundary guard, the gate, the capability check
and the approval record simultaneously.** That is the single most important constraint on B2.4C3.

---

## 15. Limitations

- **The input is an export, not the live database.** The audit is only as current as the file, and
  producing that export safely is itself unbuilt work (B2.4C2). No exporter ships in this batch.
- **`hasPublicDescription` is a boolean**, so the planner cannot tell approved copy from a single
  placeholder character. A description that exists but is inadequate reads as present.
- **Media is counted, not assessed.** The schema has no "approved" flag on media, so any owned row
  counts — matching the publication gate's own rule, and inheriting its weakness.
- **Brand publication state is not evaluated.** Whether a brand will be published is a decision that
  has not been taken, so models are not classified against it.
- **No category, line, shape or segment vocabulary is enforced** beyond whitespace normalisation.
  Deciding that `Pilot` and `Aviator` are the same shape is an editorial judgement.
- **Slug de-duplication caps at 50 variants** per base, which is far beyond anything expected but
  fails loudly rather than looping.
- **No exporter, no applier, no UI.** This batch is the audit only.

---

## 16. No real catalogue data was processed

Every run during B2.4C1 used synthetic fixtures written for the tests, containing invented models,
brands and colourways. **The tool has never been pointed at a production export, and cannot be
pointed at a database at all.** No database was contacted, no permission was granted, no bootstrap
SQL was executed, and nothing was published.
