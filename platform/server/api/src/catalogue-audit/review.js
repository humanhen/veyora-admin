/* Human review decisions and reviewed-plan generation (Fast-Track Phase 1,
   for B2.4C2).

   B2.4C1 produces PROPOSALS. This module carries the other half: what a human
   actually decided. The two are combined into a reviewed plan that stays
   non-executable, and that keeps the two kinds of statement visibly apart —
   a deterministic proposal is a machine's suggestion, an override is a
   person's decision, and conflating them is how an unreviewed change ends up
   applied under the cover of an approved batch.

   Three rules shape the format:

     1. NOTHING IS INFERRED. A proposal with no decision stays `unresolved`.
        The generator never fills a gap, never assumes "no objection means
        approved", and never promotes an unresolved item on the grounds that
        everything around it was approved.

     2. EVERY OVERRIDE IS ATTRIBUTED AND JUSTIFIED. A decision names its
        target record and field and carries a rationale. A reviewed plan whose
        entries cannot be traced back to a reason is not reviewable by the
        next person.

     3. PUBLICATION CANNOT BE DECIDED HERE. `is_published`,
        `publication_state`, `verification_status`, approval identity and
        review dates are refused at validation, not merely ignored — a review
        file asking for publication is a misunderstanding worth surfacing
        loudly, because publication is a gated, approval-recorded operation
        that happens one record at a time through the admin API. */

import { compareText, isUsableSlug, cleanText } from './normalise.js';
import { FORBIDDEN_PROPOSAL_FIELDS, CONFIDENCE } from './plan.js';

export class ReviewInputError extends Error {
  constructor(errors) {
    super(`Invalid review decisions: ${errors.length} problem(s)`);
    this.name = 'ReviewInputError';
    this.errors = errors;
  }
}

const err = (path, code, message) => ({ path, code, message });

/* ---------------------------------------------------------------------------
   The decision contract
   --------------------------------------------------------------------------- */

const TOP_LEVEL = new Set(['reviewedAt', 'reviewer', 'notes', 'brandDecisions', 'slugDecisions', 'fieldOverrides', 'exclusions']);

const BRAND_DECISION_FIELDS = {
  comparisonKey: 'string',      // identifies the mapping entry being decided
  decision: 'string',           // APPROVE_MATCH | CREATE_NEW_BRAND | REJECT | DEFER
  brandId: 'string?',           // required for APPROVE_MATCH
  rationale: 'string',
};
const BRAND_DECISIONS = new Set(['APPROVE_MATCH', 'CREATE_NEW_BRAND', 'REJECT', 'DEFER']);

const SLUG_DECISION_FIELDS = {
  productId: 'string',
  decision: 'string',           // APPROVE_PROPOSED | REPLACE | REJECT | DEFER
  slug: 'string?',              // required for REPLACE
  rationale: 'string',
};
const SLUG_DECISIONS = new Set(['APPROVE_PROPOSED', 'REPLACE', 'REJECT', 'DEFER']);

/* A reviewer may supply a value for a field the planner is allowed to touch.
   The allowlist is intentionally NARROWER than the planner's, because a human
   typing into a review file is exactly the path by which a governance field
   would otherwise be smuggled in. */
const OVERRIDABLE_FIELDS = new Set([
  'public_slug', 'brand_id', 'line', 'shape', 'segment', 'color_code',
]);

const FIELD_OVERRIDE_FIELDS = {
  recordType: 'string',         // product | variation
  recordId: 'string',
  field: 'string',
  value: 'string?',
  rationale: 'string',
};

const EXCLUSION_FIELDS = {
  recordType: 'string',
  recordId: 'string',
  rationale: 'string',
};

const COLLECTIONS = {
  brandDecisions: BRAND_DECISION_FIELDS,
  slugDecisions: SLUG_DECISION_FIELDS,
  fieldOverrides: FIELD_OVERRIDE_FIELDS,
  exclusions: EXCLUSION_FIELDS,
};

function checkField(kind, value, path, errors) {
  if (kind === 'string') {
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(err(path, 'REQUIRED_STRING', 'A non-empty string is required.'));
    }
  } else if (kind === 'string?') {
    if (value !== null && value !== undefined && typeof value !== 'string') {
      errors.push(err(path, 'INVALID_STRING', 'Must be a string or null.'));
    }
  }
}

function checkRecord(record, fields, path, errors) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    errors.push(err(path, 'INVALID_RECORD', 'Each entry must be an object.'));
    return;
  }
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      errors.push(err(`${path}.${key}`, 'UNKNOWN_FIELD',
        'Unknown field. The review format is a closed allowlist.'));
    }
  }
  for (const [key, kind] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      if (kind === 'string') errors.push(err(`${path}.${key}`, 'MISSING_FIELD', 'Required.'));
      continue;
    }
    checkField(kind, record[key], `${path}.${key}`, errors);
  }
}

