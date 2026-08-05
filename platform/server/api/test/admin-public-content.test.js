/* The public-content admin API (B2.4A) — real handlers against a
   controlled fake database.

   The fake `db` implements `.query()` and `.tx()`, matching what the
   handlers expect and mirroring this repository's existing convention for
   testing database logic without a live database (src/inventory.js's
   reserveTakes(client, ...), test/stock-guard.test.js's fakeClient()). The
   fake records every statement, so transactional behaviour, rollback and
   approval-row writes are asserted against what the handler ACTUALLY
   issued rather than assumed. No live database is contacted. */
/* MUST be the first import: the router imports authmw.js, which throws at
   module load without JWT_SECRET — deliberate fail-closed behaviour that is
   not weakened here. ESM evaluates imports in source order, so this sets
   the variable before the router module is evaluated. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeConcurrencyToken } from '../src/admin-public-serialize.js';
import { invalidatePublicCache, setCached, getCached, buildCacheKey } from '../src/public-cache.js';
import adminPublicContentRouter, {
  listAdminBrands,
  getAdminBrand,
  getAdminProduct,
  getAdminVariation,
  patchAdminEntity,
  evaluateEntity,
  publishEntity,
  unpublishEntity,
  AdminApiError,
  requirePublicContentAuth,
  PUBLIC_CONTENT_CAPABILITIES,
} from '../src/routes/admin-public-content.js';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const routerSource = fs.readFileSync(path.join(SRC, 'routes', 'admin-public-content.js'), 'utf8');
const routerCode = stripComments(routerSource);
const publicRouterCode = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'public.js'), 'utf8'));

const UPDATED = new Date('2026-08-06T10:00:00.000Z');
const ACTOR = { id: 'u_admin', role: 'admin', email: 'admin@example.test', business: 'Veyora Ops' };

const publishableBrand = () => ({
  id: 'br_1', slug: 'example-brand', name: 'Example Brand', short_name: '', segment: 'premium',
  headline: 'A headline', summary: 'A summary', story: '', ideal_retailer: '', price_tier_label: '',
  design_origin: '', manufacturing_origin: '', style_traits: [], approved_materials: [],
  logo_media_id: null, hero_media_id: null, publication_state: 'published',
  verification_status: 'verified', source_reference: 'ref-1', fact_owner: null,
  last_reviewed_at: UPDATED, scheduled_review_at: null, content_updated_at: UPDATED,
  created_at: UPDATED, updated_at: UPDATED,
});

const draftBrand = () => ({ ...publishableBrand(), publication_state: 'draft', verification_status: 'unverified', source_reference: '', last_reviewed_at: null });

const publishableProduct = () => ({
  id: 'p_1', sku: '20894', name: 'Aviator', brand: 'Legacy', public_slug: 'aviator', brand_id: 'br_1',
  line: '', shape: 'aviator', segment: '', size: 'Medium', public_description: 'desc',
  categories: ['Optical'], is_published: false, is_featured: false, is_discontinued: false,
  is_active: true, replacement_product_id: null, publication_state: 'published',
  verification_status: 'verified', source_reference: 'ref-2', fact_owner: null,
  last_reviewed_at: UPDATED, scheduled_review_at: null, content_updated_at: UPDATED,
  created_at: UPDATED, updated_at: UPDATED,
});

const publishableVariation = () => ({
  id: 'v_1', product_id: 'p_1', sku: '20894.1', color: 'Matte Black', color_code: 'BLK-01',
  swatch_media_id: null, is_published: false, is_active: true, created_at: UPDATED,
});

/**
 * Fake db. `rows` holds the canned result for each matched query pattern.
 * `failOn` makes a matching statement throw, so rollback can be exercised.
 */
