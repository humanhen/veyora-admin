/* Current-account public-content capability endpoint, and the publication
   boundary guard on PATCH (B2.4B2A).

   Real handlers and real middleware against controlled database doubles. No
   live database. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import adminPublicContentRouter, {
  getPublicContentCapabilities,
  assertPublicationBoundaryNotCrossed,
  patchAdminEntity,
  AdminApiError,
  PUBLIC_CONTENT_CAPABILITIES,
} from '../src/routes/admin-public-content.js';
import { makeConcurrencyToken } from '../src/admin-public-serialize.js';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const routerCode = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'admin-public-content.js'), 'utf8'));

const UPDATED = new Date('2026-08-06T10:00:00.000Z');

/** Permission-resolution double mirroring the real SQL's semantics: an active
 *  grant held by an ACTIVE account. */
function makeDb(grants = []) {
  const statements = [];
  return {
    statements,
    async query(sql, params = []) {
      statements.push({ sql, params });
      const activeGrantOnly = /is_active = true/.test(sql);
      const activeUserOnly = /u\.status = 'active'/.test(sql);
      if (/from account_permissions ap/.test(sql)) {
        const [userId] = params;
        const rows = grants.filter(
          (g) => g.user_id === userId
            && (!activeGrantOnly || g.is_active !== false)
            && (!activeUserOnly || g.status !== 'disabled')
        );
        return { rows: rows.map((g) => ({ permission_key: g.permission_key })) };
      }
      return { rows: [] };
    },
  };
}

const grant = (user_id, permission_key, extra = {}) =>
  ({ user_id, permission_key, is_active: true, status: 'active', ...extra });

const CAPS = PUBLIC_CONTENT_CAPABILITIES;

// ---------------------------------------------------------------------------
// 2-8 — resolution
// ---------------------------------------------------------------------------

test('2 — an authenticated account with no grants gets all three false', async () => {
  const caps = await getPublicContentCapabilities(makeDb([]), 'u_1');
  assert.deepEqual(caps, { view: false, edit: false, publish: false });
});

test('3 — a view-only account gets view true and nothing else', async () => {
  const caps = await getPublicContentCapabilities(makeDb([grant('u_1', CAPS.read)]), 'u_1');
  assert.deepEqual(caps, { view: true, edit: false, publish: false });
});

test('4 — edit implies neither view nor publish', async () => {
  const caps = await getPublicContentCapabilities(makeDb([grant('u_1', CAPS.edit)]), 'u_1');
  assert.deepEqual(caps, { view: false, edit: true, publish: false });
});

test('5 — publish implies neither edit nor view', async () => {
  const caps = await getPublicContentCapabilities(makeDb([grant('u_1', CAPS.publish)]), 'u_1');
  assert.deepEqual(caps, { view: false, edit: false, publish: true });
});

test('all three can be held together', async () => {
  const db = makeDb([grant('u_1', CAPS.read), grant('u_1', CAPS.edit), grant('u_1', CAPS.publish)]);
  assert.deepEqual(await getPublicContentCapabilities(db, 'u_1'), { view: true, edit: true, publish: true });
});

test('6 — a revoked grant resolves false', async () => {
  const db = makeDb([grant('u_1', CAPS.edit, { is_active: false }), grant('u_1', CAPS.read)]);
  assert.deepEqual(await getPublicContentCapabilities(db, 'u_1'), { view: true, edit: false, publish: false });
});

test('7 — a disabled account exercises nothing, even with active grants', async () => {
  const db = makeDb([
    grant('u_1', CAPS.read, { status: 'disabled' }),
    grant('u_1', CAPS.edit, { status: 'disabled' }),
  ]);
  assert.deepEqual(await getPublicContentCapabilities(db, 'u_1'), { view: false, edit: false, publish: false });
});

test('8 — a role-only administrator receives no implicit capability', async () => {
  /* No grants at all: the resolver has no notion of a role, so an admin is
     indistinguishable from anyone else here. */
  const caps = await getPublicContentCapabilities(makeDb([]), 'u_admin');
  assert.deepEqual(caps, { view: false, edit: false, publish: false });
  assert.doesNotMatch(stripComments(String(getPublicContentCapabilities)), /role|admin/i);
});