/** Validates a review-decision document. */
export function validateReviewDecisions(raw) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [err('$', 'INVALID_ROOT', 'The review file must be a JSON object.')] };
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL.has(key)) {
      errors.push(err(`$.${key}`, 'UNKNOWN_TOP_LEVEL', `Allowed: ${[...TOP_LEVEL].join(', ')}.`));
    }
  }
  if (raw.reviewer !== undefined) checkField('string?', raw.reviewer, '$.reviewer', errors);
  if (raw.notes !== undefined) checkField('string?', raw.notes, '$.notes', errors);
  if (raw.reviewedAt !== undefined) checkField('string?', raw.reviewedAt, '$.reviewedAt', errors);

  for (const [name, fields] of Object.entries(COLLECTIONS)) {
    const list = raw[name];
    if (list === undefined) continue;                    // an absent section means no decisions
    if (!Array.isArray(list)) {
      errors.push(err(`$.${name}`, 'INVALID_COLLECTION', 'Must be an array.'));
      continue;
    }
    list.forEach((record, i) => checkRecord(record, fields, `$.${name}[${i}]`, errors));
  }
  if (errors.length) return { ok: false, errors };

  // ---- semantic checks ----
  for (const [i, d] of (raw.brandDecisions ?? []).entries()) {
    if (!BRAND_DECISIONS.has(d.decision)) {
      errors.push(err(`$.brandDecisions[${i}].decision`, 'INVALID_DECISION',
        `Must be one of: ${[...BRAND_DECISIONS].join(', ')}.`));
    }
    if (d.decision === 'APPROVE_MATCH' && !d.brandId) {
      errors.push(err(`$.brandDecisions[${i}].brandId`, 'MISSING_TARGET',
        'APPROVE_MATCH must name the brand id being approved.'));
    }
  }
  for (const [i, d] of (raw.slugDecisions ?? []).entries()) {
    if (!SLUG_DECISIONS.has(d.decision)) {
      errors.push(err(`$.slugDecisions[${i}].decision`, 'INVALID_DECISION',
        `Must be one of: ${[...SLUG_DECISIONS].join(', ')}.`));
    }
    if (d.decision === 'REPLACE') {
      if (!d.slug) {
        errors.push(err(`$.slugDecisions[${i}].slug`, 'MISSING_VALUE', 'REPLACE must supply the replacement slug.'));
      } else if (!isUsableSlug(d.slug)) {
        errors.push(err(`$.slugDecisions[${i}].slug`, 'INVALID_SLUG',
          'The replacement slug must be lowercase letters, numbers and single hyphens, and must not be a reserved route.'));
      }
    }
  }
  for (const [i, o] of (raw.fieldOverrides ?? []).entries()) {
    const path = `$.fieldOverrides[${i}].field`;
    if (Object.prototype.hasOwnProperty.call(FORBIDDEN_PROPOSAL_FIELDS, o.field)) {
      /* Named explicitly rather than lumped in with "not overridable": a
         reviewer trying to set publication state has a real misunderstanding
         about where that decision happens. */
      errors.push(err(path, 'FORBIDDEN_FIELD',
        `"${o.field}" cannot be decided in a review file: ${FORBIDDEN_PROPOSAL_FIELDS[o.field]}`));
    } else if (!OVERRIDABLE_FIELDS.has(o.field)) {
      errors.push(err(path, 'NOT_OVERRIDABLE',
        `"${o.field}" is not overridable. Allowed: ${[...OVERRIDABLE_FIELDS].sort().join(', ')}.`));
    }
    if (!['product', 'variation'].includes(o.recordType)) {
      errors.push(err(`$.fieldOverrides[${i}].recordType`, 'INVALID_RECORD_TYPE', 'Must be product or variation.'));
    }
    if (o.field === 'public_slug' && o.value && !isUsableSlug(o.value)) {
      errors.push(err(`$.fieldOverrides[${i}].value`, 'INVALID_SLUG', 'Not a usable public slug.'));
    }
  }
  for (const [i, e] of (raw.exclusions ?? []).entries()) {
    if (!['product', 'variation'].includes(e.recordType)) {
      errors.push(err(`$.exclusions[${i}].recordType`, 'INVALID_RECORD_TYPE', 'Must be product or variation.'));
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, decisions: shape(raw) };
}

