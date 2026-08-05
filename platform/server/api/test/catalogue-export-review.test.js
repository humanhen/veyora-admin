/* Catalogue export, review decisions and reviewed-plan generation
   (Fast-Track Phase 1, for B2.4C2).

   Real modules over synthetic fixtures with an injected database double. No
   live database, no real catalogue data, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportCatalogue, EXPORT_COLUMNS } from '../src/catalogue-audit/export.js';
import { validateReviewDecisions, buildReviewedPlan, ENTRY_STATE, REVIEW_CONTRACT } from '../src/catalogue-audit/review.js';
import { validateAuditInput } from '../src/catalogue-audit/input-schema.js';
import { auditCatalogue } from '../src/catalogue-audit/index.js';
import { run as runExportCli, parseArgs as parseExportArgs } from '../scripts/export-public-catalogue.js';
import { run as runPlanCli } from '../scripts/build-reviewed-plan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `veyora-ftw1-${name}-`));

/* ---------------------------------------------------------------------------
   Database double — records every statement so SQL safety is asserted against
   what the exporter ACTUALLY issued.
   --------------------------------------------------------------------------- */

const ROW = {
  brand: {
    id: 'br_1', slug: 'essedue', name: 'Essedue', publication_state: 'approved',
    verification_status: 'verified', source_reference: 'Brand book p12',
  },
  product: {
    id: 'p_1', sku: '20894', name: 'Aviator', brand: 'Essedue', brand_id: 'br_1',
    categories: ['Men'], line: 'Heritage', shape: 'Pilot', segment: 'premium',
    public_slug: 'aviator', public_description: 'Approved copy that must never leave the database.',
    is_active: true, is_published: false, is_featured: false, is_discontinued: false,
    replacement_product_id: null, publication_state: 'approved', verification_status: 'verified',
    source_reference: 'Catalogue 2026 p8', last_reviewed_at: new Date('2026-07-01T00:00:00Z'),
    scheduled_review_at: null, content_updated_at: new Date('2026-08-01T00:00:00Z'),
  },
  variation: {
    id: 'v_1', product_id: 'p_1', sku: '20894.1', color: 'Black', color_code: 'BLK-01',
    is_active: true, is_published: false, swatch_media_id: 'med_2',
  },
  media: { id: 'med_1', owner_type: 'product', owner_id: 'p_1', kind: 'image' },
};

