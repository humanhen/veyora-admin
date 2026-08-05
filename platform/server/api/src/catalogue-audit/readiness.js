/* Product readiness classification and integrity detection (B2.4C1).

   "Ready" here means ONE thing and no more: the deterministic structural
   prerequisites are present, so a human editor could sensibly start work.

   It does NOT mean publishable. Publication needs approved copy, a verified
   source reference, a review date and an approval decision — judgements a
   planner cannot make and must not simulate. The publication gate remains the
   only authority on publishability, and it runs server-side against stored
   data at the moment of publication. Nothing here can grant, imply or
   shortcut it.

   The gate's own structural rules are mirrored where they are checkable from
   an export, and deliberately NOT mirrored where they are not: brand
   publication state, for instance, depends on decisions that have not been
   taken yet. */

import {
  cleanText, isBlank, isUsableSlug, proposeSlug, proposeDeduplicatedSlug,
  normaliseColorCode, isWellFormedColorCode, comparisonKey, compareText, stableSort,
} from './normalise.js';
import { BRAND_MATCH, resolveProductBrand } from './brand-mapping.js';

export const OUTCOME = Object.freeze({
  READY: 'READY_FOR_EDITORIAL_REVIEW',
  NEEDS_BRAND: 'NEEDS_BRAND_MAPPING',
  NEEDS_SLUG: 'NEEDS_SLUG_REVIEW',
  NEEDS_DESCRIPTION: 'NEEDS_DESCRIPTION',
  NEEDS_VARIATION: 'NEEDS_VARIATION_REVIEW',
  NEEDS_MEDIA: 'NEEDS_MEDIA',
  NEEDS_GOVERNANCE: 'NEEDS_GOVERNANCE',
  COLLISION: 'DUPLICATE_OR_COLLISION',
  EXCLUDED: 'INACTIVE_OR_EXCLUDED',
  MANUAL: 'MANUAL_REVIEW_REQUIRED',
});

/* Exactly one outcome is reported per product, chosen by this priority.
   Integrity problems outrank missing content because a collision or a broken
   reference has to be resolved before any editorial work is worth doing, and
   an excluded record outranks everything because no work is wanted at all. */
const PRIORITY = [
  OUTCOME.EXCLUDED,
  OUTCOME.COLLISION,
  OUTCOME.MANUAL,
  OUTCOME.NEEDS_BRAND,
  OUTCOME.NEEDS_SLUG,
  OUTCOME.NEEDS_VARIATION,
  OUTCOME.NEEDS_MEDIA,
  OUTCOME.NEEDS_DESCRIPTION,
  OUTCOME.NEEDS_GOVERNANCE,
  OUTCOME.READY,
];

const reason = (code, message, field = null, refs = []) => ({ code, message, field, refs });

/* ---------------------------------------------------------------------------
   Cross-record indexes — built once, deterministically
   --------------------------------------------------------------------------- */

