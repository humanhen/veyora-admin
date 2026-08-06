#!/usr/bin/env node
/* Store-contact migration planner — CLI (Final Handover, Phase 2).
 *
 * PLANS ONLY. This command reads a LOCAL JSON file describing legacy customer
 * records and writes a reviewable plan as JSON and CSV. It does not connect to
 * a database, does not read DATABASE_URL or any other connection variable,
 * does not accept a URL, and creates no contact.
 *
 * That is enforced structurally rather than promised: nothing in this file or
 * in the module it imports pulls in `pg`, `db.js`, or any network client. A
 * test asserts it, exactly as it does for plan-permission-bootstrap.js.
 *
 * Usage:
 *   node scripts/plan-store-contacts.js --input customers.json --out-dir ./review
 *
 * The input is produced by a person, from a supervised read-only query:
 *
 *   select u.id, u.customer_number, u.business, u.first_name, u.last_name,
 *          u.email, u.phone, u.role, u.status,
 *          (select count(*) from customer_contacts cc where cc.customer_id = u.id)
 *            as existing_contact_count
 *     from users u
 *    where u.role in ('customer', 'special customer');
 *
 * WHAT HAPPENS TO THE OUTPUT
 *
 * A person opens the CSV, reads each row, and types `yes` in the `approved`
 * column for the ones they are willing to vouch for. Nothing is pre-approved.
 * Rows the planner marked `skip` cannot be approved into existence — the
 * approval step refuses them — because a tick in a spreadsheet is not a
 * decision to override a rule the reviewer may not have read.
 *
 * Approved rows are then created through the governed API
 * (POST /admin/customer-contacts/:customerId) by somebody holding
 * `customer_contacts.manage`. There is no bulk applier in this repository and
 * this script is not one.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { plan, toCSV, toJSON } from '../src/contact-migration-planner.js';

const HELP = `
plan-store-contacts — propose primary store contacts from legacy customer fields

  Reads a local JSON file of legacy customer records and produces a review
  artefact. It CONTACTS NO DATABASE and creates nothing: the output is a plan
  for a person to read, correct and approve.

USAGE
  node scripts/plan-store-contacts.js --input <file.json> [--out-dir <dir>]

OPTIONS
  --input <file>     JSON: an array of records, or { "customers": [...] }.
                     Required.
  --out-dir <dir>    Where to write contact-plan.json and contact-plan.csv.
                     Defaults to the input file's directory.
  --generated-at <s> Stamp written into the artefact. Defaults to empty, which
                     keeps two runs over the same input byte-identical.
  --help, -h         Show this text.

RECORD SHAPE
  { id, customerNumber, business, firstName, lastName, email, phone,
    role, status, existingContactCount }

  snake_case keys straight from the query above are accepted too.

WHAT IT WILL NOT DO
  It never infers a job title or a responsibility - both come out empty.
  It never proposes a contact with no name or no reachable channel.
  It never creates a portal account; the customer's own account is proposed
  as a LINK only, and only for an active account.
`;

function parseArgs(argv) {
  const args = { input: '', outDir: '', generatedAt: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--input') args.input = argv[++i] ?? '';
    else if (a === '--out-dir') args.outDir = argv[++i] ?? '';
    else if (a === '--generated-at') args.generatedAt = argv[++i] ?? '';
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

/* Accepts either camelCase or the snake_case a psql export produces, so the
   documented query's output can be piped in without a reshaping step nobody
   would test. */
const pick = (row, ...keys) => {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return '';
};

function normaliseRecord(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    id: pick(r, 'id'),
    customerNumber: pick(r, 'customerNumber', 'customer_number'),
    business: pick(r, 'business'),
    firstName: pick(r, 'firstName', 'first_name'),
    lastName: pick(r, 'lastName', 'last_name'),
    email: pick(r, 'email'),
    phone: pick(r, 'phone'),
    role: pick(r, 'role'),
    status: pick(r, 'status'),
    existingContactCount: Number(pick(r, 'existingContactCount', 'existing_contact_count')) || 0,
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${HELP}`);
    process.exit(2);
    return;
  }

  if (args.help || !args.input) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 2);
    return;
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  } catch (err) {
    process.stderr.write(`Could not read ${args.input}: ${err.message}\n`);
    process.exit(1);
    return;
  }

  const rows = Array.isArray(raw) ? raw : raw?.customers;
  if (!Array.isArray(rows)) {
    process.stderr.write('The input must be an array of records, or { "customers": [...] }.\n');
    process.exit(2);
    return;
  }

  const result = plan(rows.map(normaliseRecord), {
    generatedAt: args.generatedAt === '' ? null : args.generatedAt,
  });

  const outDir = args.outDir || path.dirname(path.resolve(args.input));
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'contact-plan.json');
  const csvPath = path.join(outDir, 'contact-plan.csv');
  fs.writeFileSync(jsonPath, toJSON(result));
  fs.writeFileSync(csvPath, toCSV(result));

  process.stdout.write(
    `Store-contact plan — NOTHING WAS CREATED OR CHANGED.\n\n` +
    `  records read      ${result.total}\n` +
    `  propose           ${result.counts.propose}\n` +
    `  needs review      ${result.counts.review}\n` +
    `  skip              ${result.counts.skip}\n\n` +
    `  ${jsonPath}\n  ${csvPath}\n\n` +
    `Open the CSV, check every row, and type "yes" in the approved column for the\n` +
    `ones you are willing to vouch for. Rows marked "skip" cannot be approved.\n` +
    `Approved contacts are then created through the governed API by somebody\n` +
    `holding customer_contacts.manage.\n`
  );
}

main();