function makeDb(over = {}) {
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (/from brands/i.test(sql)) return { rows: over.brands ?? [ROW.brand] };
      if (/from products/i.test(sql)) return { rows: over.products ?? [ROW.product] };
      if (/from variations/i.test(sql)) return { rows: over.variations ?? [ROW.variation] };
      if (/from media/i.test(sql)) return { rows: over.media ?? [ROW.media] };
      return { rows: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// exporter — SQL safety
// ---------------------------------------------------------------------------

test('the exporter selects explicit columns and never uses SELECT *', async () => {
  const db = makeDb();
  await exportCatalogue(db);
  assert.equal(db.statements.length, 4);
  for (const s of db.statements) {
    assert.doesNotMatch(s.sql, /select\s+\*/i, s.sql);
    assert.doesNotMatch(s.sql, /\b[a-z]\.\*/i, s.sql);
    assert.match(s.sql, /^select [a-z_]+, /i, 'must begin with an explicit column list');
  }
});

test('the exporter never selects forbidden commercial, stock or supplier columns', async () => {
  const db = makeDb();
  await exportCatalogue(db);
  const allSql = db.statements.map((s) => s.sql).join('\n').toLowerCase();
  for (const forbidden of [
    'price', 'sale_price', 'purchase_price', 'cost', 'margin', 'stock', 'stock_status',
    'qty', 'warehouse', 'zoho_item_id', 'attributes', 'ean', 'tags', 'images',
    'fact_owner', 'rights_holder', 'rights_expiry',
  ]) {
    assert.ok(!allSql.includes(forbidden), `the exporter selected "${forbidden}"`);
  }
});

test('the exporter never touches a customer, order, payment or credential table', async () => {
  const db = makeDb();
  await exportCatalogue(db);
  const allSql = db.statements.map((s) => s.sql).join('\n').toLowerCase();
  for (const table of ['users', 'orders', 'order_items', 'invoices', 'payments', 'credit_notes',
    'carts', 'stock', 'warehouses', 'purchase_orders', 'audit_log', 'account_permissions']) {
    assert.ok(!new RegExp(`(from|join)\\s+${table}\\b`).test(allSql), `the exporter read ${table}`);
  }
});

test('the exporter issues no write SQL and opens no transaction', async () => {
  const db = makeDb();
  await exportCatalogue(db);
  for (const s of db.statements) {
    assert.match(s.sql, /^\s*select\b/i, `not a SELECT: ${s.sql}`);
    assert.doesNotMatch(s.sql, /\b(insert|update|delete|alter|drop|truncate|begin|commit|rollback)\b/i);
  }
  // And there is no tx() usage at all — the double does not even provide one.
  assert.equal(typeof db.tx, 'undefined');
});

test('the exporter source contains no write SQL and no embedded connection', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'src', 'catalogue-audit', 'export.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.doesNotMatch(code, /insert into|update\s+\w+\s+set|delete from|\btx\(/i);
  assert.doesNotMatch(code, /DATABASE_URL|process\.env|postgres:\/\/|new Pool/);
  assert.doesNotMatch(code, /veyora\.(design|com|net)|\b\d{1,3}(\.\d{1,3}){3}\b/);
});

// ---------------------------------------------------------------------------
// exporter — output contract
// ---------------------------------------------------------------------------

test('the export validates against the audit input contract', async () => {
  const fixture = await exportCatalogue(makeDb(), { source: 'synthetic' });
  const result = validateAuditInput(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? []));
});

test('the export can be audited end to end without a database', async () => {
  const fixture = await exportCatalogue(makeDb(), { source: 'synthetic' });
  const audit = auditCatalogue(fixture);
  assert.equal(audit.summary.products, 1);
  assert.equal(audit.summary.publicationsProposed, 0);
});

test('description and source reference are exported as presence booleans only', async () => {
  const fixture = await exportCatalogue(makeDb());
  const json = JSON.stringify(fixture);
  assert.ok(!json.includes('Approved copy'), 'description text leaked into the export');
  assert.ok(!json.includes('Catalogue 2026 p8'), 'source reference text leaked into the export');
  assert.equal(fixture.products[0].hasPublicDescription, true);
  assert.equal(fixture.products[0].hasSourceReference, true);
  assert.equal(fixture.brands[0].hasSourceReference, true);
});

test('an empty description or source reference reads as absent', async () => {
  const db = makeDb({ products: [{ ...ROW.product, public_description: '   ', source_reference: '' }] });
  const fixture = await exportCatalogue(db);
  assert.equal(fixture.products[0].hasPublicDescription, false);
  assert.equal(fixture.products[0].hasSourceReference, false);
});

test('swatch media is exported as presence, not as an identifier', async () => {
  const fixture = await exportCatalogue(makeDb());
  assert.equal(fixture.variations[0].hasSwatchMedia, true);
  assert.ok(!JSON.stringify(fixture.variations[0]).includes('med_2'));
});

test('media is restricted to product owners and carries no path or rights data', async () => {
  const db = makeDb();
  await exportCatalogue(db);
  const mediaSql = db.statements.find((s) => /from media/i.test(s.sql)).sql;
  assert.match(mediaSql, /where owner_type = 'product'/);
  assert.doesNotMatch(mediaSql, /path|alt|rights/i);
});

