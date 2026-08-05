/* Additive public-content schema (B2.1) — structural/semantic assertions,
   not executable-database assertions.

   No PostgreSQL executable is available on this machine (checked: no
   `psql`/`postgres` on PATH, no C:\Program Files\PostgreSQL) and none was
   installed for this batch, per the task brief. Following this
   repository's existing convention for schema-adjacent tests
   (module-wiring.test.js reads source as text rather than loading modules
   that need a live database — see its own header comment), every test
   here reads platform/server/db/migrations/0007_public_site.sql and
   platform/server/api/src/migrate.js as plain text and asserts on their
   structure. This is the strongest available validation without a live
   database — see docs/public-website-rebuild/14_B2_SCHEMA_REFERENCE.md §9
   for the full limitation note. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const API_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_SERVER_ROOT = path.dirname(API_ROOT);

const migrationPath = path.join(REPO_SERVER_ROOT, 'db', 'migrations', '0007_public_site.sql');
const migrateJsPath = path.join(API_ROOT, 'src', 'migrate.js');
const baseSchemaPath = path.join(REPO_SERVER_ROOT, 'db', 'migrations', '0001_schema.sql');

const migration = fs.readFileSync(migrationPath, 'utf8');
const migrateJs = fs.readFileSync(migrateJsPath, 'utf8');
const baseSchema = fs.readFileSync(baseSchemaPath, 'utf8');

const NEW_TABLES = [
  'brands',
  'locations',
  'policies',
  'media',
  'redirects',
  'content_pages',
  'forms',
  'form_submissions',
  'content_approvals',
];

// ---------- 1. every required new table exists in the migration ----------

test('the migration file exists at the correctly numbered path', () => {
  assert.ok(fs.existsSync(migrationPath), '0007_public_site.sql not found');
});

for (const table of NEW_TABLES) {
  test(`migration creates table "${table}"`, () => {
    assert.match(migration, new RegExp(`create table if not exists ${table}\\s*\\(`));
  });
  test(`migrate.js's ensureSchema() also creates table "${table}" (existing-database path)`, () => {
    assert.match(migrateJs, new RegExp(`create table if not exists ${table}\\s*\\(`));
  });
}

test('sanity: exactly 9 new tables are asserted', () => {
  assert.equal(NEW_TABLES.length, 9);
});

// ---------- 2/3. every approved additive product/variation field exists ----------

const PRODUCT_FIELDS = [
  'public_slug',
  'brand_id',
  'line',
  'shape',
  'segment',
  'public_description',
  'is_published',
  'is_featured',
  'is_discontinued',
  'replacement_product_id',
  'publication_state',
  'source_reference',
  'fact_owner',
  'verification_status',
  'last_reviewed_at',
  'scheduled_review_at',
  'content_updated_at',
];

const VARIATION_FIELDS = ['color_code', 'swatch_media_id', 'is_published'];

for (const field of PRODUCT_FIELDS) {
  test(`products gains additive field "${field}" in both the migration and migrate.js`, () => {
    const re = new RegExp(`alter table products add column if not exists ${field}\\b`);
    assert.match(migration, re, `missing in 0007_public_site.sql`);
    assert.match(migrateJs, re, `missing in migrate.js`);
  });
}

for (const field of VARIATION_FIELDS) {
  test(`variations gains additive field "${field}" in both the migration and migrate.js`, () => {
    const re = new RegExp(`alter table variations add column if not exists ${field}\\b`);
    assert.match(migration, re, `missing in 0007_public_site.sql`);
    assert.match(migrateJs, re, `missing in migrate.js`);
  });
}

// ---------- 4. existing columns are not dropped or renamed ----------

test('neither file contains a DROP COLUMN, DROP TABLE, or RENAME statement', () => {
  for (const [name, content] of [
    ['0007_public_site.sql', migration],
    ['migrate.js', migrateJs],
  ]) {
    assert.doesNotMatch(content, /drop\s+column/i, `${name} contains DROP COLUMN`);
    assert.doesNotMatch(content, /drop\s+table/i, `${name} contains DROP TABLE`);
    assert.doesNotMatch(content, /rename\s+(column|to)/i, `${name} contains RENAME`);
    assert.doesNotMatch(content, /alter\s+column\s+\S+\s+type/i, `${name} retypes an existing column`);
  }
});

test('0001_schema.sql (the existing base schema) is untouched by this batch', () => {
  // Spot-check specific existing definitions this migration deliberately
  // does not touch, still present verbatim.
  assert.match(baseSchema, /brand\s+text not null default ''/, 'products.brand definition changed');
  assert.match(baseSchema, /is_active\s+boolean not null default true/, 'products.is_active definition changed');
  assert.match(baseSchema, /color\s+text not null default ''/, 'variations.color definition changed');
});

// ---------- 5/6. publication-state / verification-state constraints ----------

const GOVERNANCE_TABLES_FOR_CHECKS = ['brands', 'locations', 'policies', 'content_pages'];

test('publication_state CHECK contains all five approved states, on every governance table and on products', () => {
  const expected = "check (publication_state in ('draft','verified','approved','published','retired'))";
  // products' governance columns are added via ALTER, so its CHECK is
  // split across lines in the source; check the constituent state list
  // appears verbatim regardless of which table it is attached to.
  const occurrences = (migration.match(/check \(publication_state in \('draft','verified','approved','published','retired'\)\)/g) || []).length;
  assert.ok(occurrences >= GOVERNANCE_TABLES_FOR_CHECKS.length + 1, `expected at least 5 occurrences (4 tables + products), found ${occurrences}`);
  assert.ok(migration.includes(expected) || migration.includes(expected.replace(/'/g, "'")), 'exact state list not found verbatim');
});

test('verification_status CHECK contains all three approved states, on every governance table and on products', () => {
  const occurrences = (migration.match(/check \(verification_status in \('unverified','sourced','verified'\)\)/g) || []).length;
  assert.ok(occurrences >= GOVERNANCE_TABLES_FOR_CHECKS.length + 1, `expected at least 5 occurrences (4 tables + products), found ${occurrences}`);
});

test('the same two CHECK state lists are mirrored in migrate.js', () => {
  assert.match(migrateJs, /check \(publication_state in \('draft','verified','approved','published','retired'\)\)/);
  assert.match(migrateJs, /check \(verification_status in \('unverified','sourced','verified'\)\)/);
});

// ---------- 7. products default to not published ----------

test('products.is_published defaults to false', () => {
  const re = /is_published\s+boolean not null default false/;
  assert.match(migration, re);
  assert.match(migrateJs, re);
});

test('no statement in either file sets any existing product row to published', () => {
  for (const [name, content] of [
    ['0007_public_site.sql', migration],
    ['migrate.js', migrateJs],
  ]) {
    assert.doesNotMatch(content, /update\s+products\s+set[^;]*is_published\s*=\s*true/i, `${name} sets is_published = true`);
    assert.doesNotMatch(content, /update\s+products\s+set[^;]*publication_state\s*=\s*'published'/i, `${name} sets publication_state = 'published'`);
  }
});

// ---------- 8. new content records default to draft/unverified ----------

test('every new governance-bearing table defaults publication_state to draft and verification_status to unverified', () => {
  for (const table of GOVERNANCE_TABLES_FOR_CHECKS) {
    // Extract the table's own create-table block and check the defaults
    // appear inside it.
    const re = new RegExp(`create table if not exists ${table}\\s*\\([\\s\\S]*?\\n\\);`);
    const block = migration.match(re)?.[0];
    assert.ok(block, `could not isolate ${table}'s create-table block`);
    assert.match(block, /publication_state\s+text not null default 'draft'/, `${table} does not default to draft`);
    assert.match(block, /verification_status\s+text not null default 'unverified'/, `${table} does not default to unverified`);
  }
});

// ---------- 9. redirect status constraints ----------

test('redirects.status is constrained to 301, 302 or 410', () => {
  const re = /status\s+int not null default 301 check \(status in \(301, 302, 410\)\)/;
  assert.match(migration, re);
  assert.match(migrateJs, re);
});

// ---------- 10. form delivery states are constrained ----------

test('form_submissions.delivery_state is constrained to pending, sent or failed', () => {
  const re = /delivery_state\s+text not null default 'pending' check \(delivery_state in \('pending', 'sent', 'failed'\)\)/;
  assert.match(migration, re);
  assert.match(migrateJs, re);
});

// ---------- 11/12. staged nullable migration for public_slug / brand_id ----------

test('products.public_slug is nullable (no NOT NULL), permitting staged backfill', () => {
  const re = /alter table products add column if not exists public_slug\s+text;/;
  assert.match(migration, re, 'public_slug must have no NOT NULL clause in 0007');
  const jsRe = /alter table products add column if not exists public_slug\s+text`\);/;
  assert.match(migrateJs, jsRe, 'public_slug must have no NOT NULL clause in migrate.js');
});

test('products.brand_id is nullable (no NOT NULL), permitting staged backfill', () => {
  assert.doesNotMatch(
    migration.match(/alter table products add column if not exists brand_id[^\n]*/)[0],
    /not null/i
  );
  assert.doesNotMatch(
    migrateJs.match(/alter table products add column if not exists brand_id[^\n]*/)[0],
    /not null/i
  );
});

