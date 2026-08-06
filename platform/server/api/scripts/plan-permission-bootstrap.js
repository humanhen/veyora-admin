#!/usr/bin/env node
/* Permission-bootstrap plan generator — CLI (Security Hardening Phase 5).
 *
 * PLANS ONLY. This command reads a LOCAL JSON file describing candidate
 * accounts and writes a reviewable plan plus SQL text. It does not connect to
 * a database, does not read DATABASE_URL or any other connection variable,
 * does not accept a URL, and cannot grant anything.
 *
 * That is enforced structurally rather than promised: nothing in this file or
 * in the module it imports pulls in `pg`, `db.js`, or any network client. A
 * test asserts it.
 *
 * Usage:
 *   node scripts/plan-permission-bootstrap.js --input candidates.json [--output plan.sql]
 *
 * The input is produced by a person, from a supervised read-only query:
 *
 *   select id, username, email, role, status from users where status = 'active';
 *
 * See docs/public-website-rebuild/19_ACCOUNT_PERMISSION_SYSTEM.md §8.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  MIN_MANAGERS,
  renderBootstrapSql,
  validateBootstrapPlan,
} from '../src/bootstrap-plan.js';

const HELP = `
plan-permission-bootstrap — validate and render a permission bootstrap

  Reads a local JSON file of candidate accounts and produces a reviewed plan.
  It CONTACTS NO DATABASE and grants nothing: the output is SQL text for a
  person to check and run on a supervised connection.

USAGE
  node scripts/plan-permission-bootstrap.js --input <file.json> [--output <file.sql>]

OPTIONS
  --input <file>    JSON: { "accounts": [...], "selectedIds": [...],
                            "existingHolders": [...] }. Required.
  --output <file>   Write the SQL to a file as well as stdout. Optional.
  --help, -h        Show this text.

INPUT SHAPE
  accounts         [{ id, username, email, role, status }]
  selectedIds      ids proposed to receive permissions.manage
  existingHolders  ids that already hold it (default: none)

At least ${MIN_MANAGERS} active holders must exist after the bootstrap, because
the API refuses to revoke the last one — with a single holder, losing that
account locks everybody out.
`;

function parseArgs(argv) {
  const args = { input: null, output: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--input') args.input = argv[++i] ?? null;
    else if (a === '--output') args.output = argv[++i] ?? null;
    else return { error: `Unknown argument: ${a}` };
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    process.stderr.write(`plan-permission-bootstrap: ${args.error}\n\nRun with --help for usage.\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.input) {
    process.stderr.write('plan-permission-bootstrap: --input is required.\n\nRun with --help for usage.\n');
    return 2;
  }
  /* A URL is not a file. Refusing it here makes "this cannot reach a server"
     an explicit rule rather than an accident of implementation. */
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(args.input)) {
    process.stderr.write('plan-permission-bootstrap: --input must be a local file, not a URL.\n');
    return 2;
  }

  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'));
  } catch (err) {
    process.stderr.write(`plan-permission-bootstrap: could not read --input: ${err.message}\n`);
    return 2;
  }

  let result;
  try {
    result = validateBootstrapPlan(payload);
  } catch (err) {
    process.stderr.write(`plan-permission-bootstrap: ${err.message}\n`);
    return 2;
  }

  const out = [];
  out.push('Permission bootstrap plan');
  out.push('=========================');
  out.push('');
  out.push(`Proposed holders of permissions.manage: ${result.plan.length}`);
  for (const entry of result.plan) {
    out.push(`  ${entry.id}  ${entry.username ?? '(no username)'}  [${entry.role ?? '?'}, ${entry.status}]`);
  }
  out.push('');

  if (result.warnings.length) {
    out.push('WARNINGS — review before proceeding:');
    for (const w of result.warnings) out.push(`  [${w.code}] ${w.message}`);
    out.push('');
  }

  if (!result.ok) {
    out.push('BLOCKING — this plan must not be executed:');
    for (const b of result.blocking) out.push(`  [${b.code}] ${b.message}`);
    out.push('');
    out.push('No SQL was rendered.');
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }

  out.push('Review checklist — confirm every line before running the SQL:');
  for (const item of result.checklist) out.push(`  [ ] ${item}`);
  out.push('');

  const sql = renderBootstrapSql(result);
  out.push(sql);
  out.push('');
  out.push('NOTHING HAS BEEN EXECUTED. This command contacts no database.');

  process.stdout.write(out.join('\n') + '\n');

  if (args.output) {
    fs.writeFileSync(path.resolve(args.output), sql + '\n', 'utf8');
    process.stdout.write(`\nSQL also written to ${args.output}\n`);
  }
  return 0;
}

process.exitCode = main();