function shape(raw) {
  const pick = (list, fields) => (list ?? []).map((r) => {
    const out = {};
    for (const key of Object.keys(fields)) out[key] = r[key] ?? null;
    return out;
  });
  return {
    reviewedAt: raw.reviewedAt ?? null,
    reviewer: raw.reviewer ?? null,
    notes: raw.notes ?? null,
    brandDecisions: pick(raw.brandDecisions, BRAND_DECISION_FIELDS),
    slugDecisions: pick(raw.slugDecisions, SLUG_DECISION_FIELDS),
    fieldOverrides: pick(raw.fieldOverrides, FIELD_OVERRIDE_FIELDS),
    exclusions: pick(raw.exclusions, EXCLUSION_FIELDS),
  };
}

/* ---------------------------------------------------------------------------
   Reviewed plan
   --------------------------------------------------------------------------- */

export const ENTRY_STATE = Object.freeze({
  APPROVED: 'approved',        // a human said yes
  REJECTED: 'rejected',        // a human said no
  DEFERRED: 'deferred',        // a human said not yet
  UNRESOLVED: 'unresolved',    // nobody has said anything — the default
});

/**
 * Combines a B2.4C1 audit with explicit review decisions.
 *
 * Pure: same audit + same decisions → identical output. Generates no SQL and
 * proposes no publication. Every entry records where it came from
 * (`origin: 'planner' | 'reviewer'`) so the two are never confused.
 */
export function buildReviewedPlan(audit, decisions) {
  const brandByKey = new Map((decisions.brandDecisions ?? []).map((d) => [d.comparisonKey, d]));
  const slugByProduct = new Map((decisions.slugDecisions ?? []).map((d) => [d.productId, d]));
  const excluded = new Set((decisions.exclusions ?? []).map((e) => `${e.recordType}:${e.recordId}`));
  const overrideIndex = new Map(
    (decisions.fieldOverrides ?? []).map((o) => [`${o.recordType}:${o.recordId}:${o.field}`, o])
  );

  const entries = [];
  const usedOverrides = new Set();

  for (const change of audit.plan.changes) {
    const key = `${change.recordType}:${change.recordId}`;
    const overrideKey = `${key}:${change.field}`;
    const override = overrideIndex.get(overrideKey);

    if (excluded.has(key)) {
      entries.push(entry(change, ENTRY_STATE.REJECTED, 'reviewer',
        rationaleFor(decisions.exclusions, (e) => `${e.recordType}:${e.recordId}` === key),
        { supersededBy: 'exclusion' }));
      continue;
    }

    if (override) {
      usedOverrides.add(overrideKey);
      entries.push({
        ...entry(change, ENTRY_STATE.APPROVED, 'reviewer', override.rationale),
        proposedValue: override.value,
        plannerProposedValue: change.proposedValue,
        overridden: true,
      });
      continue;
    }

    if (change.field === 'public_slug') {
      const decision = slugByProduct.get(change.recordId);
      entries.push(applySlugDecision(change, decision));
      continue;
    }
    if (change.field === 'brand_id') {
      const mappingEntry = findBrandEntry(audit, change.recordId);
      const decision = mappingEntry ? brandByKey.get(mappingEntry.comparisonKey) : undefined;
      entries.push(applyBrandDecision(change, decision));
      continue;
    }

    /* A purely deterministic normalisation with no decision against it stays
       UNRESOLVED. It is not promoted just because it is mechanical — the
       whole point of a reviewed plan is that a human saw it. */
    entries.push(entry(change, ENTRY_STATE.UNRESOLVED, 'planner', null));
  }

  /* An override naming something the planner never proposed is a reviewer
     ADDING a change. Kept, clearly marked, never silently dropped. */
  for (const [overrideKey, override] of overrideIndex) {
    if (usedOverrides.has(overrideKey)) continue;
    entries.push({
      recordType: override.recordType,
      recordId: override.recordId,
      field: override.field,
      currentValue: null,
      proposedValue: override.value,
      plannerProposedValue: null,
      reasonCode: 'REVIEWER_ADDED',
      confidence: CONFIDENCE.REVIEW_REQUIRED,
      state: ENTRY_STATE.APPROVED,
      origin: 'reviewer',
      rationale: override.rationale,
      overridden: true,
      requiresHumanApproval: true,
    });
  }

  entries.sort((a, b) =>
    compareText(a.recordType, b.recordType) || compareText(a.recordId, b.recordId) || compareText(a.field, b.field));

  const newBrands = (audit.plan.newBrands ?? []).map((proposal) => {
    const decision = [...brandByKey.values()].find((d) => cleanText(d.comparisonKey) !== '' && matchesNewBrand(audit, d, proposal));
    return {
      ...proposal,
      state: decision
        ? (decision.decision === 'CREATE_NEW_BRAND' ? ENTRY_STATE.APPROVED
          : decision.decision === 'REJECT' ? ENTRY_STATE.REJECTED : ENTRY_STATE.DEFERRED)
        : ENTRY_STATE.UNRESOLVED,
      rationale: decision?.rationale ?? null,
    };
  });

  return {
    contractVersion: audit.contractVersion,
    generatedFrom: { source: audit.input.source, exportedAt: audit.input.exportedAt },
    review: {
      reviewer: decisions.reviewer ?? null,
      reviewedAt: decisions.reviewedAt ?? null,
      notes: decisions.notes ?? null,
    },
    executable: false,
    containsSql: false,
    publicationsProposed: 0,
    summary: summarise(entries, newBrands, audit),
    entries,
    newBrands,
    /* Carried through untouched: an unresolved integrity finding must not
       vanish because a plan was reviewed. */
    outstandingIntegrityFindings: audit.integrity,
    outstandingHumanInputs: audit.plan.missingByRecord,
  };
}