test('ordering is deterministic and repeated exports are byte-identical', async () => {
  const db = makeDb();
  await exportCatalogue(db);
  for (const s of db.statements) assert.match(s.sql, /order by id asc/i);

  const at = new Date('2026-08-06T00:00:00Z');
  const a = JSON.stringify(await exportCatalogue(makeDb(), { source: 's', exportedAt: at }));
  const b = JSON.stringify(await exportCatalogue(makeDb(), { source: 's', exportedAt: at }));
  assert.equal(a, b);
});

test('the exposed column lists match what is selected', async () => {
  const db = makeDb();
  await exportCatalogue(db);
  const sql = db.statements.map((s) => s.sql).join('\n');
  for (const columns of Object.values(EXPORT_COLUMNS)) assert.ok(sql.includes(columns));
});

// ---------------------------------------------------------------------------
// export CLI
// ---------------------------------------------------------------------------

test('the export CLI refuses a URL destination and requires .json', () => {
  assert.ok(parseExportArgs(['--output', 'https://x/y.json']).errors.some((e) => /local file path/i.test(e)));
  assert.ok(parseExportArgs(['--output', 'out.csv']).errors.some((e) => /\.json/i.test(e)));
  assert.ok(parseExportArgs([]).errors.some((e) => /--output is required/.test(e)));
});

test('the export CLI does not overwrite by default, and does with the flag', async () => {
  const dir = tmpDir('export-cli');
  const file = path.join(dir, 'export.json');
  const getDb = async () => makeDb();
  try {
    assert.equal(await runExportCli(['--output', file], { stdout: { write() {} }, getDb }), 0);
    fs.writeFileSync(file, 'ANNOTATED', 'utf8');

    assert.equal(await runExportCli(['--output', file], { stdout: { write() {} }, getDb }), 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'ANNOTATED', 'the existing file must survive');

    assert.equal(await runExportCli(['--output', file, '--overwrite'], { stdout: { write() {} }, getDb }), 0);
    assert.notEqual(fs.readFileSync(file, 'utf8'), 'ANNOTATED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the export CLI prints counts and a path, never records or credentials', async () => {
  const dir = tmpDir('export-print');
  try {
    const chunks = [];
    await runExportCli(['--output', path.join(dir, 'e.json'), '--source', 'synthetic'],
      { stdout: { write: (s) => chunks.push(s) }, getDb: async () => makeDb() });
    const printed = chunks.join('');
    assert.match(printed, /READ-ONLY/);
    assert.match(printed, /models\s+1/);
    for (const leak of ['Approved copy', 'Catalogue 2026', 'DATABASE_URL', 'postgres://', 'Aviator', '20894']) {
      assert.ok(!printed.includes(leak), `printed "${leak}"`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the export CLI writes no SQL file and creates only the JSON output', async () => {
  const dir = tmpDir('export-files');
  try {
    await runExportCli(['--output', path.join(dir, 'out', 'e.json')],
      { stdout: { write() {} }, getDb: async () => makeDb() });
    assert.deepEqual(fs.readdirSync(path.join(dir, 'out')), ['e.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// review decision format
// ---------------------------------------------------------------------------

const decisionsOf = (over = {}) => ({
  reviewer: 'A Reviewer', reviewedAt: '2026-08-06T09:00:00.000Z',
  brandDecisions: [], slugDecisions: [], fieldOverrides: [], exclusions: [], ...over,
});

test('a valid review file is accepted', () => {
  const r = validateReviewDecisions(decisionsOf());
  assert.equal(r.ok, true);
});

test('an unknown top-level key or record field is rejected', () => {
  assert.equal(validateReviewDecisions({ ...decisionsOf(), publishNow: true }).ok, false);
  const r = validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'APPROVE_PROPOSED', rationale: 'ok', extra: 1 }],
  }));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'UNKNOWN_FIELD');
});

test('publication directives are refused, by name and with a reason', () => {
  for (const field of ['is_published', 'publication_state', 'verification_status',
    'source_reference', 'last_reviewed_at', 'approver_id', 'approved_at', 'fact_owner']) {
    const r = validateReviewDecisions(decisionsOf({
      fieldOverrides: [{ recordType: 'product', recordId: 'p_1', field, value: 'published', rationale: 'because' }],
    }));
    assert.equal(r.ok, false, `${field} was accepted`);
    const e = r.errors.find((x) => x.path.endsWith('.field'));
    assert.equal(e.code, 'FORBIDDEN_FIELD', field);
    assert.match(e.message, /cannot be decided in a review file/);
  }
});

test('a non-overridable but non-forbidden field is refused distinctly', () => {
  const r = validateReviewDecisions(decisionsOf({
    fieldOverrides: [{ recordType: 'product', recordId: 'p_1', field: 'sku', value: 'X', rationale: 'because' }],
  }));
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'NOT_OVERRIDABLE');
});

test('every override must name a record, a field and a rationale', () => {
  for (const missing of ['recordId', 'field', 'rationale', 'recordType']) {
    const override = { recordType: 'product', recordId: 'p_1', field: 'line', value: 'X', rationale: 'because' };
    delete override[missing];
    const r = validateReviewDecisions(decisionsOf({ fieldOverrides: [override] }));
    assert.equal(r.ok, false, `${missing} was optional`);
  }
});

test('an invalid decision verb or a missing target is rejected', () => {
  assert.equal(validateReviewDecisions(decisionsOf({
    brandDecisions: [{ comparisonKey: 'kyme', decision: 'MAYBE', rationale: 'x' }],
  })).ok, false);
  assert.equal(validateReviewDecisions(decisionsOf({
    brandDecisions: [{ comparisonKey: 'kyme', decision: 'APPROVE_MATCH', brandId: null, rationale: 'x' }],
  })).ok, false);
  assert.equal(validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'REPLACE', slug: null, rationale: 'x' }],
  })).ok, false);
});

