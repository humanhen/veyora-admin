/* Catalogue readiness audit and dry-run backfill planner (B2.4C1).

   Real modules over synthetic fixtures. No live database, no real catalogue
   data, and no network. Temporary output goes to the OS temp directory and is
   removed afterwards. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAuditInput, AUDIT_INPUT_CONTRACT } from '../src/catalogue-audit/input-schema.js';
import {
  cleanText, comparisonKey, proposeSlug, isUsableSlug, proposeDeduplicatedSlug,
  normaliseCategories, normaliseColorCode, RESERVED_SLUGS, compareText,
} from '../src/catalogue-audit/normalise.js';
import { buildBrandMapping, BRAND_MATCH } from '../src/catalogue-audit/brand-mapping.js';
import { auditCatalogue, buildReports, writeReports, OUTCOME, CONFIDENCE } from '../src/catalogue-audit/index.js';
import { csvCell, toCsv } from '../src/catalogue-audit/report.js';
import { FORBIDDEN_PROPOSAL_FIELDS } from '../src/catalogue-audit/plan.js';
import { isValidSlug } from '../src/publication-gate.js';
import { parseArgs, run } from '../../api/scripts/audit-public-catalogue.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_SRC = path.join(HERE, '..', 'src', 'catalogue-audit');

/* ---------------------------------------------------------------------------
   Fixtures — synthetic throughout
   --------------------------------------------------------------------------- */

const brand = (over = {}) => ({
  id: 'br_1', slug: 'essedue', name: 'Essedue',
  publicationState: 'approved', verificationStatus: 'verified', hasSourceReference: true, ...over,
});

const product = (over = {}) => ({
  id: 'p_1', sku: '20894', name: 'Aviator', brand: 'Essedue', brandId: 'br_1',
  categories: ['Men'], line: 'Heritage', shape: 'Pilot', segment: 'premium',
  publicSlug: 'aviator', hasPublicDescription: true,
  isActive: true, isPublished: false, isFeatured: false, isDiscontinued: false,
  replacementProductId: null,
  publicationState: 'approved', verificationStatus: 'verified', hasSourceReference: true,
  lastReviewedAt: '2026-07-01T00:00:00.000Z', scheduledReviewAt: null,
  contentUpdatedAt: '2026-08-01T00:00:00.000Z', ...over,
});

const variation = (over = {}) => ({
  id: 'v_1', productId: 'p_1', sku: '20894.1', colorName: 'Black', colorCode: 'BLK-01',
  isActive: true, isPublished: false, hasSwatchMedia: true, ...over,
});

const media = (over = {}) => ({ id: 'med_1', ownerType: 'product', ownerId: 'p_1', kind: 'image', ...over });

const exportOf = (over = {}) => ({
  exportedAt: '2026-08-06T00:00:00.000Z', source: 'synthetic',
  brands: [brand()], products: [product()], variations: [variation()], media: [media()], ...over,
});

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `veyora-audit-${name}-`));
const outcomeOf = (audit, id) => audit.classifications.find((c) => c.productId === id)?.outcome;
const reasonsOf = (audit, id) => audit.classifications.find((c) => c.productId === id)?.reasonCodes ?? [];

// ---------------------------------------------------------------------------
// 1-8 — input safety
// ---------------------------------------------------------------------------

