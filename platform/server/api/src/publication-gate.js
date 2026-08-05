/* THE publication gate (B2.4A) — the single authority on whether a brand,
   product or variation may become publicly visible.

   Pure functions: they take already-loaded rows and return a structured
   verdict. No database access, no SQL, no request/response objects — which
   is what makes every rule directly unit-testable, and what stops the gate
   from being quietly re-implemented per call site.

   Why a gate at all: B2.1 gave `products.is_published` a database CHECK
   requiring `publication_state = 'published'`, but a database constraint
   can only see one row's columns. It cannot know whether a product's brand
   is published, whether a replacement reference is coherent, or whether
   any variation is publishable. Those are cross-row invariants, and this
   is where they live (14_B2_SCHEMA_REFERENCE.md §6 recorded them as
   deferred application-level rules — this closes that gap).

   Reason codes are stable strings, not sentences: an admin UI (B2.4B+) may
   want to map them to its own copy, and a test asserting on prose would
   break on a wording change. Messages are separate and human-facing.
   Nothing here returns SQL, a column name from an error, or any
   infrastructure detail. */

/** Publication states from the B2.1 schema, in lifecycle order. */
export const PUBLICATION_STATES = ['draft', 'verified', 'approved', 'published', 'retired'];
export const VERIFICATION_STATES = ['unverified', 'sourced', 'verified'];

/* A slug that is safe in a public URL path segment: lowercase alphanumeric
   words separated by single hyphens. Deliberately strict — it is easier to
   loosen later than to un-publish a URL that has already been indexed. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 120 && SLUG_PATTERN.test(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPresentDate(value) {
  if (!value) return false;
  const d = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(d.getTime());
}

/** One failure. `field` is the record field at fault (a path like
 * `variations[0].color` where useful), never a database column expression. */
function reason(code, message, field) {
  return { code, message, field };
}

/** Verdicts are returned with reasons sorted by code, so two evaluations of
 * the same record always produce byte-identical output — the "deterministic
 * order" the brief requires, and what lets a test assert on the whole array
 * rather than on set membership. */
function verdict(reasons) {
  const sorted = [...reasons].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return { allowed: sorted.length === 0, reasons: sorted };
}

/* ---------------------------------------------------------------------------
   Shared governance requirements — identical across all three entity types,
   so a rule change happens once.
   --------------------------------------------------------------------------- */