function makeDb({ brand = null, product = null, variations = [], media = [], replacement = null, duplicateSlug = false, failOn = null } = {}) {
  const statements = [];
  let committed = false;
  let rolledBack = false;

  async function query(sql, params = []) {
    statements.push({ sql, params });
    if (failOn && failOn.test(sql)) throw new Error('simulated database failure');

    if (/from brands where slug = /i.test(sql)) return { rows: duplicateSlug ? [{ id: 'br_other' }] : [] };
    if (/from products where public_slug = /i.test(sql)) return { rows: duplicateSlug ? [{ id: 'p_other' }] : [] };
    if (/from brands where id = /i.test(sql)) return { rows: brand ? [brand] : [] };
    if (/from brands order by name/i.test(sql)) return { rows: brand ? [brand] : [] };
    if (/from products where id = \$1 limit 1/i.test(sql) && /is_published/.test(sql) && params[0] === replacement?.id) {
      return { rows: [replacement] };
    }
    if (/select id, is_published from products where id/i.test(sql)) return { rows: replacement ? [replacement] : [] };
    if (/from products where id = /i.test(sql)) return { rows: product ? [product] : [] };
    if (/from products\s+where \(\$3/i.test(sql)) return { rows: product ? [product] : [] };
    if (/from variations where product_id = /i.test(sql)) return { rows: variations };
    if (/from variations where id = /i.test(sql)) return { rows: variations.length ? [variations[0]] : [] };
    if (/from media where owner_type = 'product'/i.test(sql)) return { rows: media };
    if (/from media where id = /i.test(sql)) return { rows: media };
    if (/^\s*update /i.test(sql)) return { rows: [], rowCount: 1 };
    if (/^\s*insert into content_approvals/i.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  }

  return {
    statements,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
    query,
    async tx(fn) {
      try {
        const result = await fn({ query });
        committed = true;
        return result;
      } catch (err) {
        rolledBack = true;
        throw err;
      }
    },
    approvalWrites() {
      return statements.filter((s) => /insert into content_approvals/i.test(s.sql));
    },
    updateWrites() {
      return statements.filter((s) => /^\s*update /i.test(s.sql));
    },
  };
}

/* Cache probe: seed an entry, run an operation, and see whether it survived. */
function seedCache() {
  invalidatePublicCache();
  const key = buildCacheKey('brands', {});
  setCached(key, { brands: ['sentinel'] });
  return () => getCached(key) !== undefined;
}

// ---------------------------------------------------------------------------
// 1/2/3/4 — authentication and authorisation
// ---------------------------------------------------------------------------

/* B2.4P moved this router from a role check to per-account capabilities.
   The router-level gate now proves only IDENTITY; authority is the
   per-route capability middleware asserted below and in
   account-permissions.test.js. */

test('every route is gated: router-level authentication plus a per-route capability', () => {
  const middleware = adminPublicContentRouter.stack.filter((l) => !l.route);
  assert.equal(middleware.length, 1, 'expected exactly one router-level gate');
  for (const layer of adminPublicContentRouter.stack) {
    if (!layer.route) continue;
    assert.equal(layer.route.stack.length, 2, `${layer.route.path} lacks a capability middleware`);
  }
});

test('the authentication gate rejects an unauthenticated request with 401', async () => {
  const gate = requirePublicContentAuth();
  const req = { cookies: {}, headers: {} };
  /* requireAuth answers by calling res.status(401).json(...) and does NOT
     call next() — so the promise resolves on the json() call, not on next.
     Resolving on next() instead would hang forever, which is exactly the
     behaviour being asserted: an unauthenticated request must not fall
     through to a handler. */
  const result = await new Promise((resolve, reject) => {
    const res = {
      status: (code) => ({ json: (body) => resolve({ code, body }) }),
      cookie: () => {},
    };
    gate(req, res, () => reject(new Error('next() was called — the request was not rejected')));
  });
  assert.equal(result.code, 401);
  assert.deepEqual(result.body, { error: 'unauthorized' });
});

test('the gate reuses the existing authentication, not a second auth system', () => {
  assert.match(routerCode, /import \{ requireAuth \} from '\.\.\/authmw\.js'/);
  // No home-grown token/session parsing anywhere in this router.
  assert.doesNotMatch(routerCode, /jsonwebtoken|jwt\.|cookies\.veyora|hashToken/);
});

test('authority is the capability, not a role — no role name gates any route', () => {
  /* B2.4P: requireAuth() is called with NO role arguments. A role name here
     would be a bypass, letting any admin edit and publish public copy
     without a grant — the exact thing account-specific permissions exist to
     prevent. 'warehouse' remains excluded for the same reason it always
     was: public copy is not fulfilment work. */
  assert.match(routerCode, /requireAuth\(\)/);
  assert.doesNotMatch(routerCode, /requireAuth\('[^']*'/);
  assert.doesNotMatch(routerCode, /ADMIN_ROLES|AGENT_ROLES/);
  assert.doesNotMatch(routerCode, /'warehouse'|'admin'/);
  // Each capability used here is one of the four registered keys.
  for (const key of Object.values(PUBLIC_CONTENT_CAPABILITIES)) {
    assert.ok(
      ['public_content.view', 'public_content.edit', 'public_content.publish'].includes(key),
      `unexpected capability ${key}`
    );
  }
});

test('actor identity is taken from the authenticated context, never the request body', async () => {
  const db = makeDb({ brand: publishableBrand() });
  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  await publishEntity(db, 'brand', 'br_1', { token, actor: ACTOR, note: 'ok' });
  const approval = db.approvalWrites()[0];
  // params: [entity_type, entity_id, field, approver_id, source_reference, note]
  assert.equal(approval.params[3], 'u_admin', 'approver must be the authenticated actor');
  // The router only ever passes req.user through as `actor`.
  assert.match(routerCode, /actor: req\.user/);
  assert.doesNotMatch(routerCode, /actor:\s*req\.body/);
  assert.doesNotMatch(routerCode, /approver_id.*req\.body/);
});

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

test('admin GET returns a concurrency token and a publication verdict', async () => {
  const db = makeDb({ brand: draftBrand() });
  const out = await getAdminBrand(db, 'br_1');
  assert.equal(out.concurrencyToken, makeConcurrencyToken('brand', 'br_1', UPDATED));
  assert.equal(out.publicationGate.allowed, false, 'a draft brand should not be publishable');
  assert.ok(out.publicationGate.reasons.length > 0);
});

test('admin list returns serialized records', async () => {
  const db = makeDb({ brand: publishableBrand() });
  const brands = await listAdminBrands(db, {});
  assert.equal(brands.length, 1);
  assert.equal(brands[0].slug, 'example-brand');
});

test('a product GET includes its variations and gate verdict', async () => {
  const db = makeDb({ product: publishableProduct(), brand: publishableBrand(), variations: [publishableVariation()], media: [{ id: 'med_1' }] });
  const out = await getAdminProduct(db, 'p_1');
  assert.equal(out.variations.length, 1);
  assert.equal(out.publicationGate.allowed, true, JSON.stringify(out.publicationGate.reasons));
});

test('an unknown record is a 404 AdminApiError', async () => {
  const db = makeDb({});
  for (const [fn, args] of [[getAdminBrand, ['br_x']], [getAdminProduct, ['p_x']], [getAdminVariation, ['v_x']]]) {
    await assert.rejects(() => fn(db, ...args), (err) => {
      assert.ok(err instanceof AdminApiError);
      assert.equal(err.status, 404);
      return true;
    });
  }
});

// ---------------------------------------------------------------------------
// 6-11 — PATCH validation through the handler
// ---------------------------------------------------------------------------

test('PATCH with an unknown field returns a 400 with field-level errors and writes nothing', async () => {
  const db = makeDb({ brand: publishableBrand() });
  const cacheSurvived = seedCache();
  await assert.rejects(
    () => patchAdminEntity(db, 'brand', 'br_1', { concurrencyToken: makeConcurrencyToken('brand', 'br_1', UPDATED), bogus: 1 }),
    (err) => {
      assert.equal(err.status, 400);
      assert.ok(Array.isArray(err.body.fieldErrors));
      return true;
    }
  );
  assert.equal(db.updateWrites().length, 0, 'a rejected patch must not write');
  assert.equal(cacheSurvived(), true, 'a validation failure must not invalidate the cache');
});

test('PATCH allows a partial draft save and bumps content_updated_at', async () => {
  const db = makeDb({ brand: draftBrand() });
  await patchAdminEntity(db, 'brand', 'br_1', {
    concurrencyToken: makeConcurrencyToken('brand', 'br_1', UPDATED),
    headline: 'A new headline',
  });
  const update = db.updateWrites()[0];
  assert.match(update.sql, /headline = \$2/);
  assert.match(update.sql, /content_updated_at = now\(\)/);
  assert.ok(db.committed);
});

test('PATCH locks the row inside the transaction before writing', async () => {
  const db = makeDb({ brand: draftBrand() });
  await patchAdminEntity(db, 'brand', 'br_1', {
    concurrencyToken: makeConcurrencyToken('brand', 'br_1', UPDATED),
    headline: 'x',
  });
  assert.ok(db.statements.some((s) => /for update/i.test(s.sql)), 'expected a locked read');
});

// ---------------------------------------------------------------------------
// 22-26 — concurrency
// ---------------------------------------------------------------------------

test('a stale concurrency token returns 409 and writes nothing', async () => {
  const db = makeDb({ brand: publishableBrand() });
  const cacheSurvived = seedCache();
  const stale = makeConcurrencyToken('brand', 'br_1', new Date(UPDATED.getTime() - 5000));
  await assert.rejects(
    () => patchAdminEntity(db, 'brand', 'br_1', { concurrencyToken: stale, headline: 'x' }),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.body.code, 'STALE_TOKEN');
      return true;
    }
  );
  assert.equal(db.updateWrites().length, 0, 'a stale patch must write nothing');
  assert.ok(db.rolledBack, 'the transaction must roll back');
  assert.equal(cacheSurvived(), true, 'a conflict must not invalidate the cache');
});

test('a missing token is treated as stale', async () => {
  const db = makeDb({ brand: publishableBrand() });
  await assert.rejects(
    () => patchAdminEntity(db, 'brand', 'br_1', { headline: 'x' }),
    (err) => err.status === 409
  );
});

test("another record's token cannot be replayed", async () => {
  const db = makeDb({ brand: publishableBrand() });
  const otherToken = makeConcurrencyToken('brand', 'br_999', UPDATED);
  await assert.rejects(
    () => patchAdminEntity(db, 'brand', 'br_1', { concurrencyToken: otherToken, headline: 'x' }),
    (err) => err.status === 409
  );
});

test('a publish attempt with a stale token is a 409, not a publication', async () => {
  const db = makeDb({ brand: publishableBrand() });
  const stale = makeConcurrencyToken('brand', 'br_1', new Date(0));
  await assert.rejects(() => publishEntity(db, 'brand', 'br_1', { token: stale, actor: ACTOR }), (err) => err.status === 409);
  assert.equal(db.approvalWrites().length, 0, 'no approval row on a conflict');
  assert.equal(db.updateWrites().length, 0);
});

// ---------------------------------------------------------------------------
// 27-32 — transactions and approvals
// ---------------------------------------------------------------------------

test('a successful publish commits both the content update and the approval row', async () => {
  const db = makeDb({ brand: publishableBrand() });
  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  await publishEntity(db, 'brand', 'br_1', { token, actor: ACTOR, note: 'approved by commercial' });

  assert.ok(db.committed);
  const update = db.updateWrites()[0];
  assert.match(update.sql, /publication_state = 'published'/);
  const approval = db.approvalWrites()[0];
  assert.equal(approval.params[0], 'brand');
  assert.equal(approval.params[1], 'br_1');
  assert.equal(approval.params[2], 'publication');
  assert.equal(approval.params[3], 'u_admin');
  assert.match(approval.params[5], /approved by commercial/);
});

test('a failed publication gate returns 422 and writes NEITHER content nor approval', async () => {
  const db = makeDb({ brand: draftBrand() });
  const cacheSurvived = seedCache();
  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  await assert.rejects(
    () => publishEntity(db, 'brand', 'br_1', { token, actor: ACTOR }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.body.code, 'PUBLICATION_GATE_FAILED');
      assert.ok(err.body.reasons.length > 0, 'must report why');
      return true;
    }
  );
  assert.equal(db.updateWrites().length, 0, 'no content write on a failed gate');
  assert.equal(db.approvalWrites().length, 0, 'no approval row on a failed gate');
  assert.ok(db.rolledBack);
  assert.equal(cacheSurvived(), true, 'a failed gate must not invalidate the cache');
});

