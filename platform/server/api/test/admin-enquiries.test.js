/* Governed enquiry operations (Fast-Track WS2 Phase 2).

   Real handlers against a controlled database double. No live database, and no
   real enquiry data: every submission here is invented, uses example.test
   addresses, and describes nothing a real person sent. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import enquiryRouter, {
  ENQUIRY_CAPABILITIES,
  EnquiryApiError,
  getEnquiry,
  getEnquiryCapabilities,
  listEnquiries,
  transitionEnquiry,
} from '../src/routes/admin-enquiries.js';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_RETENTION_DAYS,
  ENQUIRY_OPERATIONS_CONTRACT,
  HANDLING_STATUSES,
  INITIAL_STATUS,
  MAX_NOTE_LENGTH,
  MAX_PAGE_SIZE,
  allowedTransitions,
  canTransition,
  cleanNote,
  isHandlingStatus,
  makeEnquiryToken,
  parseFormTypeFilter,
  parsePaging,
  parseStatusFilter,
  retentionMetadata,
  serializeEnquiryDetail,
  serializeEnquirySummary,
} from '../src/enquiry-operations.js';
import { PERMISSION_KEYS } from '../src/permission-registry.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migrationSql = fs.readFileSync(path.join(MIGRATIONS, '0009_enquiry_operations.sql'), 'utf8');
const migrateJs = fs.readFileSync(path.join(SRC, 'migrate.js'), 'utf8');
const routerSource = fs.readFileSync(path.join(SRC, 'routes', 'admin-enquiries.js'), 'utf8');
const routerCode = stripComments(routerSource);
const opsCode = stripComments(fs.readFileSync(path.join(SRC, 'enquiry-operations.js'), 'utf8'));
const indexCode = stripComments(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'));
/* SQL statements only — the comments explain what is deliberately NOT done and
   would otherwise match every destructive-verb assertion below. */
const migrationStatements = migrationSql.replace(/^\s*--[^\n]*$/gm, ' ');

const NOW = new Date('2026-08-06T12:00:00.000Z');
const ACTOR = { id: 'u_handler', role: 'admin', email: 'ops@example.test', business: 'Veyora Ops' };

