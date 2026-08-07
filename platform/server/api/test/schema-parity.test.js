/* Migration ↔ ensureSchema parity (Final Release Correction).

   THE PROBLEM THIS EXISTS TO PREVENT

   Veyora has two paths to a schema, and they are not the same code:

     - `db/migrations/*.sql` runs ONLY on a completely fresh database volume,
       through the postgres container's `docker-entrypoint-initdb.d`;
     - `src/migrate.js`'s `ensureSchema()` runs on EVERY API boot, and is the
       only thing an existing database ever executes.

   The migrations directory is mounted into the postgres container alone — the
   API image is built from `platform/server/api` and does not contain it. So
   `ensureSchema()` cannot read or execute the canonical SQL at runtime; it is
   a hand-written mirror, and hand-written mirrors drift.

   They had. Migrations 0003, 0004 and 0005 were never mirrored, and nobody
   noticed for the whole life of the project, because a fresh volume gets them
   from the migrations and the deployed database happened to have them already.
   The failure is silent until a database is restored from a backup that
   predates them, at which point `/admin/snapshot` throws on a missing
   `po_number_seq` and the entire admin panel stops loading.

   This test is the mechanism that makes that impossible to reintroduce. It
   PARSES both definitions and compares them structurally, so a migration added
   next year is covered without anybody remembering to extend a list.
*/
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');
const MIGRATE_JS = path.join(ROOT, 'src', 'migrate.js');

/* SQL comments stripped. Several migrations explain in prose what they
   deliberately do NOT do, and an assertion satisfied — or defeated — by a
   comment is no assertion at all. */
const readSql = (file) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8')
  .replace(/^\s*--[^\n]*$/gm, ' ')
  .replace(/--[^\n]*/g, ' ');

/* The mirror is JavaScript wrapping SQL in template literals; its own JS
   comments go the same way, for the same reason. */
const mirrorRaw = fs.readFileSync(MIGRATE_JS, 'utf8');
const mirror = mirrorRaw
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migrationFiles = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

/* ---------------------------------------------------------------------------
   Declared scope — every exclusion is a DECISION with a reason, not an omission
   --------------------------------------------------------------------------- */

/**
 * Migrations that are deliberately NOT mirrored in `ensureSchema()`.
 *
 * Keyed by file, valued with the reason. A migration absent from this map is
 * in scope and MUST be mirrored — which is what makes the next omission a test
 * failure rather than a discovery years later.
 */
export const MIGRATION_ONLY = Object.freeze({
  '0001_schema.sql':
    'The base schema. It IS the database — every table, sequence and trigger the '
    + 'platform starts from. It runs once on a fresh volume through '
    + 'docker-entrypoint-initdb.d, and mirroring it would mean maintaining a second '
    + 'complete copy of the entire schema in JavaScript. ensureSchema() exists to '
    + 'apply what came AFTER go-live, which its own header states.',
  '0002_views.sql':
    'Reporting views only (units_sold_by_model and friends). Nothing in the API '
    + 'reads them — asserted below — so an existing database lacking them loses no '
    + 'runtime behaviour. They are analyst-facing SQL, applied deliberately rather '
    + 'than on every boot.',
});

/* ---------------------------------------------------------------------------
   Structural extraction
   --------------------------------------------------------------------------- */

/** Every schema object a migration declares, by kind. */
export function objectsIn(sql) {
  const tables = [];
  const sequences = [];
  const functions = [];
  const triggers = [];
  const indexes = [];
  const columns = [];   // `table.column`

  for (const m of sql.matchAll(/create table(?:\s+if not exists)?\s+(\w+)/gi)) tables.push(m[1]);
  for (const m of sql.matchAll(/create sequence(?:\s+if not exists)?\s+(\w+)/gi)) sequences.push(m[1]);
  for (const m of sql.matchAll(/create (?:or replace )?function\s+(\w+)/gi)) functions.push(m[1]);
  for (const m of sql.matchAll(/create trigger\s+(\w+)/gi)) triggers.push(m[1]);
  for (const m of sql.matchAll(/create (?:unique )?index(?:\s+if not exists)?\s+(\w+)/gi)) indexes.push(m[1]);

  /* ALTER TABLE … ADD COLUMN, including the multi-column form several
     migrations use. */
  for (const m of sql.matchAll(/alter table\s+(\w+)([\s\S]*?);/gi)) {
    for (const c of m[2].matchAll(/add column(?:\s+if not exists)?\s+(\w+)/gi)) {
      columns.push(`${m[1]}.${c[1]}`);
    }
  }

  return {
    tables: [...new Set(tables)],
    sequences: [...new Set(sequences)],
    functions: [...new Set(functions)],
    triggers: [...new Set(triggers)],
    indexes: [...new Set(indexes)],
    columns: [...new Set(columns)],
  };
}

/* Whether the MIRROR declares a given object. Each check is anchored to the
   creating statement, so the mere appearance of a word elsewhere — `status`,
   `id`, `notes` all appear dozens of times on unrelated tables — cannot pass
   for a definition. That looseness is precisely how an earlier draft of this
   check reported 0004 as partly present when none of it was. */