test('a database failure mid-transaction rolls back, leaving no partial approval row', async () => {
  const db = makeDb({ brand: publishableBrand(), failOn: /insert into content_approvals/i });
  const cacheSurvived = seedCache();
  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  await assert.rejects(() => publishEntity(db, 'brand', 'br_1', { token, actor: ACTOR }));
  assert.ok(db.rolledBack, 'the transaction must roll back');
  assert.equal(cacheSurvived(), true, 'a rollback must not invalidate the cache');
});

test('publishing a product sets is_published and publication_state together', async () => {
  const db = makeDb({ product: publishableProduct(), brand: publishableBrand(), variations: [publishableVariation()], media: [{ id: 'med_1' }] });
  const token = makeConcurrencyToken('product', 'p_1', UPDATED);
  await publishEntity(db, 'product', 'p_1', { token, actor: ACTOR });
  const update = db.updateWrites().find((s) => /update products/i.test(s.sql));
  assert.match(update.sql, /is_published = true/);
  assert.match(update.sql, /publication_state = 'published'/);
});

test('a product whose brand is unpublished cannot be published (422, cross-row rule)', async () => {
  const db = makeDb({
    product: publishableProduct(),
    brand: { ...publishableBrand(), publication_state: 'approved' },
    variations: [publishableVariation()],
    media: [{ id: 'med_1' }],
  });
  const token = makeConcurrencyToken('product', 'p_1', UPDATED);
  await assert.rejects(
    () => publishEntity(db, 'product', 'p_1', { token, actor: ACTOR }),
    (err) => {
      assert.equal(err.status, 422);
      assert.ok(err.body.reasons.some((r) => r.code === 'PRODUCT_BRAND_NOT_PUBLISHED'));
      return true;
    }
  );
});

