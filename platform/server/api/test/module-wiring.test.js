/* Static import wiring.

   `node --check` only parses; it cannot tell that a module USES a helper it
   never imported. That exact bug shipped into this batch — place-order called
   lockCartForSubmission() after the helper had been moved to another module and
   the import was dropped. Every unit test still passed, because none of them
   import the route file; it would have thrown ReferenceError at the first real
   checkout.

   These checks read the source as text (no module loading, so nothing needs
   JWT_SECRET or a database) and verify that:
     1. every named import actually exists in the module it comes from;
     2. every shared helper a file USES is imported by that file. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : (p.endsWith('.js') ? [p] : []);
  });
}
const FILES = walk(SRC);
const read = f => fs.readFileSync(f, 'utf8');
const strip = s => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')      // line comments
  .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')   // template literals
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""');

/** Named imports: [{ names, from }] */
function namedImports(src) {
  const out = [];
  const re = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    out.push({
      names: m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean),
      from: m[2],
    });
  }
  return out;
}

/** Exported names of a module. */
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const as = part.trim().split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  return names;
}

test('every named import exists in the module it is imported from', () => {
  const problems = [];
  for (const file of FILES) {
    const src = read(file);
    for (const imp of namedImports(src)) {
      if (!imp.from.startsWith('.')) continue;                 // node_modules
      const target = path.resolve(path.dirname(file), imp.from);
      if (!fs.existsSync(target)) { problems.push(`${file}: missing module ${imp.from}`); continue; }
      const exported = exportedNames(read(target));
      for (const name of imp.names) {
        if (!exported.has(name)) {
          problems.push(`${path.relative(SRC, file)} imports { ${name} } from `
            + `${imp.from}, which does not export it`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

/* Shared helpers that are easy to call after a move without re-importing.
   Each maps to the module that owns it. */
const SHARED_HELPERS = {
  lockCartForSubmission: './ordering.js',
  resolveOrderingCustomer: './ordering.js',
  pricingIdentity: './ordering.js',
  sanitizeOrderNote: './ordering.js',
  orderFieldsFromBackorder: './ordering.js',
  reconcileBackorderSync: './ordering.js',
  isBackorderProcessable: './ordering.js',
  canDeleteBackorder: './ordering.js',
  BACKORDER_LOCK_SQL: './ordering.js',
  BACKORDER_DELETE_CANDIDATES_SQL: './ordering.js',
  CART_SUBMISSION_LOCK_SQL: './ordering.js',
  compareCartSnapshots: './ordering.js',
  normalizeCartRow: './ordering.js',
  orderLinesForLocking: './ordering.js',
  allocateCommercials: './pricing.js',
  planAllocation: './inventory.js',
  planConversion: './inventory.js',
  planSkuReservations: './inventory.js',
  reserveTakes: './inventory.js',
  aggregateBySku: './inventory.js',
  recordMovement: './inventory.js',
  afterCommit: './postcommit.js',
  afterCommitDetached: './postcommit.js',
  invalidateCatalogCache: './routes/catalog.js',
  startServer: './startup.js',
};

test('every shared helper a file USES is imported by that file', () => {
  const problems = [];
  for (const file of FILES) {
    const raw = read(file);
    const code = strip(raw);
    const owner = path.relative(SRC, file).replace(/\\/g, '/');
    const imported = new Set(namedImports(raw).flatMap(i => i.names));
    const declaredHere = exportedNames(raw);

    for (const helper of Object.keys(SHARED_HELPERS)) {
      if (declaredHere.has(helper)) continue;                  // this file owns it
      // a real call/reference, not a substring of a longer identifier
      const used = new RegExp(`(?<![\\w$.])${helper}(?![\\w$])`).test(code);
      if (used && !imported.has(helper)) {
        problems.push(`${owner} uses ${helper}() but never imports it `
          + `(owner: ${SHARED_HELPERS[helper]})`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the guard itself works — it would have caught the dropped import', () => {
  // Reproduces the exact defect: a file that calls the helper without importing.
  const broken = `
    import { cartSummary } from './cart.js';
    async function place(c, user) {
      const locked = await lockCartForSubmission(c, user.id);
      return locked;
    }`;
  const imported = new Set(namedImports(broken).flatMap(i => i.names));
  const used = /(?<![\w$.])lockCartForSubmission(?![\w$])/.test(strip(broken));
  assert.equal(used, true);
  assert.equal(imported.has('lockCartForSubmission'), false);
  assert.ok(used && !imported.has('lockCartForSubmission'), 'this is what the check flags');
});

test('comments and strings do not produce false positives', () => {
  const benign = `
    /* mentions lockCartForSubmission in prose */
    // and lockCartForSubmission again
    const msg = 'lockCartForSubmission';
    const tpl = \`lockCartForSubmission\`;
  `;
  assert.equal(/(?<![\w$.])lockCartForSubmission(?![\w$])/.test(strip(benign)), false);
});

test('a property access of the same name is not treated as a bare call', () => {
  assert.equal(/(?<![\w$.])reserveTakes(?![\w$])/.test(strip('await db.reserveTakes(x);')), false);
});