test('another account’s grants never leak into this answer', async () => {
  const db = makeDb([grant('u_other', CAPS.read), grant('u_other', CAPS.publish)]);
  assert.deepEqual(await getPublicContentCapabilities(db, 'u_1'), { view: false, edit: false, publish: false });
});

test('a missing user id resolves all false rather than throwing', async () => {
  for (const id of [undefined, null, '']) {
    assert.deepEqual(await getPublicContentCapabilities(makeDb([grant('u_1', CAPS.read)]), id),
      { view: false, edit: false, publish: false });
  }
});

// ---------------------------------------------------------------------------
// 10 — response shape
// ---------------------------------------------------------------------------

test('10 — the response is exactly three booleans and discloses nothing else', async () => {
  const db = makeDb([
    grant('u_1', CAPS.read),
    grant('u_1', 'permissions.manage'),   // held, but must not be disclosed here
  ]);
  const caps = await getPublicContentCapabilities(db, 'u_1');

  assert.deepEqual(Object.keys(caps).sort(), ['edit', 'publish', 'view']);
  for (const v of Object.values(caps)) assert.equal(typeof v, 'boolean');

  const json = JSON.stringify(caps);
  for (const forbidden of ['permissions.manage', 'role', 'email', 'granted', 'revoked', 'user', 'id']) {
    assert.ok(!json.includes(forbidden), `leaked ${forbidden}`);
  }
});

test('the answer is a fresh literal, not a database row', async () => {
  const db = makeDb([grant('u_1', CAPS.read)]);
  const a = await getPublicContentCapabilities(db, 'u_1');
  const b = await getPublicContentCapabilities(db, 'u_1');
  assert.notEqual(a, b, 'each call must build its own object');
  assert.deepEqual(a, b);
});

test('resolution is not cached — a revocation takes effect on the next call', async () => {
  const grants = [grant('u_1', CAPS.edit)];
  const db = makeDb(grants);
  assert.equal((await getPublicContentCapabilities(db, 'u_1')).edit, true);
  grants[0].is_active = false;
  assert.equal((await getPublicContentCapabilities(db, 'u_1')).edit, false);
});

test('the endpoint performs no mutation', async () => {
  const db = makeDb([grant('u_1', CAPS.read)]);
  await getPublicContentCapabilities(db, 'u_1');
  for (const s of db.statements) {
    assert.doesNotMatch(s.sql, /^\s*(insert|update|delete)/i);
  }
});

// ---------------------------------------------------------------------------
// 1/9 — routing and forgery
// ---------------------------------------------------------------------------

test('1 — /capabilities is behind authentication but behind no capability gate', () => {
  const layer = adminPublicContentRouter.stack.find((l) => l.route && l.route.path === '/capabilities');
  assert.ok(layer, 'the route must exist');
  assert.equal(layer.route.stack.length, 1,
    'exactly one handler: an authenticated account with no capability must still get an answer');

  // Router-level authentication still applies to it.
  assert.equal(adminPublicContentRouter.stack.filter((l) => !l.route).length, 1);
  assert.match(routerCode, /r\.use\(requirePublicContentAuth\(\)\)/);
});

test('every other route still carries its capability middleware', () => {
  for (const layer of adminPublicContentRouter.stack) {
    if (!layer.route || layer.route.path === '/capabilities') continue;
    assert.equal(layer.route.stack.length, 2, `${layer.route.path} lost its capability gate`);
  }
});

test('9 — the answer is derived from req.user.id only; body, query and headers cannot forge it', async () => {
  const db = makeDb([grant('u_victim', CAPS.publish)]);

  // The handler is passed req.user?.id and nothing else — asserted structurally
  // because the express layer is what wires it.
  assert.match(routerCode, /getPublicContentCapabilities\(liveDb, req\.user\?\.id\)/);
  assert.doesNotMatch(routerCode, /getPublicContentCapabilities\([^)]*req\.(body|query|headers)/);

  // And the resolver itself reads nothing from a request.
  const caps = await getPublicContentCapabilities(db, 'u_attacker');
  assert.deepEqual(caps, { view: false, edit: false, publish: false });
});

test('the capability handler reads nothing from the request object', () => {
  const fn = stripComments(String(getPublicContentCapabilities));
  assert.doesNotMatch(fn, /req\./);
});

