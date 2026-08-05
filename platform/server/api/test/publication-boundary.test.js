/* Publication-boundary regression suite (B2.4B2B).

   B2.4B2A found and closed a real bypass: because brands have no
   `is_published` column, `publication_state = 'published'` IS their
   publication flag, and it was PATCH-editable under `public_content.edit`
   alone — so edit could publish, skipping the publish capability, the gate
   and the approval record.

   This file exists to keep that closed. It asserts the boundary end to end:
   what PATCH refuses, what the governed endpoints require, and that the two
   capabilities stay independent. Real handlers and real middleware against
   controlled database doubles. No live database. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import adminPublicContentRouter, {
  patchAdminEntity,
  publishEntity,
  unpublishEntity,
  evaluateEntity,
  AdminApiError,
  PUBLIC_CONTENT_CAPABILITIES,
} from '../src/routes/admin-public-content.js';
import { makeConcurrencyToken, validateAdminPatch } from '../src/admin-public-serialize.js';
import { requirePermission } from '../src/permissions.js';

const UPDATED = new Date('2026-08-06T10:00:00.000Z');
const ACTOR = { id: 'u_pub', role: 'admin', email: 'pub@example.test', business: 'Veyora Ops' };

const brandRow = (over = {}) => ({
  id: 'br_1', slug: 'example-brand', name: 'Example Brand', short_name: '', segment: 'premium',
  headline: 'A headline', summary: 'A summary', story: '', ideal_retailer: '', price_tier_label: '',
  design_origin: '', manufacturing_origin: '', style_traits: [], approved_materials: [],
  logo_media_id: null, hero_media_id: null,
  publication_state: 'approved', verification_status: 'verified', source_reference: 'ref-1',
  fact_owner: null, last_reviewed_at: UPDATED, scheduled_review_at: null,
  content_updated_at: UPDATED, created_at: UPDATED, updated_at: UPDATED, ...over,
});

/** Fake db with a mutable brand row, recording every statement. */
function makeDb(brand, { duplicateSlug = false } = {}) {
  const statements = [];
  let committed = false, rolledBack = false;
  async function query(sql, params = []) {
    statements.push({ sql, params });
    if (/from brands where slug = /i.test(sql)) return { rows: duplicateSlug ? [{ id: 'br_other' }] : [] };
    if (/from brands where id = /i.test(sql)) return { rows: brand ? [brand] : [] };
    if (/^\s*update /i.test(sql)) return { rows: [], rowCount: 1 };
    if (/^\s*insert into content_approvals/i.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  }
  return {
    statements, query,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    async tx(fn) {
      try { const r = await fn({ query }); committed = true; return r; }
      catch (e) { rolledBack = true; throw e; }
    },
    updates() { return statements.filter((s) => /^\s*update /i.test(s.sql)); },
    approvals() { return statements.filter((s) => /insert into content_approvals/i.test(s.sql)); },
  };
}

const tokenFor = (row) => makeConcurrencyToken('brand', row.id, row.updated_at);

/** Runs a capability middleware with a permission-resolution double. */
function permissionDb(keys) {
  return {
    async query(sql, params = []) {
      if (/from account_permissions ap/.test(sql)) {
        const [, key] = params;
        return { rows: keys.includes(key) ? [{ permission_key: key }] : [] };
      }
      return { rows: [] };
    },
  };
}

function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    const res = { status: (code) => ({ json: (body) => resolve({ outcome: 'denied', code, body }) }) };
    mw(req, res, (err) => resolve(err ? { outcome: 'error', err } : { outcome: 'allowed' }));
  });
}

// ---------------------------------------------------------------------------
// 1/2 — PATCH cannot cross the boundary
// ---------------------------------------------------------------------------

test('1 — an edit-only account cannot PATCH a brand INTO published state', async () => {
  const brand = brandRow({ publication_state: 'approved' });
  const db = makeDb(brand);

  await assert.rejects(
    () => patchAdminEntity(db, 'brand', 'br_1', { publication_state: 'published', concurrencyToken: tokenFor(brand) }),
    (err) => {
      assert.ok(err instanceof AdminApiError);
      assert.equal(err.status, 400);
      assert.equal(err.body.code, 'PUBLICATION_BOUNDARY');
      assert.match(err.body.error, /publish endpoint/i);
      return true;
    }
  );
  assert.equal(db.updates().length, 0, 'no write may reach the brands table');
  assert.equal(db.approvals().length, 0, 'no approval may be recorded');
  assert.ok(db.rolledBack);
});

