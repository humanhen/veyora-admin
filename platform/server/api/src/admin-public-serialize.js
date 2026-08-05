/* Administrative serializers, PATCH validation and concurrency tokens for
   the public-content admin API (B2.4A).

   Deliberately a separate module from public-serialize.js, because the two
   answer different questions. The public serializer's job is to expose the
   minimum a visitor may see. This one's job is to expose what an
   *editor* needs to do their work — governance state, review dates,
   publication verdicts — while still never returning an unrestricted row.
   Same discipline (fresh object literals, named fields, no row spreading),
   different allowlist. Merging them would inevitably leak governance
   fields onto the public surface or starve the admin UI. */

import { PUBLICATION_STATES, VERIFICATION_STATES, isValidSlug } from './publication-gate.js';

/* ---------------------------------------------------------------------------
   Concurrency tokens
   --------------------------------------------------------------------------- */

/* The repository has no existing optimistic-concurrency convention — the
   closest thing is `select ... for update` row locking inside a
   transaction (routes/admin.js's order PATCH), which prevents concurrent
   writes but does NOT stop a second admin overwriting a value they never
   saw. Every relevant table already carries a trigger-maintained
   `updated_at`, so that is the version source: no schema change, no new
   dependency.

   The token binds the entity type and id as well as the timestamp, so a
   token issued for one record cannot be replayed against another (a
   requirement of the brief). It is not a secret and needs no signature —
   it protects against a lost update, not against a hostile admin, who is
   already authenticated and authorised to write. */
export function makeConcurrencyToken(entityType, id, updatedAt) {
  const stamp = updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt ?? '');
  return `${entityType}:${id}:${stamp}`;
}

/** Returns true when the supplied token matches the record as currently
 * stored. A malformed, absent or mismatched token is a conflict. */
export function tokenMatches(token, entityType, id, updatedAt) {
  if (typeof token !== 'string' || token.length === 0) return false;
  return token === makeConcurrencyToken(entityType, id, updatedAt);
}

/* ---------------------------------------------------------------------------
   Administrative serializers
   --------------------------------------------------------------------------- */

function isoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function textArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

/** Governance block, identical shape across entities that carry one. */
function governanceOf(row) {
  return {
    publicationState: row.publication_state ?? null,
    verificationStatus: row.verification_status ?? null,
    sourceReference: row.source_reference ?? '',
    lastReviewedAt: isoOrNull(row.last_reviewed_at),
    scheduledReviewAt: isoOrNull(row.scheduled_review_at),
    contentUpdatedAt: isoOrNull(row.content_updated_at),
    /* `fact_owner` is a users.id. Exposed as a plain identifier because an
       editor legitimately needs to know who owns a fact — but never joined
       to the users table here, so no name, email or other account detail
       reaches an administrative response through this path. */
    factOwnerId: row.fact_owner ?? null,
  };
}

export function serializeAdminBrand(row, { gate = null, isPublished = undefined } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug ?? null,
    name: row.name ?? null,
    shortName: row.short_name ?? '',
    segment: row.segment ?? '',
    headline: row.headline ?? '',
    summary: row.summary ?? '',
    story: row.story ?? '',
    idealRetailer: row.ideal_retailer ?? '',
    priceTierLabel: row.price_tier_label ?? '',
    designOrigin: row.design_origin ?? '',
    manufacturingOrigin: row.manufacturing_origin ?? '',
    styleTraits: textArray(row.style_traits),
    approvedMaterials: textArray(row.approved_materials),
    logoMediaId: row.logo_media_id ?? null,
    heroMediaId: row.hero_media_id ?? null,
    governance: governanceOf(row),
    isPublished: isPublished === undefined ? row.publication_state === 'published' : isPublished,
    publicationGate: gate,
    concurrencyToken: makeConcurrencyToken('brand', row.id, row.updated_at),
    updatedAt: isoOrNull(row.updated_at),
    createdAt: isoOrNull(row.created_at),
  };
}

