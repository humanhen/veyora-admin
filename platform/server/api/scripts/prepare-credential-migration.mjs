#!/usr/bin/env node
/* ================= Stage 1 — LOCAL credential preparation =================

   RUNS ON THE OPERATOR'S OWN MACHINE ONLY. Never on the VPS, never in a
   container, never in CI.

   It reads the credential workbook, validates it, bcrypt-hashes every password
   locally at cost 10, and streams a JSON payload of HASHES to stdout. The
   plaintext password is dropped the instant it has been hashed and is never
   written to a file, a log, a report or the payload.

       stdout : the JSON payload, and nothing else, so it can be piped
       stderr : every human-readable line, all of it sanitised

   Usage:
     node scripts/prepare-credential-migration.mjs --file "<workbook.xlsx>" --stdout

   Piped to the server:
     node scripts/prepare-credential-migration.mjs --file "<workbook.xlsx>" --stdout |
       ssh veyora-vps "docker exec -i veyora_rc-api-1 \
         node scripts/apply-credential-migration.mjs --dry-run"
                                                                              */
import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { readXlsx } from '../src/xlsx-lite.js';
import { validateSheet, maskEmail, isBcryptHash, bcryptCost, findPlaintext,
         BCRYPT_COST, PAYLOAD_KIND, PAYLOAD_VERSION,
         REQUIRED_HEADERS } from '../src/credential-migration.js';

const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const die = msg => { log(`\n  ERROR: ${msg}\n`); process.exit(1); };

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const has = name => process.argv.includes(`--${name}`);

if (has('help') || !arg('file')) {
  log(`
  Prepare a credential migration payload — LOCAL ONLY.

    --file <path>   the .xlsx workbook (required)
    --stdout        emit the payload to stdout (required; a guard against
                    running this by accident and dumping a payload to a screen)
    --limit <n>     process only the first n data rows (for a rehearsal)

  The workbook must have exactly these headers, in this order:
    ${REQUIRED_HEADERS.join(', ')}

  Nothing is written to disk. Do NOT redirect stdout to a file — pipe it.
`);
  process.exit(arg('file') ? 0 : 1);
}
if (!has('stdout')) die('refusing to run without --stdout; the payload must be piped, never stored');

const file = String(arg('file'));
if (!fs.existsSync(file)) die(`workbook not found: ${file}`);

/* ---- read ---- */
const buffer = fs.readFileSync(file);
const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
log(`\n  Veyora credential migration — local preparation`);
log(`  workbook  : ${file.replace(/^.*[\\/]/, '')}`);
log(`  sha256    : ${sha256}`);
log(`  size      : ${buffer.length.toLocaleString()} bytes`);

/* ExcelJS is NOT a dependency of this project. If the operator has installed it
   locally (npm i -D exceljs) it is used, because it copes with more real-world
   workbook variants; otherwise the built-in reader handles the ordinary case.
   Either way this only ever runs locally. */
let headers, rows, via = 'built-in reader';
try {
  const ex = await import('exceljs').then(m => m.default ?? m).catch(() => null);
  if (ex) {
    const wb = new ex.Workbook();
    await wb.xlsx.load(buffer);
    const sheet = wb.worksheets[0];
    if (!sheet) die('workbook has no worksheets');
    const all = [];
    sheet.eachRow({ includeEmpty: true }, (r, n) => {
      const cells = [];
      for (let c = 1; c <= REQUIRED_HEADERS.length; c++) {
        const v = r.getCell(c).value;
        cells.push(v == null ? ''
          : typeof v === 'object' && v.text != null ? String(v.text)
          : typeof v === 'object' && v.result != null ? String(v.result)
          : String(v));
      }
      all[n - 1] = cells;
    });
    for (let i = 0; i < all.length; i++) if (!all[i]) all[i] = [];
    headers = (all.shift() || []).map(h => String(h).trim());
    rows = all;
    via = 'ExcelJS';
  } else {
    ({ headers, rows } = readXlsx(buffer));
  }
} catch (e) {
  die(`could not read the workbook (${e.message}). `
    + `Re-save it from Excel as .xlsx, or install a reader locally: npm i -D exceljs`);
}
log(`  reader    : ${via}`);

/* ---- validate ---- */
let limited = rows;
const limit = arg('limit');
if (limit && limit !== true) {
  const n = parseInt(limit, 10);
  if (Number.isFinite(n) && n > 0) { limited = rows.slice(0, n); log(`  limit     : first ${n} data rows`); }
}

const sheet = validateSheet(headers, limited);
if (!sheet.ok) die(sheet.fatal);

log(`\n  rows read      : ${limited.length}`);
log(`  blank ignored  : ${sheet.blankRows}`);
log(`  usable rows    : ${sheet.records.length}`);
if (sheet.problems.length) {
  log(`  unusable rows  : ${sheet.problems.length}`);
  for (const p of sheet.problems) {
    log(`    row ${p.row} · id ${p.sourceId ?? '—'} · ${p.businessName ?? '—'} · ${p.maskedEmail} · ${p.reason}`);
  }
}
if (!sheet.records.length) die('no usable rows — nothing to migrate');

/* ---- hash ---- */
log(`\n  hashing ${sheet.records.length} passwords with bcrypt cost ${BCRYPT_COST}…`);
const outRows = [];
for (let i = 0; i < sheet.records.length; i++) {
  const record = sheet.records[i];
  /* Hash, then drop the plaintext immediately. `passwords[i]` is the only
     reference and it is cleared as we go, so nothing accumulates. */
  const hash = await bcrypt.hash(sheet.passwords[i], BCRYPT_COST);
  sheet.passwords[i] = null;
  if (!isBcryptHash(hash) || bcryptCost(hash) !== BCRYPT_COST) {
    die(`row ${record.row}: bcrypt produced an unexpected hash shape`);
  }
  outRows.push({ ...record, passwordHash: hash });
  if ((i + 1) % 25 === 0 || i + 1 === sheet.records.length) {
    log(`    ${i + 1}/${sheet.records.length}`);
  }
}
sheet.passwords.length = 0;

const payload = {
  kind: PAYLOAD_KIND,
  version: PAYLOAD_VERSION,
  generatedAt: new Date().toISOString(),
  source: { name: file.replace(/^.*[\\/]/, ''), sha256, rowCount: outRows.length },
  rows: outRows,
};

/* ---- last line of defence ---- */
const leaks = findPlaintext(payload);
if (leaks.length) die(`refusing to emit: ${leaks.join('; ')}`);
const serialised = JSON.stringify(payload);

log(`\n  payload        : ${outRows.length} rows, ${serialised.length.toLocaleString()} bytes`);
log(`  placeholders   : ${outRows.filter(r => r.placeholderEmail).length} rows supply an import placeholder email`);
log(`  sample (masked): ${outRows.slice(0, 3).map(r => maskEmail(r.emailNormalised)).join(', ')}`);
log(`\n  Passwords are not in this payload and were never written to disk.`);
log(`  Pipe stdout straight into the apply script — do not save it.\n`);

process.stdout.write(serialised);