test('a replacement slug must be a usable public slug', () => {
  for (const slug of ['Not A Slug', 'brands', '', 'a--b', '/x/']) {
    const r = validateReviewDecisions(decisionsOf({
      slugDecisions: [{ productId: 'p_1', decision: 'REPLACE', slug, rationale: 'x' }],
    }));
    assert.equal(r.ok, false, slug);
  }
  assert.equal(validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'REPLACE', slug: 'aviator-classic', rationale: 'x' }],
  })).ok, true);
});

test('the review contract is exposed and lists the forbidden fields', () => {
  assert.ok(REVIEW_CONTRACT.forbiddenFields.includes('is_published'));
  assert.ok(REVIEW_CONTRACT.forbiddenFields.includes('publication_state'));
  assert.ok(!REVIEW_CONTRACT.overridableFields.includes('is_published'));
});

// ---------------------------------------------------------------------------
// reviewed plan
// ---------------------------------------------------------------------------

async function auditFixture(over = {}) {
  const fixture = await exportCatalogue(makeDb(over), { source: 'synthetic' });
  return auditCatalogue(fixture);
}

/** A catalogue whose brand is new and whose slug needs proposing. */
const NEEDS_WORK = {
  brands: [],
  products: [{ ...ROW.product, brand: 'Kyme', brand_id: null, public_slug: null, line: '  Heritage  ' }],
};

test('an unresolved proposal stays unresolved — silence is never approval', async () => {
  const audit = await auditFixture(NEEDS_WORK);
  const plan = buildReviewedPlan(audit, validateReviewDecisions(decisionsOf()).decisions);

  assert.ok(plan.entries.length > 0);
  for (const e of plan.entries) {
    assert.equal(e.state, ENTRY_STATE.UNRESOLVED, `${e.field} was resolved without a decision`);
    assert.equal(e.origin, 'planner');
    assert.equal(e.rationale, null);
  }
  assert.equal(plan.summary.byState.approved, 0);
});

