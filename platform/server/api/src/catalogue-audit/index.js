/* Catalogue readiness audit and dry-run backfill planner (B2.4C1).

   READ-ONLY BY CONSTRUCTION. This module imports no database driver, opens no
   connection, and reads no environment variable. Its only input is a parsed
   JSON export that has passed the closed allowlist in input-schema.js; its
   only output is a set of report artefacts. A test asserts that nothing under
   this directory imports `pg` or `../db.js`.

   The audit answers one question per record — "what would have to be true
   before a human could sensibly start editorial work on this?" — and produces
   proposals for the parts that are mechanical. Everything requiring judgement
   is reported as outstanding, never filled in. */

import { validateAuditInput, AuditInputError, AUDIT_INPUT_CONTRACT } from './input-schema.js';
import { buildBrandMapping, detectBrandSlugCollisions, BRAND_MATCH } from './brand-mapping.js';
import { buildIndexes, planSlugs, classifyProduct, detectIntegrityFindings, OUTCOME } from './readiness.js';
import { buildPlan, CONFIDENCE } from './plan.js';
import { buildReports, writeReports } from './report.js';
import { compareText, stableSort } from './normalise.js';

export const CONTRACT_VERSION = '2.4c1';

/**
 * Runs the complete audit over a validated export.
 *
 * @param raw the parsed JSON export
 * @returns the audit result (see buildReports for the artefact shapes)
 * @throws AuditInputError when the export does not satisfy the contract
 */
export function auditCatalogue(raw) {
  const validated = validateAuditInput(raw);
  if (!validated.ok) throw new AuditInputError(validated.errors);
  const input = validated.input;

  const indexes = buildIndexes(input);
  const mapping = buildBrandMapping(input.brands, input.products);
  const slugPlan = planSlugs(input, indexes);

  const classifications = stableSort(input.products, 'sku')
    .map((product) => classifyProduct(product, { indexes, mapping, slugPlan }));

  const integrity = detectIntegrityFindings(input, indexes, slugPlan);
  const brandSlugCollisions = detectBrandSlugCollisions(input.brands, mapping.entries);
  const plan = buildPlan({ input, indexes, mapping, slugPlan, classifications });

  return {
    contractVersion: CONTRACT_VERSION,
    input: { source: input.source, exportedAt: input.exportedAt },
    summary: summarise({ input, classifications, mapping, integrity, plan, brandSlugCollisions }),
    classifications,
    mapping,
    integrity,
    brandSlugCollisions,
    plan,
  };
}

function summarise({ input, classifications, mapping, integrity, plan, brandSlugCollisions }) {
  const tally = (list, keyFn) => {
    const out = {};
    for (const item of list) {
      const key = keyFn(item);
      out[key] = (out[key] ?? 0) + 1;
    }
    /* Sorted keys so two runs serialise identically — object key order is
       insertion order in JSON.stringify. */
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareText(a, b)));
  };

  const outcomes = tally(classifications, (c) => c.outcome);
  for (const outcome of Object.values(OUTCOME)) if (!(outcome in outcomes)) outcomes[outcome] = 0;

  const brandClasses = tally(mapping.entries, (e) => e.classification);
  for (const cls of Object.values(BRAND_MATCH)) if (!(cls in brandClasses)) brandClasses[cls] = 0;

  return {
    products: input.products.length,
    variations: input.variations.length,
    brands: input.brands.length,
    mediaReferences: input.media.length,
    outcomes: Object.fromEntries(Object.entries(outcomes).sort(([a], [b]) => compareText(a, b))),
    brandValues: mapping.entries.length,
    brandClassifications: Object.fromEntries(Object.entries(brandClasses).sort(([a], [b]) => compareText(a, b))),
    brandSlugCollisions: brandSlugCollisions.length,
    integrityFindings: integrity.length,
    integrityByCode: tally(integrity, (f) => f.code),
    proposedChanges: plan.changes.length,
    proposedChangesDeterministic: plan.changes.filter((c) => c.confidence === CONFIDENCE.DETERMINISTIC).length,
    proposedChangesRequiringApproval: plan.changes.filter((c) => c.requiresHumanApproval).length,
    outstandingHumanInputs: plan.missingByRecord.length,
    newBrandsProposed: plan.newBrands.length,
    /* Stated as a number so it appears in every report and can be asserted:
       this tool never publishes anything. */
    publicationsProposed: 0,
  };
}

export {
  AuditInputError, AUDIT_INPUT_CONTRACT,
  buildReports, writeReports,
  OUTCOME, BRAND_MATCH, CONFIDENCE,
};
