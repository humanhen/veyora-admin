/* Append-only audit history (Security Hardening Phase 4).

   Finding SEC-015: `audit` was a synced collection, so the generic
   whole-database sync endpoint could UPDATE and DELETE audit rows like any
   other table.

   The database-level enforcement is a trigger, so it cannot be exercised
   without PostgreSQL. What is asserted here is everything that CAN be checked
   without one: the migration and its ensureSchema mirror define the triggers,
   the pattern matches the inventory ledger's, no application path can reach an
   UPDATE or DELETE, and the writer still works. The trigger's runtime
   behaviour is recorded as an RC verification step. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIMPLE_COLLECTIONS } from '../src/shape.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');

const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migration = fs.readFileSync(path.join(MIGRATIONS, '0010_audit_log_append_only.sql'), 'utf8');
/* Statements only: the header explains at length what is deliberately NOT
   done, and every destructive-verb assertion below would match the prose. */
const statements = migration.replace(/^\s*--[^\n]*$/gm, ' ');
const migrateJs = read('migrate.js');

// ---------------------------------------------------------------------------
// 1-7 — the database refuses mutation
// ---------------------------------------------------------------------------

test('1 — UPDATE on audit_log is rejected by a trigger', () => {
  assert.match(statements, /create trigger t_audit_log_no_update\s+before update on audit_log/);
  assert.match(migrateJs, /create trigger t_audit_log_no_update before update on audit_log/);
});

test('2 — DELETE on audit_log is rejected by a trigger', () => {
  assert.match(statements, /create trigger t_audit_log_no_delete\s+before delete on audit_log/);
  assert.match(migrateJs, /create trigger t_audit_log_no_delete before delete on audit_log/);
});

test('3 — the trigger function raises rather than silently ignoring', () => {
  assert.match(statements, /raise exception 'audit_log is append-only/);
  assert.match(migrateJs, /raise exception 'audit_log is append-only/);
  /* A trigger that RETURNs NULL would silently swallow the write, which is
     worse: the caller believes it succeeded. */
  assert.ok(!/return null/i.test(statements), 'the trigger must raise, not swallow');
});

test('4 — INSERT is untouched, so the server-side writer still works', () => {
  assert.ok(!/before insert on audit_log/i.test(statements));
  assert.ok(!/before insert on audit_log/i.test(migrateJs));
  assert.match(code('db.js'), /insert into audit_log/);
});

test('5 — it reuses the established append-only pattern, not a second mechanism', () => {
  /* inventory_movements has used exactly this shape since it was built. */
  assert.match(migrateJs, /create or replace function inventory_movements_immutable/);
  assert.match(migrateJs, /create or replace function audit_log_immutable/);
  for (const fn of ['inventory_movements_immutable', 'audit_log_immutable']) {
    const at = migrateJs.indexOf(`function ${fn}`);
    assert.match(migrateJs.slice(at, at + 300), /raise exception/,
      `${fn} should follow the same raise-on-mutation shape`);
  }
});

test('6 — the migration is non-destructive', () => {
  for (const destructive of [/drop\s+table/i, /drop\s+column/i, /alter\s+column/i,
                             /truncate/i, /delete\s+from/i, /update\s+audit_log/i]) {
    assert.ok(!destructive.test(statements), `the migration must not contain ${destructive}`);
  }
  assert.equal((statements.match(/\binsert\s+into\b/gi) ?? []).length, 0,
    'the migration writes no rows');
});

test('7 — the migration and the ensureSchema mirror stay aligned', () => {
  for (const fragment of [
    'audit_log_immutable',
    't_audit_log_no_update',
    't_audit_log_no_delete',
    'before update on audit_log',
    'before delete on audit_log',
  ]) {
    assert.ok(migration.includes(fragment), `migration missing ${fragment}`);
    assert.ok(migrateJs.includes(fragment), `ensureSchema missing ${fragment}`);
  }
});

// ---------------------------------------------------------------------------
// 8-14 — no application path can mutate audit records
// ---------------------------------------------------------------------------

test('8 — audit is no longer a syncable collection', () => {
  assert.ok(!('audit' in SIMPLE_COLLECTIONS),
    'the generic sync must not be able to reach the audit log at all');
});

test('9 — the generic sync cannot touch audit rows', () => {
  /* Two independent reasons, either sufficient: the collection is absent from
     the map (so the sync loop throws "unknown collection"), and the endpoint
     is admin-only. */
  const admin = code('routes/admin.js');
  const sync = admin.slice(admin.indexOf("r.post('/sync'"));
  assert.ok(!/'audit'/.test(sync), 'the sync loop must have no audit branch');
  assert.match(sync, /unknown collection/);
});

test('10 — only the server-side writer creates audit entries', () => {
  const writers = [];
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
    if (/insert into audit_log/i.test(code(file))) writers.push(file);
  }
  for (const file of fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.js'))) {
    if (/insert into audit_log/i.test(code('routes', file))) writers.push(`routes/${file}`);
  }
  /* Two writers, both reviewed and both APPEND:
       - db.js          the ordinary audit() helper every route uses;
       - credential-migration.js  a supervised script that records its own run.
     The property that matters is not "one writer" but "every writer appends".
     Test 11 asserts the other half: nobody updates or deletes. */
  assert.deepEqual(writers.sort(), ['credential-migration.js', 'db.js'],
    'a new audit writer appeared — confirm it only ever INSERTs');
});

test('11 — no application code updates or deletes an audit row', () => {
  const files = [
    ...fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => [f]),
    ...fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.js')).map((f) => ['routes', f]),
  ];
  for (const parts of files) {
    const src = code(...parts);
    assert.ok(!/update\s+audit_log/i.test(src), `${parts.join('/')} updates audit_log`);
    assert.ok(!/delete\s+from\s+audit_log/i.test(src), `${parts.join('/')} deletes from audit_log`);
  }
});