test('an explicitly approved slug becomes approved and records the reviewer', async () => {
  const audit = await auditFixture(NEEDS_WORK);
  const decisions = validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'APPROVE_PROPOSED', slug: null, rationale: 'Matches the model name.' }],
  })).decisions;
  const plan = buildReviewedPlan(audit, decisions);

  const slug = plan.entries.find((e) => e.field === 'public_slug');
  assert.equal(slug.state, ENTRY_STATE.APPROVED);
  assert.equal(slug.origin, 'reviewer');
  assert.equal(slug.rationale, 'Matches the model name.');
  assert.equal(slug.proposedValue, 'aviator');
});

test('a reviewer replacement overrides the proposal and both values are kept', async () => {
  const audit = await auditFixture(NEEDS_WORK);
  const decisions = validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'REPLACE', slug: 'aviator-classic', rationale: 'Marketing prefers this.' }],
  })).decisions;
  const plan = buildReviewedPlan(audit, decisions);

  const slug = plan.entries.find((e) => e.field === 'public_slug');
  assert.equal(slug.state, ENTRY_STATE.APPROVED);
  assert.equal(slug.proposedValue, 'aviator-classic');
  assert.equal(slug.plannerProposedValue, 'aviator', 'the machine proposal must remain visible');
  assert.equal(slug.overridden, true);
});

test('a rejected proposal stays rejected and is not silently dropped', async () => {
  const audit = await auditFixture(NEEDS_WORK);
  const decisions = validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'REJECT', slug: null, rationale: 'Model is being renamed.' }],
  })).decisions;
  const plan = buildReviewedPlan(audit, decisions);

  const slug = plan.entries.find((e) => e.field === 'public_slug');
  assert.equal(slug.state, ENTRY_STATE.REJECTED);
  assert.equal(slug.rationale, 'Model is being renamed.');
  assert.equal(plan.summary.byState.rejected >= 1, true);
});

test('an approved brand match is applied; CREATE_NEW_BRAND stays deferred', async () => {
  const audit = await auditFixture(NEEDS_WORK);

  const key = audit.mapping.entries[0].comparisonKey;
  const approved = buildReviewedPlan(audit, validateReviewDecisions(decisionsOf({
    brandDecisions: [{ comparisonKey: key, decision: 'APPROVE_MATCH', brandId: 'br_new', rationale: 'Created manually first.' }],
  })).decisions);
  const brandEntry = approved.entries.find((e) => e.field === 'brand_id');
  assert.equal(brandEntry.state, ENTRY_STATE.APPROVED);
  assert.equal(brandEntry.proposedValue, 'br_new');

  const deferred = buildReviewedPlan(audit, validateReviewDecisions(decisionsOf({
    brandDecisions: [{ comparisonKey: key, decision: 'CREATE_NEW_BRAND', brandId: null, rationale: 'Real brand, to be created.' }],
  })).decisions);
  const deferredEntry = deferred.entries.find((e) => e.field === 'brand_id');
  assert.equal(deferredEntry.state, ENTRY_STATE.DEFERRED, 'no id exists yet, so nothing can be written');
  assert.equal(deferred.newBrands[0].state, ENTRY_STATE.APPROVED);
});

test('an unresolved collision stays unresolved and its findings survive', async () => {
  const audit = await auditFixture({
    brands: [ROW.brand],
    products: [ROW.product, { ...ROW.product, id: 'p_2', public_slug: 'aviator-two' }],
  });
  const plan = buildReviewedPlan(audit, validateReviewDecisions(decisionsOf()).decisions);

  assert.ok(plan.outstandingIntegrityFindings.some((f) => f.code === 'DUPLICATE_SKU'),
    'a duplicate SKU must survive into the reviewed plan');
  assert.equal(plan.summary.outstandingIntegrityFindings, audit.integrity.length);
});

