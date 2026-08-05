/* Dry-run backfill plan (B2.4C1).

   A plan is a list of PROPOSALS. Nothing here executes, connects, or emits
   SQL. Applying a plan is B2.4C3's problem, behind the governed
   administrative API and a human decision.

   The forbidden-proposal list below is the load-bearing part of this file.
   A planner that could propose `is_published = true`, a verification status,
   a source reference, a review date or description copy would be
   manufacturing exactly the editorial and governance judgements the whole
   B2.4 sequence exists to keep in human hands. Those fields appear in the
   plan only as MISSING — named, so a reviewer knows what to supply, and never
   filled in. */

import { cleanText, compareText, normaliseColorCode, stableSort } from './normalise.js';
import { BRAND_MATCH } from './brand-mapping.js';
import { OUTCOME } from './readiness.js';

export const CONFIDENCE = Object.freeze({
  DETERMINISTIC: 'deterministic',
  REVIEW_REQUIRED: 'review_required',
});

/* Fields this planner must never propose a value for, with the reason. The
   plan builder asserts against this set, so adding a proposal for one of them
   fails loudly rather than shipping quietly. */
export const FORBIDDEN_PROPOSAL_FIELDS = Object.freeze({
  is_published: 'Publication is a gated, approval-recorded decision taken through the publish endpoint.',
  publication_state: 'Reaching the published state is the publish endpoint\'s job, not a backfill\'s.',
  verification_status: 'Only a human reviewer may declare content verified.',
  source_reference: 'A source reference must cite a real source; inventing one defeats its purpose.',
  last_reviewed_at: 'A review date must record a review that actually happened.',
  scheduled_review_at: 'A review schedule is an editorial decision.',
  public_description: 'Description copy is editorial content and is never machine-generated here.',
  fact_owner: 'Ownership is assigned by a human.',
  approver_id: 'Approval identity is server-controlled.',
  approved_at: 'Approval time is server-controlled.',
  replacement_product_id: 'A replacement relationship is a commercial decision, never inferred.',
  price: 'Commercial data is out of scope entirely.',
  sale_price: 'Commercial data is out of scope entirely.',
});

const change = ({ recordType, recordId, field, currentValue, proposedValue, reasonCode, confidence, dependsOn = [], note = null }) => {
  if (Object.prototype.hasOwnProperty.call(FORBIDDEN_PROPOSAL_FIELDS, field)) {
    /* Not a validation branch a caller can trip in normal use — a guard so a
       future edit cannot introduce one silently. */
    throw new Error(`Refusing to propose a value for "${field}": ${FORBIDDEN_PROPOSAL_FIELDS[field]}`);
  }
  return {
    recordType,
    recordId,
    field,
    currentValue: currentValue === undefined ? null : currentValue,
    proposedValue: proposedValue === undefined ? null : proposedValue,
    reasonCode,
    confidence,
    /* Human approval is required for anything that is not a pure mechanical
       normalisation — and for every proposal that depends on a record which
       does not exist yet. */
    requiresHumanApproval: confidence !== CONFIDENCE.DETERMINISTIC || dependsOn.length > 0,
    dependsOn: [...dependsOn].sort(compareText),
    note,
  };
};

/**
 * Builds the dry-run plan.
 *
 * @returns {{changes:Array, missingByRecord:Array, newBrands:Array}}
 */