test('2 — an edit-only account cannot PATCH a published brand OUT of published state', async () => {
  const brand = brandRow({ publication_state: 'published' });
  const db = makeDb(brand);

  await assert.rejects(
    () => patchAdminEntity(db, 'brand', 'br_1', { publication_state: 'draft', concurrencyToken: tokenFor(brand) }),
    (err) => {
      assert.equal(err.body.code, 'PUBLICATION_BOUNDARY');
      assert.match(err.body.error, /unpublish endpoint/i);
      return true;
    }
  );
  assert.equal(db.updates().length, 0);
  assert.equal(brand.publication_state, 'published', 'the record stays published');
});

test('the boundary holds for every published-crossing transition, in both directions', async () => {
  for (const [from, to] of [
    ['draft', 'published'], ['verified', 'published'], ['approved', 'published'], ['retired', 'published'],
    ['published', 'draft'], ['published', 'verified'], ['published', 'approved'], ['published', 'retired'],
  ]) {
    const brand = brandRow({ publication_state: from });
    const db = makeDb(brand);
    await assert.rejects(
      () => patchAdminEntity(db, 'brand', 'br_1', { publication_state: to, concurrencyToken: tokenFor(brand) }),
      (err) => { assert.equal(err.body.code, 'PUBLICATION_BOUNDARY'); return true; },
      `${from} → ${to} must be refused`
    );
    assert.equal(db.updates().length, 0, `${from} → ${to} wrote something`);
  }
});

test('3 — ordinary editorial transitions remain possible through PATCH', async () => {
  for (const [from, to] of [
    ['draft', 'verified'], ['verified', 'approved'], ['approved', 'draft'],
    ['approved', 'retired'], ['retired', 'draft'],
  ]) {
    const brand = brandRow({ publication_state: from });
    const db = makeDb(brand);
    await assert.doesNotReject(
      () => patchAdminEntity(db, 'brand', 'br_1', { publication_state: to, concurrencyToken: tokenFor(brand) }),
      `${from} → ${to} must stay editable`
    );
    const update = db.updates().find((s) => /update brands/i.test(s.sql));
    assert.ok(update, `${from} → ${to} should have written`);
    assert.ok(update.params.includes(to), 'the new state must be a bound parameter');
  }
});

test('editing ordinary content on a published brand is still allowed', async () => {
  const brand = brandRow({ publication_state: 'published' });
  const db = makeDb(brand);
  await assert.doesNotReject(
    () => patchAdminEntity(db, 'brand', 'br_1', { headline: 'A new headline', concurrencyToken: tokenFor(brand) })
  );
  assert.equal(db.updates().length, 1);
});

test('8 — a record that fails the gate cannot be published by PATCHing state instead', async () => {
  /* A draft that could never pass: no slug, unverified, no source reference. */
  const brand = brandRow({ publication_state: 'draft', slug: '', verification_status: 'unverified', source_reference: '' });
  const db = makeDb(brand);

  const verdict = await evaluateEntity(db, 'brand', 'br_1');
  assert.equal(verdict.allowed, false, 'this fixture must genuinely fail the gate');

  await assert.rejects(
    () => patchAdminEntity(db, 'brand', 'br_1', { publication_state: 'published', concurrencyToken: tokenFor(brand) }),
    (err) => { assert.equal(err.body.code, 'PUBLICATION_BOUNDARY'); return true; }
  );
  assert.equal(db.updates().length, 0, 'the gate cannot be routed around');
});

test('`is_published` remains rejected outright by validation', () => {
  for (const entity of ['product', 'variation']) {
    const r = validateAdminPatch(entity, { is_published: true });
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].code, 'IMMUTABLE_FIELD');
  }
});

// ---------------------------------------------------------------------------
// 4/5/6/7 — the governed endpoints
// ---------------------------------------------------------------------------

test('4/5/6 — the publish endpoint runs the gate and records an approval', async () => {
  const brand = brandRow({ publication_state: 'approved' });
  const db = makeDb(brand);

  await publishEntity(db, 'brand', 'br_1', { token: tokenFor(brand), actor: ACTOR, note: 'signed off' });

  const update = db.updates().find((s) => /update brands/i.test(s.sql));
  assert.match(update.sql, /publication_state = 'published'/);

  const approval = db.approvals()[0];
  assert.ok(approval, 'an approval row must be written');
  assert.equal(approval.params[0], 'brand');
  assert.equal(approval.params[1], 'br_1');
  assert.equal(approval.params[2], 'publication');
  assert.equal(approval.params[3], 'u_pub', 'the approver is the authenticated actor');
  assert.equal(approval.params[5], 'signed off');
  assert.ok(db.committed);
});