test('an exclusion rejects every proposal for that record', async () => {
  const audit = await auditFixture(NEEDS_WORK);
  const decisions = validateReviewDecisions(decisionsOf({
    exclusions: [{ recordType: 'product', recordId: 'p_1', rationale: 'Discontinued line, not going public.' }],
  })).decisions;
  const plan = buildReviewedPlan(audit, decisions);

  const forProduct = plan.entries.filter((e) => e.recordId === 'p_1');
  assert.ok(forProduct.length > 0);
  for (const e of forProduct) {
    assert.equal(e.state, ENTRY_STATE.REJECTED);
    assert.equal(e.rationale, 'Discontinued line, not going public.');
  }
});

test('a reviewer-added change the planner never proposed is kept and marked', async () => {
  const audit = await auditFixture();
  const decisions = validateReviewDecisions(decisionsOf({
    fieldOverrides: [{ recordType: 'product', recordId: 'p_1', field: 'segment', value: 'luxury', rationale: 'Repositioned.' }],
  })).decisions;
  const plan = buildReviewedPlan(audit, decisions);

  const added = plan.entries.find((e) => e.reasonCode === 'REVIEWER_ADDED');
  assert.ok(added, 'a reviewer addition must not be dropped');
  assert.equal(added.origin, 'reviewer');
  assert.equal(added.state, ENTRY_STATE.APPROVED);
  assert.equal(added.plannerProposedValue, null);
  assert.equal(plan.summary.reviewerAdded, 1);
});

test('deterministic proposals and human overrides stay distinguishable', async () => {
  const audit = await auditFixture(NEEDS_WORK);
  const decisions = validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'REPLACE', slug: 'aviator-classic', rationale: 'x' }],
  })).decisions;
  const plan = buildReviewedPlan(audit, decisions);

  for (const e of plan.entries) {
    assert.ok(['planner', 'reviewer'].includes(e.origin));
    if (e.origin === 'reviewer') assert.ok(e.rationale, `${e.field} has no rationale`);
    else assert.equal(e.state, ENTRY_STATE.UNRESOLVED);
  }
});

test('the reviewed plan is non-executable, SQL-free and proposes no publication', async () => {
  const audit = await auditFixture(NEEDS_WORK);
  const plan = buildReviewedPlan(audit, validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'APPROVE_PROPOSED', slug: null, rationale: 'ok' }],
  })).decisions);

  assert.equal(plan.executable, false);
  assert.equal(plan.containsSql, false);
  assert.equal(plan.publicationsProposed, 0);
  assert.equal(plan.summary.publicationsProposed, 0);

  const json = JSON.stringify(plan).toUpperCase();
  for (const keyword of ['INSERT INTO', 'UPDATE ', 'DELETE FROM', 'ALTER TABLE', 'DROP ', 'SELECT ']) {
    assert.ok(!json.includes(keyword), `the reviewed plan contains "${keyword}"`);
  }
  for (const e of plan.entries) {
    assert.ok(!['is_published', 'publication_state', 'verification_status'].includes(e.field));
  }
});

test('the reviewed plan carries no pricing, stock or private data', async () => {
  const audit = await auditFixture();
  const plan = buildReviewedPlan(audit, validateReviewDecisions(decisionsOf()).decisions);
  const json = JSON.stringify(plan).toLowerCase();
  for (const term of ['price', 'cost', 'margin', 'stock', 'qty', 'warehouse', 'customer',
    'invoice', 'zoho', 'approved copy', 'catalogue 2026']) {
    assert.ok(!json.includes(term), `the reviewed plan contains "${term}"`);
  }
});