const submission = (over = {}) => ({
  id: 'fsub_1',
  form_type: 'contact',
  payload: { name: 'Sam Example', email: 'sam@example.test', company: 'Example Optics', message: 'Do you ship to Ireland?' },
  source_url: '/contact',
  region: 'IE',
  business_type: '',
  consent_version: '2026-08-enquiry-v1',
  consent_at: NOW,
  delivery_state: 'pending',
  attempts: 0,
  last_error: '',
  handling_status: 'new',
  handled_by: null,
  handled_at: null,
  handling_note: '',
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

/** Fake db over a mutable form_submissions table. */
function makeDb({ rows = [submission()], forms = [], grants = [] } = {}) {
  const statements = [];
  let table = rows.map((r) => ({ ...r }));
  let rolledBack = false;

  async function query(sql, params = []) {
    statements.push({ sql, params });

    if (/from account_permissions/i.test(sql)) {
      // Mirrors permissions.js: only active grants for active accounts.
      const held = grants.filter((g) => g.user_id === params[0] && g.is_active !== false);
      if (/select 1/i.test(sql)) {
        return { rows: held.filter((g) => g.permission_key === params[1]).map(() => ({ '?column?': 1 })) };
      }
      return { rows: held.map((g) => ({ permission_key: g.permission_key })) };
    }
    if (/from forms where type/i.test(sql)) {
      const row = forms.find((f) => f.type === params[0]);
      return { rows: row ? [{ retention_days: row.retention_days }] : [] };
    }
    if (/count\(\*\)/i.test(sql)) {
      return { rows: [{ total: filtered(sql, params).length }] };
    }
    if (/^\s*select .*from form_submissions where id/is.test(sql)) {
      const row = table.find((r) => r.id === params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^\s*select .*from form_submissions/is.test(sql)) {
      const list = filtered(sql, params)
        .slice()
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      return { rows: list.slice(offset, offset + limit).map((r) => ({ ...r })) };
    }
    if (/^\s*update form_submissions/i.test(sql)) {
      const [id, toStatus, handledBy, note, fromStatus] = params;
      const row = table.find((r) => r.id === id && r.handling_status === fromStatus);
      if (!row) return { rows: [] };
      Object.assign(row, {
        handling_status: toStatus,
        handled_by: handledBy,
        handled_at: new Date('2026-08-06T13:00:00.000Z'),
        handling_note: note,
      });
      return { rows: [{ ...row }] };
    }
    if (/^\s*insert into audit_log/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }

  function filtered(sql, params) {
    let list = table;
    // The handlers build the WHERE from validated filters, in this order.
    let i = 0;
    if (/handling_status = \$/.test(sql)) { const v = params[i++]; list = list.filter((r) => r.handling_status === v); }
    if (/form_type = \$/.test(sql)) { const v = params[i++]; list = list.filter((r) => r.form_type === v); }
    return list;
  }

  return {
    statements,
    get table() { return table; },
    get rolledBack() { return rolledBack; },
    query,
    async tx(fn) {
      const snapshot = table.map((r) => ({ ...r }));
      try {
        return await fn({ query });
      } catch (err) {
        table = snapshot; // real rollback semantics
        rolledBack = true;
        throw err;
      }
    },
    writes() {
      return statements.filter((s) => /^\s*(insert into|update|delete from)\s+form_submissions/i.test(s.sql));
    },
  };
}

async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/** Runs a middleware stack and reports what it did. */
function runMiddleware(mw, req) {
  return new Promise((resolve) => {
    const res = { status: (code) => ({ json: (body) => resolve({ outcome: 'denied', code, body }) }) };
    mw(req, res, (err) => resolve(err ? { outcome: 'error', err } : { outcome: 'allowed' }));
  });
}

// ===========================================================================
// 1-9 — capabilities and authority
// ===========================================================================

test('1 — the two enquiry capabilities are registered and are not public_content keys', () => {
  assert.ok(PERMISSION_KEYS.includes('enquiries.view'));
  assert.ok(PERMISSION_KEYS.includes('enquiries.manage'));
  assert.equal(ENQUIRY_CAPABILITIES.view, 'enquiries.view');
  assert.equal(ENQUIRY_CAPABILITIES.manage, 'enquiries.manage');
});

test('2 — the router never references a public_content capability', () => {
  assert.ok(!routerCode.includes('public_content'), 'enquiry routes must not reuse content capabilities');
  assert.ok(!opsCode.includes('public_content'));
});

test('3 — no role fallback anywhere on the enquiry surface', () => {
  /* requireAuth() is called with no arguments: a role must not be able to
     satisfy a capability gate, and passing one here would make grants to
     non-admin accounts silently ineffective. */
  assert.match(routerCode, /requireAuth\(\)/);
  assert.ok(!/requireAuth\(\s*['"]/.test(routerCode), 'requireAuth must take no role argument');
  assert.ok(!/req\.user\.role\s*===/.test(routerCode), 'no role comparison may decide authority');
  assert.ok(!/role\s*===\s*['"]admin['"]/.test(routerCode));
});

test('4 — no wildcard or prefix matching decides authority', () => {
  for (const construct of [/permission_key\s+like/i, /startsWith\(\s*['"]enquiries/, /'enquiries\.\*'/]) {
    assert.ok(!construct.test(routerCode), `wildcard construct found: ${construct}`);
  }
});

test('5 — reads require enquiries.view and are refused without it', async () => {
  const db = makeDb({ grants: [] });
  const denied = await runMiddleware(
    (await import('../src/permissions.js')).requirePermission('enquiries.view', { db }),
    { user: { id: 'u_nobody' } }
  );
  assert.equal(denied.outcome, 'denied');
  assert.equal(denied.code, 403);
});

test('6 — a holder of enquiries.view is admitted to reads', async () => {
  const db = makeDb({ grants: [{ user_id: 'u_viewer', permission_key: 'enquiries.view', is_active: true }] });
  const allowed = await runMiddleware(
    (await import('../src/permissions.js')).requirePermission('enquiries.view', { db }),
    { user: { id: 'u_viewer' } }
  );
  assert.equal(allowed.outcome, 'allowed');
});

test('7 — enquiries.view alone does NOT admit a transition', async () => {
  const db = makeDb({ grants: [{ user_id: 'u_viewer', permission_key: 'enquiries.view', is_active: true }] });
  const denied = await runMiddleware(
    (await import('../src/permissions.js')).requirePermission('enquiries.manage', { db }),
    { user: { id: 'u_viewer' } }
  );
  assert.equal(denied.outcome, 'denied');
  assert.equal(denied.code, 403);
});

test('8 — public_content.publish does not confer any enquiry authority', async () => {
  const db = makeDb({
    grants: [
      { user_id: 'u_publisher', permission_key: 'public_content.view', is_active: true },
      { user_id: 'u_publisher', permission_key: 'public_content.edit', is_active: true },
      { user_id: 'u_publisher', permission_key: 'public_content.publish', is_active: true },
    ],
  });
  const capabilities = await getEnquiryCapabilities(db, 'u_publisher');
  assert.deepEqual(capabilities, { view: false, manage: false });
});

test('9 — capability discovery answers honestly for an account holding none', async () => {
  const db = makeDb({ grants: [] });
  assert.deepEqual(await getEnquiryCapabilities(db, 'u_nobody'), { view: false, manage: false });

  const both = makeDb({
    grants: [
      { user_id: 'u_ops', permission_key: 'enquiries.view', is_active: true },
      { user_id: 'u_ops', permission_key: 'enquiries.manage', is_active: true },
    ],
  });
  assert.deepEqual(await getEnquiryCapabilities(both, 'u_ops'), { view: true, manage: true });
});

test('10 — capability discovery leaks nothing but its two booleans', async () => {
  const db = makeDb({
    grants: [
      { user_id: 'u_ops', permission_key: 'enquiries.view', is_active: true },
      { user_id: 'u_ops', permission_key: 'permissions.manage', is_active: true },
    ],
  });
  const capabilities = await getEnquiryCapabilities(db, 'u_ops');
  assert.deepEqual(Object.keys(capabilities).sort(), ['manage', 'view']);
  // permissions.manage is held but must not be disclosed by this endpoint.
  assert.ok(!JSON.stringify(capabilities).includes('permissions.manage'));
});

// ===========================================================================
// 11-20 — the transition model
// ===========================================================================

test('11 — the status set is closed and starts at new', () => {
  assert.deepEqual(HANDLING_STATUSES, ['new', 'in_review', 'responded', 'closed', 'spam']);
  assert.equal(INITIAL_STATUS, 'new');
  assert.ok(!HANDLING_STATUSES.includes('deleted'), 'there must be no deleted status');
});

test('12 — unrecognised statuses are refused, fail closed', () => {
  for (const value of [undefined, null, '', 'NEW', 'archived', 42, {}, ['new']]) {
    assert.equal(isHandlingStatus(value), false, `${JSON.stringify(value)} must not be a status`);
    assert.deepEqual(allowedTransitions(value), []);
    assert.equal(canTransition(value, 'closed'), false);
    assert.equal(canTransition('new', value), false);
  }
});

test('13 — a no-op transition is refused', () => {
  for (const status of HANDLING_STATUSES) {
    assert.equal(canTransition(status, status), false, `${status} -> ${status} must be refused`);
  }
});

test('14 — no state is terminal: closed and spam are both recoverable', () => {
  assert.ok(allowedTransitions('closed').length > 0, 'a mis-closed enquiry must be recoverable');
  assert.ok(allowedTransitions('spam').length > 0, 'a mis-filed enquiry must be recoverable');
  assert.ok(canTransition('closed', 'in_review'));
  assert.ok(canTransition('spam', 'in_review'));
});

test('15 — nothing may return to new', () => {
  for (const status of HANDLING_STATUSES) {
    assert.equal(canTransition(status, 'new'), false, `${status} must not return to new`);
  }
});

test('16 — every declared transition targets a registered status', () => {
  for (const from of HANDLING_STATUSES) {
    for (const to of allowedTransitions(from)) {
      assert.ok(HANDLING_STATUSES.includes(to), `${from} -> ${to} is not a registered status`);
      assert.ok(canTransition(from, to));
    }
  }
});

test('17 — the transition map cannot be mutated through what it returns', () => {
  const first = allowedTransitions('new');
  first.push('deleted');
  assert.ok(!allowedTransitions('new').includes('deleted'), 'the map must return a copy');
});

test('18 — filters are validated against closed sets', () => {
  assert.deepEqual(parseStatusFilter('closed'), { ok: true, status: 'closed' });
  assert.deepEqual(parseStatusFilter(''), { ok: true, status: null });
  assert.equal(parseStatusFilter('anything').ok, false);
  assert.deepEqual(parseFormTypeFilter('contact'), { ok: true, formType: 'contact' });
  assert.equal(parseFormTypeFilter('unknown-form').ok, false);
  assert.equal(parseFormTypeFilter(7).ok, false);
});

test('19 — paging is clamped so a screen cannot become an export', () => {
  assert.equal(parsePaging({ limit: 9999 }).limit, MAX_PAGE_SIZE);
  assert.equal(parsePaging({}).limit, DEFAULT_PAGE_SIZE);
  assert.equal(parsePaging({ limit: 0 }).limit, DEFAULT_PAGE_SIZE);
  assert.equal(parsePaging({ limit: -5 }).limit, DEFAULT_PAGE_SIZE);
  assert.equal(parsePaging({ offset: -1 }).offset, 0);
  assert.equal(parsePaging({ offset: '40' }).offset, 40);
  assert.equal(parsePaging({ limit: 'all' }).limit, DEFAULT_PAGE_SIZE);
});

test('20 — a handling note is cleaned and length-capped, and a non-string is rejected', () => {
  assert.equal(cleanNote(undefined), '');
  assert.equal(cleanNote('  spaced  '), 'spaced');
  assert.equal(cleanNote('a b'), 'a b');
  assert.equal(cleanNote('x'.repeat(MAX_NOTE_LENGTH)), 'x'.repeat(MAX_NOTE_LENGTH));
  assert.equal(cleanNote('x'.repeat(MAX_NOTE_LENGTH + 1)), null);
  assert.equal(cleanNote(42), null);
  assert.equal(cleanNote({}), null);
});

// ===========================================================================
// 21-30 — serialization
// ===========================================================================

test('21 — the list row omits the enquirer free text', () => {
  const summary = serializeEnquirySummary(submission());
  assert.ok(!('message' in summary), 'a list must not render everyone\'s message');
  assert.ok(!('email' in summary), 'a list must not render everyone\'s email address');
  assert.ok(!JSON.stringify(summary).includes('Do you ship'));
  assert.equal(summary.name, 'Sam Example');
});

test('22 — the list row is a fixed object literal, never a spread row', () => {
  const summary = serializeEnquirySummary(submission({ secret_column: 'leaked', delivery_state: 'failed' }));
  assert.deepEqual(Object.keys(summary).sort(), [
    'businessType', 'company', 'createdAt', 'formType', 'handledAt', 'handlingStatus', 'id', 'name', 'region',
  ]);
  assert.ok(!JSON.stringify(summary).includes('leaked'));
});

test('23 — the detail record is a fixed object literal with the expected keys', () => {
  const detail = serializeEnquiryDetail(submission(), { now: NOW });
  assert.deepEqual(Object.keys(detail).sort(), [
    'allowedTransitions', 'businessType', 'concurrencyToken', 'consentAt', 'consentVersion', 'createdAt',
    'fields', 'formType', 'handledAt', 'handledBy', 'handlingNote', 'handlingStatus', 'id', 'region',
    'retention', 'sourcePath',
  ]);
});

test('24 — delivery mechanics never reach an operations screen', () => {
  const detail = serializeEnquiryDetail(submission({ delivery_state: 'failed', last_error: 'smtp timeout', attempts: 9 }), { now: NOW });
  const json = JSON.stringify(detail);
  for (const leak of ['deliveryState', 'delivery_state', 'lastError', 'smtp timeout', 'attempts']) {
    assert.ok(!json.includes(leak), `${leak} must not be serialized`);
  }
});

test('25 — the payload is re-filtered through the current field allowlist', () => {
  const detail = serializeEnquiryDetail(
    submission({ payload: { name: 'Sam', message: 'Hello', injected: 'not a form field', consent: 'true' } }),
    { now: NOW }
  );
  assert.deepEqual(Object.keys(detail.fields).sort(), ['message', 'name']);
  assert.ok(!('injected' in detail.fields), 'a key that reached the column another way must not be echoed');
  assert.ok(!('consent' in detail.fields), 'consent is recorded as consentAt, never as a field');
});

test('26 — a malformed or absent payload serializes to an empty field set, not a crash', () => {
  for (const payload of [null, undefined, 'a string', ['array'], 42]) {
    const detail = serializeEnquiryDetail(submission({ payload }), { now: NOW });
    assert.deepEqual(detail.fields, {});
  }
});

test('27 — an unknown form type yields no fields rather than the raw payload', () => {
  const detail = serializeEnquiryDetail(
    submission({ form_type: 'not-a-form', payload: { name: 'Sam', message: 'Hello' } }),
    { now: NOW }
  );
  assert.deepEqual(detail.fields, {});
});

test('28 — retention is derived, not stored', () => {
  const meta = retentionMetadata(new Date('2026-01-01T00:00:00.000Z'), { retentionDays: 365, now: new Date('2026-07-01T00:00:00.000Z') });
  assert.equal(meta.retentionDays, 365);
  assert.equal(meta.retainUntil, '2027-01-01T00:00:00.000Z');
  assert.equal(meta.expired, false);
  assert.ok(meta.daysRemaining > 180 && meta.daysRemaining < 190);
});

test('29 — an elapsed retention period reports as expired with a negative remainder', () => {
  const meta = retentionMetadata(new Date('2024-01-01T00:00:00.000Z'), { retentionDays: 30, now: NOW });
  assert.equal(meta.expired, true);
  assert.ok(meta.daysRemaining < 0, 'the overrun must be visible, not clamped to zero');
});

test('30 — an unusable retention configuration falls back to the default', () => {
  for (const days of [0, -1, null, undefined, 'a year', NaN]) {
    assert.equal(retentionMetadata(NOW, { retentionDays: days, now: NOW }).retentionDays, DEFAULT_RETENTION_DAYS);
  }
  const bad = retentionMetadata('not a date', { now: NOW });
  assert.equal(bad.retainUntil, null);
});

// ===========================================================================
// 31-45 — handlers
// ===========================================================================

test('31 — the list is paginated, ordered newest first, and reports a total', async () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    submission({ id: `fsub_${i}`, created_at: new Date(Date.UTC(2026, 0, i + 1)) })
  );
  const db = makeDb({ rows });
  const page = await listEnquiries(db, { limit: 3, offset: 0 });
  assert.equal(page.total, 7);
  assert.equal(page.limit, 3);
  assert.equal(page.enquiries.length, 3);
  assert.deepEqual(page.enquiries.map((e) => e.id), ['fsub_6', 'fsub_5', 'fsub_4']);
});

test('32 — the list ordering is total, so pages cannot hide a row', async () => {
  const same = new Date('2026-03-01T00:00:00.000Z');
  const db = makeDb({ rows: ['a', 'b', 'c'].map((s) => submission({ id: `fsub_${s}`, created_at: same })) });
  const first = await listEnquiries(db, { limit: 2, offset: 0 });
  const second = await listEnquiries(db, { limit: 2, offset: 2 });
  const seen = [...first.enquiries, ...second.enquiries].map((e) => e.id);
  assert.deepEqual(new Set(seen).size, 3, 'every row must appear exactly once across pages');
  const sql = db.statements.find((s) => /order by/i.test(s.sql)).sql;
  assert.match(sql, /order by created_at desc, id desc/i);
});

test('33 — an unrecognised filter is a 400, never a silently ignored filter', async () => {
  const db = makeDb();
  const statusErr = await rejects(listEnquiries(db, { status: 'archived' }));
  assert.ok(statusErr instanceof EnquiryApiError);
  assert.equal(statusErr.status, 400);
  const formErr = await rejects(listEnquiries(db, { formType: 'made-up' }));
  assert.equal(formErr.status, 400);
  assert.equal(db.writes().length, 0);
});

test('34 — filters are parameterised, never interpolated', async () => {
  const db = makeDb({ rows: [submission({ handling_status: 'closed' })] });
  await listEnquiries(db, { status: 'closed', formType: 'contact' });
  for (const statement of db.statements) {
    assert.ok(!statement.sql.includes('closed'), 'a filter value must not appear in SQL text');
    assert.ok(!statement.sql.includes('contact'));
  }
});

test('35 — detail returns the record plus a concurrency token', async () => {
  const db = makeDb();
  const detail = await getEnquiry(db, 'fsub_1', { now: NOW });
  assert.equal(detail.id, 'fsub_1');
  assert.equal(detail.handlingStatus, 'new');
  assert.equal(detail.concurrencyToken, makeEnquiryToken(submission()));
  assert.deepEqual(detail.allowedTransitions, allowedTransitions('new'));
});

test('36 — a missing enquiry is a 404', async () => {
  const err = await rejects(getEnquiry(makeDb(), 'fsub_missing'));
  assert.equal(err.status, 404);
});

test('37 — retention comes from the form definition when one exists', async () => {
  const db = makeDb({ forms: [{ type: 'contact', retention_days: 90 }] });
  const detail = await getEnquiry(db, 'fsub_1', { now: NOW });
  assert.equal(detail.retention.retentionDays, 90);
});

test('38 — with no form definition row the default period applies', async () => {
  const detail = await getEnquiry(makeDb({ forms: [] }), 'fsub_1', { now: NOW });
  assert.equal(detail.retention.retentionDays, DEFAULT_RETENTION_DAYS);
});

test('39 — a legal transition is applied and attributed to the authenticated actor', async () => {
  const db = makeDb();
  const before = await getEnquiry(db, 'fsub_1', { now: NOW });
  const after = await transitionEnquiry(db, 'fsub_1', {
    toStatus: 'in_review',
    token: before.concurrencyToken,
    note: 'Picked up.',
    actor: ACTOR,
  });
  assert.equal(after.handlingStatus, 'in_review');
  assert.equal(after.handledBy, 'u_handler');
  assert.ok(after.handledAt);
  assert.equal(after.handlingNote, 'Picked up.');
});

test('40 — attribution is never taken from the request body', async () => {
  const db = makeDb();
  const before = await getEnquiry(db, 'fsub_1', { now: NOW });
  await transitionEnquiry(db, 'fsub_1', {
    toStatus: 'in_review',
    token: before.concurrencyToken,
    actor: ACTOR,
  });
  const update = db.writes().find((s) => /^\s*update/i.test(s.sql));
  assert.equal(update.params[2], 'u_handler');
  assert.ok(!routerCode.includes('req.body?.actor'), 'the actor must never be read from the body');
  assert.match(routerCode, /actor: req\.user/);
});

test('41 — an illegal transition is a 422 and writes nothing', async () => {
  const db = makeDb({ rows: [submission({ handling_status: 'closed', handled_at: NOW })] });
  const before = await getEnquiry(db, 'fsub_1', { now: NOW });
  const err = await rejects(transitionEnquiry(db, 'fsub_1', {
    toStatus: 'responded', token: before.concurrencyToken, actor: ACTOR,
  }));
  assert.equal(err.status, 422);
  assert.equal(err.body.code, 'ILLEGAL_TRANSITION');
  assert.deepEqual(err.body.allowed, allowedTransitions('closed'));
  assert.equal(db.writes().length, 0);
  assert.equal(db.table[0].handling_status, 'closed');
});

test('42 — an unregistered target status is a 400 before any query runs', async () => {
  const db = makeDb();
  const err = await rejects(transitionEnquiry(db, 'fsub_1', { toStatus: 'deleted', token: 'x', actor: ACTOR }));
  assert.equal(err.status, 400);
  assert.equal(err.body.code, 'UNKNOWN_STATUS');
  assert.equal(db.statements.length, 0, 'nothing may be queried for an unknown status');
});

test('43 — a stale token is a 409 and the transaction rolls back', async () => {
  const db = makeDb();
  const err = await rejects(transitionEnquiry(db, 'fsub_1', {
    toStatus: 'in_review', token: 'enquiry:fsub_1:new:someone-elses-value', actor: ACTOR,
  }));
  assert.equal(err.status, 409);
  assert.equal(err.body.code, 'STALE_TOKEN');
  assert.ok(db.rolledBack);
  assert.equal(db.table[0].handling_status, 'new');
});

test('44 — a token issued for one enquiry cannot be replayed against another', async () => {
  const db = makeDb({ rows: [submission({ id: 'fsub_a' }), submission({ id: 'fsub_b' })] });
  const a = await getEnquiry(db, 'fsub_a', { now: NOW });
  const err = await rejects(transitionEnquiry(db, 'fsub_b', {
    toStatus: 'in_review', token: a.concurrencyToken, actor: ACTOR,
  }));
  assert.equal(err.status, 409);
});

test('45 — a second transition with the first token loses', async () => {
  const db = makeDb();
  const before = await getEnquiry(db, 'fsub_1', { now: NOW });
  await transitionEnquiry(db, 'fsub_1', { toStatus: 'in_review', token: before.concurrencyToken, actor: ACTOR });
  const err = await rejects(transitionEnquiry(db, 'fsub_1', {
    toStatus: 'closed', token: before.concurrencyToken, actor: ACTOR,
  }));
  assert.equal(err.status, 409);
  assert.equal(db.table[0].handling_status, 'in_review');
});

test('46 — the row is locked for the transaction', async () => {
  const db = makeDb();
  const before = await getEnquiry(db, 'fsub_1', { now: NOW });
  await transitionEnquiry(db, 'fsub_1', { toStatus: 'in_review', token: before.concurrencyToken, actor: ACTOR });
  const locking = db.statements.filter((s) => /for update/i.test(s.sql));
  assert.equal(locking.length, 1, 'the transition must select for update exactly once');
});

test('47 — an oversized note is rejected before anything is written', async () => {
  const db = makeDb();
  const before = await getEnquiry(db, 'fsub_1', { now: NOW });
  const err = await rejects(transitionEnquiry(db, 'fsub_1', {
    toStatus: 'in_review', token: before.concurrencyToken, note: 'x'.repeat(MAX_NOTE_LENGTH + 1), actor: ACTOR,
  }));
  assert.equal(err.status, 400);
  assert.equal(err.body.code, 'INVALID_NOTE');
  assert.equal(db.writes().length, 0);
});

test('48 — the transition writes only handling columns', async () => {
  const db = makeDb();
  const before = await getEnquiry(db, 'fsub_1', { now: NOW });
  await transitionEnquiry(db, 'fsub_1', { toStatus: 'in_review', token: before.concurrencyToken, actor: ACTOR });
  const update = db.writes().find((s) => /^\s*update/i.test(s.sql)).sql;
  const setClause = update.slice(update.toLowerCase().indexOf('set'), update.toLowerCase().indexOf('where'));
  for (const column of ['payload', 'consent_at', 'consent_version', 'form_type', 'source_url', 'region', 'business_type', 'delivery_state']) {
    assert.ok(!setClause.includes(column), `${column} must never be written by the enquiry API`);
  }
  for (const column of ['handling_status', 'handled_by', 'handled_at', 'handling_note']) {
    assert.ok(setClause.includes(column), `${column} should be written`);
  }
});

test('49 — the audit entry records the states and never the enquirer', async () => {
  const db = makeDb();
  const before = await getEnquiry(db, 'fsub_1', { now: NOW });
  await transitionEnquiry(db, 'fsub_1', {
    toStatus: 'in_review', token: before.concurrencyToken, note: 'Emailed Sam Example', actor: ACTOR,
  });
  const auditCall = routerCode.slice(routerCode.indexOf("'enquiry.transition'"), routerCode.indexOf("'enquiry.transition'") + 400);
  assert.ok(!auditCall.includes('payload'), 'the audit entry must not carry the submission payload');
  assert.ok(!auditCall.includes('cleanedNote'), 'the audit entry must not carry the note, which may quote the enquirer');
  assert.match(routerCode, /\$\{result\.from\} -> \$\{result\.to\}/);
});

// ===========================================================================
// 50-60 — nothing is deleted, nothing is invented
// ===========================================================================

test('50 — no DELETE anywhere in the enquiry surface', () => {
  for (const [name, source] of [['router', routerCode], ['operations module', opsCode], ['migration', migrationStatements]]) {
    assert.doesNotMatch(source, /delete\s+from\s+form_submissions/i, `${name} deletes submissions`);
    assert.doesNotMatch(source, /truncate/i, `${name} truncates`);
    assert.doesNotMatch(source, /drop\s+table/i, `${name} drops a table`);
  }
  assert.ok(!/r\.delete\(/.test(routerCode), 'there must be no DELETE route');
});

test('51 — the migration drops no column and alters no existing one', () => {
  assert.doesNotMatch(migrationStatements, /drop\s+column/i);
  assert.doesNotMatch(migrationStatements, /alter\s+column/i);
  assert.doesNotMatch(migrationStatements, /alter table users/i);
  // The only DROPs are CHECK constraints being widened, each with IF EXISTS.
  for (const match of migrationStatements.match(/drop constraint[^\n;]*/gi) ?? []) {
    assert.match(match, /if exists/i, `unguarded constraint drop: ${match}`);
  }
});

test('52 — every new column has a default that describes existing rows', () => {
  assert.match(migrationSql, /handling_status text not null default 'new'/);
  assert.match(migrationSql, /handling_note text not null default ''/);
  // handled_by / handled_at are nullable: an untouched enquiry has no handler.
  assert.match(migrationSql, /handled_at timestamptz/);
});

test('53 — the migration and ensureSchema mirror stay aligned', () => {
  for (const fragment of [
    'handling_status',
    'handled_by',
    'handled_at',
    'handling_note',
    'form_submissions_handling_status_valid',
    'form_submissions_handling_attributed',
    'form_submissions_handling_status_idx',
    'form_submissions_created_at_idx',
    'account_permissions_permission_key_registered',
    "'enquiries.view'",
    "'enquiries.manage'",
  ]) {
    assert.ok(migrationSql.includes(fragment), `migration missing ${fragment}`);
    assert.ok(migrateJs.includes(fragment), `ensureSchema missing ${fragment}`);
  }
});

test('54 — the migration grants nothing', () => {
  assert.equal((migrationStatements.match(/insert into account_permissions/gi) ?? []).length, 0);
  assert.equal((migrationStatements.match(/\binsert\s+into\b/gi) ?? []).length, 0, 'the migration inserts no row at all');
});

test('55 — the database constrains handling_status to the registered set', () => {
  for (const status of HANDLING_STATUSES) {
    assert.ok(migrationSql.includes(`'${status}'`), `CHECK missing ${status}`);
  }
  // Statements only: the comments explain that 'deleted' deliberately is not
  // a status, and would otherwise match.
  assert.ok(!migrationStatements.includes("'deleted'"));
});

test('56 — the router is mounted before the general admin router', () => {
  const enquiryMount = indexCode.indexOf("app.use('/admin/enquiries'");
  const adminMount = indexCode.indexOf("app.use('/admin', adminRoutes)");
  assert.ok(enquiryMount > -1, 'the enquiry router must be mounted');
  assert.ok(adminMount > -1);
  assert.ok(enquiryMount < adminMount, 'the general /admin router must not gate enquiries first');
});

test('57 — the enquiry surface is not reachable from the public router', () => {
  const publicRouter = stripComments(fs.readFileSync(path.join(SRC, 'routes', 'public.js'), 'utf8'));
  assert.ok(!publicRouter.includes('form_submissions'), 'the unauthenticated API must not read submissions');
  assert.ok(!publicRouter.includes('handling_status'));
  assert.ok(!indexCode.includes("app.use('/public', adminEnquiryRoutes"));
});

test('58 — the router selects explicit columns, never SELECT *', () => {
  assert.ok(!/select\s+\*/i.test(routerCode), 'SELECT * must not appear');
});

test('59 — the contract the UI renders from is frozen and complete', () => {
  assert.throws(() => { 'use strict'; ENQUIRY_OPERATIONS_CONTRACT.statuses = []; }, TypeError);
  assert.deepEqual(ENQUIRY_OPERATIONS_CONTRACT.statuses, HANDLING_STATUSES);
  assert.equal(ENQUIRY_OPERATIONS_CONTRACT.initialStatus, INITIAL_STATUS);
  for (const status of HANDLING_STATUSES) {
    assert.deepEqual(ENQUIRY_OPERATIONS_CONTRACT.transitions[status], allowedTransitions(status));
  }
});

test('60 — the router exposes exactly the intended routes', () => {
  const routes = [...routerCode.matchAll(/r\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(routes.sort(), [
    'GET /',
    'GET /:id',
    'GET /capabilities',
    'POST /:id/notifications/:notificationId/retry',
    'POST /:id/status',
  ]);
});

test('61 — the router is an express Router with the expected mounting shape', () => {
  assert.equal(typeof enquiryRouter, 'function');
  assert.ok(Array.isArray(enquiryRouter.stack), 'default export should be an express router');
});