test('5 — publishing a record that fails the gate is refused with its reasons, and writes nothing', async () => {
  const brand = brandRow({ publication_state: 'draft', slug: '', verification_status: 'unverified', source_reference: '' });
  const db = makeDb(brand);

  await assert.rejects(
    () => publishEntity(db, 'brand', 'br_1', { token: tokenFor(brand), actor: ACTOR }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.body.code, 'PUBLICATION_GATE_FAILED');
      assert.ok(Array.isArray(err.body.reasons) && err.body.reasons.length > 0);
      for (const r of err.body.reasons) {
        assert.equal(typeof r.code, 'string');
        assert.equal(typeof r.message, 'string');
      }
      return true;
    }
  );
  assert.equal(db.updates().length, 0, 'a failed gate must write nothing');
  assert.equal(db.approvals().length, 0, 'a failed gate must record no approval');
  assert.ok(db.rolledBack);
});

// ---------------------------------------------------------------------------
// The publication round trip — the deadlock B2.4B2B found and fixed
// ---------------------------------------------------------------------------

test('an APPROVED brand can be published — the state gate is no longer circular', async () => {
  /* Before B2.4B2B the gate demanded publication_state === 'published'
     before allowing a publish. Brands have no separate live flag, and
     B2.4B2A closed the PATCH route into that state, so no brand could ever
     be published. This is the regression test for that. */
  const brand = brandRow({ publication_state: 'approved' });
  const db = makeDb(brand);

  const verdict = await evaluateEntity(db, 'brand', 'br_1');
  assert.equal(verdict.allowed, true, `an approved brand must be publishable: ${JSON.stringify(verdict.reasons)}`);

  await assert.doesNotReject(() => publishEntity(db, 'brand', 'br_1', { token: tokenFor(brand), actor: ACTOR }));
  assert.match(db.updates()[0].sql, /publication_state = 'published'/);
});

test('unpublish then republish works — unpublication is not one-way', async () => {
  /* unpublishEntity returns a record to 'approved'. Under the old rule that
     state could never be published again, so withdrawing a record was
     irreversible through the API. */
  const brand = brandRow({ publication_state: 'published' });
  const db1 = makeDb(brand);
  await unpublishEntity(db1, 'brand', 'br_1', { token: tokenFor(brand), actor: ACTOR });
  assert.match(db1.updates()[0].sql, /publication_state = 'approved'/);

  const withdrawn = brandRow({ publication_state: 'approved' });
  const db2 = makeDb(withdrawn);
  const verdict = await evaluateEntity(db2, 'brand', 'br_1');
  assert.equal(verdict.allowed, true, 'a withdrawn record must be republishable');
  await assert.doesNotReject(() => publishEntity(db2, 'brand', 'br_1', { token: tokenFor(withdrawn), actor: ACTOR }));
});

test('states that are not signed off still block publication', async () => {
  for (const state of ['draft', 'verified', 'retired']) {
    const brand = brandRow({ publication_state: state });
    const verdict = await evaluateEntity(makeDb(brand), 'brand', 'br_1');
    assert.equal(verdict.allowed, false, `${state} must not be publishable`);
    await assert.rejects(
      () => publishEntity(makeDb(brand), 'brand', 'br_1', { token: tokenFor(brand), actor: ACTOR }),
      (err) => { assert.equal(err.status, 422); return true; }
    );
  }
});

test('gate reasons come back in deterministic order', async () => {
  const brand = brandRow({ publication_state: 'draft', slug: '', verification_status: 'unverified', source_reference: '', summary: '', headline: '' });
  const a = await evaluateEntity(makeDb(brand), 'brand', 'br_1');
  const b = await evaluateEntity(makeDb(brand), 'brand', 'br_1');
  assert.deepEqual(a.reasons.map((r) => r.code), b.reasons.map((r) => r.code));
  const codes = a.reasons.map((r) => r.code);
  assert.deepEqual(codes, [...codes].sort(), 'reasons must be sorted by code');
});

test('7 — the unpublish endpoint records a decision and preserves content', async () => {
  const brand = brandRow({ publication_state: 'published' });
  const db = makeDb(brand);

  await unpublishEntity(db, 'brand', 'br_1', { token: tokenFor(brand), actor: ACTOR, note: 'withdrawn' });

  const update = db.updates().find((s) => /update brands/i.test(s.sql));
  assert.match(update.sql, /publication_state = 'approved'/);

  const approval = db.approvals()[0];
  assert.equal(approval.params[2], 'unpublication');
  assert.equal(approval.params[3], 'u_pub');

  assert.ok(!db.statements.some((s) => /delete/i.test(s.sql)), 'unpublish must never delete');
  assert.ok(!db.statements.some((s) => /redirects/i.test(s.sql)), 'redirect history must be untouched');
});

test('unpublish is not gated — an unpublishable record can still be withdrawn', async () => {
  const brand = brandRow({ publication_state: 'published', slug: '', verification_status: 'unverified', source_reference: '' });
  const db = makeDb(brand);
  await assert.doesNotReject(() => unpublishEntity(db, 'brand', 'br_1', { token: tokenFor(brand), actor: ACTOR }));
  assert.ok(db.committed);
});