export function serializeAdminProduct(row, { gate = null, advisories = [] } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    sku: row.sku ?? null,
    name: row.name ?? null,
    publicSlug: row.public_slug ?? null,
    brandId: row.brand_id ?? null,
    /* The legacy free-text `brand` column, shown read-only so an editor can
       see what the Zoho import recorded while mapping to a real brand_id.
       Never writable through this API. */
    legacyBrandText: row.brand ?? '',
    line: row.line ?? '',
    shape: row.shape ?? '',
    segment: row.segment ?? '',
    size: row.size ?? '',
    publicDescription: row.public_description ?? '',
    categories: textArray(row.categories),
    isPublished: row.is_published === true,
    isFeatured: row.is_featured === true,
    isDiscontinued: row.is_discontinued === true,
    replacementProductId: row.replacement_product_id ?? null,
    /* `is_active` is the PORTAL's ordering flag and is entirely separate
       from public publication (14_B2_SCHEMA_REFERENCE.md §3.1). Shown
       read-only so an editor is not confused by a product that is
       orderable but unpublished, or vice versa. Never writable here. */
    isActiveInPortal: row.is_active === true,
    governance: governanceOf(row),
    publicationGate: gate,
    advisories,
    concurrencyToken: makeConcurrencyToken('product', row.id, row.updated_at),
    updatedAt: isoOrNull(row.updated_at),
    createdAt: isoOrNull(row.created_at),
  };
}

export function serializeAdminVariation(row, { gate = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_id ?? null,
    sku: row.sku ?? null,
    colorName: row.color ?? '',
    colorCode: row.color_code ?? '',
    swatchMediaId: row.swatch_media_id ?? null,
    isPublished: row.is_published === true,
    isActiveInPortal: row.is_active === true,
    publicationGate: gate,
    /* `variations` has no `updated_at` column in the base schema, so its
       concurrency token is derived from `created_at` plus the fields this
       API can change. See CONCURRENCY note in
       18_B2_ADMIN_PUBLICATION_API.md — this is a real limitation, recorded
       rather than papered over. */
    concurrencyToken: makeConcurrencyToken(
      'variation',
      row.id,
      `${isoOrNull(row.created_at) ?? ''}|${row.color ?? ''}|${row.color_code ?? ''}|${row.swatch_media_id ?? ''}|${row.is_published === true}`
    ),
    createdAt: isoOrNull(row.created_at),
  };
}

/* ---------------------------------------------------------------------------
   PATCH validation — explicit allowlists per entity
   --------------------------------------------------------------------------- */

const MAX_SHORT = 200;
const MAX_LONG = 20_000;
const MAX_ARRAY_ITEMS = 40;

/* Fields an administrator may edit through this API, and how each is
   validated. Anything not listed is rejected with 400 — never silently
   dropped, so an admin UI sending a field this API does not understand
   finds out immediately instead of believing a save succeeded. */
const BRAND_FIELDS = {
  slug: { kind: 'slug' },
  name: { kind: 'text', max: MAX_SHORT },
  short_name: { kind: 'text', max: MAX_SHORT },
  segment: { kind: 'text', max: MAX_SHORT },
  headline: { kind: 'text', max: MAX_SHORT },
  summary: { kind: 'text', max: MAX_LONG },
  story: { kind: 'text', max: MAX_LONG },
  ideal_retailer: { kind: 'text', max: MAX_SHORT },
  price_tier_label: { kind: 'text', max: MAX_SHORT },
  design_origin: { kind: 'text', max: MAX_SHORT },
  manufacturing_origin: { kind: 'text', max: MAX_SHORT },
  style_traits: { kind: 'textArray' },
  approved_materials: { kind: 'textArray' },
  logo_media_id: { kind: 'idOrNull' },
  hero_media_id: { kind: 'idOrNull' },
  publication_state: { kind: 'enum', values: PUBLICATION_STATES },
  verification_status: { kind: 'enum', values: VERIFICATION_STATES },
  source_reference: { kind: 'text', max: MAX_LONG },
  last_reviewed_at: { kind: 'dateOrNull' },
  scheduled_review_at: { kind: 'dateOrNull' },
};