/* Every gap between keywords is `\s+`, never a literal space. Both the
   migrations and the mirror align columns for readability —
   `create index        if not exists products_brand_id_idx` — and a
   single-space regex reported four correctly-mirrored indexes as missing on
   the first run of this file. A parity checker that cries wolf over whitespace
   is worse than none, because the next real gap gets waved through. */
const declares = {
  tables: (name) => new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${name}\\b`, 'i').test(mirror),
  sequences: (name) => new RegExp(`create\\s+sequence\\s+if\\s+not\\s+exists\\s+${name}\\b`, 'i').test(mirror),
  functions: (name) => new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${name}\\b`, 'i').test(mirror),
  triggers: (name) => new RegExp(`create\\s+trigger\\s+${name}\\b`, 'i').test(mirror),
  indexes: (name) => new RegExp(`create\\s+(?:unique\\s+)?index\\s+if\\s+not\\s+exists\\s+${name}\\b`, 'i').test(mirror),
  columns: (qualified) => {
    const [table, column] = qualified.split('.');
    /* Either an ALTER on that table that adds the column, or the column
       appearing inside that table's CREATE in the mirror. */
    const alters = [...mirror.matchAll(new RegExp(`alter\\s+table\\s+${table}\\b([\\s\\S]{0,900}?)\`\\)`, 'gi'))];
    if (alters.some((a) => new RegExp(`add\\s+column\\s+if\\s+not\\s+exists\\s+${column}\\b`, 'i').test(a[1]))) return true;
    const create = mirror.match(new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\)\``, 'i'));
    return !!create && new RegExp(`^\\s*${column}\\s`, 'im').test(create[1]);
  },
};

const KINDS = ['tables', 'sequences', 'functions', 'triggers', 'indexes', 'columns'];

/* ---------------------------------------------------------------------------
   The parity tests
   --------------------------------------------------------------------------- */

test('1 — every migration is either in scope or has a stated reason not to be', () => {
  /* A migration cannot be quietly ignored: it is mirrored, or it appears in
     MIGRATION_ONLY with an explanation somebody had to write. */
  for (const file of migrationFiles) {
    const excluded = Object.prototype.hasOwnProperty.call(MIGRATION_ONLY, file);
    if (!excluded) continue;
    assert.ok(MIGRATION_ONLY[file].length > 80,
      `${file} is excluded from the mirror but its reason is too thin to be a decision`);
  }
  /* And the exclusion list cannot name a migration that does not exist — a
     stale entry would silently widen the exclusion. */
  for (const file of Object.keys(MIGRATION_ONLY)) {
    assert.ok(migrationFiles.includes(file), `MIGRATION_ONLY names a missing migration: ${file}`);
  }
});

test('2 — every schema object in an in-scope migration exists in ensureSchema', () => {
  /* THE test. Structural, exhaustive, and automatic for migrations that do not
     exist yet. */
  const missing = [];
  for (const file of migrationFiles) {
    if (MIGRATION_ONLY[file]) continue;
    const objects = objectsIn(readSql(file));
    for (const kind of KINDS) {
      for (const name of objects[kind]) {
        if (!declares[kind](name)) missing.push(`${file}  ${kind.padEnd(10)} ${name}`);
      }
    }
  }
  assert.deepEqual(missing, [],
    `ensureSchema() is missing schema objects that a migration creates:\n  ${missing.join('\n  ')}`);
});

test('3 — the three objects that were actually missing are now present', () => {
  /* Named explicitly, so this reads as a regression test for the specific
     defect rather than only as a general rule. */
  assert.ok(declares.columns('return_items.exchange_sku'), '0003: return_items.exchange_sku');
  assert.ok(declares.tables('purchase_orders'), '0004: purchase_orders');
  assert.ok(declares.sequences('po_number_seq'), '0004: po_number_seq');
  assert.ok(declares.columns('orders.zoho_so_id'), '0005: orders.zoho_so_id');
});