test('9 — a stale token on publish or unpublish writes no approval and no change', async () => {
  for (const fn of [publishEntity, unpublishEntity]) {
    const brand = brandRow({ publication_state: fn === publishEntity ? 'approved' : 'published' });
    const db = makeDb(brand);
    await assert.rejects(
      () => fn(db, 'brand', 'br_1', { token: 'brand:br_1:stale', actor: ACTOR }),
      (err) => { assert.equal(err.status, 409); assert.equal(err.body.code, 'STALE_TOKEN'); return true; }
    );
    assert.equal(db.updates().length, 0, 'a conflict must write nothing');
    assert.equal(db.approvals().length, 0, 'a conflict must record no approval');
    assert.ok(db.rolledBack);
  }
});

test('the approver identity is never taken from the caller-supplied body', async () => {
  const brand = brandRow({ publication_state: 'approved' });
  const db = makeDb(brand);
  /* publishEntity's signature accepts `actor` only from the router, which
     passes req.user. There is no path from a request body to approver_id. */
  await publishEntity(db, 'brand', 'br_1', { token: tokenFor(brand), actor: ACTOR, note: 'x' });
  assert.equal(db.approvals()[0].params[3], 'u_pub');

  const routerSource = (await import('node:fs')).readFileSync(
    new URL('../src/routes/admin-public-content.js', import.meta.url), 'utf8');
  const code = routerSource.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  assert.match(code, /actor: req\.user/);
  assert.doesNotMatch(code, /actor: req\.body|approver[iI]d.*req\.body/);
});

test('a missing actor records null rather than inventing an approver', async () => {
  const brand = brandRow({ publication_state: 'approved' });
  const db = makeDb(brand);
  await publishEntity(db, 'brand', 'br_1', { token: tokenFor(brand), actor: undefined });
  assert.equal(db.approvals()[0].params[3], null);
});

// ---------------------------------------------------------------------------
// 10 — capability independence
// ---------------------------------------------------------------------------

test('10 — edit and publish are independent capabilities on the routes', async () => {
  const editOnly = permissionDb([PUBLIC_CONTENT_CAPABILITIES.edit]);
  const publishOnly = permissionDb([PUBLIC_CONTENT_CAPABILITIES.publish]);
  const req = { user: { id: 'u_1', status: 'active', role: 'admin' } };

  // An editor cannot publish.
  assert.equal(
    (await runMiddleware(requirePermission(PUBLIC_CONTENT_CAPABILITIES.publish, { db: editOnly }), req)).outcome,
    'denied');
  // A publisher cannot edit.
  assert.equal(
    (await runMiddleware(requirePermission(PUBLIC_CONTENT_CAPABILITIES.edit, { db: publishOnly }), req)).outcome,
    'denied');
  // Each can do its own.
  assert.equal(
    (await runMiddleware(requirePermission(PUBLIC_CONTENT_CAPABILITIES.edit, { db: editOnly }), req)).outcome,
    'allowed');
  assert.equal(
    (await runMiddleware(requirePermission(PUBLIC_CONTENT_CAPABILITIES.publish, { db: publishOnly }), req)).outcome,
    'allowed');
});

test('10 — a publisher holding no view capability is still refused a read', async () => {
  const publishOnly = permissionDb([PUBLIC_CONTENT_CAPABILITIES.publish]);
  const req = { user: { id: 'u_1', status: 'active' } };
  assert.equal(
    (await runMiddleware(requirePermission(PUBLIC_CONTENT_CAPABILITIES.read, { db: publishOnly }), req)).outcome,
    'denied');
});

test('4 — publish, unpublish and evaluate keep their documented capability gates', () => {
  const routes = {};
  for (const layer of adminPublicContentRouter.stack) {
    if (layer.route) routes[Object.keys(layer.route.methods)[0].toUpperCase() + ' ' + layer.route.path] = layer.route.stack.length;
  }
  for (const seg of ['brands', 'products', 'variations']) {
    assert.equal(routes[`POST /${seg}/:id/publish`], 2, `${seg} publish must be capability gated`);
    assert.equal(routes[`POST /${seg}/:id/unpublish`], 2, `${seg} unpublish must be capability gated`);
    assert.equal(routes[`POST /${seg}/:id/evaluate`], 2, `${seg} evaluate must be capability gated`);
    assert.equal(routes[`PATCH /${seg}/:id`], 2, `${seg} patch must be capability gated`);
  }
});

test('evaluation is read-only — it never writes and never publishes', async () => {
  const brand = brandRow({ publication_state: 'draft' });
  const db = makeDb(brand);
  await evaluateEntity(db, 'brand', 'br_1');
  for (const s of db.statements) {
    assert.doesNotMatch(s.sql, /^\s*(update|insert|delete)/i, 'evaluate must not mutate');
  }
  assert.equal(brand.publication_state, 'draft');
});
