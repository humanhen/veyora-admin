/* Deterministic brand mapping for the catalogue audit (B2.4C1).

   The catalogue carries a free-text `brand` column from the Zoho/old-site
   import. The public site needs every model linked to a real `brands` row via
   `brand_id`. This module proposes that mapping — and, just as importantly,
   refuses to guess.

   THE RULE: a mapping is only ever proposed automatically when the match is
   EXACT or differs only by case, whitespace, accents or punctuation. Anything
   else is a review item. There is no edit-distance matching, no token
   overlap, no "closest match wins". Those techniques silently attach a model
   to the wrong brand, and on a public site that error is a wrong logo on a
   product page rather than a failed lookup someone notices.

   Visually similar but distinct names are exactly the case this protects: two
   real brands whose names differ by one character must both survive as
   separate review items, never be collapsed into one. */

import { canonicalBrandName, comparisonKey, isBlank, proposeSlug, isUsableSlug, compareText } from './normalise.js';

export const BRAND_MATCH = Object.freeze({
  EXACT: 'EXACT_MATCH',
  NORMALISED: 'NORMALISED_MATCH',
  PROPOSED_NEW: 'PROPOSED_NEW_BRAND',
  AMBIGUOUS: 'AMBIGUOUS',
  MISSING: 'MISSING',
  UNUSABLE: 'UNUSABLE',
});

/**
 * Builds the brand mapping plan.
 *
 * @param brands      existing brand records from the export
 * @param products    product records (their free-text `brand` is the input)
 * @returns {{entries:Array, byComparisonKey:Map}}
 */
export function buildBrandMapping(brands, products) {
  /* Index existing brands. A comparison key can legitimately collide — two
     real brands whose names differ only by punctuation — and when it does,
     EVERY product pointing at that key becomes ambiguous rather than being
     attached to whichever row happened to sort first. */
  const byExact = new Map();
  const byKey = new Map();
  for (const brand of brands) {
    const name = canonicalBrandName(brand.name);
    if (name !== '' && !byExact.has(name)) byExact.set(name, brand);
    const key = comparisonKey(brand.name);
    if (key === '') continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(brand);
  }

  /* Collect the distinct free-text values actually in use, with the products
     that use each. Grouped by comparison key so "ESSEDUE" and "Essedue "
     become one review item rather than two. */
  const groups = new Map();
  for (const product of products) {
    const raw = product.brand;
    const key = comparisonKey(raw);
    const bucket = groups.get(key) ?? { key, originals: new Map(), productIds: [] };
    const original = canonicalBrandName(raw);
    bucket.originals.set(original, (bucket.originals.get(original) ?? 0) + 1);
    bucket.productIds.push(product.id);
    groups.set(key, bucket);
  }

  const entries = [];
  for (const bucket of groups.values()) {
    /* The representative spelling is the most frequent one, ties broken
       byte-wise — deterministic, and it does not invent a spelling. */
    const originals = [...bucket.originals.entries()]
      .sort((a, b) => (b[1] - a[1]) || compareText(a[0], b[0]));
    const representative = originals[0]?.[0] ?? '';
    const productIds = [...bucket.productIds].sort(compareText);

    entries.push(classify({ bucket, representative, originals, productIds, byExact, byKey }));
  }

  entries.sort((a, b) => compareText(a.originalValue, b.originalValue) || compareText(a.comparisonKey, b.comparisonKey));

  const byComparisonKey = new Map(entries.map((e) => [e.comparisonKey, e]));
  /* Direct product → mapping lookup, so the plan builder never has to scan
     every entry per product (quadratic on a 1,300-model catalogue). */
  const byProductId = new Map();
  for (const entry of entries) {
    for (const id of entry.productIds) byProductId.set(id, entry);
  }
  return { entries, byComparisonKey, byProductId };
}

