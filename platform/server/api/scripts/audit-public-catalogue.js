#!/usr/bin/env node
/* Catalogue readiness audit and dry-run backfill planner — CLI (B2.4C1).

   DRY RUN ONLY. This command reads a local JSON export and writes report
   files. It does not connect to a database, does not read DATABASE_URL or any
   other environment variable, does not accept a URL, and cannot mutate
   anything. It never emits SQL.

   Usage:
     node scripts/audit-public-catalogue.js --input <export.json> --output <dir>

   See docs/public-website-rebuild/23_CATALOGUE_BACKFILL_PLAN.md. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  auditCatalogue, AuditInputError, buildReports, writeReports, AUDIT_INPUT_CONTRACT,
} from '../src/catalogue-audit/index.js';

const HELP = `
audit-public-catalogue — catalogue readiness audit and DRY-RUN backfill planner

  Reads a local JSON catalogue export and writes a readiness audit plus a
  proposed backfill plan. It is READ-ONLY: no database is contacted, nothing is
  created, updated, deleted or published, and no SQL is produced.

USAGE
  node scripts/audit-public-catalogue.js --input <file.json> --output <directory>

OPTIONS
  --input <file>     Local JSON export. Required. A URL is not accepted.
  --output <dir>     Directory to write reports into. Required.
  --overwrite        Replace report files that already exist. Off by default.
  --quiet            Print only the summary line.
  --help, -h         Show this help.

OUTPUTS (written into --output)
  summary.json                 Counts and guarantees.
  audit-detail.json            Full machine-readable audit.
  product-readiness.csv        One row per model, with its outcome.
  proposed-changes.csv         Every proposed field change (nothing applied).
  brand-mapping-review.csv     Free-text brand values and their classification.
  integrity-findings.csv       Duplicates, collisions and broken references.

INPUT CONTRACT
  Top level: ${AUDIT_INPUT_CONTRACT.topLevel.join(', ')}
  The contract is a closed allowlist. Unknown fields are REJECTED rather than
  ignored, as are prices, stock, customer data and the unrestricted attributes
  blob — an export carrying them is a mistake worth surfacing at source.

EXIT CODES
  0  audit completed
  1  invalid arguments, unreadable input, or refusing to overwrite
  2  the export failed the input contract
`;

/* ---------------------------------------------------------------------------
   Argument parsing — explicit, no dependency, no shell interpretation
   --------------------------------------------------------------------------- */

export function parseArgs(argv) {
  const out = { input: null, output: null, overwrite: false, quiet: false, help: false };
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help': case '-h': out.help = true; break;
      case '--overwrite': out.overwrite = true; break;
      case '--quiet': out.quiet = true; break;
      case '--input': case '--output': {
        const value = argv[++i];
        if (value === undefined || value.startsWith('--')) {
          errors.push(`${arg} requires a value.`);
          break;
        }
        out[arg === '--input' ? 'input' : 'output'] = value;
        break;
      }
      default:
        errors.push(`Unknown argument "${arg}".`);
    }
  }

  if (!out.help) {
    if (!out.input) errors.push('--input is required.');
    if (!out.output) errors.push('--output is required.');
    /* A URL would mean fetching, and fetching means the tool could reach a
       production export or an attacker-controlled host. Local files only. */
    if (out.input && /^[a-z][a-z0-9+.-]*:\/\//i.test(out.input)) {
      errors.push('--input must be a local file path. URLs are not accepted.');
    }
  }
  return { options: out, errors };
}

/* ---------------------------------------------------------------------------
   Run
   --------------------------------------------------------------------------- */

/* Reports a failure and yields the exit code. Deliberately does NOT touch
   process.exitCode: `run()` is imported by tests, and a library function that
   mutates process state would make a test asserting a non-zero result fail the
   whole test file. Only the direct-invocation block below sets the code. */
function fail(message, code) {
  process.stderr.write(`${message}\n`);
  return code;
}

export function run(argv, io = {}) {
  const out = io.stdout ?? process.stdout;
  const { options, errors } = parseArgs(argv);

  if (options.help) { out.write(HELP); return 0; }
  if (errors.length) {
    return fail(`audit-public-catalogue: ${errors.join('\n  ')}\n\nRun with --help for usage.`, 1);
  }

  /* path.resolve normalises Windows separators and drive letters, so the same
     command works from Git Bash and from PowerShell. */
  const inputPath = path.resolve(options.input);
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    return fail(`audit-public-catalogue: input file not found: ${inputPath}`, 1);
  }
  if (path.extname(inputPath).toLowerCase() !== '.json') {
    return fail('audit-public-catalogue: --input must be a .json file.', 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (e) {
    return fail(`audit-public-catalogue: could not parse JSON from ${inputPath}: ${e.message}`, 1);
  }

  let audit;
  try {
    audit = auditCatalogue(parsed);
  } catch (e) {
    if (e instanceof AuditInputError) {
      process.stderr.write(
        `audit-public-catalogue: the export failed the input contract (${e.errors.length} problem(s)):\n`);
      /* Capped, because a wholly wrong file can produce thousands of problems
         and the first few are what tell an operator what went wrong. */
      for (const problem of e.errors.slice(0, 40)) {
        process.stderr.write(`  ${problem.path}  [${problem.code}]  ${problem.message}\n`);
      }
      if (e.errors.length > 40) process.stderr.write(`  … and ${e.errors.length - 40} more.\n`);
      return 2;
    }
    throw e;
  }

  const reports = buildReports(audit);
  let written;
  try {
    written = writeReports(options.output, reports, { overwrite: options.overwrite });
  } catch (e) {
    return fail(`audit-public-catalogue: ${e.message}`, 1);
  }

  const s = audit.summary;
  if (!options.quiet) {
    out.write('audit-public-catalogue — DRY RUN. Nothing was created, updated, deleted or published.\n\n');
    out.write(`  input                     ${inputPath}\n`);
    out.write(`  models                    ${s.products}\n`);
    out.write(`  colourways                ${s.variations}\n`);
    out.write(`  existing brands           ${s.brands}\n`);
    out.write(`  distinct brand values     ${s.brandValues}\n\n`);
    out.write('  readiness outcomes\n');
    for (const [outcome, count] of Object.entries(s.outcomes)) {
      out.write(`    ${outcome.padEnd(28)} ${count}\n`);
    }
    out.write('\n  brand mapping\n');
    for (const [cls, count] of Object.entries(s.brandClassifications)) {
      out.write(`    ${cls.padEnd(28)} ${count}\n`);
    }
    out.write('\n');
    out.write(`  integrity findings        ${s.integrityFindings}\n`);
    out.write(`  proposed changes          ${s.proposedChanges} (${s.proposedChangesRequiringApproval} need human approval)\n`);
    out.write(`  outstanding human inputs  ${s.outstandingHumanInputs}\n`);
    out.write(`  new brands proposed       ${s.newBrandsProposed}\n`);
    out.write(`  publications proposed     ${s.publicationsProposed}\n\n`);
    out.write('  reports written\n');
    for (const file of written) out.write(`    ${file}\n`);
    out.write('\nNothing has been applied. Applying any of this is a later, governed step.\n');
  } else {
    out.write(`DRY RUN: ${s.products} models, ${s.proposedChanges} proposed changes, ${s.integrityFindings} integrity findings, 0 mutations.\n`);
  }
  return 0;
}

/* Only run when invoked directly, so the module can be imported by tests. */
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) {
  const code = run(process.argv.slice(2));
  if (code) process.exitCode = code;
}
