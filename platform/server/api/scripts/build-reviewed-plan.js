#!/usr/bin/env node
/* Reviewed backfill plan generator — CLI (Fast-Track Phase 1, for B2.4C2).

   Combines a B2.4C1 audit with an explicit human review file into a reviewed
   plan. Reads two local files, writes one. No database, no network, no SQL.

   The output is still NOT executable. It is the artefact B2.4C3 will apply,
   one record at a time, through the governed administrative API. */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { auditCatalogue, AuditInputError } from '../src/catalogue-audit/index.js';
import { validateReviewDecisions, buildReviewedPlan, ReviewInputError, REVIEW_CONTRACT } from '../src/catalogue-audit/review.js';

const HELP = `
build-reviewed-plan — combine a catalogue audit with human review decisions

  Produces a reviewed backfill plan. The result is NOT executable and contains
  no SQL. Applying it is a separate, governed step through the admin API.

USAGE
  node scripts/build-reviewed-plan.js --export <export.json> --decisions <review.json> --output <plan.json>

OPTIONS
  --export <file>     The catalogue export (audit input). Required.
  --decisions <file>  The human review decisions. Required.
  --output <file>     Local .json path for the reviewed plan. Required.
  --overwrite         Replace the output if it exists. Off by default.
  --help, -h          Show this help.

REVIEW FILE
  Top level: ${REVIEW_CONTRACT.topLevel.join(', ')}
  Closed allowlist — unknown fields are rejected. Overridable fields:
  ${REVIEW_CONTRACT.overridableFields.join(', ')}.

  Publication cannot be decided here. is_published, publication_state,
  verification_status, approval identity and review dates are REFUSED, because
  publication is a gated, approval-recorded operation performed one record at
  a time through the admin API.

NOTHING IS INFERRED
  A proposal with no matching decision stays "unresolved". Silence is never
  read as approval.

EXIT CODES
  0  reviewed plan written
  1  invalid arguments, unreadable input, or refusing to overwrite
  2  the export or the review file failed its contract
`;

export function parseArgs(argv) {
  const out = { export: null, decisions: null, output: null, overwrite: false, help: false };
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help': case '-h': out.help = true; break;
      case '--overwrite': out.overwrite = true; break;
      case '--export': case '--decisions': case '--output': {
        const value = argv[++i];
        if (value === undefined || value.startsWith('--')) { errors.push(`${arg} requires a value.`); break; }
        out[arg.slice(2)] = value;
        break;
      }
      default: errors.push(`Unknown argument "${arg}".`);
    }
  }

  if (!out.help) {
    for (const key of ['export', 'decisions', 'output']) {
      if (!out[key]) errors.push(`--${key} is required.`);
      else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(out[key])) errors.push(`--${key} must be a local file path.`);
    }
  }
  return { options: out, errors };
}

function readJson(file, label, problems) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    problems.push(`${label} not found: ${resolved}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (e) {
    problems.push(`${label} is not valid JSON: ${e.message}`);
    return null;
  }
}

export function run(argv, { stdout = process.stdout } = {}) {
  const { options, errors } = parseArgs(argv);
  if (options.help) { stdout.write(HELP); return 0; }
  if (errors.length) {
    process.stderr.write(`build-reviewed-plan: ${errors.join('\n  ')}\n\nRun with --help for usage.\n`);
    return 1;
  }

  const outputPath = path.resolve(options.output);
  if (fs.existsSync(outputPath) && !options.overwrite) {
    process.stderr.write(`build-reviewed-plan: refusing to overwrite ${outputPath}. Use --overwrite to replace it.\n`);
    return 1;
  }

  const problems = [];
  const rawExport = readJson(options.export, 'export', problems);
  const rawDecisions = readJson(options.decisions, 'decisions', problems);
  if (problems.length) {
    process.stderr.write(`build-reviewed-plan: ${problems.join('\n  ')}\n`);
    return 1;
  }

  let audit;
  try {
    audit = auditCatalogue(rawExport);
  } catch (e) {
    if (e instanceof AuditInputError) {
      process.stderr.write(`build-reviewed-plan: the export failed the audit input contract (${e.errors.length} problem(s)):\n`);
      for (const p of e.errors.slice(0, 40)) process.stderr.write(`  ${p.path}  [${p.code}]  ${p.message}\n`);
      return 2;
    }
    throw e;
  }

  const validated = validateReviewDecisions(rawDecisions);
  if (!validated.ok) {
    process.stderr.write(`build-reviewed-plan: the review file failed its contract (${validated.errors.length} problem(s)):\n`);
    for (const p of validated.errors.slice(0, 40)) process.stderr.write(`  ${p.path}  [${p.code}]  ${p.message}\n`);
    return 2;
  }

  const plan = buildReviewedPlan(audit, validated.decisions);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(plan, null, 2) + '\n', 'utf8');

  const s = plan.summary;
  stdout.write('build-reviewed-plan — the result is NOT executable and contains no SQL.\n\n');
  stdout.write(`  entries                   ${s.entries}\n`);
  for (const [state, count] of Object.entries(s.byState)) {
    stdout.write(`    ${state.padEnd(24)} ${count}\n`);
  }
  stdout.write(`  reviewer overrides        ${s.reviewerOverrides}\n`);
  stdout.write(`  reviewer-added entries    ${s.reviewerAdded}\n`);
  stdout.write(`  new brands (approved)     ${s.newBrands} (${s.newBrandsApproved})\n`);
  stdout.write(`  outstanding integrity     ${s.outstandingIntegrityFindings}\n`);
  stdout.write(`  outstanding human inputs  ${s.outstandingHumanInputs}\n`);
  stdout.write(`  publications proposed     ${s.publicationsProposed}\n\n`);
  stdout.write(`  written                   ${outputPath}\n\n`);
  stdout.write('Nothing has been applied. Applying this is a governed step through the admin API.\n');
  return 0;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedDirectly) {
  const code = run(process.argv.slice(2));
  if (code) process.exitCode = code;
}