test('unpublish records a decision, preserves content and clears both flags together', async () => {
  const db = makeDb({ product: { ...publishableProduct(), is_published: true } });
  const token = makeConcurrencyToken('product', 'p_1', UPDATED);
  await unpublishEntity(db, 'product', 'p_1', { token, actor: ACTOR, note: 'withdrawn' });

  const update = db.updateWrites().find((s) => /update products/i.test(s.sql));
  assert.match(update.sql, /is_published = false/);
  assert.match(update.sql, /publication_state = 'approved'/);
  // Content is preserved: no delete anywhere, and no redirect/slug cleanup.
  assert.ok(!db.statements.some((s) => /delete/i.test(s.sql)), 'unpublish must never delete');
  assert.ok(!db.statements.some((s) => /redirects/i.test(s.sql)), 'redirect history must be untouched');

  const approval = db.approvalWrites()[0];
  assert.equal(approval.params[2], 'unpublication');
  assert.equal(approval.params[3], 'u_admin');
});

test('unpublish is NOT gated — removing something from public view must always be possible', async () => {
  // An incomplete draft that could never pass the publish gate can still be unpublished.
  const db = makeDb({ brand: { ...draftBrand(), publication_state: 'published' } });
  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  await assert.doesNotReject(() => unpublishEntity(db, 'brand', 'br_1', { token, actor: ACTOR }));
  assert.ok(db.committed);
});