const PRODUCT_FIELDS = {
  public_slug: { kind: 'slug' },
  name: { kind: 'text', max: MAX_SHORT },
  brand_id: { kind: 'idOrNull' },
  line: { kind: 'text', max: MAX_SHORT },
  shape: { kind: 'text', max: MAX_SHORT },
  segment: { kind: 'text', max: MAX_SHORT },
  public_description: { kind: 'text', max: MAX_LONG },
  is_featured: { kind: 'boolean' },
  is_discontinued: { kind: 'boolean' },
  replacement_product_id: { kind: 'idOrNull' },
  publication_state: { kind: 'enum', values: PUBLICATION_STATES },
  verification_status: { kind: 'enum', values: VERIFICATION_STATES },
  source_reference: { kind: 'text', max: MAX_LONG },
  last_reviewed_at: { kind: 'dateOrNull' },
  scheduled_review_at: { kind: 'dateOrNull' },
};

const VARIATION_FIELDS = {
  color: { kind: 'text', max: MAX_SHORT },
  color_code: { kind: 'text', max: 40 },
  swatch_media_id: { kind: 'idOrNull' },
};

export const EDITABLE_FIELDS = {
  brand: Object.keys(BRAND_FIELDS),
  product: Object.keys(PRODUCT_FIELDS),
  variation: Object.keys(VARIATION_FIELDS),
};

/* Explicitly rejected with a distinct message rather than a generic
   "unknown field", because an admin UI sending one of these has a real bug
   worth naming. `is_published` is here deliberately: publication is a
   transactional, gated operation with its own endpoint — allowing it as a
   PATCH field would let a caller bypass the gate, which is the single most
   important invariant this batch protects. */
const IMMUTABLE_FIELDS = new Set([
  'id',
  'created_at',
  'updated_at',
  'content_updated_at',
  'is_published',
  'fact_owner',
  'approver_id',
  'approved_at',
  'is_active',
  'sku',
  'brand',
  'price',
  'sale_price',
  'purchase_price',
  'zoho_item_id',
  'product_id',
]);

const ID_PATTERN = /^[a-z]+_[a-z0-9]+$/i;

function validateField(name, spec, value, errors) {
  switch (spec.kind) {
    case 'slug': {
      if (typeof value !== 'string') {
        errors.push({ field: name, code: 'INVALID_TYPE', message: 'Must be a string.' });
        return undefined;
      }
      const trimmed = value.trim();
      // An empty slug is allowed while drafting — a record cannot publish
      // without one, but forcing it before the name is decided would make
      // draft editing impossible.
      if (trimmed === '') return '';
      if (!isValidSlug(trimmed)) {
        errors.push({
          field: name,
          code: 'INVALID_SLUG',
          message: 'Use lowercase letters, numbers and single hyphens only.',
        });
        return undefined;
      }
      return trimmed;
    }
    case 'text': {
      if (typeof value !== 'string') {
        errors.push({ field: name, code: 'INVALID_TYPE', message: 'Must be a string.' });
        return undefined;
      }
      if (value.length > spec.max) {
        errors.push({ field: name, code: 'TOO_LONG', message: `Must be ${spec.max} characters or fewer.` });
        return undefined;
      }
      return value;
    }
    case 'textArray': {
      if (!Array.isArray(value)) {
        errors.push({ field: name, code: 'INVALID_TYPE', message: 'Must be an array of strings.' });
        return undefined;
      }
      if (value.length > MAX_ARRAY_ITEMS) {
        errors.push({ field: name, code: 'TOO_MANY_ITEMS', message: `At most ${MAX_ARRAY_ITEMS} items.` });
        return undefined;
      }
      if (!value.every((v) => typeof v === 'string' && v.length <= MAX_SHORT)) {
        errors.push({ field: name, code: 'INVALID_ITEM', message: 'Every item must be a short string.' });
        return undefined;
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push({ field: name, code: 'INVALID_TYPE', message: 'Must be true or false.' });
        return undefined;
      }
      return value;
    }
    case 'enum': {
      if (!spec.values.includes(value)) {
        errors.push({
          field: name,
          code: 'INVALID_VALUE',
          message: `Must be one of: ${spec.values.join(', ')}.`,
        });
        return undefined;
      }
      return value;
    }
    case 'idOrNull': {
      if (value === null) return null;
      if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
        errors.push({ field: name, code: 'INVALID_ID', message: 'Must be a record identifier or null.' });
        return undefined;
      }
      return value;
    }
    case 'dateOrNull': {
      if (value === null) return null;
      if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
        errors.push({ field: name, code: 'INVALID_DATE', message: 'Must be an ISO date string or null.' });
        return undefined;
      }
      return new Date(value).toISOString();
    }
    default:
      errors.push({ field: name, code: 'UNSUPPORTED', message: 'Unsupported field type.' });
      return undefined;
  }
}

