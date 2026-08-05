/* THE public serializer layer (B2.2) — every /public/* response is built by
   one of these functions, never by spreading a database row.

   Hard rules, enforced by construction in every function below:
     - always return a FRESH object literal listing only permitted fields;
     - never `{ ...row }`, never `res.json(row)`, never `row_to_json`/
       `json_agg` of an unrestricted row passed straight through;
     - a jsonb column (best_for, component_origins) is picked apart into a
       validated array of strings, never returned as the raw parsed JSON —
       an attacker-controlled or simply mis-shaped JSON blob in that column
       cannot smuggle an unexpected key into the response;
     - optional scalar fields normalise '' to null so callers get a
       consistent "absent" signal instead of guessing whether empty-string
       means unset;
     - array fields are always arrays (never null), even when empty.

   Every function here is pure: given a row (or rows) shaped like what the
   public router's SELECTs return, it returns plain data with no I/O, no
   caching, no request/response objects — which is what makes it directly
   unit-testable with adversarial fixtures (see
   test/public-serialize.test.js) independent of any database. */

const MAX_STRING_ARRAY_ITEMS = 20;
const MAX_STRING_ARRAY_ITEM_LENGTH = 200;

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Validates a jsonb column that is *supposed* to be a plain array of short
 * strings (`best_for`, `component_origins`). Anything else — an object, a
 * nested array, a non-string element, an over-long string — is dropped
 * rather than passed through, so a malformed or attacker-influenced jsonb
 * value can never smuggle an unexpected shape into the response. */
function pickStringArray(value, max = MAX_STRING_ARRAY_ITEMS) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_STRING_ARRAY_ITEM_LENGTH)
    .slice(0, max);
}

/** A native Postgres text[] column (style_traits, approved_materials,
 * regions_served) is already a flat array of strings by the time `pg`
 * hands it back — same validation as pickStringArray, kept as a separate
 * name so a future caller can't confuse "trusted array column" with
 * "jsonb blob that merely looks like one". */
function pickTextArray(value, max = MAX_STRING_ARRAY_ITEMS) {
  return pickStringArray(value, max);
}

// ---------------------------------------------------------------------------

/** `media` row -> safe public shape. No internal id, no rights/ownership
 * administration fields (rights_holder, rights_expiry, owner_type, owner_id
 * are all deliberately absent — Task 3's "media-rights administration
 * fields" are never public). */
export function serializeMedia(row) {
  if (!row) return null;
  return {
    path: emptyToNull(row.path),
    alt: row.alt ?? '',
    width: typeof row.width === 'number' ? row.width : null,
    height: typeof row.height === 'number' ? row.height : null,
    kind: row.kind === 'video' ? 'video' : 'image',
  };
}

/** `variations` row (+ optional resolved swatch media row) -> safe public
 * shape. No price, no stock, no purchase cost, no Zoho id — a variation
 * row from the database carries all of those, and none of them appear
 * here because this function only ever reads the six fields below. */
export function serializeVariation(row, { swatchMedia = null } = {}) {
  if (!row) return null;
  return {
    sku: emptyToNull(row.sku),
    colorName: emptyToNull(row.color),
    colorCode: emptyToNull(row.color_code),
    swatchMedia: serializeMedia(swatchMedia),
  };
}

/** Lightweight card for listing/related-model contexts. */
export function serializeModelCard(row, { primaryMedia = null } = {}) {
  if (!row) return null;
  return {
    brandSlug: emptyToNull(row.brand_slug),
    brandName: emptyToNull(row.brand_name),
    slug: emptyToNull(row.public_slug),
    sku: emptyToNull(row.sku),
    name: emptyToNull(row.name),
    line: emptyToNull(row.line),
    shape: emptyToNull(row.shape),
    segment: emptyToNull(row.segment),
    size: emptyToNull(row.size),
    // Internal `label:*` tags (e.g. "label:best-seller") are stripped here,
    // not merely relied upon to be absent — this is the one place a
    // category/tag array reaches public output, so it is also where the
    // label:* rule (Task 3/4) is actually enforced, not just assumed.
    categories: Array.isArray(row.categories)
      ? row.categories.filter((c) => typeof c === 'string' && !/^label:/i.test(c.trim()))
      : [],
    isFeatured: row.is_featured === true,
    primaryMedia: serializeMedia(primaryMedia),
  };
}