function classify({ bucket, representative, originals, productIds, byExact, byKey }) {
  const base = {
    comparisonKey: bucket.key,
    originalValue: representative,
    spellingVariants: originals.map(([value, count]) => ({ value, productCount: count })),
    productCount: productIds.length,
    productIds,
    proposedBrandId: null,
    proposedBrandName: null,
    proposedBrandSlug: null,
    requiresHumanApproval: true,
    notes: [],
  };

  if (isBlank(representative)) {
    return { ...base, classification: BRAND_MATCH.MISSING,
      notes: ['No brand value on the source record. A model cannot be published without a brand.'] };
  }

  const candidates = byKey.get(bucket.key) ?? [];

  if (candidates.length > 1) {
    /* Two existing brands normalise to the same key. Choosing either would
       be a coin flip with a public consequence. */
    return { ...base, classification: BRAND_MATCH.AMBIGUOUS,
      candidateBrandIds: candidates.map((b) => b.id).sort(compareText),
      notes: [`${candidates.length} existing brands normalise to the same name. A human must choose.`] };
  }

  if (candidates.length === 1) {
    const brand = candidates[0];
    const exact = byExact.get(representative);
    const isExact = exact && exact.id === brand.id && canonicalBrandName(brand.name) === representative;
    return {
      ...base,
      classification: isExact ? BRAND_MATCH.EXACT : BRAND_MATCH.NORMALISED,
      proposedBrandId: brand.id,
      proposedBrandName: canonicalBrandName(brand.name),
      proposedBrandSlug: brand.slug ?? null,
      /* An exact match is a deterministic fact; a normalised match differs
         only by case/whitespace/accents/punctuation and is still safe to
         apply automatically, but is flagged so a reviewer sees it happened. */
      requiresHumanApproval: false,
      notes: isExact ? [] : ['Matched after case, whitespace, accent and punctuation normalisation.'],
    };
  }

  /* No existing brand. A new one can be PROPOSED — never created here, and
     never with invented copy. Only the name and a slug are proposed; every
     editorial field (headline, summary, story, origins) stays empty for a
     human to supply. */
  const slug = proposeSlug(representative);
  if (!slug.ok) {
    return { ...base, classification: BRAND_MATCH.UNUSABLE,
      notes: [`A public slug could not be derived from this value (${slug.code}). Needs a usable brand name.`] };
  }
  return {
    ...base,
    classification: BRAND_MATCH.PROPOSED_NEW,
    proposedBrandName: representative,
    proposedBrandSlug: slug.slug,
    notes: ['No existing brand matches. A new brand record would have to be created and written by a human — this plan proposes only its name and slug.'],
  };
}

/** The resolution for one product, given the mapping. */
export function resolveProductBrand(product, mapping) {
  const entry = mapping.byComparisonKey.get(comparisonKey(product.brand));
  if (!entry) {
    return { classification: BRAND_MATCH.MISSING, entry: null, brandId: null, resolved: false };
  }
  const resolved = (entry.classification === BRAND_MATCH.EXACT || entry.classification === BRAND_MATCH.NORMALISED)
    && typeof entry.proposedBrandId === 'string';
  return { classification: entry.classification, entry, brandId: resolved ? entry.proposedBrandId : null, resolved };
}

/** Brand slug collisions among existing brands and newly proposed ones. */
export function detectBrandSlugCollisions(brands, mappingEntries) {
  const claims = new Map();
  const add = (slug, owner) => {
    if (!slug) return;
    if (!claims.has(slug)) claims.set(slug, []);
    claims.get(slug).push(owner);
  };

  for (const brand of brands) {
    if (isUsableSlug(brand.slug)) add(brand.slug, { kind: 'existing_brand', id: brand.id });
    else if (brand.slug !== null && brand.slug !== '') add(brand.slug, { kind: 'existing_brand_invalid_slug', id: brand.id });
  }
  for (const entry of mappingEntries) {
    if (entry.classification === BRAND_MATCH.PROPOSED_NEW) {
      add(entry.proposedBrandSlug, { kind: 'proposed_brand', id: entry.comparisonKey });
    }
  }

  const collisions = [];
  for (const [slug, owners] of claims) {
    if (owners.length > 1) {
      collisions.push({
        slug,
        owners: owners.slice().sort((a, b) => compareText(a.kind, b.kind) || compareText(a.id, b.id)),
      });
    }
  }
  return collisions.sort((a, b) => compareText(a.slug, b.slug));
}