test('evaluate is read-only — it never writes', async () => {
  const db = makeDb({ brand: draftBrand() });
  const gate = await evaluateEntity(db, 'brand', 'br_1');
  assert.equal(gate.allowed, false);
  assert.equal(db.updateWrites().length, 0);
  assert.equal(db.approvalWrites().length, 0);
});

// ---------------------------------------------------------------------------
// 33-37 — cache invalidation
// ---------------------------------------------------------------------------

test('a successful PATCH invalidates the public cache', async () => {
  const db = makeDb({ brand: draftBrand() });
  const cacheSurvived = seedCache();
  await patchAdminEntity(db, 'brand', 'br_1', {
    concurrencyToken: makeConcurrencyToken('brand', 'br_1', UPDATED),
    headline: 'x',
  });
  assert.equal(cacheSurvived(), false, 'a committed change must invalidate the cache');
});

test('a successful publish invalidates the public cache', async () => {
  const db = makeDb({ brand: publishableBrand() });
  const cacheSurvived = seedCache();
  await publishEntity(db, 'brand', 'br_1', { token: makeConcurrencyToken('brand', 'br_1', UPDATED), actor: ACTOR });
  assert.equal(cacheSurvived(), false);
});

test('a successful unpublish invalidates the public cache', async () => {
  const db = makeDb({ brand: publishableBrand() });
  const cacheSurvived = seedCache();
  await unpublishEntity(db, 'brand', 'br_1', { token: makeConcurrencyToken('brand', 'br_1', UPDATED), actor: ACTOR });
  assert.equal(cacheSurvived(), false);
});

test('invalidation happens only after commit — it is never called inside the transaction', () => {
  // Structural: the invalidate call sits after the awaited tx() in each
  // mutation, not inside the callback passed to it.
  const publishFn = routerCode.slice(routerCode.indexOf('export async function publishEntity'));
  const txEnd = publishFn.indexOf('});');
  const invalidateAt = publishFn.indexOf('invalidatePublicCache()');
  assert.ok(invalidateAt > txEnd, 'invalidatePublicCache must be called after the transaction closes');
});