test('public_slug uniqueness is enforced without forbidding NULL (a plain unique index, not NOT NULL UNIQUE)', () => {
  const re = /create unique index if not exists products_public_slug_idx on products \(public_slug\)/;
  assert.match(migration, re);
  assert.match(migrateJs, re);
});

// ---------- 13/14. slug-change protection exists for brands and products ----------

test('a slug-change trigger exists for brands', () => {
  assert.match(migration, /create trigger t_brands_slug_redirect\s+before update on brands/);
  assert.match(migrateJs, /t_brands_slug_redirect/);
});

test('a slug-change trigger exists for products', () => {
  assert.match(migration, /create trigger t_products_slug_redirect\s+before update on products/);
  assert.match(migrateJs, /t_products_slug_redirect/);
});

// ---------- 15. unpublished slug changes do not create redirects ----------

test('the brand slug-redirect function only inserts when the OLD row was already published', () => {
  const fn = migration.match(/create or replace function record_brand_slug_redirect[\s\S]*?\$\$ language plpgsql;/)[0];
  assert.match(fn, /if old\.publication_state = 'published'/);
});

test('the product slug-redirect function only inserts when the OLD row was already is_published', () => {
  const fn = migration.match(/create or replace function record_product_slug_redirect[\s\S]*?\$\$ language plpgsql;/)[0];
  assert.match(fn, /if old\.is_published/);
});

