#!/usr/bin/env node
/* Read-only catalogue exporter — CLI (Fast-Track Phase 1, for B2.4C2).

   Produces the closed audit-input fixture that audit-public-catalogue.js
   consumes. It reads and writes one local file. It issues only SELECT
   statements, opens no transaction, and generates no SQL file.

   The connection comes from the repository's existing convention
   (`src/db.js`, which reads DATABASE_URL) and is imported lazily, so this
   file can be loaded — and its argument handling tested — without a database
   being configured at all.

   NO EXPORT WAS RUN DURING THE BATCH THAT ADDED THIS. See
   docs/public-website-rebuild/23_CATALOGUE_BACKFILL_PLAN.md §17. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { exportCatalogue } from '../src/catalogue-audit/export.js';

const HELP = `
export-public-catalogue — READ-ONLY catalogue export for the backfill audit

  Reads the catalogue and writes a JSON fixture matching the audit input
  contract. It issues only SELECT statements: nothing is created, updated,
  deleted or published, and no SQL file is produced.

  Prices, sale prices, purchase costs, stock, warehouses, customer and order
  data, Zoho identifiers and the unrestricted attributes blob are never
  selected. Public descriptions and source references are exported as
  PRESENCE BOOLEANS only — the copy itself never leaves the database.

USAGE
  node scripts/export-public-catalogue.js --output <file.json> [--source <label>]

OPTIONS
  --output <file>   Local .json path to write. Required. A URL is not accepted.
  --source <label>  Recorded in the fixture, e.g. "staging-2026-08-06".
  --overwrite       Replace the file if it already exists. Off by default.
  --help, -h        Show this help.

CONNECTION
  Uses the repository's existing database configuration (DATABASE_URL via
  src/db.js). No host, credential or origin is embedded in this script.

NEXT STEP
  node scripts/audit-public-catalogue.js --input <file.json> --output <dir>

EXIT CODES
  0  export written
  1  invalid arguments, refusing to overwrite, or the export failed
`;

export function parseArgs(argv) {
  const out = { output: null, source: null, overwrite: false, help: false };
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help': case '-h': out.help = true; break;
      case '--overwrite': out.overwrite = true; break;
      case '--output': case '--source': {
        const value = argv[++i];
        if (value === undefined || value.startsWith('--')) { errors.push(`${arg} requires a value.`); break; }
        out[arg === '--output' ? 'output' : 'source'] = value;
        break;
      }
      default: errors.push(`Unknown argument "${arg}".`);
    }
  }

  if (!out.help) {
    if (!out.output) errors.push('--output is required.');
    /* A URL destination would mean uploading a catalogue file somewhere. */
    if (out.output && /^[a-z][a-z0-9+.-]*:\/\//i.test(out.output)) {
      errors.push('--output must be a local file path. URLs are not accepted.');
    }
    if (out.output && path.extname(out.output).toLowerCase() !== '.json') {
      errors.push('--output must be a .json file.');
    }
  }
  return { options: out, errors };
}

/**
 * @param deps.getDb  supplies the database client. Injected so tests never
 *                    import src/db.js, which would open a pool.
 */
export async function run(argv, { stdout = process.stdout, getDb } = {}) {
  const { options, errors } = parseArgs(argv);

  if (options.help) { stdout.write(HELP); return 0; }
  if (errors.length) {
    process.stderr.write(`export-public-catalogue: ${errors.join('\n  ')}\n\nRun with --help for usage.\n`);
    return 1;
  }

  const outputPath = path.resolve(options.output);
  if (fs.existsSync(outputPath) && !options.overwrite) {
    process.stderr.write(
      `export-public-catalogue: refusing to overwrite ${outputPath}. Use --overwrite to replace it.\n`);
    return 1;
  }

  let db;
  try {
    db = getDb ? await getDb() : (await import('../src/db.js')).pool;
  } catch (e) {
    /* The message, not the stack or the connection string. */
    process.stderr.write(`export-public-catalogue: could not obtain a database connection: ${e.message}\n`);
    return 1;
  }

  let fixture;
  try {
    fixture = await exportCatalogue(db, { source: options.source, exportedAt: new Date() });
  } catch (e) {
    process.stderr.write(`export-public-catalogue: the export failed: ${e.message}\n`);
    return 1;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(fixture, null, 2) + '\n', 'utf8');

  /* Counts and a path. Never a record, never a field value, never the
     connection string. */
  stdout.write('export-public-catalogue — READ-ONLY. Nothing was created, updated, deleted or published.\n\n');
  stdout.write(`  brands            ${fixture.brands.length}\n`);
  stdout.write(`  models            ${fixture.products.length}\n`);
  stdout.write(`  colourways        ${fixture.variations.length}\n`);
  stdout.write(`  media references  ${fixture.media.length}\n\n`);
  stdout.write(`  written           ${outputPath}\n\n`);
  stdout.write('Next: node scripts/audit-public-catalogue.js --input <file> --output <dir>\n');
  return 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) {
  run(process.argv.slice(2)).then((code) => { if (code) process.exitCode = code; });
}