test('1 — a valid minimal export is accepted', () => {
  const result = validateAuditInput({ brands: [], products: [], variations: [], media: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.input.products, []);
});

test('2 — an unknown record field is rejected, not ignored', () => {
  const result = validateAuditInput(exportOf({ products: [{ ...product(), somethingNew: 'x' }] }));
  assert.equal(result.ok, false);
  const e = result.errors.find((x) => x.path.endsWith('.somethingNew'));
  assert.equal(e.code, 'UNKNOWN_FIELD');
});

test('2 — an unknown top-level key is rejected', () => {
  const result = validateAuditInput({ ...exportOf(), orders: [] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'UNKNOWN_TOP_LEVEL');
});

test('3 — price, stock, customer and supplier fields are rejected by name', () => {
  for (const [field, value] of [
    ['price', 100], ['salePrice', 90], ['purchasePrice', 40], ['cost', 10], ['margin', 0.5],
    ['stock', 5], ['stockStatus', 'in stock'], ['qty', 3], ['warehouse', 'w_1'],
    ['zohoItemId', 'z1'], ['factOwner', 'u_1'], ['rightsHolder', 'someone'],
  ]) {
    const result = validateAuditInput(exportOf({ products: [{ ...product(), [field]: value }] }));
    assert.equal(result.ok, false, `${field} was accepted`);
    const e = result.errors.find((x) => x.path.endsWith(`.${field}`));
    assert.ok(['EXCLUDED_FIELD', 'FORBIDDEN_FIELD'].includes(e.code), `${field}: ${e.code}`);
  }
});

test('3 — customer and order identity fields are rejected', () => {
  for (const field of ['customerId', 'email', 'phone', 'orderId', 'invoice', 'taxId', 'balance']) {
    const result = validateAuditInput(exportOf({ products: [{ ...product(), [field]: 'x' }] }));
    assert.equal(result.ok, false, `${field} was accepted`);
  }
});

test('4 — malformed arrays and objects are rejected', () => {
  assert.equal(validateAuditInput(exportOf({ products: 'nope' })).ok, false);
  assert.equal(validateAuditInput(exportOf({ products: [null] })).ok, false);
  assert.equal(validateAuditInput(exportOf({ products: [{ ...product(), categories: 'Men' }] })).ok, false);
  assert.equal(validateAuditInput(exportOf({ products: [{ ...product(), categories: [1, 2] }] })).ok, false);
  assert.equal(validateAuditInput(exportOf({ products: [{ ...product(), isActive: 'yes' }] })).ok, false);
  assert.equal(validateAuditInput(exportOf({ products: [{ ...product(), lastReviewedAt: 'not-a-date' }] })).ok, false);
  assert.equal(validateAuditInput([]).ok, false);
  assert.equal(validateAuditInput(null).ok, false);
});

test('5 — the unrestricted attributes blob is rejected', () => {
  const result = validateAuditInput(exportOf({ products: [{ ...product(), attributes: { lens_w: 54 } }] }));
  assert.equal(result.ok, false);
  const e = result.errors.find((x) => x.path.endsWith('.attributes'));
  assert.equal(e.code, 'EXCLUDED_FIELD');
  assert.match(e.message, /not constrained/i);
});

test('5 — description and source text are excluded in favour of presence booleans', () => {
  for (const field of ['description', 'publicDescription', 'sourceReference', 'tags', 'images', 'ean']) {
    const result = validateAuditInput(exportOf({ products: [{ ...product(), [field]: 'x' }] }));
    assert.equal(result.ok, false, `${field} was accepted`);
  }
});

test('a missing required field is reported', () => {
  const { sku, ...withoutSku } = product();
  const result = validateAuditInput(exportOf({ products: [withoutSku] }));
  assert.equal(result.ok, false);
  assert.equal(result.errors.find((x) => x.path.endsWith('.sku')).code, 'MISSING_FIELD');
});

test('6 — a URL input is rejected by the CLI', () => {
  for (const url of ['https://example.test/export.json', 'http://x/y.json', 'file://x/y.json']) {
    const { errors } = parseArgs(['--input', url, '--output', 'out']);
    assert.ok(errors.some((e) => /local file path/i.test(e)), url);
  }
});

test('7 — a missing input file exits non-zero', () => {
  const written = [];
  const code = run(['--input', path.join(os.tmpdir(), 'definitely-not-here.json'), '--output', os.tmpdir()],
    { stdout: { write: (s) => written.push(s) } });
  assert.equal(code, 1);
});

test('7 — missing arguments exit non-zero', () => {
  assert.equal(run(['--input', 'x.json'], { stdout: { write() {} } }), 1);
  assert.equal(run(['--output', 'x'], { stdout: { write() {} } }), 1);
  assert.equal(run(['--bogus'], { stdout: { write() {} } }), 1);
});

test('8 — no audit module imports a database driver or connection', () => {
  for (const file of fs.readdirSync(AUDIT_SRC)) {
    const source = fs.readFileSync(path.join(AUDIT_SRC, file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    assert.doesNotMatch(code, /from\s+['"]pg['"]|require\(['"]pg['"]\)/, `${file} imports pg`);
    assert.doesNotMatch(code, /\.\.\/db\.js/, `${file} imports the database module`);
    assert.doesNotMatch(code, /DATABASE_URL|process\.env/, `${file} reads the environment`);
    assert.doesNotMatch(code, /\bfetch\s*\(|node:https?\b/, `${file} performs network access`);
  }
  const cli = fs.readFileSync(path.join(HERE, '..', 'scripts', 'audit-public-catalogue.js'), 'utf8');
  assert.doesNotMatch(cli.replace(/\/\*[\s\S]*?\*\//g, ' '), /from\s+['"]pg['"]|DATABASE_URL/);
});

// ---------------------------------------------------------------------------
// 9-17 — normalisation
// ---------------------------------------------------------------------------

test('9 — normalisation is deterministic across repeated calls', () => {
  const samples = ['  Essedue  Occhiali ', 'Café Noir', "MEN'S & WOMEN'S", '20894 — Aviator'];
  for (const s of samples) {
    const a = proposeSlug(s), b = proposeSlug(s);
    assert.deepEqual(a, b);
    assert.equal(comparisonKey(s), comparisonKey(s));
  }
});

test('10 — Unicode is normalised: composed and decomposed spellings agree', () => {
  const composed = 'Café';          // é
  const decomposed = 'Café';       // e + combining acute
  assert.equal(cleanText(composed), cleanText(decomposed));
  assert.equal(comparisonKey(composed), comparisonKey(decomposed));
  assert.deepEqual(proposeSlug(composed), proposeSlug(decomposed));
  assert.equal(proposeSlug(composed).slug, 'cafe');
});

test('11 — whitespace and case differences normalise to one brand key', () => {
  const keys = ['Essedue', '  essedue ', 'ESSEDUE', 'Es­sedue'.replace('­', ''), 'Essedue '];
  const set = new Set(keys.map(comparisonKey));
  assert.equal(set.size, 1, `expected one key, got ${[...set].join(' | ')}`);
});

test('12 — unsafe punctuation is removed from slugs', () => {
  assert.equal(proposeSlug('Aviator / Pilot (2026)!').slug, 'aviator-pilot-2026');
  assert.equal(proposeSlug('A+B=C').slug, 'a-b-c');
  assert.equal(proposeSlug('“Quoted” — Model').slug, 'quoted-model');
});

test('13 — repeated separators collapse to one hyphen', () => {
  assert.equal(proposeSlug('a   b---c___d').slug, 'a-b-c-d');
  assert.equal(proposeSlug('---leading and trailing---').slug, 'leading-and-trailing');
});

test('14 — a slug that would be empty is rejected, never id-derived', () => {
  for (const s of ['', '   ', '###', '!!!', '—', null, undefined]) {
    const r = proposeSlug(s);
    assert.equal(r.ok, false, JSON.stringify(s));
    assert.equal(r.code, 'SLUG_EMPTY');
  }
});

test('15 — a reserved public route name is rejected as a slug', () => {
  for (const reserved of ['brands', 'collections', 'contact', 'sitemap', 'admin', 'api', 'terms']) {
    assert.equal(proposeSlug(reserved).ok, false, reserved);
    assert.equal(proposeSlug(reserved).code, 'SLUG_RESERVED');
    assert.equal(isUsableSlug(reserved), false);
  }
  assert.ok(RESERVED_SLUGS.includes('brands'));
});

test('every proposed slug also satisfies the API publication gate', () => {
  for (const name of ['Aviator', 'Café Noir', "Men's & Women's", '20894 Pilot', 'a'.repeat(200)]) {
    const r = proposeSlug(name);
    if (!r.ok) continue;
    assert.equal(isValidSlug(r.slug), true, `${r.slug} would be rejected by the gate`);
  }
});

test('16 — an existing valid, unique slug is preserved unchanged', () => {
  const audit = auditCatalogue(exportOf());
  const plan = audit.plan.changes.filter((c) => c.field === 'public_slug');
  assert.deepEqual(plan, [], 'a usable existing slug must not be churned');
  assert.equal(audit.classifications[0].proposedSlug, 'aviator');
});

test('17 — a slug collision produces a review item, never a silent overwrite', () => {
  const audit = auditCatalogue(exportOf({
    products: [
      product({ id: 'p_1', sku: '1', name: 'Aviator', publicSlug: null }),
      product({ id: 'p_2', sku: '2', name: 'Aviator', publicSlug: null }),
    ],
    variations: [], media: [],
  }));
  const slugs = audit.plan.changes.filter((c) => c.field === 'public_slug');
  assert.equal(slugs.length, 2);
  assert.deepEqual(slugs.map((c) => c.proposedValue).sort(), ['aviator', 'aviator-2']);

  const suffixed = slugs.find((c) => c.proposedValue === 'aviator-2');
  assert.equal(suffixed.confidence, CONFIDENCE.REVIEW_REQUIRED);
  assert.equal(suffixed.requiresHumanApproval, true);
  assert.ok(reasonsOf(audit, suffixed.recordId).includes('SLUG_NEEDS_REVIEW'));
});

test('a de-duplication suffix is deterministic and never reuses a claimed slug', () => {
  const taken = new Set(['aviator', 'aviator-2']);
  assert.deepEqual(proposeDeduplicatedSlug('aviator', taken), { ok: true, slug: 'aviator-3', suffixed: true });
  assert.deepEqual(proposeDeduplicatedSlug('aviator', taken), { ok: true, slug: 'aviator-3', suffixed: true });
  assert.equal(proposeDeduplicatedSlug('pilot', taken).slug, 'pilot');
});

test('categories normalise, de-duplicate and order stably', () => {
  assert.deepEqual(normaliseCategories([' Men ', 'men', 'Women', '', null, 'Acetate']), ['Acetate', 'Men', 'Women']);
  assert.deepEqual(normaliseCategories(null), []);
});

test('colour codes normalise to uppercase alphanumerics and hyphens', () => {
  assert.equal(normaliseColorCode(' blk-01 '), 'BLK-01');
  assert.equal(normaliseColorCode('hav/02'), 'HAV02');
  assert.equal(normaliseColorCode('--a--b--'), 'A-B');
});

// ---------------------------------------------------------------------------
// 18-23 — brand mapping
// ---------------------------------------------------------------------------

const mappingFor = (brands, products) => buildBrandMapping(brands, products);

test('18 — an exact brand match is classified EXACT and needs no approval', () => {
  const m = mappingFor([brand()], [product({ brand: 'Essedue' })]);
  assert.equal(m.entries.length, 1);
  assert.equal(m.entries[0].classification, BRAND_MATCH.EXACT);
  assert.equal(m.entries[0].proposedBrandId, 'br_1');
  assert.equal(m.entries[0].requiresHumanApproval, false);
});

test('19 — a case or accent difference is a NORMALISED match', () => {
  for (const value of ['  ESSEDUE ', 'essedue', 'ESSEDUÉ']) {
    const m = mappingFor([brand()], [product({ brand: value })]);
    assert.equal(m.entries[0].classification, BRAND_MATCH.NORMALISED, value);
    assert.equal(m.entries[0].proposedBrandId, 'br_1');
    assert.match(m.entries[0].notes[0], /normalisation/i);
  }
});

test('19 — a whitespace-only difference is an EXACT match once cleaned', () => {
  /* Deliberate: cleaning is documented and lossless for whitespace, so
     "Essedue " and "Essedue" are the same name rather than a variant worth
     flagging. Case and accent differences still surface as NORMALISED so a
     reviewer can see the import was inconsistent. */
  for (const value of ['Essedue ', '  Essedue', 'Essedue  Occhiali'.replace('  Occhiali', '')]) {
    const m = mappingFor([brand()], [product({ brand: value })]);
    assert.equal(m.entries[0].classification, BRAND_MATCH.EXACT, value);
    assert.equal(m.entries[0].proposedBrandId, 'br_1');
  }
});

test('20 — an unmatched value proposes a NEW brand, with name and slug only', () => {
  const m = mappingFor([brand()], [product({ brand: 'Kyme' })]);
  const entry = m.entries.find((e) => e.originalValue === 'Kyme');
  assert.equal(entry.classification, BRAND_MATCH.PROPOSED_NEW);
  assert.equal(entry.proposedBrandName, 'Kyme');
  assert.equal(entry.proposedBrandSlug, 'kyme');
  assert.equal(entry.proposedBrandId, null, 'a new brand has no id until a human creates it');
  assert.equal(entry.requiresHumanApproval, true);
});

test('21 — two existing brands normalising alike leave the value AMBIGUOUS', () => {
  const m = mappingFor(
    [brand({ id: 'br_1', name: 'Extreme Next', slug: 'extreme-next' }),
     brand({ id: 'br_2', name: 'EXTREME-NEXT', slug: 'extreme-next-2' })],
    [product({ brand: 'Extreme Next' })]
  );
  const entry = m.entries[0];
  assert.equal(entry.classification, BRAND_MATCH.AMBIGUOUS);
  assert.equal(entry.proposedBrandId, null, 'ambiguity must never resolve to a guess');
  assert.deepEqual(entry.candidateBrandIds, ['br_1', 'br_2']);
  assert.equal(entry.requiresHumanApproval, true);
});

test('22 — a missing brand value is classified MISSING and blocks the model', () => {
  const audit = auditCatalogue(exportOf({ products: [product({ brand: '  ' })] }));
  assert.equal(audit.mapping.entries[0].classification, BRAND_MATCH.MISSING);
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.NEEDS_BRAND_MAPPING ?? OUTCOME.NEEDS_BRAND);
  assert.ok(reasonsOf(audit, 'p_1').includes('BRAND_MISSING'));
});

test('23 — visually similar but distinct names are never fuzzily merged', () => {
  const m = mappingFor(
    [brand({ id: 'br_1', name: 'Kyme', slug: 'kyme' })],
    [product({ id: 'p_1', sku: '1', brand: 'Kyrne' }), product({ id: 'p_2', sku: '2', brand: 'Kyme' })]
  );
  const kyrne = m.entries.find((e) => e.originalValue === 'Kyrne');
  assert.equal(kyrne.classification, BRAND_MATCH.PROPOSED_NEW,
    'a one-character difference must not be absorbed into an existing brand');
  assert.equal(kyrne.proposedBrandId, null);

  const kyme = m.entries.find((e) => e.originalValue === 'Kyme');
  assert.equal(kyme.proposedBrandId, 'br_1');
});

test('23 — the mapping code contains no fuzzy-matching machinery', () => {
  const source = fs.readFileSync(path.join(AUDIT_SRC, 'brand-mapping.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.doesNotMatch(source, /levenshtein|jaro|soundex|similarity|distance|fuzzy/i);
});

test('spelling variants of one value are collected for review', () => {
  const m = mappingFor([], [
    product({ id: 'p_1', sku: '1', brand: 'Kyme' }),
    product({ id: 'p_2', sku: '2', brand: 'KYME' }),
    product({ id: 'p_3', sku: '3', brand: 'kyme' }),
  ]);
  assert.equal(m.entries.length, 1);
  assert.equal(m.entries[0].productCount, 3);
  assert.deepEqual(m.entries[0].spellingVariants.map((v) => v.value).sort(), ['KYME', 'Kyme', 'kyme']);
});

// ---------------------------------------------------------------------------
// 24-32 — readiness
// ---------------------------------------------------------------------------

test('24 — a structurally complete model reaches READY_FOR_EDITORIAL_REVIEW and nothing more', () => {
  const audit = auditCatalogue(exportOf());
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.READY);
  assert.deepEqual(reasonsOf(audit, 'p_1'), [], 'ready means no outstanding reasons');

  // Ready is NOT publishable: nothing proposes publication.
  assert.equal(audit.summary.publicationsProposed, 0);
  assert.equal(audit.plan.changes.some((c) => c.field === 'is_published'), false);
});

test('25 — a missing description is classified', () => {
  const audit = auditCatalogue(exportOf({ products: [product({ hasPublicDescription: false })] }));
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.NEEDS_DESCRIPTION);
  assert.ok(reasonsOf(audit, 'p_1').includes('NO_PUBLIC_DESCRIPTION'));
});

test('26 — a model with no colourway is classified', () => {
  const audit = auditCatalogue(exportOf({ variations: [] }));
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.NEEDS_VARIATION);
  assert.ok(reasonsOf(audit, 'p_1').includes('NO_VARIATIONS'));
});

test('27 — a model with no approved media is classified', () => {
  const audit = auditCatalogue(exportOf({ media: [] }));
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.NEEDS_MEDIA);
  assert.ok(reasonsOf(audit, 'p_1').includes('NO_APPROVED_MEDIA'));
});

test('28 — missing governance is classified, per field', () => {
  const cases = [
    [{ hasSourceReference: false }, 'NO_SOURCE_REFERENCE'],
    [{ lastReviewedAt: null }, 'NOT_REVIEWED'],
    [{ verificationStatus: 'sourced' }, 'NOT_VERIFIED'],
  ];
  for (const [over, code] of cases) {
    const audit = auditCatalogue(exportOf({ products: [product(over)] }));
    assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.NEEDS_GOVERNANCE, code);
    assert.ok(reasonsOf(audit, 'p_1').includes(code));
  }
});

test('29 — an inactive model is excluded and receives no proposals', () => {
  const audit = auditCatalogue(exportOf({
    products: [product({ isActive: false, publicSlug: null, brandId: null })],
  }));
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.EXCLUDED);
  assert.ok(reasonsOf(audit, 'p_1').includes('PRODUCT_INACTIVE'));
  assert.equal(audit.plan.changes.filter((c) => c.recordId === 'p_1').length, 0,
    'an excluded model must generate no work');
  assert.equal(audit.plan.missingByRecord.filter((m) => m.recordId === 'p_1').length, 0);
});

test('30 — a duplicate SKU classifies as DUPLICATE_OR_COLLISION', () => {
  const audit = auditCatalogue(exportOf({
    products: [product({ id: 'p_1', publicSlug: 'a' }), product({ id: 'p_2', publicSlug: 'b' })],
  }));
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.COLLISION);
  assert.equal(outcomeOf(audit, 'p_2'), OUTCOME.COLLISION);
  assert.ok(reasonsOf(audit, 'p_1').includes('DUPLICATE_SKU'));
});

test('31 — every secondary reason is retained alongside the single outcome', () => {
  const audit = auditCatalogue(exportOf({
    products: [product({ hasPublicDescription: false, hasSourceReference: false, verificationStatus: 'unverified', lastReviewedAt: null })],
    media: [],
  }));
  const codes = reasonsOf(audit, 'p_1');
  for (const expected of ['NO_PUBLIC_DESCRIPTION', 'NO_APPROVED_MEDIA', 'NO_SOURCE_REFERENCE', 'NOT_REVIEWED', 'NOT_VERIFIED']) {
    assert.ok(codes.includes(expected), `missing ${expected}`);
  }
  const outcomes = new Set(audit.classifications.map((c) => c.outcome));
  assert.equal(outcomes.size, 1, 'exactly one top-level outcome per model');
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.NEEDS_MEDIA, 'the highest-priority outcome wins');
});

test('32 — no record is ever made automatically publishable', () => {
  const audit = auditCatalogue(exportOf({
    products: [product(), product({ id: 'p_2', sku: '2', publicSlug: 'b' })],
    variations: [variation(), variation({ id: 'v_2', productId: 'p_2', sku: '2.1' })],
    media: [media(), media({ id: 'med_2', ownerId: 'p_2' })],
  }));
  assert.equal(audit.summary.publicationsProposed, 0);
  for (const c of audit.plan.changes) {
    assert.ok(!['is_published', 'publication_state'].includes(c.field), `proposed ${c.field}`);
  }
  const json = JSON.stringify(audit.plan);
  assert.doesNotMatch(json, /"proposedValue"\s*:\s*"published"/);
  assert.equal(audit.classifications.every((c) => c.outcome !== 'PUBLISHED'), true);
});

// ---------------------------------------------------------------------------
// 33-39 — integrity
// ---------------------------------------------------------------------------

const findingCodes = (audit) => audit.integrity.map((f) => f.code);

test('33 — a duplicate SKU is reported', () => {
  const audit = auditCatalogue(exportOf({
    products: [product({ id: 'p_1', publicSlug: 'a' }), product({ id: 'p_2', publicSlug: 'b' })],
  }));
  const f = audit.integrity.find((x) => x.code === 'DUPLICATE_SKU');
  assert.ok(f);
  assert.deepEqual(f.recordIds, ['p_1', 'p_2']);
});

test('34 — a duplicate existing public slug is reported', () => {
  const audit = auditCatalogue(exportOf({
    products: [product({ id: 'p_1', sku: '1' }), product({ id: 'p_2', sku: '2' })],
  }));
  assert.ok(findingCodes(audit).includes('DUPLICATE_PUBLIC_SLUG'));
});

test('35 — self-replacement is reported', () => {
  const audit = auditCatalogue(exportOf({ products: [product({ replacementProductId: 'p_1' })] }));
  assert.ok(findingCodes(audit).includes('REPLACEMENT_SELF'));
  assert.ok(reasonsOf(audit, 'p_1').includes('REPLACEMENT_SELF'));
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.MANUAL);
});

test('36 — a missing replacement target is reported', () => {
  const audit = auditCatalogue(exportOf({ products: [product({ replacementProductId: 'p_gone' })] }));
  const f = audit.integrity.find((x) => x.code === 'REPLACEMENT_MISSING');
  assert.ok(f);
  assert.deepEqual(f.recordIds, ['p_1']);
});

test('37 — duplicate colours within a model are reported', () => {
  const audit = auditCatalogue(exportOf({
    variations: [variation({ id: 'v_1', colorName: 'Black' }), variation({ id: 'v_2', sku: '20894.2', colorName: ' black ' })],
  }));
  assert.ok(findingCodes(audit).includes('DUPLICATE_VARIATION_COLOUR'));
  assert.ok(reasonsOf(audit, 'p_1').includes('VARIATION_DUPLICATE_COLOUR'));
});

test('38 — a malformed colour code is reported', () => {
  const audit = auditCatalogue(exportOf({ variations: [variation({ colorCode: '!!!' })] }));
  assert.ok(findingCodes(audit).includes('MALFORMED_COLOUR_CODE'));
  assert.ok(reasonsOf(audit, 'p_1').includes('VARIATION_MALFORMED_COLOUR_CODE'));
});

test('39 — a published flag inconsistent with governance is reported', () => {
  const audit = auditCatalogue(exportOf({ products: [product({ isPublished: true, publicationState: 'approved' })] }));
  assert.ok(findingCodes(audit).includes('PUBLISHED_STATE_INCONSISTENT'));
  assert.equal(outcomeOf(audit, 'p_1'), OUTCOME.MANUAL);
});

test('an orphaned colourway and a missing colour name are reported', () => {
  const audit = auditCatalogue(exportOf({
    variations: [variation({ id: 'v_x', productId: 'p_gone' }), variation({ id: 'v_y', sku: 'z', colorName: '' })],
  }));
  assert.ok(findingCodes(audit).includes('VARIATION_ORPHANED'));
  assert.ok(findingCodes(audit).includes('VARIATION_NO_COLOUR'));
});

test('a brand slug collision is reported', () => {
  const audit = auditCatalogue(exportOf({
    brands: [brand({ id: 'br_1', slug: 'kyme', name: 'Kyme' }), brand({ id: 'br_2', slug: 'kyme', name: 'Kyme Eyewear' })],
  }));
  assert.equal(audit.brandSlugCollisions.length, 1);
  assert.equal(audit.brandSlugCollisions[0].slug, 'kyme');
});

// ---------------------------------------------------------------------------
// 40-45 — plan safety
// ---------------------------------------------------------------------------

test('40 — planned values are deterministic across repeated audits', () => {
  const input = exportOf({
    products: [product({ id: 'p_1', sku: '2', publicSlug: null, brand: ' essedue ' }),
               product({ id: 'p_2', sku: '1', name: 'Aviator', publicSlug: null })],
    variations: [variation({ colorCode: ' blk-01 ' })],
  });
  const a = JSON.stringify(auditCatalogue(structuredClone(input)).plan);
  const b = JSON.stringify(auditCatalogue(structuredClone(input)).plan);
  assert.equal(a, b);
});

test('41 — proposals needing judgement are marked review_required and need approval', () => {
  const audit = auditCatalogue(exportOf({
    brands: [], products: [product({ brand: 'Kyme', brandId: null, publicSlug: null })],
  }));
  const brandChange = audit.plan.changes.find((c) => c.field === 'brand_id');
  assert.equal(brandChange.confidence, CONFIDENCE.REVIEW_REQUIRED);
  assert.equal(brandChange.requiresHumanApproval, true);
  assert.equal(brandChange.proposedValue, null, 'a brand that does not exist cannot be proposed as a value');
  assert.deepEqual(brandChange.dependsOn, ['brand:kyme']);
});

test('41 — a deterministic proposal is marked deterministic', () => {
  const audit = auditCatalogue(exportOf({ variations: [variation({ colorCode: ' blk-01 ' })] }));
  const change = audit.plan.changes.find((c) => c.field === 'color_code');
  assert.equal(change.proposedValue, 'BLK-01');
  assert.equal(change.confidence, CONFIDENCE.DETERMINISTIC);
  assert.equal(change.requiresHumanApproval, false);
});

test('42/43 — no proposal can set is_published or publication_state', () => {
  for (const field of ['is_published', 'publication_state']) {
    assert.ok(Object.prototype.hasOwnProperty.call(FORBIDDEN_PROPOSAL_FIELDS, field));
  }
  const audit = auditCatalogue(exportOf({
    products: [product({ publicSlug: null, hasPublicDescription: false, hasSourceReference: false, verificationStatus: 'unverified', lastReviewedAt: null })],
  }));
  for (const c of audit.plan.changes) {
    assert.ok(!Object.prototype.hasOwnProperty.call(FORBIDDEN_PROPOSAL_FIELDS, c.field), `proposed ${c.field}`);
  }
});

test('44 — descriptions, source references, review dates and media are reported missing, never invented', () => {
  const audit = auditCatalogue(exportOf({
    products: [product({ hasPublicDescription: false, hasSourceReference: false, verificationStatus: 'unverified', lastReviewedAt: null })],
    media: [],
  }));
  const missing = audit.plan.missingByRecord.filter((m) => m.recordId === 'p_1');
  const fields = missing.map((m) => m.field).sort();
  assert.deepEqual(fields, ['last_reviewed_at', 'media', 'public_description', 'source_reference', 'verification_status']);
  for (const m of missing) assert.equal(m.mustBeSuppliedBy, 'human');

  // And no change proposes a value for any of them.
  for (const c of audit.plan.changes) {
    assert.ok(!fields.includes(c.field), `proposed a value for ${c.field}`);
  }
});

test('44 — a proposed new brand carries no invented editorial copy', () => {
  const audit = auditCatalogue(exportOf({ brands: [], products: [product({ brand: 'Kyme', brandId: null })] }));
  const proposal = audit.plan.newBrands[0];
  assert.deepEqual(Object.keys(proposal).sort(),
    ['fieldsRequiringHumanInput', 'productCount', 'proposedName', 'proposedSlug', 'requiresHumanApproval', 'sourceValue']);
  assert.equal(proposal.requiresHumanApproval, true);
  assert.ok(proposal.fieldsRequiringHumanInput.includes('summary'));
  assert.ok(proposal.fieldsRequiringHumanInput.includes('source_reference'));
});

test('45 — no report contains executable SQL', () => {
  const audit = auditCatalogue(exportOf({
    products: [product({ publicSlug: null, brand: 'Kyme', brandId: null })],
    brands: [],
  }));
  for (const report of buildReports(audit)) {
    const upper = report.content.toUpperCase();
    for (const keyword of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'ALTER TABLE', 'DROP ', 'SELECT ', 'COMMIT;']) {
      assert.ok(!upper.includes(keyword), `${report.name} contains "${keyword}"`);
    }
  }
});

