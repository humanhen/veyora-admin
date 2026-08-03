#!/usr/bin/env node
/* ================= Post-migration login check — LOCAL ONLY =================

   Reads a handful of credentials from the workbook on the operator's own
   machine and tries to sign in with them against a running site, to prove the
   migration actually works end to end.

   It is deliberately small and noisy about its side effects:
     - it never prints a password;
     - it masks every email in its output;
     - it defaults to at most 5 accounts;
     - a real login updates last_login_at, prev_login_at and the audit log, and
       it says so before it starts;
     - it refuses production-looking hosts unless --allow-production is given.

   Usage:
     node scripts/verify-credential-logins.mjs --file "<workbook.xlsx>" \
       --base-url https://rc.example.test --count 3
     node scripts/verify-credential-logins.mjs --file "<workbook.xlsx>" \
       --base-url https://rc.example.test --rows 2,9,41
                                                                              */
import fs from 'node:fs';
import { readXlsx } from '../src/xlsx-lite.js';
import { validateSheet, maskEmail, REQUIRED_HEADERS } from '../src/credential-migration.js';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const die = msg => { log(`\n  ERROR: ${msg}\n`); process.exit(1); };
const has = n => process.argv.includes(`--${n}`);
function arg(n, fallback = null) {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const MAX_DEFAULT = 5;
const PRODUCTION_LIKE = /(^|\.)veyora\.(design|com)$/i;

if (has('help') || !arg('file') || !arg('base-url')) {
  log(`
  Verify migrated logins — LOCAL ONLY.

    --file <path>        the .xlsx workbook (required)
    --base-url <url>     the site to sign in to (required)
    --count <n>          how many accounts to try (default ${MAX_DEFAULT}, max ${MAX_DEFAULT})
    --rows 2,9,41        specific source row numbers instead of --count
    --allow-production   required before touching a production-looking host

  Headers expected: ${REQUIRED_HEADERS.join(', ')}
  Passwords are never printed; emails are masked.
`);
  process.exit(arg('file') && arg('base-url') ? 0 : 1);
}

const file = String(arg('file'));
if (!fs.existsSync(file)) die(`workbook not found: ${file}`);

const baseUrl = String(arg('base-url')).replace(/\/+$/, '');
let host;
try { host = new URL(baseUrl).hostname; } catch { die(`--base-url is not a URL: ${baseUrl}`); }
if (PRODUCTION_LIKE.test(host) && !has('allow-production')) {
  die(`${host} looks like production. Re-run with --allow-production if that is really intended.`);
}

let headers, rows;
try { ({ headers, rows } = readXlsx(fs.readFileSync(file))); }
catch (e) { die(`could not read the workbook (${e.message})`); }

const sheet = validateSheet(headers, rows);
if (!sheet.ok) die(sheet.fatal);

/* ---- choose which accounts to try ---- */
let chosen;
const rowsArg = arg('rows');
if (rowsArg && rowsArg !== true) {
  const wanted = new Set(String(rowsArg).split(',').map(s => parseInt(s.trim(), 10)));
  chosen = sheet.records
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => wanted.has(r.row));
  const missing = [...wanted].filter(n => !chosen.some(({ r }) => r.row === n));
  if (missing.length) die(`row(s) not usable in the workbook: ${missing.join(', ')}`);
} else {
  const n = Math.min(parseInt(arg('count', String(MAX_DEFAULT)), 10) || MAX_DEFAULT, MAX_DEFAULT);
  /* Deterministic spread rather than the first n, so a rehearsal exercises
     more than the top of the sheet. */
  const step = Math.max(1, Math.floor(sheet.records.length / n));
  chosen = [];
  for (let i = 0; i < sheet.records.length && chosen.length < n; i += step) {
    chosen.push({ r: sheet.records[i], i });
  }
}
if (chosen.length > MAX_DEFAULT) chosen = chosen.slice(0, MAX_DEFAULT);
if (!chosen.length) die('no accounts selected');

log(`\n  Veyora login verification`);
log(`  target : ${baseUrl}`);
log(`  trying : ${chosen.length} account(s)`);
log(`\n  NOTE: a successful sign-in is a REAL sign-in. It updates last_login_at,`);
log(`  prev_login_at and writes an audit entry for each account below.\n`);

let pass = 0, fail = 0;
for (const { r, i } of chosen) {
  const masked = maskEmail(r.emailNormalised);
  let outcome;
  try {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: r.emailNormalised, password: sheet.passwords[i] }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (res.ok && body?.user) {
      outcome = `PASS  (role ${body.user.role}, status ${body.user.status ?? 'active'})`;
      pass++;
    } else {
      outcome = `FAIL  HTTP ${res.status}${body?.error || body?.message ? ` — ${body.error || body.message}` : ''}`;
      fail++;
    }
  } catch (e) {
    outcome = `FAIL  ${e.message}`;
    fail++;
  } finally {
    sheet.passwords[i] = null;      // drop the plaintext as soon as it is used
  }
  log(`  row ${String(r.row).padStart(4)} · ${r.businessName} · ${masked} · ${outcome}`);
}
sheet.passwords.length = 0;

log(`\n  ${pass} passed, ${fail} failed.\n`);
process.exit(fail ? 1 : 0);