test('4 — the mirrored purchase_orders definition matches the migration semantically', () => {
  /* Presence is not parity. The status CHECK and the UNIQUE on `number` are
     the two constraints that would silently differ if somebody re-typed the
     table rather than copying it. */
  const canonical = readSql('0004_purchasing.sql');
  const mirrored = mirror.match(/create table if not exists purchase_orders\s*\(([\s\S]*?)\n\s*\)`/i);
  assert.ok(mirrored, 'purchase_orders must be created in the mirror');

  for (const status of ['draft', 'ordered', 'partially received', 'received', 'cancelled']) {
    assert.ok(canonical.includes(`'${status}'`), `the migration should allow '${status}'`);
    assert.ok(mirrored[1].includes(`'${status}'`), `the mirror must allow '${status}'`);
  }
  assert.match(mirrored[1], /number\s+text unique/i, 'number must stay UNIQUE in the mirror');
  assert.match(mirrored[1], /id\s+text primary key/i, 'id must stay the primary key');
  assert.match(mirrored[1], /items\s+jsonb not null default '\[\]'/i, 'items must keep its default');
  assert.match(mirrored[1], /status\s+text not null default 'ordered'/i, 'status must keep its default');
});

test('5 — every mirrored statement is idempotent', () => {
  /* ensureSchema runs on EVERY boot. A statement that is not safe to repeat
     turns a restart into an outage. */
  const creates = [...mirror.matchAll(
    /create\s+(?:unique\s+)?(table|sequence|index)\s+(?!if\s+not\s+exists)(\w+)/gi)];
  assert.deepEqual(creates.map((m) => `${m[1]} ${m[2]}`), [],
    'every CREATE in ensureSchema must be "if not exists"');

  /* ALTER TABLE ... ADD COLUMN likewise. */
  const adds = [...mirror.matchAll(/add\s+column\s+(?!if\s+not\s+exists)(\w+)/gi)];
  assert.deepEqual(adds.map((m) => m[1]), [],
    'every ADD COLUMN in ensureSchema must be "if not exists"');

  /* A constraint is dropped before being re-added when a CHECK is widened;
     that drop must be guarded or a second boot fails. */
  for (const m of mirror.matchAll(/drop\s+constraint\s+([^\n`]*)/gi)) {
    assert.match(m[1], /if\s+exists/i, `unguarded constraint drop: ${m[0].trim().slice(0, 60)}`);
  }
});

test('6 — ensureSchema is never destructive', () => {
  /* It runs unattended on every boot against a live database. */
  for (const forbidden of [/drop\s+table/i, /drop\s+column/i, /alter\s+column/i,
    /truncate/i, /drop\s+database/i]) {
    assert.doesNotMatch(mirror, forbidden, `ensureSchema contains ${forbidden}`);
  }
  /* `delete from` is checked separately: a seeding statement may legitimately
     clear a staging table, so the assertion names what is actually forbidden —
     deleting from a table that holds customer or financial data. */
  for (const m of mirror.matchAll(/delete\s+from\s+(\w+)/gi)) {
    assert.fail(`ensureSchema deletes from ${m[1]}`);
  }
});

test('7 — the excluded views really are unused by the API', () => {
  /* 0002 is migration-only on the stated grounds that nothing reads it. If
     that ever stops being true the exclusion is wrong, and this is what says
     so. */
  const views = [...readSql('0002_views.sql')
    .matchAll(/create (?:or replace )?view\s+(\w+)/gi)].map((m) => m[1]);
  assert.ok(views.length > 0, '0002 should declare at least one view');

  const srcDir = path.join(ROOT, 'src');
  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) sources.push(fs.readFileSync(p, 'utf8'));
    }
  }(srcDir));
  const allSource = sources.join('\n');

  for (const view of views) {
    assert.ok(!new RegExp(`\\b${view}\\b`).test(allSource),
      `${view} is now read by the API — 0002 can no longer be migration-only`);
  }
});

test('8 — the base schema is excluded for a reason that still holds', () => {
  /* 0001 is excluded because it IS the database. If ensureSchema ever started
     creating core tables, the exclusion would be wrong and the two paths would
     be competing rather than complementary. */
  for (const core of ['users', 'products', 'orders', 'variations', 'stock']) {
    assert.ok(!new RegExp(`create table if not exists ${core}\\b`, 'i').test(mirror),
      `ensureSchema creates the core table ${core} — 0001 can no longer be migration-only`);
  }
});

test('9 — every in-scope migration is announced in the mirror', () => {
  /* A readability property rather than a correctness one, but it is what makes
     the mirror auditable by eye: each mirrored migration says which file it
     mirrors. Checked against the RAW source, since these are comments. */
  const missing = [];
  for (const file of migrationFiles) {
    if (MIGRATION_ONLY[file]) continue;
    const number = file.slice(0, 4);
    if (!new RegExp(`mirrors db/migrations/${number}`).test(mirrorRaw)) missing.push(file);
  }
  assert.deepEqual(missing, [],
    `these mirrored migrations are not announced in migrate.js:\n  ${missing.join('\n  ')}`);
});

test('10 — the objects the API depends on at runtime are all mirrored', () => {
  /* The severity check. These three were the actual gap, and each is read or
     written on a path that runs constantly:
       - po_number_seq       on every /admin/snapshot
       - exchange_sku        on every return creation
       - zoho_so_id          on every Zoho order push
     A database missing any of them does not degrade; it throws. */
  const runtimeCritical = [
    ['sequences', 'po_number_seq', 'read by seqNext() on every /admin/snapshot'],
    ['tables', 'purchase_orders', 'synced as the purchaseOrders collection'],
    ['columns', 'return_items.exchange_sku', 'inserted by two return routes'],
    ['columns', 'orders.zoho_so_id', 'read and written by the Zoho push'],
  ];
  for (const [kind, name, why] of runtimeCritical) {
    assert.ok(declares[kind](name), `${name} is missing from ensureSchema — ${why}`);
  }
});