test('reviewed-plan generation is deterministic', async () => {
  const audit = await auditFixture(NEEDS_WORK);
  const decisions = validateReviewDecisions(decisionsOf({
    slugDecisions: [{ productId: 'p_1', decision: 'APPROVE_PROPOSED', slug: null, rationale: 'ok' }],
  })).decisions;
  const a = JSON.stringify(buildReviewedPlan(audit, decisions));
  const b = JSON.stringify(buildReviewedPlan(audit, decisions));
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// reviewed-plan CLI, and the whole synthetic chain
// ---------------------------------------------------------------------------

test('the full synthetic chain runs export → audit → reviewed plan, byte-identically', async () => {
  const dir = tmpDir('chain');
  try {
    const exportFile = path.join(dir, 'export.json');
    const decisionsFile = path.join(dir, 'decisions.json');

    assert.equal(await runExportCli(['--output', exportFile, '--source', 'synthetic'],
      { stdout: { write() {} }, getDb: async () => makeDb(NEEDS_WORK) }), 0);

    fs.writeFileSync(decisionsFile, JSON.stringify(decisionsOf({
      slugDecisions: [{ productId: 'p_1', decision: 'APPROVE_PROPOSED', slug: null, rationale: 'ok' }],
    })), 'utf8');

    const planA = path.join(dir, 'plan-a.json');
    const planB = path.join(dir, 'plan-b.json');
    const args = (out) => ['--export', exportFile, '--decisions', decisionsFile, '--output', out];

    assert.equal(runPlanCli(args(planA), { stdout: { write() {} } }), 0);
    assert.equal(runPlanCli(args(planB), { stdout: { write() {} } }), 0);
    assert.equal(fs.readFileSync(planA, 'utf8'), fs.readFileSync(planB, 'utf8'));

    const plan = JSON.parse(fs.readFileSync(planA, 'utf8'));
    assert.equal(plan.executable, false);
    assert.equal(plan.publicationsProposed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the reviewed-plan CLI refuses to overwrite, and reports contract failures as exit 2', () => {
  const dir = tmpDir('plan-cli');
  try {
    const exportFile = path.join(dir, 'export.json');
    const decisionsFile = path.join(dir, 'decisions.json');
    const output = path.join(dir, 'plan.json');

    fs.writeFileSync(exportFile, JSON.stringify({ brands: [], products: [], variations: [], media: [] }), 'utf8');
    fs.writeFileSync(decisionsFile, JSON.stringify(decisionsOf()), 'utf8');
    const args = ['--export', exportFile, '--decisions', decisionsFile, '--output', output];

    assert.equal(runPlanCli(args, { stdout: { write() {} } }), 0);
    assert.equal(runPlanCli(args, { stdout: { write() {} } }), 1, 'must refuse to overwrite');
    assert.equal(runPlanCli([...args, '--overwrite'], { stdout: { write() {} } }), 0);

    fs.writeFileSync(decisionsFile, JSON.stringify({ publishEverything: true }), 'utf8');
    assert.equal(runPlanCli([...args, '--overwrite'], { stdout: { write() {} } }), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both CLIs offer help and neither imports a database at load time', () => {
  assert.equal(runPlanCli(['--help'], { stdout: { write() {} } }), 0);
  for (const file of ['export-public-catalogue.js', 'build-reviewed-plan.js']) {
    const source = fs.readFileSync(path.join(HERE, '..', 'scripts', file), 'utf8');
    /* Strip comments AND the help text: naming DATABASE_URL in --help is
       documentation an operator needs, not an embedded credential. What must
       never appear is an actual connection string, host or password. */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/const HELP = `[\s\S]*?`;/, 'const HELP = "";');

    assert.doesNotMatch(code, /^import .*db\.js/m, `${file} imports the database eagerly`);
    assert.doesNotMatch(code, /postgres(ql)?:\/\//i, `${file} embeds a connection string`);
    assert.doesNotMatch(code, /\b\d{1,3}(\.\d{1,3}){3}\b/, `${file} embeds a host address`);
    assert.doesNotMatch(code, /veyora\.(design|com|net)/i, `${file} embeds a production hostname`);
    assert.doesNotMatch(code, /password|secret|api[_-]?key/i, `${file} may embed a credential`);
    // The only DATABASE_URL reference is the lazy import of the shared module.
    assert.doesNotMatch(code, /process\.env\.DATABASE_URL/, `${file} reads the connection itself`);
  }
});