export function buildIndexes(input) {
  const productsById = new Map(input.products.map((p) => [p.id, p]));

  const variationsByProduct = new Map();
  for (const v of input.variations) {
    if (!variationsByProduct.has(v.productId)) variationsByProduct.set(v.productId, []);
    variationsByProduct.get(v.productId).push(v);
  }
  for (const [, list] of variationsByProduct) list.sort((a, b) => compareText(a.sku, b.sku) || compareText(a.id, b.id));

  const mediaCountByProduct = new Map();
  for (const m of input.media) {
    if (m.ownerType !== 'product') continue;
    mediaCountByProduct.set(m.ownerId, (mediaCountByProduct.get(m.ownerId) ?? 0) + 1);
  }

  const countBy = (list, keyFn) => {
    const out = new Map();
    for (const item of list) {
      const key = keyFn(item);
      if (key === null || key === '') continue;
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return out;
  };

  return {
    productsById,
    variationsByProduct,
    mediaCountByProduct,
    skuCounts: countBy(input.products, (p) => cleanText(p.sku)),
    existingSlugCounts: countBy(input.products, (p) => (isUsableSlug(p.publicSlug) ? p.publicSlug : null)),
    brandSlugs: new Set(input.brands.map((b) => b.slug).filter(isUsableSlug)),
  };
}

/* ---------------------------------------------------------------------------
   Slug planning — done for the whole catalogue at once so proposals are
   collision-free as a set, and stable regardless of input order.
   --------------------------------------------------------------------------- */

export function planSlugs(input, indexes) {
  /* Products are processed in a fixed order (sku, then id) so that when two
     records want the same slug, the SAME one wins on every run. */
  const ordered = stableSort(input.products, 'sku');

  const claimed = new Set(indexes.brandSlugs);
  const result = new Map();

  /* Pass 1: every record with a usable, unique existing slug keeps it. An
     approved public URL is never churned by this planner. */
  for (const product of ordered) {
    const current = product.publicSlug;
    if (isUsableSlug(current) && (indexes.existingSlugCounts.get(current) ?? 0) === 1 && !claimed.has(current)) {
      claimed.add(current);
      result.set(product.id, { slug: current, changed: false, status: 'KEPT', reviewRequired: false });
    }
  }

  // Pass 2: everything else gets a proposal derived from its name.
  for (const product of ordered) {
    if (result.has(product.id)) continue;

    const current = product.publicSlug;
    const currentUsable = isUsableSlug(current);
    const duplicated = currentUsable && (indexes.existingSlugCounts.get(current) ?? 0) > 1;

    const derived = proposeSlug(product.name);
    if (!derived.ok) {
      result.set(product.id, {
        slug: null, changed: false, status: derived.code, reviewRequired: true,
        note: 'A public slug could not be derived from the model name.',
      });
      continue;
    }

    const deduped = proposeDeduplicatedSlug(derived.slug, claimed);
    if (!deduped.ok) {
      result.set(product.id, { slug: null, changed: false, status: deduped.code, reviewRequired: true });
      continue;
    }
    claimed.add(deduped.slug);
    result.set(product.id, {
      slug: deduped.slug,
      changed: deduped.slug !== current,
      /* A suffix means two models share a name. The suffix is deterministic,
         but which model deserves the bare slug is an editorial call. */
      status: duplicated ? 'REPLACED_DUPLICATE' : (currentUsable ? 'REPLACED_INVALID' : 'PROPOSED'),
      reviewRequired: deduped.suffixed || duplicated,
      suffixed: deduped.suffixed,
    });
  }

  return result;
}

/* ---------------------------------------------------------------------------
   Per-product classification
   --------------------------------------------------------------------------- */

export function classifyProduct(product, ctx) {
  const { indexes, mapping, slugPlan } = ctx;
  const reasons = [];
  const outcomes = new Set();

  // ---- exclusion ----
  if (product.isActive === false) {
    reasons.push(reason('PRODUCT_INACTIVE', 'The model is inactive in the portal and is excluded from public backfill.', 'isActive'));
    outcomes.add(OUTCOME.EXCLUDED);
  }

  // ---- identity / duplicates ----
  const sku = cleanText(product.sku);
  if ((indexes.skuCounts.get(sku) ?? 0) > 1) {
    reasons.push(reason('DUPLICATE_SKU', 'More than one model carries this SKU.', 'sku'));
    outcomes.add(OUTCOME.COLLISION);
  }
  const currentSlug = product.publicSlug;
  if (isUsableSlug(currentSlug) && (indexes.existingSlugCounts.get(currentSlug) ?? 0) > 1) {
    reasons.push(reason('DUPLICATE_PUBLIC_SLUG', 'More than one model already uses this public slug.', 'publicSlug'));
    outcomes.add(OUTCOME.COLLISION);
  }
  if (isUsableSlug(currentSlug) && indexes.brandSlugs.has(currentSlug)) {
    reasons.push(reason('SLUG_COLLIDES_WITH_BRAND', 'This public slug is already used by a brand.', 'publicSlug'));
    outcomes.add(OUTCOME.COLLISION);
  }

  // ---- name ----
  if (isBlank(product.name)) {
    reasons.push(reason('PRODUCT_NO_NAME', 'A public model name is required.', 'name'));
    outcomes.add(OUTCOME.MANUAL);
  }
  if (isBlank(sku)) {
    reasons.push(reason('PRODUCT_NO_SKU', 'A display SKU is required.', 'sku'));
    outcomes.add(OUTCOME.MANUAL);
  }

  // ---- replacement integrity ----
  const replacementId = product.replacementProductId;
  if (replacementId) {
    if (replacementId === product.id) {
      reasons.push(reason('REPLACEMENT_SELF', 'The model lists itself as its own replacement.', 'replacementProductId'));
      outcomes.add(OUTCOME.MANUAL);
    } else if (!indexes.productsById.has(replacementId)) {
      reasons.push(reason('REPLACEMENT_MISSING', 'The named replacement model is not in this export.', 'replacementProductId', [replacementId]));
      outcomes.add(OUTCOME.MANUAL);
    }
  } else if (product.isDiscontinued === true) {
    /* Not fatal — a discontinued model may legitimately have no successor —
       but a visitor landing on it deserves somewhere to go. */
    reasons.push(reason('DISCONTINUED_WITHOUT_REPLACEMENT', 'The model is discontinued and names no replacement.', 'replacementProductId'));
    outcomes.add(OUTCOME.MANUAL);
  }

  // ---- published/governance coherence ----
  if (product.isPublished === true && product.publicationState !== 'published') {
    reasons.push(reason('PUBLISHED_STATE_INCONSISTENT',
      `The model is flagged published while its publication state is "${product.publicationState ?? 'unset'}".`, 'publicationState'));
    outcomes.add(OUTCOME.MANUAL);
  }
  if (product.publicationState === 'retired' && product.isPublished === true) {
    reasons.push(reason('RETIRED_BUT_PUBLISHED', 'The model is retired but still flagged published.', 'publicationState'));
    outcomes.add(OUTCOME.MANUAL);
  }

  // ---- brand ----
  const brand = resolveProductBrand(product, mapping);
  if (brand.classification === BRAND_MATCH.MISSING) {
    reasons.push(reason('BRAND_MISSING', 'The model carries no brand value.', 'brand'));
    outcomes.add(OUTCOME.NEEDS_BRAND);
  } else if (brand.classification === BRAND_MATCH.AMBIGUOUS) {
    reasons.push(reason('BRAND_AMBIGUOUS', 'The brand value matches more than one existing brand. A human must choose.', 'brand'));
    outcomes.add(OUTCOME.NEEDS_BRAND);
  } else if (brand.classification === BRAND_MATCH.UNUSABLE) {
    reasons.push(reason('BRAND_UNUSABLE', 'No usable brand name could be derived from this value.', 'brand'));
    outcomes.add(OUTCOME.NEEDS_BRAND);
  } else if (brand.classification === BRAND_MATCH.PROPOSED_NEW) {
    reasons.push(reason('BRAND_NOT_YET_CREATED', 'The brand does not exist yet and must be created by a human before linking.', 'brandId'));
    outcomes.add(OUTCOME.NEEDS_BRAND);
  }

  // ---- slug ----
  const slug = slugPlan.get(product.id);
  if (!slug || slug.slug === null) {
    reasons.push(reason('SLUG_NOT_DERIVABLE', `A public slug could not be proposed (${slug?.status ?? 'UNKNOWN'}).`, 'publicSlug'));
    outcomes.add(OUTCOME.NEEDS_SLUG);
  } else if (slug.reviewRequired) {
    reasons.push(reason('SLUG_NEEDS_REVIEW',
      slug.suffixed
        ? 'The proposed slug needed a numeric suffix because another model claims the same name.'
        : 'The existing public slug is duplicated or unusable and a replacement is proposed.',
      'publicSlug'));
    outcomes.add(OUTCOME.NEEDS_SLUG);
  }

  // ---- variations ----
  const variations = indexes.variationsByProduct.get(product.id) ?? [];
  const variationFindings = classifyVariations(product, variations);
  reasons.push(...variationFindings.reasons);
  if (variationFindings.blocking) outcomes.add(OUTCOME.NEEDS_VARIATION);

  // ---- media ----
  const mediaCount = indexes.mediaCountByProduct.get(product.id) ?? 0;
  if (mediaCount < 1) {
    reasons.push(reason('NO_APPROVED_MEDIA', 'The model has no approved public image.', 'media'));
    outcomes.add(OUTCOME.NEEDS_MEDIA);
  }

  // ---- description ----
  if (product.hasPublicDescription !== true) {
    reasons.push(reason('NO_PUBLIC_DESCRIPTION',
      'Approved public description copy is required. The planner never proposes description text.', 'publicDescription'));
    outcomes.add(OUTCOME.NEEDS_DESCRIPTION);
  }

  // ---- governance ----
  if (product.hasSourceReference !== true) {
    reasons.push(reason('NO_SOURCE_REFERENCE', 'A source reference must be supplied by a human before publication.', 'sourceReference'));
    outcomes.add(OUTCOME.NEEDS_GOVERNANCE);
  }
  if (!product.lastReviewedAt) {
    reasons.push(reason('NOT_REVIEWED', 'A last-reviewed date must be recorded by a human before publication.', 'lastReviewedAt'));
    outcomes.add(OUTCOME.NEEDS_GOVERNANCE);
  }
  if (product.verificationStatus !== 'verified') {
    reasons.push(reason('NOT_VERIFIED',
      `Verification status is "${product.verificationStatus ?? 'unset'}". Only a human reviewer may set it to verified.`, 'verificationStatus'));
    outcomes.add(OUTCOME.NEEDS_GOVERNANCE);
  }

  const outcome = PRIORITY.find((o) => outcomes.has(o)) ?? OUTCOME.READY;
  reasons.sort((a, b) => compareText(a.code, b.code) || compareText(a.field, b.field));

  return {
    productId: product.id,
    sku,
    name: cleanText(product.name),
    outcome,
    reasonCodes: reasons.map((r) => r.code),
    reasons,
    brandClassification: brand.classification,
    proposedBrandId: brand.brandId,
    proposedSlug: slug?.slug ?? null,
    variationCount: variations.length,
    usableVariationCount: variationFindings.usableCount,
    mediaCount,
  };
}

function classifyVariations(product, variations) {
  const reasons = [];
  let blocking = false;

  if (variations.length === 0) {
    reasons.push(reason('NO_VARIATIONS', 'The model has no colourways.', 'variations'));
    return { reasons, blocking: true, usableCount: 0 };
  }

  const seenColour = new Map();
  let usableCount = 0;

  for (const v of variations) {
    const colour = cleanText(v.colorName);
    if (colour === '') {
      reasons.push(reason('VARIATION_NO_COLOUR', 'A colourway has no public colour name.', 'variations', [v.id]));
      blocking = true;
    } else {
      const key = comparisonKey(colour);
      if (seenColour.has(key)) {
        reasons.push(reason('VARIATION_DUPLICATE_COLOUR',
          `Two colourways share the colour name "${colour}".`, 'variations', [seenColour.get(key), v.id].sort(compareText)));
        blocking = true;
      } else {
        seenColour.set(key, v.id);
      }
    }

    const code = cleanText(v.colorCode);
    if (code !== '' && !isWellFormedColorCode(normaliseColorCode(code))) {
      reasons.push(reason('VARIATION_MALFORMED_COLOUR_CODE',
        `The colour code "${code}" is not well formed.`, 'variations', [v.id]));
      blocking = true;
    }

    if (v.isActive !== false && colour !== '') usableCount++;
  }

  if (usableCount === 0) {
    reasons.push(reason('NO_USABLE_VARIATION', 'No colourway is both active and named.', 'variations'));
    blocking = true;
  }

  return { reasons, blocking, usableCount };
}

/* ---------------------------------------------------------------------------
   Catalogue-wide integrity findings
   --------------------------------------------------------------------------- */

export function detectIntegrityFindings(input, indexes, slugPlan) {
  const findings = [];
  const add = (code, message, recordType, recordIds, field = null) =>
    findings.push({ code, message, recordType, recordIds: [...recordIds].sort(compareText), field });

  const group = (list, keyFn) => {
    const out = new Map();
    for (const item of list) {
      const key = keyFn(item);
      if (key === null || key === '') continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(item.id);
    }
    return out;
  };

  for (const [sku, ids] of group(input.products, (p) => cleanText(p.sku))) {
    if (ids.length > 1) add('DUPLICATE_SKU', `${ids.length} models share the SKU "${sku}".`, 'product', ids, 'sku');
  }
  for (const [sku, ids] of group(input.variations, (v) => cleanText(v.sku))) {
    if (ids.length > 1) add('DUPLICATE_VARIATION_SKU', `${ids.length} colourways share the SKU "${sku}".`, 'variation', ids, 'sku');
  }
  for (const [slug, ids] of group(input.products, (p) => (isUsableSlug(p.publicSlug) ? p.publicSlug : null))) {
    if (ids.length > 1) add('DUPLICATE_PUBLIC_SLUG', `${ids.length} models already use the public slug "${slug}".`, 'product', ids, 'publicSlug');
  }

  /* Proposed slugs are collision-free by construction (planSlugs claims as it
     goes). This asserts that invariant rather than assuming it, so a future
     change to the planner cannot silently start emitting duplicates. */
  const proposed = new Map();
  for (const [productId, plan] of slugPlan) {
    if (!plan.slug) continue;
    if (!proposed.has(plan.slug)) proposed.set(plan.slug, []);
    proposed.get(plan.slug).push(productId);
  }
  for (const [slug, ids] of proposed) {
    if (ids.length > 1) add('DUPLICATE_PROPOSED_SLUG', `The planner proposed "${slug}" for ${ids.length} models.`, 'product', ids, 'publicSlug');
    if (indexes.brandSlugs.has(slug)) add('PROPOSED_SLUG_COLLIDES_WITH_BRAND', `The proposed slug "${slug}" is already a brand slug.`, 'product', ids, 'publicSlug');
  }

  for (const product of input.products) {
    if (product.replacementProductId === product.id) {
      add('REPLACEMENT_SELF', 'A model lists itself as its own replacement.', 'product', [product.id], 'replacementProductId');
    } else if (product.replacementProductId && !indexes.productsById.has(product.replacementProductId)) {
      add('REPLACEMENT_MISSING', `The replacement model "${product.replacementProductId}" is not in this export.`, 'product', [product.id], 'replacementProductId');
    }
    if (product.isPublished === true && product.publicationState !== 'published') {
      add('PUBLISHED_STATE_INCONSISTENT', 'A model is flagged published without the published governance state.', 'product', [product.id], 'publicationState');
    }
    if (product.isActive === false && product.isPublished === true) {
      add('INACTIVE_BUT_PUBLISHED', 'A model is inactive in the portal but flagged published.', 'product', [product.id], 'isActive');
    }
  }

  for (const variation of input.variations) {
    if (!indexes.productsById.has(variation.productId)) {
      add('VARIATION_ORPHANED', `The colourway's parent model "${variation.productId}" is not in this export.`, 'variation', [variation.id], 'productId');
    }
    const code = cleanText(variation.colorCode);
    if (code !== '' && !isWellFormedColorCode(normaliseColorCode(code))) {
      add('MALFORMED_COLOUR_CODE', `The colour code "${code}" is not well formed.`, 'variation', [variation.id], 'colorCode');
    }
    if (isBlank(variation.colorName)) {
      add('VARIATION_NO_COLOUR', 'A colourway has no public colour name.', 'variation', [variation.id], 'colorName');
    }
  }

  for (const [productId, variations] of indexes.variationsByProduct) {
    const seen = new Map();
    for (const v of variations) {
      const key = comparisonKey(v.colorName);
      if (key === '') continue;
      if (seen.has(key)) {
        add('DUPLICATE_VARIATION_COLOUR',
          `Model "${productId}" has two colourways named "${cleanText(v.colorName)}".`, 'variation', [seen.get(key), v.id], 'colorName');
      } else seen.set(key, v.id);
    }
  }

  findings.sort((a, b) =>
    compareText(a.code, b.code) || compareText(a.recordType, b.recordType) || compareText(a.recordIds[0], b.recordIds[0]));
  return findings;
}
