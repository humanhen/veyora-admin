#!/usr/bin/env node
/* ================= Stage 2 — SERVER apply =================

   Runs inside the API container. Reads the HASHED payload from stdin, plans it
   against the live database, and either reports (--dry-run, the default) or
   writes it in one transaction (--apply).

   It uses only production dependencies — pg and the project's own modules. No
   spreadsheet parser, no bcrypt hashing: the hashes arrive already made. It
   never receives a plaintext password, and it refuses the whole payload if one
   is present.

     docker exec -i veyora_rc-api-1 node scripts/apply-credential-migration.mjs --dry-run
     docker exec -i veyora_rc-api-1 node scripts/apply-credential-migration.mjs --apply
                                                                              */
import pg from 'pg';
import {
  validatePayload, planMigration, problemLines, isWrite,
  findPlaintext, alreadyApplied, applyPlan,
} from '../src/credential-migration.js';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const die = msg => { log(`\n  ERROR: ${msg}\n`); process.exit(1); };
const has = name => process.argv.includes(`--${name}`);

const APPLY = has('apply');
const CREATE_MISSING = has('create-missing');
const FORCE = has('force');
if (APPLY && has('dry-run')) die('choose either --dry-run or --apply, not both');
const MODE = APPLY ? 'APPLY' : 'DRY RUN';

/* ---- read the payload from stdin ---- */
async function readStdin() {
  if (process.stdin.isTTY) die('no payload on stdin — pipe the prepare script into this one');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readStdin();
if (!raw.trim()) die('stdin was empty');
let payload;
try { payload = JSON.parse(raw); } catch (e) { die(`stdin is not valid JSON (${e.message})`); }

/* Refuse a payload carrying plaintext BEFORE anything else touches it. */
const leaks = findPlaintext(payload);
if (leaks.length) die(`payload contains plaintext credential fields and was rejected: ${leaks.join('; ')}`);
const structure = validatePayload(payload);
if (!structure.ok) die(structure.error);

const sha256 = String(payload.source.sha256).toLowerCase();
log(`\n  Veyora credential migration — ${MODE}`);
log(`  workbook sha256 : ${sha256}`);
log(`  prepared at     : ${payload.generatedAt}`);
log(`  payload rows    : ${payload.rows.length}`);
log(`  create-missing  : ${CREATE_MISSING ? 'ENABLED (explicit)' : 'off (default)'}`);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let exitCode = 0;

try {
  /* ---- has this exact workbook already been applied? ---- */
  const { rows: settingsRows } = await pool.query(`select data from settings where id=1`);
  const settingsData = settingsRows[0]?.data || {};
  const prior = alreadyApplied(settingsData, sha256);
  if (prior && !FORCE) {
    log(`\n  This workbook was already applied at ${prior.at}.`);
    log(`  Re-applying would overwrite any password a customer has changed since.`);
    if (APPLY) die('refusing to apply the same workbook twice — pass --force only if you mean it');
    log(`  (dry run continues for information)\n`);
  } else if (prior && FORCE) {
    log(`\n  WARNING: this workbook was applied at ${prior.at}; --force was supplied.\n`);
  }

  /* ---- plan against the CURRENT database ---- */
  const { rows: users } = await pool.query(
    `select id, email, business, role, status, customer_number from users`);
  log(`  database users  : ${users.length}`);

  const { actions, summary } = planMigration(payload.rows, users,
    { createMissing: CREATE_MISSING });

  const report = { ...summary, sourceSha256: sha256 };
  log(`\n  ── plan ──────────────────────────────────────────────`);
  for (const [k, v] of Object.entries(report)) log(`  ${k.padEnd(32)} ${v}`);

  const problems = problemLines(actions);
  if (problems.length) {
    log(`\n  ── rows not written ──────────────────────────────────`);
    for (const line of problems) log(line);
  }
  const placeholders = actions.filter(a => isWrite(a.outcome) && a.placeholderSuppliedEmail);
  if (placeholders.length) {
    log(`\n  ── placeholder supplied emails (login will work; email will not) ──`);
    for (const a of placeholders) {
      log(`  row ${a.row} · ${a.businessName} · ${a.maskedEmail}`
        + ` — activation, password reset and notifications need a real address`);
    }
  }

  if (!APPLY) {
    log(`\n  DRY RUN — nothing was written. ${summary.totalSafeUpdates} row(s) would change.`);
    log(`  Re-run with --apply when the plan above is approved.\n`);
  } else {
    /* ---- one transaction, all or nothing ---- */
    const writes = actions.filter(a => isWrite(a.outcome));
    if (!writes.length) die('the plan contains no safe writes — nothing to apply');

    const client = await pool.connect();
    try {
      /* applyPlan owns the transaction: begin, the guarded writes, the
         sanitised settings and audit records, commit — and rollback on any
         failure. It lives in src/credential-migration.js so the tests drive
         this exact code with a controlled client. */
      const { applied } = await applyPlan(client, {
        actions, payload, createMissing: CREATE_MISSING, summary: report,
        forced: !!(prior && FORCE),
      });
      log(`\n  ── applied ───────────────────────────────────────────`);
      for (const [k, v] of Object.entries(applied)) log(`  ${k.padEnd(32)} ${v}`);
      log(`\n  Committed. User ids and their orders are unchanged.`);
      log(`  Verify a few real logins before telling customers.\n`);
    } catch (e) {
      exitCode = 1;
      log(`\n  ROLLED BACK — nothing was written.`);
      log(`  ${e.message}\n`);
    } finally {
      client.release();
    }
  }
} catch (e) {
  exitCode = 1;
  log(`\n  ERROR: ${e.message}\n`);
} finally {
  await pool.end().catch(() => {});
}
process.exit(exitCode);