test('no report leaks pricing, stock or customer data', () => {
  const audit = auditCatalogue(exportOf());
  for (const report of buildReports(audit)) {
    const lower = report.content.toLowerCase();
    for (const term of ['price', 'cost', 'margin', 'stock', 'qty', 'warehouse', 'customer', 'invoice', 'zoho']) {
      assert.ok(!lower.includes(term), `${report.name} contains "${term}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// 46-53 — output
// ---------------------------------------------------------------------------

test('46 — a comma is quoted', () => {
  assert.equal(csvCell('Black, Havana'), '"Black, Havana"');
});

test('47 — a quote is doubled and the field quoted', () => {
  assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
});

test('48 — a line break is quoted, not emitted raw', () => {
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell('a\r\nb'), '"a\r\nb"');
});

test('49 — a formula prefix is neutralised', () => {
  for (const payload of ['=cmd|calc', '+1+1', '-1+1', '@SUM(A1)', '\tx', '\rx']) {
    const cell = csvCell(payload);
    assert.ok(cell.replace(/^"/, '').startsWith("'"), `${JSON.stringify(payload)} → ${cell}`);
  }
  // And a payload that is also comma-bearing is both neutralised and quoted.
  assert.equal(csvCell('=1,2'), `"'=1,2"`);
  // Ordinary text is untouched.
  assert.equal(csvCell('Aviator'), 'Aviator');
});

test('a hostile catalogue value survives into CSV as inert text', () => {
  const audit = auditCatalogue(exportOf({
    // A classic spreadsheet RCE payload, plus a comma, a quote and a newline.
    products: [product({ name: '=cmd|\'/c calc\'!A1, "danger"\nsecond line' })],
  }));
  const csv = buildReports(audit).find((r) => r.name === 'product-readiness.csv').content;
  assert.ok(csv.includes(`"'=cmd`), 'the formula prefix must be neutralised');
  assert.ok(!/(^|\r\n)=cmd/.test(csv), 'no cell may begin a formula');
});

test('CSV uses RFC 4180 line endings and a header row', () => {
  const csv = toCsv([{ key: 'a', header: 'col_a' }, { key: 'b', header: 'col_b' }], [{ a: 1, b: 2 }]);
  assert.equal(csv, 'col_a,col_b\r\n1,2\r\n');
});

test('50 — existing outputs are not overwritten without the flag', () => {
  const dir = tmpDir('overwrite');
  try {
    const reports = buildReports(auditCatalogue(exportOf()));
    writeReports(dir, reports);
    const before = fs.readFileSync(path.join(dir, 'summary.json'), 'utf8');
    fs.writeFileSync(path.join(dir, 'summary.json'), 'ANNOTATED BY A REVIEWER', 'utf8');

    assert.throws(() => writeReports(dir, reports), (e) => {
      assert.equal(e.code, 'WOULD_OVERWRITE');
      assert.match(e.message, /--overwrite/);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'), 'ANNOTATED BY A REVIEWER',
      'the reviewer’s file must survive');
    assert.ok(before.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('51 — the overwrite flag replaces files in a temporary directory', () => {
  const dir = tmpDir('overwrite-flag');
  try {
    const reports = buildReports(auditCatalogue(exportOf()));
    writeReports(dir, reports);
    fs.writeFileSync(path.join(dir, 'summary.json'), 'stale', 'utf8');
    const written = writeReports(dir, reports, { overwrite: true });
    assert.equal(written.length, 6);
    assert.notEqual(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'), 'stale');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an output directory is required', () => {
  assert.throws(() => writeReports('', []), (e) => e.code === 'NO_OUTPUT_DIR');
});

test('52 — output ordering is stable regardless of input order', () => {
  const records = [
    product({ id: 'p_3', sku: '3', name: 'Cee', publicSlug: 'cee' }),
    product({ id: 'p_1', sku: '1', name: 'Aye', publicSlug: 'aye' }),
    product({ id: 'p_2', sku: '2', name: 'Bee', publicSlug: 'bee' }),
  ];
  const forward = auditCatalogue(exportOf({ products: structuredClone(records), variations: [], media: [] }));
  const reversed = auditCatalogue(exportOf({ products: structuredClone(records).reverse(), variations: [], media: [] }));

  assert.deepEqual(forward.classifications.map((c) => c.productId), ['p_1', 'p_2', 'p_3']);
  assert.equal(JSON.stringify(forward.classifications), JSON.stringify(reversed.classifications));
  assert.equal(JSON.stringify(forward.plan), JSON.stringify(reversed.plan));
  assert.equal(JSON.stringify(forward.integrity), JSON.stringify(reversed.integrity));
});

test('52 — the whole report set is byte-identical across two runs', () => {
  const input = exportOf({
    products: [product(), product({ id: 'p_2', sku: '2', name: 'Aviator', publicSlug: null, brand: 'Kyme', brandId: null })],
  });
  const a = buildReports(auditCatalogue(structuredClone(input))).map((r) => r.name + ' ' + r.content).join('');
  const b = buildReports(auditCatalogue(structuredClone(input))).map((r) => r.name + ' ' + r.content).join('');
  assert.equal(a, b);
});

test('summary counts every outcome and brand classification, including zeros', () => {
  const audit = auditCatalogue(exportOf());
  for (const outcome of Object.values(OUTCOME)) {
    assert.equal(typeof audit.summary.outcomes[outcome], 'number', `missing ${outcome}`);
  }
  for (const cls of Object.values(BRAND_MATCH)) {
    assert.equal(typeof audit.summary.brandClassifications[cls], 'number', `missing ${cls}`);
  }
  assert.equal(audit.summary.publicationsProposed, 0);
});

test('53 — the CLI help succeeds and describes the dry-run boundary', () => {
  const chunks = [];
  const code = run(['--help'], { stdout: { write: (s) => chunks.push(s) } });
  assert.equal(code, 0);
  const help = chunks.join('');
  assert.match(help, /DRY-RUN/);
  assert.match(help, /no database is contacted/i);
  assert.match(help, /--overwrite/);
});

test('the CLI runs end to end over a synthetic fixture and mutates nothing', () => {
  const dir = tmpDir('cli');
  const inputFile = path.join(dir, 'export.json');
  try {
    fs.writeFileSync(inputFile, JSON.stringify(exportOf()), 'utf8');
    const chunks = [];
    const code = run(['--input', inputFile, '--output', path.join(dir, 'out')], { stdout: { write: (s) => chunks.push(s) } });
    assert.equal(code, 0);

    const printed = chunks.join('');
    assert.match(printed, /DRY RUN/);
    assert.match(printed, /publications proposed\s+0/);
    assert.match(printed, /Nothing has been applied/);

    const files = fs.readdirSync(path.join(dir, 'out')).sort();
    assert.deepEqual(files, [
      'audit-detail.json', 'brand-mapping-review.csv', 'integrity-findings.csv',
      'product-readiness.csv', 'proposed-changes.csv', 'summary.json',
    ]);
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'summary.json'), 'utf8'));
    assert.equal(summary.mode, 'DRY_RUN');
    assert.equal(summary.mutationsPerformed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an export failing the contract exits with code 2', () => {
  const dir = tmpDir('bad');
  const inputFile = path.join(dir, 'export.json');
  try {
    fs.writeFileSync(inputFile, JSON.stringify(exportOf({ products: [{ ...product(), price: 100 }] })), 'utf8');
    const code = run(['--input', inputFile, '--output', path.join(dir, 'out')], { stdout: { write() {} } });
    assert.equal(code, 2);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false, 'nothing may be written for an invalid export');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-JSON input file is refused', () => {
  const dir = tmpDir('ext');
  try {
    const file = path.join(dir, 'export.csv');
    fs.writeFileSync(file, 'a,b\n1,2', 'utf8');
    assert.equal(run(['--input', file, '--output', dir], { stdout: { write() {} } }), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the input contract is exposed for documentation and stays closed', () => {
  assert.deepEqual(AUDIT_INPUT_CONTRACT.topLevel.sort(),
    ['brands', 'exportedAt', 'media', 'products', 'source', 'variations']);
  assert.ok(AUDIT_INPUT_CONTRACT.excluded.includes('attributes'));
  assert.ok(AUDIT_INPUT_CONTRACT.excluded.includes('price'));
  assert.ok(!AUDIT_INPUT_CONTRACT.products.includes('price'));
});