export function buildPlan({ input, indexes, mapping, slugPlan, classifications }) {
  const changes = [];
  const byId = new Map(classifications.map((c) => [c.productId, c]));

  for (const product of stableSort(input.products, 'sku')) {
    const verdict = byId.get(product.id);
    if (!verdict) continue;

    /* An excluded record gets no proposals at all. Proposing changes to a
       model nobody intends to publish is noise that hides the real work. */
    if (verdict.outcome === OUTCOME.EXCLUDED) continue;

    // ---- brand link ----
    const resolved = mapping.byProductId.get(product.id) ?? null;
    if (resolved) {
      if (resolved.classification === BRAND_MATCH.EXACT || resolved.classification === BRAND_MATCH.NORMALISED) {
        if (product.brandId !== resolved.proposedBrandId) {
          changes.push(change({
            recordType: 'product', recordId: product.id, field: 'brand_id',
            currentValue: product.brandId, proposedValue: resolved.proposedBrandId,
            reasonCode: resolved.classification === BRAND_MATCH.EXACT ? 'BRAND_EXACT_MATCH' : 'BRAND_NORMALISED_MATCH',
            confidence: resolved.classification === BRAND_MATCH.EXACT ? CONFIDENCE.DETERMINISTIC : CONFIDENCE.DETERMINISTIC,
            note: resolved.classification === BRAND_MATCH.NORMALISED
              ? `Matched "${cleanText(product.brand)}" to "${resolved.proposedBrandName}" after normalisation.` : null,
          }));
        }
      } else if (resolved.classification === BRAND_MATCH.PROPOSED_NEW) {
        changes.push(change({
          recordType: 'product', recordId: product.id, field: 'brand_id',
          currentValue: product.brandId, proposedValue: null,
          reasonCode: 'BRAND_REQUIRES_NEW_RECORD',
          confidence: CONFIDENCE.REVIEW_REQUIRED,
          dependsOn: [`brand:${resolved.proposedBrandSlug}`],
          note: `Depends on a new brand "${resolved.proposedBrandName}" being created first. This plan proposes no brand copy.`,
        }));
      }
      // AMBIGUOUS / MISSING / UNUSABLE produce no proposal at all — see the
      // brand-mapping review report instead.
    }

    // ---- public slug ----
    const slug = slugPlan.get(product.id);
    if (slug && slug.slug && slug.changed) {
      changes.push(change({
        recordType: 'product', recordId: product.id, field: 'public_slug',
        currentValue: product.publicSlug, proposedValue: slug.slug,
        reasonCode: `SLUG_${slug.status}`,
        confidence: slug.reviewRequired ? CONFIDENCE.REVIEW_REQUIRED : CONFIDENCE.DETERMINISTIC,
        note: slug.suffixed ? 'A numeric suffix was needed because another model derives the same slug.' : null,
      }));
    }

    // ---- directly derived text fields ----
    for (const [field, value] of [['line', product.line], ['shape', product.shape], ['segment', product.segment]]) {
      const cleaned = cleanText(value);
      if (value !== null && cleaned !== String(value ?? '')) {
        changes.push(change({
          recordType: 'product', recordId: product.id, field,
          currentValue: value, proposedValue: cleaned,
          reasonCode: 'TEXT_NORMALISED', confidence: CONFIDENCE.DETERMINISTIC,
          note: 'Whitespace and Unicode normalisation only — no wording changed.',
        }));
      }
    }
  }

  // ---- variation colour codes ----
  for (const variation of stableSort(input.variations, 'sku')) {
    const parent = indexes.productsById.get(variation.productId);
    if (parent && parent.isActive === false) continue;
    const current = variation.colorCode;
    if (current === null || cleanText(current) === '') continue;
    const normalised = normaliseColorCode(current);
    if (normalised !== '' && normalised !== current) {
      changes.push(change({
        recordType: 'variation', recordId: variation.id, field: 'color_code',
        currentValue: current, proposedValue: normalised,
        reasonCode: 'COLOUR_CODE_NORMALISED', confidence: CONFIDENCE.DETERMINISTIC,
        note: 'Case and separator normalisation only.',
      }));
    }
  }

  changes.sort((a, b) =>
    compareText(a.recordType, b.recordType) || compareText(a.recordId, b.recordId) || compareText(a.field, b.field));

  return {
    changes,
    missingByRecord: buildMissing(classifications),
    newBrands: buildNewBrands(mapping),
  };
}

/* Governance and editorial fields are reported as MISSING, never proposed.
   This is the list a human works through — it names what has to be supplied
   without pretending to supply it. */
function buildMissing(classifications) {
  const MISSING_FROM_REASON = {
    NO_PUBLIC_DESCRIPTION: 'public_description',
    NO_SOURCE_REFERENCE: 'source_reference',
    NOT_REVIEWED: 'last_reviewed_at',
    NOT_VERIFIED: 'verification_status',
    NO_APPROVED_MEDIA: 'media',
  };
  const out = [];
  for (const verdict of classifications) {
    if (verdict.outcome === OUTCOME.EXCLUDED) continue;
    for (const r of verdict.reasons) {
      const field = MISSING_FROM_REASON[r.code];
      if (!field) continue;
      out.push({
        recordType: 'product', recordId: verdict.productId, field,
        reasonCode: r.code, mustBeSuppliedBy: 'human',
        note: r.message,
      });
    }
  }
  return out.sort((a, b) => compareText(a.recordId, b.recordId) || compareText(a.field, b.field));
}

/** Brands that would have to be created. Name and slug only — every editorial
    field is left for a human, and is listed so nobody assumes it is optional. */
function buildNewBrands(mapping) {
  return mapping.entries
    .filter((e) => e.classification === BRAND_MATCH.PROPOSED_NEW)
    .map((e) => ({
      proposedName: e.proposedBrandName,
      proposedSlug: e.proposedBrandSlug,
      sourceValue: e.originalValue,
      productCount: e.productCount,
      requiresHumanApproval: true,
      fieldsRequiringHumanInput: [
        'headline', 'summary', 'story', 'ideal_retailer', 'design_origin',
        'manufacturing_origin', 'source_reference', 'verification_status', 'last_reviewed_at',
      ],
    }))
    .sort((a, b) => compareText(a.proposedSlug, b.proposedSlug));
}