// ---------------------------------------------------------------------------
// PUBLICATION BOUNDARY GUARD — the defect found in B2.4A
// ---------------------------------------------------------------------------

test('a brand cannot be PUBLISHED through PATCH — the gate and publish capability stand', () => {
  assert.throws(
    () => assertPublicationBoundaryNotCrossed('brand', { publication_state: 'approved' }, { publication_state: 'published' }),
    (err) => {
      assert.ok(err instanceof AdminApiError);
      assert.equal(err.status, 400);
      assert.equal(err.body.code, 'PUBLICATION_BOUNDARY');
      assert.equal(err.body.fieldErrors[0].field, 'publication_state');
      assert.match(err.body.error, /publish endpoint/i);
      return true;
    }
  );
});

test('a published brand cannot be UNPUBLISHED through PATCH either', () => {
  assert.throws(
    () => assertPublicationBoundaryNotCrossed('brand', { publication_state: 'published' }, { publication_state: 'draft' }),
    (err) => {
      assert.equal(err.body.code, 'PUBLICATION_BOUNDARY');
      assert.match(err.body.error, /unpublish endpoint/i);
      return true;
    }
  );
});

test('ordinary editorial transitions remain fully editable', () => {
  for (const [from, to] of [
    ['draft', 'verified'], ['verified', 'approved'], ['approved', 'draft'],
    ['approved', 'retired'], ['retired', 'draft'], ['draft', 'draft'],
  ]) {
    assert.doesNotThrow(
      () => assertPublicationBoundaryNotCrossed('brand', { publication_state: from }, { publication_state: to }),
      `${from} → ${to} must stay editable`
    );
  }
});

test('a no-op write of the same published state is not treated as a transition', () => {
  assert.doesNotThrow(
    () => assertPublicationBoundaryNotCrossed('brand', { publication_state: 'published' }, { publication_state: 'published' })
  );
});

test('a patch that does not mention publication_state is unaffected', () => {
  assert.doesNotThrow(
    () => assertPublicationBoundaryNotCrossed('brand', { publication_state: 'published' }, { headline: 'New' })
  );
});

test('products are unaffected — their publication flag is the immutable is_published column', () => {
  assert.doesNotThrow(
    () => assertPublicationBoundaryNotCrossed('product', { publication_state: 'approved' }, { publication_state: 'published' })
  );
  assert.doesNotThrow(
    () => assertPublicationBoundaryNotCrossed('variation', {}, { color: 'Black' })
  );
});

test('the guard runs inside the transaction and rolls the write back', async () => {
  const statements = [];
  const brand = {
    id: 'br_1', slug: 'example-brand', name: 'Example', short_name: '', segment: '',
    headline: '', summary: '', story: '', ideal_retailer: '', price_tier_label: '',
    design_origin: '', manufacturing_origin: '', style_traits: [], approved_materials: [],
    logo_media_id: null, hero_media_id: null, publication_state: 'approved',
    verification_status: 'verified', source_reference: 'r', fact_owner: null,
    last_reviewed_at: UPDATED, scheduled_review_at: null, content_updated_at: UPDATED,
    created_at: UPDATED, updated_at: UPDATED,
  };
  let rolledBack = false;
  const db = {
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (/from brands where slug = /i.test(sql)) return { rows: [] };
      if (/from brands where id = /i.test(sql)) return { rows: [brand] };
      return { rows: [] };
    },
    async tx(fn) {
      try { return await fn({ query: this.query.bind(this) }); }
      catch (e) { rolledBack = true; throw e; }
    },
  };

  const token = makeConcurrencyToken('brand', 'br_1', UPDATED);
  await assert.rejects(
    () => patchAdminEntity(db, 'brand', 'br_1', { publication_state: 'published', concurrencyToken: token }),
    (err) => { assert.equal(err.body.code, 'PUBLICATION_BOUNDARY'); return true; }
  );

  assert.ok(rolledBack, 'the transaction must roll back');
  assert.equal(statements.filter((s) => /^\s*update brands/i.test(s.sql)).length, 0,
    'no write may reach the brands table');
});

test('the guard is applied by patchAdminEntity, not only exported', () => {
  assert.match(routerCode, /assertPublicationBoundaryNotCrossed\(entityType, current, validated\.fields\)/);
});