test('12 — the actor comes from the authenticated request, never the body', () => {
  const db = code('db.js');
  assert.match(db, /export async function audit\(actor,/);
  assert.ok(!/req\.body/.test(db), 'the audit writer must not read a request body');
  /* Callers pass req.user-derived actors. Spot-check the governed surfaces. */
  for (const file of ['routes/account-permissions.js', 'routes/admin-enquiries.js', 'routes/admin-inventory.js']) {
    assert.match(code(file), /actor\?\.id/, `${file} should attribute from the actor object`);
  }
});

test('13 — existing audit records stay readable', () => {
  /* Only UPDATE and DELETE are blocked. Nothing touches SELECT, and the admin
     screen still reads the log. */
  assert.ok(!/before select/i.test(statements));
  assert.match(code('routes/admin.js'), /audit/);
});

test('14 — the admin panel Undo control is gone', () => {
  /* It set `undone = true` and inserted a row claiming a reversal, while
     reverting nothing — the log actively misstated what happened (REP-007).
     It is also now impossible: the table is append-only and audit is not
     syncable. */
  const ops = fs.readFileSync(path.join(path.dirname(path.dirname(path.dirname(ROOT))), 'js', 'pages_ops.js'), 'utf8');
  assert.ok(!/data-undo=/.test(ops), 'the Undo button must be gone from the audit table');
  assert.ok(!/ev\.undone\s*=\s*true/.test(ops), 'nothing may flip the undone flag');
  assert.match(ops, /Undo" control was REMOVED|control was REMOVED here/,
    'the removal should be explained where the control used to be');
});

// ---------------------------------------------------------------------------
// 15-16 — corrections, and what is not enforced here
// ---------------------------------------------------------------------------

test('15 — a correction is a new record, and the migration says so', () => {
  assert.match(migration, /compensating record/i);
  assert.match(migration, /never mutation|not mutations|NOT MUTATIONS/i);
});

test('16 — the runtime trigger behaviour is recorded as needing a real database', () => {
  /* Honest scope. A trigger cannot fire without PostgreSQL, and this suite
     has none — so the assertions above are about DEFINITION, and the
     behaviour is an RC verification step. Stated in the migration header so a
     reader does not mistake a green suite for a proven trigger. */
  assert.match(migration, /fresh database volume/);
  assert.match(migration, /ensureSchema/);
});