const SPECS = { brand: BRAND_FIELDS, product: PRODUCT_FIELDS, variation: VARIATION_FIELDS };

/**
 * Validates a PATCH body against one entity's allowlist.
 *
 * Returns `{ ok: true, fields }` where `fields` maps DATABASE COLUMN NAMES
 * to validated values — the column names come from this module's own
 * constant specs, never from request input, which is what lets the router
 * build `set` clauses without interpolating anything a caller supplied.
 *
 * Partial bodies are fine: this supports draft editing, so a body with one
 * field is valid even when the record is nowhere near publishable.
 */
export function validateAdminPatch(entityType, body) {
  const spec = SPECS[entityType];
  if (!spec) return { ok: false, errors: [{ field: null, code: 'UNKNOWN_ENTITY', message: 'Unknown entity type.' }] };

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [{ field: null, code: 'INVALID_BODY', message: 'Body must be an object.' }] };
  }

  const errors = [];
  const fields = {};

  for (const [key, value] of Object.entries(body)) {
    // The concurrency token travels in the body but is not a data field.
    if (key === 'concurrencyToken') continue;

    if (IMMUTABLE_FIELDS.has(key)) {
      errors.push({
        field: key,
        code: 'IMMUTABLE_FIELD',
        message:
          key === 'is_published'
            ? 'Publication is a separate, gated operation — use the publish endpoint.'
            : 'This field cannot be changed through this API.',
      });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(spec, key)) {
      errors.push({ field: key, code: 'UNKNOWN_FIELD', message: 'This field is not editable here.' });
      continue;
    }
    const validated = validateField(key, spec[key], value, errors);
    if (validated !== undefined) fields[key] = validated;
  }

  if (errors.length) {
    // Deterministic order so a test (and an admin UI) sees stable output.
    errors.sort((a, b) => String(a.field).localeCompare(String(b.field)) || a.code.localeCompare(b.code));
    return { ok: false, errors };
  }
  if (Object.keys(fields).length === 0) {
    return { ok: false, errors: [{ field: null, code: 'EMPTY_PATCH', message: 'No editable fields were supplied.' }] };
  }
  return { ok: true, fields };
}

/**
 * Builds a parameterised UPDATE fragment from already-validated fields.
 *
 * Column names come only from `Object.keys(fields)`, which
 * validateAdminPatch() populated from its own constant specs — a caller
 * cannot introduce a column name, so there is no field-name interpolation
 * from user input anywhere in this path.
 */
export function buildUpdateSql(fields, { startIndex = 2 } = {}) {
  const sets = [];
  const values = [];
  let param = startIndex;
  for (const [column, value] of Object.entries(fields)) {
    sets.push(`${column} = $${param}`);
    values.push(value);
    param += 1;
  }
  return { sets, values, nextParam: param };
}