// ---------- 16. unchanged slugs do not create redirects ----------

test('both slug-redirect functions require the slug to actually change (IS DISTINCT FROM)', () => {
  const brandFn = migration.match(/create or replace function record_brand_slug_redirect[\s\S]*?\$\$ language plpgsql;/)[0];
  const productFn = migration.match(/create or replace function record_product_slug_redirect[\s\S]*?\$\$ language plpgsql;/)[0];
  assert.match(brandFn, /new\.slug is distinct from old\.slug/);
  assert.match(productFn, /new\.public_slug is distinct from old\.public_slug/);
});

// ---------- 17. redirect targets are internal paths ----------

test('redirects.to_path is constrained to empty or an internal path (never absolute/external)', () => {
  const re = /constraint redirects_to_path_internal check \(to_path = '' or to_path like '\/%'\)/;
  assert.match(migration, re);
  assert.match(migrateJs, re);
});

test('the slug-redirect functions only ever construct a leading-slash internal path', () => {
  const brandFn = migration.match(/create or replace function record_brand_slug_redirect[\s\S]*?\$\$ language plpgsql;/)[0];
  const productFn = migration.match(/create or replace function record_product_slug_redirect[\s\S]*?\$\$ language plpgsql;/)[0];
  assert.match(brandFn, /'\/brands\/' \|\|/);
  assert.match(productFn, /'\/collections\/' \|\|/);
  assert.doesNotMatch(brandFn, /https?:\/\//);
  assert.doesNotMatch(productFn, /https?:\/\//);
});

test('duplicate redirect insertion is guarded (ON CONFLICT DO NOTHING), never a silent overwrite', () => {
  const brandFn = migration.match(/create or replace function record_brand_slug_redirect[\s\S]*?\$\$ language plpgsql;/)[0];
  const productFn = migration.match(/create or replace function record_product_slug_redirect[\s\S]*?\$\$ language plpgsql;/)[0];
  assert.match(brandFn, /on conflict \(from_path\) do nothing/);
  assert.match(productFn, /on conflict \(from_path\) do nothing/);
});

// ---------- 18. no migration updates existing products to published ----------
// (see the shared assertion under "products default to not published" above)

test('the published-requires-state CHECK makes it structurally impossible to publish via this migration', () => {
  const re = /check \(is_published = false or publication_state = 'published'\)/;
  assert.match(migration, re);
  assert.match(migrateJs, re);
});

// ---------- 19. no DROP COLUMN or destructive table operation ----------
// (covered above; this test asserts the inverse — that ADD/CREATE dominate)

test('every table/column-shaping statement in the migration is additive (CREATE or ADD, never DROP/ALTER TYPE)', () => {
  const ddlLines = migration
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(create|alter)\s/i.test(l));
  assert.ok(ddlLines.length > 0, 'no DDL found — the extraction itself is broken');
  for (const line of ddlLines) {
    assert.doesNotMatch(line, /drop/i, `destructive line: ${line}`);
  }
});

test('self-reference and publish-requires-state constraints are present and additive (ALTER ... ADD CONSTRAINT, not a rewrite)', () => {
  assert.match(migration, /alter table products add constraint products_replacement_not_self/);
  assert.match(migration, /alter table products add constraint products_published_requires_state/);
});

// ---------- 20. existing API tests remain green ----------
// Verified by running the full suite in the same `npm test` invocation as
// this file — see the B2.1 validation step. No test here can assert that
// directly; it is a property of the whole-suite run, not of this file.

test('migrate.js is valid, parseable ESM (sanity on the mirrored copy)', () => {
  // `node --check` parses without executing (no DB connection needed) and
  // correctly understands ESM `import`/`export`, unlike the Function
  // constructor. A syntax error here would already fail API startup.
  const result = spawnSync(process.execPath, ['--check', migrateJsPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