function entry(change, state, origin, rationale, extra = {}) {
  return {
    recordType: change.recordType,
    recordId: change.recordId,
    field: change.field,
    currentValue: change.currentValue,
    proposedValue: change.proposedValue,
    plannerProposedValue: change.proposedValue,
    reasonCode: change.reasonCode,
    confidence: change.confidence,
    state,
    origin,
    rationale: rationale ?? null,
    overridden: false,
    requiresHumanApproval: change.requiresHumanApproval,
    ...extra,
  };
}

function applySlugDecision(change, decision) {
  if (!decision) return entry(change, ENTRY_STATE.UNRESOLVED, 'planner', null);
  if (decision.decision === 'APPROVE_PROPOSED') return entry(change, ENTRY_STATE.APPROVED, 'reviewer', decision.rationale);
  if (decision.decision === 'REJECT') return entry(change, ENTRY_STATE.REJECTED, 'reviewer', decision.rationale);
  if (decision.decision === 'DEFER') return entry(change, ENTRY_STATE.DEFERRED, 'reviewer', decision.rationale);
  return {
    ...entry(change, ENTRY_STATE.APPROVED, 'reviewer', decision.rationale),
    proposedValue: decision.slug,
    overridden: true,
  };
}

function applyBrandDecision(change, decision) {
  if (!decision) return entry(change, ENTRY_STATE.UNRESOLVED, 'planner', null);
  if (decision.decision === 'APPROVE_MATCH') {
    return { ...entry(change, ENTRY_STATE.APPROVED, 'reviewer', decision.rationale), proposedValue: decision.brandId,
      overridden: decision.brandId !== change.proposedValue };
  }
  if (decision.decision === 'REJECT') return entry(change, ENTRY_STATE.REJECTED, 'reviewer', decision.rationale);
  /* CREATE_NEW_BRAND and DEFER both leave the link outstanding: the brand
     does not exist yet, so there is no id to write. */
  return entry(change, ENTRY_STATE.DEFERRED, 'reviewer', decision.rationale);
}

function findBrandEntry(audit, productId) {
  return audit.mapping.byProductId?.get(productId)
    ?? audit.mapping.entries.find((e) => e.productIds.includes(productId))
    ?? null;
}

function matchesNewBrand(audit, decision, proposal) {
  const entryForKey = audit.mapping.byComparisonKey?.get(decision.comparisonKey);
  return Boolean(entryForKey) && entryForKey.proposedBrandSlug === proposal.proposedSlug;
}

function rationaleFor(list, predicate) {
  return (list ?? []).find(predicate)?.rationale ?? null;
}

function summarise(entries, newBrands, audit) {
  const tally = (list, keyFn) => {
    const out = {};
    for (const item of list) out[keyFn(item)] = (out[keyFn(item)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareText(a, b)));
  };
  const byState = tally(entries, (e) => e.state);
  for (const state of Object.values(ENTRY_STATE)) if (!(state in byState)) byState[state] = 0;

  return {
    entries: entries.length,
    byState: Object.fromEntries(Object.entries(byState).sort(([a], [b]) => compareText(a, b))),
    reviewerOverrides: entries.filter((e) => e.overridden).length,
    reviewerAdded: entries.filter((e) => e.reasonCode === 'REVIEWER_ADDED').length,
    newBrands: newBrands.length,
    newBrandsApproved: newBrands.filter((b) => b.state === ENTRY_STATE.APPROVED).length,
    outstandingIntegrityFindings: audit.integrity.length,
    outstandingHumanInputs: audit.plan.missingByRecord.length,
    publicationsProposed: 0,
  };
}

export const REVIEW_CONTRACT = Object.freeze({
  topLevel: [...TOP_LEVEL],
  brandDecisions: [...BRAND_DECISIONS],
  slugDecisions: [...SLUG_DECISIONS],
  overridableFields: [...OVERRIDABLE_FIELDS].sort(),
  forbiddenFields: Object.keys(FORBIDDEN_PROPOSAL_FIELDS).sort(),
});