function governanceReasons(record, prefix) {
  const out = [];
  if (record.publication_state === 'retired') {
    out.push(reason(`${prefix}_RETIRED`, 'A retired record cannot be published.', 'publication_state'));
  }
  if (record.publication_state !== 'published') {
    out.push(
      reason(
        `${prefix}_STATE_NOT_PUBLISHED`,
        `Publication state must be "published" (currently "${record.publication_state ?? 'unset'}").`,
        'publication_state'
      )
    );
  }
  if (record.verification_status !== 'verified') {
    out.push(
      reason(
        `${prefix}_NOT_VERIFIED`,
        `Verification status must be "verified" (currently "${record.verification_status ?? 'unset'}").`,
        'verification_status'
      )
    );
  }
  if (!isNonEmptyString(record.source_reference)) {
    out.push(reason(`${prefix}_NO_SOURCE_REFERENCE`, 'A source reference is required before publishing.', 'source_reference'));
  }
  if (!isPresentDate(record.last_reviewed_at)) {
    out.push(reason(`${prefix}_NOT_REVIEWED`, 'A last-reviewed date is required before publishing.', 'last_reviewed_at'));
  }
  if (!isPresentDate(record.content_updated_at)) {
    out.push(reason(`${prefix}_NO_CONTENT_DATE`, 'A content-updated date is required before publishing.', 'content_updated_at'));
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Brand
   --------------------------------------------------------------------------- */

/**
 * @param brand a `brands` row.
 * @param slugIsUnique caller-supplied result of the uniqueness query. The
 *   gate cannot check uniqueness itself (that needs the database), so the
 *   caller must pass it; `undefined` means "not checked", which fails
 *   closed rather than silently assuming uniqueness.
 */
export function evaluateBrandPublication(brand, { slugIsUnique } = {}) {
  if (!brand) {
    return verdict([reason('BRAND_NOT_FOUND', 'The brand record could not be loaded.', null)]);
  }
  const reasons = governanceReasons(brand, 'BRAND');

  if (!isNonEmptyString(brand.name)) {
    reasons.push(reason('BRAND_NO_NAME', 'An approved brand name is required.', 'name'));
  }
  if (!isValidSlug(brand.slug)) {
    reasons.push(
      reason('BRAND_INVALID_SLUG', 'A valid URL slug is required (lowercase letters, numbers and single hyphens).', 'slug')
    );
  }
  if (slugIsUnique === false) {
    reasons.push(reason('BRAND_SLUG_NOT_UNIQUE', 'Another brand already uses this slug.', 'slug'));
  } else if (slugIsUnique === undefined) {
    reasons.push(reason('BRAND_SLUG_UNIQUENESS_UNKNOWN', 'Slug uniqueness could not be confirmed.', 'slug'));
  }

  /* A brand's public description may come from either `summary` or
     `headline` — the B2.1 schema carries both and the public brand page
     renders whichever exists. Requiring a specific one would block a brand
     whose approved copy happens to live in the other field. Requiring at
     least one is the documented rule; a brand with neither would publish a
     page with nothing but a name. */
  if (!isNonEmptyString(brand.summary) && !isNonEmptyString(brand.headline)) {
    reasons.push(
      reason('BRAND_NO_PUBLIC_DESCRIPTION', 'An approved summary or headline is required before publishing.', 'summary')
    );
  }

  return verdict(reasons);
}

/* ---------------------------------------------------------------------------
   Product
   --------------------------------------------------------------------------- */

/**
 * @param product a `products` row.
 * @param context.brand the product's `brands` row (null when unlinked).
 * @param context.publishableVariationCount how many of its variations pass
 *   the variation gate. Counted by the caller, which has the rows.
 * @param context.mediaCount approved public media items for this product.
 * @param context.replacement the replacement product row when
 *   `replacement_product_id` is set; null when the id points at nothing.
 * @param context.slugIsUnique as for brands.
 */
export function evaluateProductPublication(product, context = {}) {
  if (!product) {
    return verdict([reason('PRODUCT_NOT_FOUND', 'The product record could not be loaded.', null)]);
  }
  const { brand, publishableVariationCount, mediaCount, replacement, slugIsUnique } = context;
  const reasons = governanceReasons(product, 'PRODUCT');

  if (!isNonEmptyString(product.name)) {
    reasons.push(reason('PRODUCT_NO_NAME', 'An approved public name is required.', 'name'));
  }
  if (!isValidSlug(product.public_slug)) {
    reasons.push(
      reason('PRODUCT_INVALID_SLUG', 'A valid public slug is required (lowercase letters, numbers and single hyphens).', 'public_slug')
    );
  }
  if (slugIsUnique === false) {
    reasons.push(reason('PRODUCT_SLUG_NOT_UNIQUE', 'Another product already uses this public slug.', 'public_slug'));
  } else if (slugIsUnique === undefined) {
    reasons.push(reason('PRODUCT_SLUG_UNIQUENESS_UNKNOWN', 'Public slug uniqueness could not be confirmed.', 'public_slug'));
  }

  /* The display SKU is the existing `sku` column, which is `not null unique`
     in the base schema — so it is effectively always present. It is checked
     anyway because "effectively always" is an assumption about data this
     gate is not entitled to make. */
  if (!isNonEmptyString(product.sku)) {
    reasons.push(reason('PRODUCT_NO_DISPLAY_SKU', 'A public display SKU is required.', 'sku'));
  }
  if (!isNonEmptyString(product.public_description)) {
    reasons.push(
      reason('PRODUCT_NO_PUBLIC_DESCRIPTION', 'An approved public description is required before publishing.', 'public_description')
    );
  }

  // ---- brand relation ----
  if (!product.brand_id) {
    reasons.push(reason('PRODUCT_NO_BRAND', 'The product must be linked to a brand before publishing.', 'brand_id'));
  } else if (!brand) {
    reasons.push(reason('PRODUCT_BRAND_MISSING', 'The linked brand record could not be loaded.', 'brand_id'));
  } else if (brand.publication_state !== 'published') {
    reasons.push(
      reason('PRODUCT_BRAND_NOT_PUBLISHED', 'The linked brand must be published first.', 'brand_id')
    );
  }

  // ---- replacement coherence ----
  if (product.replacement_product_id) {
    if (product.replacement_product_id === product.id) {
      reasons.push(
        reason('PRODUCT_REPLACEMENT_SELF', 'A product cannot list itself as its own replacement.', 'replacement_product_id')
      );
    } else if (!replacement) {
      reasons.push(
        reason('PRODUCT_REPLACEMENT_MISSING', 'The replacement product could not be found.', 'replacement_product_id')
      );
    } else if (!replacement.is_published) {
      /* A discontinued frame pointing at an unpublished replacement would
         render a dead link on a public page. */
      reasons.push(
        reason('PRODUCT_REPLACEMENT_NOT_PUBLISHED', 'The replacement product must itself be published.', 'replacement_product_id')
      );
    }
  } else if (product.is_discontinued) {
    /* Not fatal: a discontinued model with no successor is a real
       situation. Recorded as a distinct code so an admin UI can warn
       without blocking — see PRODUCT_DISCONTINUED_NO_REPLACEMENT in the
       advisory list below rather than here. */
  }

  // ---- variations ----
  /* `is_non_variant` does not exist as a column in the B2.1 schema, so a
     product is treated as requiring at least one publishable variation
     unless the caller explicitly declares otherwise. See the
     DEFERRED_GATES note at the bottom of this file. */
  if (context.isNonVariant !== true) {
    if (publishableVariationCount === undefined) {
      reasons.push(
        reason('PRODUCT_VARIATION_COUNT_UNKNOWN', 'Publishable variations could not be counted.', 'variations')
      );
    } else if (publishableVariationCount < 1) {
      reasons.push(
        reason('PRODUCT_NO_PUBLISHABLE_VARIATION', 'At least one publishable variation is required.', 'variations')
      );
    }
  }

  // ---- media ----
  if (mediaCount === undefined) {
    reasons.push(reason('PRODUCT_MEDIA_COUNT_UNKNOWN', 'Approved media could not be counted.', 'media'));
  } else if (mediaCount < 1) {
    reasons.push(reason('PRODUCT_NO_APPROVED_MEDIA', 'At least one approved public image is required.', 'media'));
  }

  return verdict(reasons);
}

/* ---------------------------------------------------------------------------
   Variation
   --------------------------------------------------------------------------- */

/**
 * @param variation a `variations` row.
 * @param context.parentEligible whether the parent product passes its own
 *   gate. A variation cannot be more public than the model it belongs to.
 * @param context.mediaExists whether `swatch_media_id`, if set, resolves.
 */
export function evaluateVariationPublication(variation, context = {}) {
  if (!variation) {
    return verdict([reason('VARIATION_NOT_FOUND', 'The variation record could not be loaded.', null)]);
  }
  const reasons = [];

  /* Variations carry no governance block of their own in the B2.1 schema
     (only `is_published`), so their governance is inherited from the parent
     product — which is exactly why parentEligible is required rather than
     optional. */
  if (context.parentEligible === undefined) {
    reasons.push(
      reason('VARIATION_PARENT_UNKNOWN', 'The parent product could not be evaluated.', 'product_id')
    );
  } else if (context.parentEligible === false) {
    reasons.push(
      reason('VARIATION_PARENT_NOT_ELIGIBLE', 'The parent product is not eligible for publication.', 'product_id')
    );
  }

  if (!isNonEmptyString(variation.color)) {
    reasons.push(reason('VARIATION_NO_COLOUR_NAME', 'An approved public colour name is required.', 'color'));
  }

  /* colour code is optional; when present it must be a safe short token —
     it is rendered publicly and used as a display value. */
  if (variation.color_code !== null && variation.color_code !== undefined && variation.color_code !== '') {
    const code = String(variation.color_code);
    if (code.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(code)) {
      reasons.push(reason('VARIATION_INVALID_COLOUR_CODE', 'The colour code contains unsupported characters.', 'color_code'));
    }
  }

  if (variation.swatch_media_id && context.mediaExists === false) {
    reasons.push(reason('VARIATION_MEDIA_MISSING', 'The referenced swatch image could not be found.', 'swatch_media_id'));
  }

  /* Deliberately NO price, stock or availability requirement — none of
     those is public data (15_B2_PUBLIC_API_CONTRACT.md §5), so requiring
     them here would gate public publication on commercial fields the
     public surface must never expose. */

  return verdict(reasons);
}

/* ---------------------------------------------------------------------------
   Advisory (non-blocking) observations
   --------------------------------------------------------------------------- */

/** Things an editor probably wants to know before publishing, which are
 * NOT reasons to refuse. Kept separate from the verdict so "allowed" never
 * depends on a judgement call. */
export function productAdvisories(product, { publishableVariationCount } = {}) {
  const out = [];
  if (product?.is_discontinued && !product.replacement_product_id) {
    out.push(
      reason(
        'PRODUCT_DISCONTINUED_NO_REPLACEMENT',
        'This model is marked discontinued and names no replacement.',
        'replacement_product_id'
      )
    );
  }
  if (product?.is_featured && publishableVariationCount === 0) {
    out.push(reason('PRODUCT_FEATURED_WITHOUT_VARIATIONS', 'A featured model with no publishable colours will render sparsely.', 'variations'));
  }
  return out.sort((a, b) => (a.code < b.code ? -1 : 1));
}

/* ---------------------------------------------------------------------------
   Deferred gates — requirements the current schema cannot express safely.
   Recorded here (and in 18_B2_ADMIN_PUBLICATION_API.md) rather than
   invented, per the B2.4A brief.
   --------------------------------------------------------------------------- */
export const DEFERRED_GATES = [
  {
    code: 'DEFERRED_NON_VARIANT_FLAG',
    detail:
      'There is no `is_non_variant` column, so "a model that legitimately has no colourways" cannot be ' +
      'distinguished from "a model whose variations are not ready". Callers may pass isNonVariant: true ' +
      'explicitly; there is no persisted field backing it.',
  },
  {
    code: 'DEFERRED_MEDIA_APPROVAL_STATE',
    detail:
      'The `media` table has no publication/approval state of its own, so "approved public media" is ' +
      'currently only "media rows exist for this product". Per-asset approval (and rights expiry ' +
      'enforcement) needs a schema addition.',
  },
  {
    code: 'DEFERRED_FIELD_LEVEL_APPROVAL',
    detail:
      '`content_approvals` records an approval event per field, but nothing yet REQUIRES a matching ' +
      'approval row before a state change. The gate checks governance columns, not the approval ledger. ' +
      'Enforcing "no publish without a recorded approver for each claim field" is a later batch.',
  },
];