// ---------------------------------------------------------------------------
// 38-43 — safety
// ---------------------------------------------------------------------------

test('no write route exists under /public', () => {
  assert.doesNotMatch(publicRouterCode, /r\.(post|put|patch|delete)\(/i);
});

test('the admin router defines no DELETE route', () => {
  for (const layer of adminPublicContentRouter.stack) {
    if (!layer.route) continue;
    assert.ok(!layer.route.methods.delete, `DELETE defined on ${layer.route.path}`);
  }
  assert.doesNotMatch(routerCode, /r\.delete\(/);
});

test('every admin route is GET, PATCH or POST only', () => {
  const allowed = new Set(['get', 'patch', 'post']);
  for (const layer of adminPublicContentRouter.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      assert.ok(allowed.has(method), `unexpected method ${method} on ${layer.route.path}`);
    }
  }
});

test('no SQL uses SELECT * or a table-star selection', () => {
  assert.doesNotMatch(routerCode, /select\s+\*/i);
  assert.doesNotMatch(routerCode, /\b[a-z]\.\*/i);
});

test('no customer, order, invoice, payment or pricing table is queried', () => {
  for (const table of ['users', 'orders', 'order_items', 'invoices', 'payments', 'credit_notes', 'carts', 'cart_items', 'stock']) {
    assert.doesNotMatch(routerCode, new RegExp(`(from|join)\\s+${table}\\b`, 'i'), `queries ${table}`);
  }
});

test('every query value is parameterised — an adversarial value never reaches SQL text', async () => {
  const db = makeDb({ brand: draftBrand() });
  const payload = "x'; drop table brands; --";
  await patchAdminEntity(db, 'brand', 'br_1', {
    concurrencyToken: makeConcurrencyToken('brand', 'br_1', UPDATED),
    headline: payload,
  });
  for (const statement of db.statements) {
    assert.ok(!statement.sql.includes('drop table'), `payload leaked into SQL: ${statement.sql}`);
  }
  assert.ok(db.updateWrites()[0].params.includes(payload), 'the payload should be a bound parameter');
});

test('an adversarial record id is only ever a bound parameter', async () => {
  const db = makeDb({ brand: draftBrand() });
  const evil = "br_1'; drop table brands; --";
  await getAdminBrand(db, evil).catch(() => {});
  for (const statement of db.statements) {
    assert.ok(!statement.sql.includes('drop table'));
  }
});

test('the admin router does not import pricing, ordering, inventory or Zoho modules', () => {
  for (const forbidden of ['pricing.js', 'ordering.js', 'inventory.js', 'zoho.js', 'cart.js']) {
    assert.doesNotMatch(routerCode, new RegExp(`from\\s+['"][^'"]*${forbidden.replace('.', '\\.')}['"]`));
  }
});

test('no error body leaks SQL, a stack trace or infrastructure detail', async () => {
  const db = makeDb({ brand: draftBrand() });
  try {
    await publishEntity(db, 'brand', 'br_1', { token: makeConcurrencyToken('brand', 'br_1', UPDATED), actor: ACTOR });
    assert.fail('should have thrown');
  } catch (err) {
    const body = JSON.stringify(err.body);
    assert.doesNotMatch(body, /select |from brands|update |pg_|postgres|\$\d/i);
    assert.doesNotMatch(body, /at \w+ \(/);
  }
});

test('the router is mounted under /admin, never under /public', () => {
  const indexCode = stripComments(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'));
  assert.match(indexCode, /app\.use\('\/admin\/public-content', adminPublicContentRoutes\)/);
  // The read-only public mount is unchanged and still points at the public router.
  assert.match(indexCode, /app\.use\('\/public', publicRoutes\)/);
});

test('mounting order puts the stricter gate first, before the general /admin router', () => {
  const indexCode = stripComments(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'));
  const strict = indexCode.indexOf("app.use('/admin/public-content'");
  const general = indexCode.indexOf("app.use('/admin', adminRoutes)");
  assert.ok(strict > -1 && general > -1);
  assert.ok(strict < general, 'the stricter public-content gate must be mounted first');
});