/** Full model detail: the card fields plus description, published
 * variations, media, a validated lens-type extracted from the `attributes`
 * jsonb bag (never the bag itself — Task 3: "never expose arbitrary JSON
 * blobs without explicit nested-field validation"), and related-model
 * cards. No availability field anywhere, per the B2.2 brief. */
export function serializeModelDetail(row, { variations = [], media = [], relatedModels = [] } = {}) {
  if (!row) return null;
  const card = serializeModelCard(row, { primaryMedia: media[0] ?? null });
  const attributes = row.attributes && typeof row.attributes === 'object' ? row.attributes : {};
  const lensType = typeof attributes.lensType === 'string' ? emptyToNull(attributes.lensType) : null;
  return {
    ...card,
    publicDescription: emptyToNull(row.public_description),
    lensType,
    variations: variations.map((v) => serializeVariation(v.variation ?? v, { swatchMedia: v.swatchMedia })).filter(Boolean),
    media: media.map((m) => serializeMedia(m)).filter(Boolean),
    relatedModels: relatedModels.map((m) => serializeModelCard(m.row ?? m, { primaryMedia: m.primaryMedia ?? null })).filter(Boolean),
    contentUpdatedAt: toIso(row.content_updated_at),
  };
}

/** `brands` row -> safe public summary shape (for /public/brands listing
 * and as an embedded reference elsewhere). */
export function serializeBrandSummary(row, { logoMedia = null } = {}) {
  if (!row) return null;
  return {
    slug: emptyToNull(row.slug),
    name: emptyToNull(row.name),
    shortName: emptyToNull(row.short_name),
    segment: emptyToNull(row.segment),
    headline: emptyToNull(row.headline),
    priceTierLabel: emptyToNull(row.price_tier_label),
    logoMedia: serializeMedia(logoMedia),
  };
}

/** `brands` row -> full public detail shape, plus safe featured-model
 * card summaries. `best_for` / `component_origins` are jsonb columns,
 * picked apart into validated string arrays rather than passed through. */
export function serializeBrandDetail(row, { logoMedia = null, heroMedia = null, featuredModels = [] } = {}) {
  if (!row) return null;
  const summary = serializeBrandSummary(row, { logoMedia });
  return {
    ...summary,
    summary: emptyToNull(row.summary),
    story: emptyToNull(row.story),
    idealRetailer: emptyToNull(row.ideal_retailer),
    bestFor: pickStringArray(row.best_for),
    styleTraits: pickTextArray(row.style_traits),
    designOrigin: emptyToNull(row.design_origin),
    manufacturingOrigin: emptyToNull(row.manufacturing_origin),
    componentOrigins: pickStringArray(row.component_origins),
    approvedMaterials: pickTextArray(row.approved_materials),
    heroMedia: serializeMedia(heroMedia),
    featuredModels: featuredModels.map((m) => serializeModelCard(m.row ?? m, { primaryMedia: m.primaryMedia ?? null })).filter(Boolean),
    contentUpdatedAt: toIso(row.content_updated_at),
  };
}

/** `locations` row -> safe public shape. Deliberately narrow: address,
 * contact and coordinates are NOT included. The B2.1 schema has only one
 * row-level publication signal (publication_state + is_public) and no
 * per-field publication marker, so there is no schema-backed way yet to
 * know an address or contact block was individually reviewed for public
 * display — per the B2.2 brief ("unless explicitly marked public and
 * approved by the schema/publication rules"), the safe default is to omit
 * them until a later batch adds that finer-grained approval. */
export function serializeLocation(row) {
  if (!row) return null;
  return {
    slug: emptyToNull(row.slug),
    name: emptyToNull(row.name),
    function: emptyToNull(row.function),
    regionsServed: pickTextArray(row.regions_served),
    hours: emptyToNull(row.hours),
  };
}

/** One shared shape for every sitemap-data record — the router builds
 * `path` per record type (brand/model/page) from already-validated slugs,
 * this function only shapes the final pair. */
export function serializeSitemapRecord({ path, contentUpdatedAt }) {
  return {
    path: emptyToNull(path),
    contentUpdatedAt: toIso(contentUpdatedAt),
  };
}
