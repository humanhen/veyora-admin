/* Batch 1K — secure customer credential migration.

   EVERY value in this file is invented. There is no real business name, no real
   email address and no real password anywhere here, and the real workbook was
   never opened. The fake emails all use .test / .invalid, which are reserved by
   RFC 2606 and can never be a live address.

   The fixture is a genuine .xlsx built from scratch (a ZIP of XML, written by
   the helper below), so the tests exercise the real reader, the real
   validation, the real bcrypt hashing and the real transaction code rather
   than a stand-in. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

import { readXlsx } from '../src/xlsx-lite.js';
import {
  REQUIRED_HEADERS, BCRYPT_COST, PLACEHOLDER_EMAIL_DOMAIN, CUSTOMER_ROLES,
  PAYLOAD_KIND, PAYLOAD_VERSION, OUTCOME,
  validateHeaders, validateRow, validateSheet, validatePayload,
  normaliseEmail, normaliseBusiness, maskEmail, isPlaceholderEmail, isEmailShaped,
  isBcryptHash, bcryptCost, findPlaintext,
  planMigration, summarise, problemLines, isWrite, applyPlan,
  alreadyApplied, MIGRATION_SETTINGS_KEY, buildUpdate, buildInsert,
} from '../src/credential-migration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '..');
const readSrc = p => fs.readFileSync(path.join(API, p), 'utf8');

/* ============ a real .xlsx, built from nothing ============ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Minimal ZIP writer. `deflate` exercises the reader's inflate path. */
function zip(entries, { deflate = true } = {}) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, contentRaw] of entries) {
    const content = Buffer.from(contentRaw, 'utf8');
    const data = deflate ? zlib.deflateRawSync(content) : content;
    const method = deflate ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(content);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8); cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(content.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36); cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42); nameBuf.copy(cen, 46);
    central.push(cen);
    offset += local.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const xmlEscape = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = i => {
  let s = '', n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/** Build a workbook. `shared:true` uses a sharedStrings table like Excel does. */
function makeXlsx(rows, { shared = true, deflate = true } = {}) {
  const strings = [];
  const idx = v => {
    const at = strings.indexOf(v);
    if (at >= 0) return at;
    strings.push(v); return strings.length - 1;
  };
  const sheetRows = rows.map((cells, r) => {
    const cs = cells.map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      if (v === '' || v == null) return '';
      return shared
        ? `<c r="${ref}" t="s"><v>${idx(String(v))}</v></c>`
        : `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cs}</row>`;
  }).join('');

  const entries = [
    ['[Content_Types].xml',
     `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      </Types>`],
    ['_rels/.rels',
     `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`],
    ['xl/workbook.xml',
     `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Credentials" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels',
     `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      </Relationships>`],
    ['xl/worksheets/sheet1.xml',
     `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  if (shared) {
    entries.push(['xl/sharedStrings.xml',
      `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
       count="${strings.length}" uniqueCount="${strings.length}">${
        strings.map(s => `<si><t>${xmlEscape(s)}</t></si>`).join('')}</sst>`]);
  }
  return zip(entries, { deflate });
}

/* ============ invented data ============ */

const HEADERS = [...REQUIRED_HEADERS];
/* Passwords below are fabricated for this test file and are not used anywhere. */
const FAKE = [
  ['5001', 'EXT-1', 'Aurora Optical',       'nina@aurora-optical.test',   'fake-Passw0rd-A!'],
  ['5002', 'EXT-2', 'Borealis Eyewear Ltd', 'omar@borealis.test',         'fake-Passw0rd-B!'],
  ['5003', 'EXT-3', 'Cassini Vision',       'pia@cassini-vision.test',    'fake-Passw0rd-C!'],
  ['5004', 'EXT-4', 'Delphi Optics',        'quinn@delphi-optics.test',   'fake-Passw0rd-D!'],
  ['5005', 'EXT-5', 'Equinox Frames',       `equinox${PLACEHOLDER_EMAIL_DOMAIN}`, 'fake-Passw0rd-E!'],
];
const sheetOf = (rows = FAKE) => [HEADERS, ...rows];

function tmpWorkbook(rows = FAKE, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veyora-cred-'));
  const file = path.join(dir, 'fake-credentials.xlsx');
  fs.writeFileSync(file, makeXlsx(sheetOf(rows), opts));
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A payload as prepare would emit it, with real bcrypt hashes of fake passwords. */
async function fakePayload(rows = FAKE) {
  const sheet = validateSheet(HEADERS, rows);
  assert.equal(sheet.ok, true, sheet.fatal);
  const out = [];
  for (let i = 0; i < sheet.records.length; i++) {
    out.push({ ...sheet.records[i], passwordHash: await bcrypt.hash(sheet.passwords[i], BCRYPT_COST) });
  }
  return {
    kind: PAYLOAD_KIND, version: PAYLOAD_VERSION, generatedAt: new Date().toISOString(),
    source: { name: 'fake-credentials.xlsx', sha256: crypto.createHash('sha256')
      .update('fake-workbook').digest('hex'), rowCount: out.length },
    rows: out,
  };
}

const dbUser = o => ({ id: 'u_' + (o.n ?? '1'), email: o.email, business: o.business ?? '',
  role: o.role ?? 'customer', status: o.status ?? 'active', customer_number: o.cn ?? null });

/* ============ workbook reading and validation ============ */

test('the generated fixture is a real xlsx the reader can parse', () => {
  const { file, cleanup } = tmpWorkbook();
  try {
    const { headers, rows, sheetName } = readXlsx(fs.readFileSync(file));
    assert.deepEqual(headers, HEADERS);
    assert.equal(sheetName, 'Credentials');
    assert.equal(rows.length, FAKE.length);
    assert.deepEqual(rows[0], FAKE[0]);
  } finally { cleanup(); }
});

test('both shared-string and inline-string workbooks read identically', () => {
  const a = readXlsx(makeXlsx(sheetOf(), { shared: true }));
  const b = readXlsx(makeXlsx(sheetOf(), { shared: false }));
  assert.deepEqual(a.rows, b.rows);
  const stored = readXlsx(makeXlsx(sheetOf(), { deflate: false }));
  assert.deepEqual(stored.rows, a.rows, 'stored and deflated entries both work');
});

test('the headers must be exactly the agreed five, in order', () => {
  assert.equal(validateHeaders(HEADERS).ok, true);
  assert.equal(validateHeaders([...HEADERS, '']).ok, true, 'a trailing blank column is tolerated');
  assert.equal(validateHeaders(HEADERS.map(h => h.toUpperCase())).ok, true, 'case-insensitive');
  for (const bad of [
    ['id', 'external_id', 'business_name', 'email'],                    // short
    ['id', 'business_name', 'external_id', 'email', 'password'],        // reordered
    ['id', 'external_id', 'business', 'email', 'password'],             // renamed
    ['id', 'external_id', 'business_name', 'email', 'password', 'note'],// extra
  ]) {
    const r = validateHeaders(bad);
    assert.equal(r.ok, false, bad.join(','));
    assert.match(r.error, /workbook headers must be exactly/);
  }
});

test('normalisation is consistent for emails and business names', () => {
  assert.equal(normaliseEmail('  Nina@Aurora-Optical.TEST '), 'nina@aurora-optical.test');
  assert.equal(normaliseEmail('   '), null);
  assert.equal(normaliseBusiness('  Aurora   Optical, LLC. '), 'aurora optical llc');
  assert.equal(normaliseBusiness('AURORA OPTICAL LLC'), 'aurora optical llc');
  assert.equal(normaliseBusiness('Borealis & Sons'), 'borealis and sons');
  assert.equal(normaliseBusiness('Borealis and Sons'), 'borealis and sons');
  assert.equal(normaliseBusiness(''), '');
  assert.equal(isEmailShaped('a@b.test'), true);
  assert.equal(isEmailShaped('a@b'), false);
  assert.equal(isEmailShaped('a b@c.test'), false);
  assert.equal(isPlaceholderEmail(`x${PLACEHOLDER_EMAIL_DOMAIN}`), true);
  assert.equal(isPlaceholderEmail('x@real.test'), false);
});

test('emails are masked everywhere they are reported', () => {
  assert.equal(maskEmail('nina@aurora-optical.test'), 'n***@aurora-optical.test');
  assert.equal(maskEmail(''), '(blank)');
  assert.equal(maskEmail('@nope'), '***');
  /* The local part must never survive beyond its first character. */
  assert.ok(!maskEmail('nina@aurora-optical.test').includes('ina'));
});

test('a row is rejected for each thing that makes it unusable', () => {
  const ok = validateRow(FAKE[0], 2);
  assert.equal(ok.ok, true);
  assert.equal(ok.record.sourceId, '5001');
  assert.equal(ok.record.businessNormalised, 'aurora optical');

  const cases = [
    [['', 'E', 'Aurora Optical', 'a@b.test', 'fake-Passw0rd!'], /missing id/],
    [['1', 'E', '', 'a@b.test', 'fake-Passw0rd!'], /missing business_name/],
    [['1', 'E', 'Aurora', '', 'fake-Passw0rd!'], /missing email/],
    [['1', 'E', 'Aurora', 'not-an-email', 'fake-Passw0rd!'], /not a usable address/],
    [['1', 'E', 'Aurora', 'a@b.test', ''], /missing password/],
    [['1', 'E', 'Aurora', 'a@b.test', 'short'], /shorter than 8/],
  ];
  for (const [cells, re] of cases) {
    const r = validateRow(cells, 9);
    assert.equal(r.ok, false, cells.join('|'));
    assert.match(r.reason, re);
    assert.ok(!JSON.stringify(r).includes('fake-Passw0rd'),
      'a rejection report never carries the password');
  }
});

test('blank rows are ignored, not treated as errors', () => {
  const sheet = validateSheet(HEADERS, [FAKE[0], ['', '', '', '', ''], [], FAKE[1]]);
  assert.equal(sheet.ok, true);
  assert.equal(sheet.blankRows, 2);
  assert.equal(sheet.records.length, 2);
  assert.deepEqual(sheet.records.map(r => r.row), [2, 5], 'source row numbers survive the gap');
});

test('duplicate normalised emails are FATAL', () => {
  const dup = [...FAKE, ['9999', 'EXT-9', 'Ninth Optical', ' NINA@Aurora-Optical.test ', 'fake-Passw0rd-Z!']];
  const sheet = validateSheet(HEADERS, dup);
  assert.equal(sheet.ok, false);
  assert.match(sheet.fatal, /duplicate email addresses/);
  assert.match(sheet.fatal, /rows 2 and 7/);
  assert.equal(sheet.records.length, 0, 'nothing is usable from a workbook we cannot trust');
  assert.match(sheet.fatal, /n\*\*\*@aurora-optical\.test/, 'and even the fatal error masks it');
});

test('a business name repeated in the workbook is marked non-unique', () => {
  const rows = [...FAKE, ['5006', 'EXT-6', 'aurora  optical', 'ray@other.test', 'fake-Passw0rd-F!']];
  const sheet = validateSheet(HEADERS, rows);
  assert.equal(sheet.ok, true, 'not fatal — those rows can still match on email');
  const aurora = sheet.records.filter(r => r.businessNormalised === 'aurora optical');
  assert.equal(aurora.length, 2);
  assert.ok(aurora.every(r => r.businessUniqueInWorkbook === false));
  assert.equal(sheet.records.find(r => r.sourceId === '5002').businessUniqueInWorkbook, true);
});

/* ============ hashing and the plaintext guard ============ */

test('passwords become bcrypt cost-10 hashes that actually verify', async () => {
  const payload = await fakePayload();
  for (const [i, row] of payload.rows.entries()) {
    assert.ok(isBcryptHash(row.passwordHash), `row ${row.row} is not a bcrypt hash`);
    assert.equal(bcryptCost(row.passwordHash), 10);
    assert.equal(bcryptCost(row.passwordHash), BCRYPT_COST);
    assert.equal(await bcrypt.compare(FAKE[i][4], row.passwordHash), true,
      'the fake password verifies against its hash');
    assert.equal(await bcrypt.compare('not-the-password', row.passwordHash), false);
  }
});

test('no plaintext password appears anywhere in the payload', async () => {
  const payload = await fakePayload();
  const json = JSON.stringify(payload);
  for (const row of FAKE) {
    assert.ok(!json.includes(row[4]), `plaintext ${row[4].slice(0, 6)}… leaked into the payload`);
  }
  for (const row of payload.rows) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'password'), false);
    assert.ok(!Object.keys(row).some(k => /^(password|pass|pwd|secret)$/i.test(k)));
  }
  assert.deepEqual(findPlaintext(payload), []);
});

test('the guard rejects every shape a plaintext leak could take', () => {
  const good = { rows: [{ passwordHash: '$2a$10$' + 'a'.repeat(53) }] };
  assert.deepEqual(findPlaintext(good), []);
  const bad = [
    { rows: [{ password: 'hunter2' }] },
    { rows: [{ pwd: 'hunter2' }] },
    { rows: [{ passphrase: 'hunter2' }] },
    { rows: [{ plaintext: 'hunter2' }] },
    { rows: [{ secret: 'hunter2' }] },
    { rows: [{ credential: 'hunter2' }] },
    { nested: { deep: [{ password: 'hunter2' }] } },
  ];
  for (const p of bad) {
    const problems = findPlaintext(p);
    assert.equal(problems.length > 0, true, JSON.stringify(p));
    assert.match(problems[0], /forbidden key/);
  }
  /* A hash-shaped field that is not a hash, or the wrong cost, is refused too. */
  assert.match(findPlaintext({ passwordHash: 'hunter2' })[0], /not a bcrypt hash/);
  assert.match(findPlaintext({ passwordHash: '$2a$04$' + 'a'.repeat(53) })[0], /bcrypt cost 4/);
});

test('a payload is structurally validated before it is trusted', async () => {
  const good = await fakePayload();
  assert.equal(validatePayload(good).ok, true);
  assert.match(validatePayload(null).error, /not an object/);
  assert.match(validatePayload({ ...good, kind: 'something-else' }).error, /payload kind/);
  assert.match(validatePayload({ ...good, version: 99 }).error, /version 99/);
  assert.match(validatePayload({ ...good, source: { sha256: 'nope' } }).error, /sha256/);
  assert.match(validatePayload({ ...good, rows: [] }).error, /no rows/);
  const leaky = { ...good, rows: [{ ...good.rows[0], password: 'hunter2' }] };
  assert.match(validatePayload(leaky).error, /payload rejected/);
});

/* ============ the prepare script, end to end ============ */

function runPrepare(args) {
  const script = path.join(API, 'scripts', 'prepare-credential-migration.mjs');
  const res = execFileSync(process.execPath, [script, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return res;
}

test('prepare streams a hash-only payload to stdout and prose to stderr', () => {
  const { file, cleanup } = tmpWorkbook();
  try {
    const script = path.join(API, 'scripts', 'prepare-credential-migration.mjs');
    const proc = execFileSync(process.execPath, [script, '--file', file, '--stdout'],
      { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = proc.toString('utf8');

    const payload = JSON.parse(stdout);
    assert.equal(payload.kind, PAYLOAD_KIND);
    assert.equal(payload.rows.length, FAKE.length);
    assert.match(payload.source.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(findPlaintext(payload), []);
    for (const row of FAKE) {
      assert.ok(!stdout.includes(row[4]), 'no plaintext on stdout');
    }
    /* stdout is the payload and nothing else — it has to be pipeable. */
    assert.equal(stdout.trim()[0], '{');
    assert.equal(stdout.trim().at(-1), '}');
  } finally { cleanup(); }
});

test('prepare prints no password and no hash to stderr', () => {
  const { file, cleanup } = tmpWorkbook();
  try {
    const script = path.join(API, 'scripts', 'prepare-credential-migration.mjs');
    const stderr = spawnSync(process.execPath, [script, '--file', file, '--stdout'],
      { encoding: 'utf8' }).stderr;
    assert.ok(stderr, 'the script reports its progress on stderr');
    for (const row of FAKE) {
      assert.ok(!stderr.includes(row[4]), 'a password reached stderr');
      assert.ok(!stderr.includes(row[3]), 'an unmasked email reached stderr');
    }
    assert.ok(!/\$2[aby]\$\d\d\$/.test(stderr), 'a bcrypt hash reached stderr');
    assert.match(stderr, /sha256\s*:\s*[a-f0-9]{64}/, 'the digest is reported');
    assert.match(stderr, /hashing \d+ passwords with bcrypt cost 10/);
    assert.match(stderr, /n\*\*\*@aurora-optical\.test/, 'samples are masked');
  } finally { cleanup(); }
});

test('prepare refuses to run without --stdout', () => {
  const { file, cleanup } = tmpWorkbook();
  try {
    const script = path.join(API, 'scripts', 'prepare-credential-migration.mjs');
    assert.throws(() => execFileSync(process.execPath, [script, '--file', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      /Command failed/, 'it must not emit a payload by accident');
  } finally { cleanup(); }
});

/* ============ matching ============ */

test('an exact email match keeps the user id and every business field', async () => {
  const payload = await fakePayload([FAKE[0]]);
  const users = [dbUser({ n: 'keep', email: 'NINA@Aurora-Optical.TEST', business: 'Aurora Optical',
    status: 'active', cn: '1042' })];
  const { actions } = planMigration(payload.rows, users);
  assert.equal(actions[0].outcome, OUTCOME.UPDATE_EMAIL_MATCH);
  assert.equal(actions[0].userId, 'u_keep', 'the database id is preserved, not the workbook id');
  assert.equal(actions[0].replaceEmail, false, 'the email on file is untouched');
  assert.equal(actions[0].activate, false);
  /* The update statement touches only the password and the timestamp. */
  const { sql } = buildUpdate(actions[0], payload.rows[0]);
  assert.match(sql, /^update users set password_hash = \$2, updated_at = now\(\) where id = \$1/);
  const setClause = sql.slice(sql.indexOf(' set ') + 5, sql.indexOf(' where '));
  for (const col of ['customer_number', 'role', 'pricing', 'agent_id', 'balance',
                     'business', 'status', 'email']) {
    assert.ok(!setClause.includes(col), `${col} must not be written on an exact match`);
  }
  /* role and status appear only as GUARDS in the predicate, never as writes. */
  assert.match(sql, /where id = \$1 and role = any\(\$3\) and status <> 'disabled'/);
});

test('a pending account is activated; an active one is left active', async () => {
  const payload = await fakePayload([FAKE[0], FAKE[1]]);
  const users = [
    dbUser({ n: 'p', email: 'nina@aurora-optical.test', status: 'pending' }),
    dbUser({ n: 'a', email: 'omar@borealis.test', status: 'active' }),
  ];
  const { actions, summary } = planMigration(payload.rows, users);
  assert.equal(actions[0].activate, true);
  assert.match(buildUpdate(actions[0], payload.rows[0]).sql, /status = 'active'/);
  assert.equal(actions[1].activate, false);
  assert.ok(!/status = 'active'/.test(buildUpdate(actions[1], payload.rows[1]).sql));
  assert.equal(summary.pendingToActivate, 1);
  assert.equal(summary.alreadyActive, 1);
});

test('a disabled account is never reactivated', async () => {
  const payload = await fakePayload([FAKE[0]]);
  const { actions, summary } = planMigration(payload.rows,
    [dbUser({ n: 'd', email: 'nina@aurora-optical.test', status: 'disabled' })]);
  assert.equal(actions[0].outcome, OUTCOME.SKIP_DISABLED);
  assert.equal(isWrite(actions[0].outcome), false);
  assert.equal(summary.disabledSkips, 1);
  assert.equal(summary.totalSafeUpdates, 0);
});

test('staff accounts are skipped whatever the workbook says', async () => {
  for (const role of ['admin', 'warehouse', 'agent', 'super-agent']) {
    const payload = await fakePayload([FAKE[0]]);
    const { actions } = planMigration(payload.rows,
      [dbUser({ n: 's', email: 'nina@aurora-optical.test', role })]);
    assert.equal(actions[0].outcome, OUTCOME.SKIP_ROLE, role);
    assert.match(actions[0].reason, new RegExp(`'${role}'`));
  }
  assert.deepEqual(CUSTOMER_ROLES, ['customer', 'special customer']);
});

test('a unique placeholder-email business match adopts the workbook email', async () => {
  const payload = await fakePayload([FAKE[2]]);
  /* Punctuation and spacing differ from the workbook; normalisation is what
     makes them the same business. */
  const users = [dbUser({ n: 'bus', email: `cassini${PLACEHOLDER_EMAIL_DOMAIN}`,
    business: '  CASSINI   Vision. ', status: 'pending' })];
  const { actions } = planMigration(payload.rows, users);
  assert.equal(actions[0].outcome, OUTCOME.UPDATE_BUSINESS_FALLBACK);
  assert.equal(actions[0].userId, 'u_bus', 'the id — and its orders — are preserved');
  assert.equal(actions[0].replaceEmail, true);
  assert.equal(actions[0].activate, true);
  assert.match(actions[0].previousEmail, /^c\*\*\*@import\.veyora\.local$/);
  const { sql, params } = buildUpdate(actions[0], payload.rows[0]);
  assert.match(sql, /email = \$3/);
  assert.equal(params[2], 'pia@cassini-vision.test');
});

test('a business match whose account has a real email is ambiguous', async () => {
  const payload = await fakePayload([FAKE[2]]);
  const { actions, summary } = planMigration(payload.rows,
    [dbUser({ n: 'r', email: 'someone-else@cassini.test', business: 'Cassini Vision' })]);
  assert.equal(actions[0].outcome, OUTCOME.SKIP_AMBIGUOUS);
  assert.match(actions[0].reason, /already has a real email address/);
  assert.equal(summary.ambiguousSkips, 1);
});

test('two database accounts sharing a business name is ambiguous', async () => {
  const payload = await fakePayload([FAKE[2]]);
  const { actions } = planMigration(payload.rows, [
    dbUser({ n: '1', email: `a${PLACEHOLDER_EMAIL_DOMAIN}`, business: 'Cassini Vision' }),
    dbUser({ n: '2', email: `b${PLACEHOLDER_EMAIL_DOMAIN}`, business: 'cassini  vision' }),
  ]);
  assert.equal(actions[0].outcome, OUTCOME.SKIP_AMBIGUOUS);
  assert.match(actions[0].reason, /2 database accounts share this business name/);
});

test('a business name duplicated in the workbook cannot be used as a fallback', async () => {
  const rows = [FAKE[2], ['5099', 'EXT-9', 'Cassini Vision', 'zoe@cassini-two.test', 'fake-Passw0rd-G!']];
  const payload = await fakePayload(rows);
  const { actions } = planMigration(payload.rows,
    [dbUser({ n: 'x', email: `cassini${PLACEHOLDER_EMAIL_DOMAIN}`, business: 'Cassini Vision' })]);
  for (const a of actions) {
    assert.equal(a.outcome, OUTCOME.SKIP_AMBIGUOUS);
    assert.match(a.reason, /lists this business name more than once/);
  }
});

test('a workbook placeholder email never replaces a placeholder on file', async () => {
  const payload = await fakePayload([FAKE[4]]);         // supplies an @import address
  const { actions } = planMigration(payload.rows,
    [dbUser({ n: 'e', email: `equinox-db${PLACEHOLDER_EMAIL_DOMAIN}`, business: 'Equinox Frames' })]);
  assert.equal(actions[0].outcome, OUTCOME.SKIP_AMBIGUOUS);
  assert.match(actions[0].reason, /placeholder email/);
});

test('an exact match on a placeholder email still works, and is flagged', async () => {
  const payload = await fakePayload([FAKE[4]]);
  const { actions, summary } = planMigration(payload.rows,
    [dbUser({ n: 'e', email: `equinox${PLACEHOLDER_EMAIL_DOMAIN}`, business: 'Equinox Frames',
      status: 'pending' })]);
  assert.equal(actions[0].outcome, OUTCOME.UPDATE_EMAIL_MATCH, 'the existing login keeps working');
  assert.equal(actions[0].activate, true);
  assert.equal(actions[0].placeholderSuppliedEmail, true, 'but it is flagged');
  assert.equal(summary.placeholderSuppliedEmails, 1);
});

test('missing accounts are reported and skipped by default', async () => {
  const payload = await fakePayload([FAKE[0]]);
  const { actions, summary } = planMigration(payload.rows, []);
  assert.equal(actions[0].outcome, OUTCOME.SKIP_MISSING);
  assert.match(actions[0].reason, /--create-missing/);
  assert.equal(summary.missingAccounts, 1);
  assert.equal(summary.accountsToCreate, 0);
  assert.equal(summary.totalSafeUpdates, 0);
  assert.equal(summary.wouldCreateWithFlag, 1);
});

test('--create-missing must be explicit, and refuses unsafe creations', async () => {
  const payload = await fakePayload([FAKE[0]]);
  const { actions, summary } = planMigration(payload.rows, [], { createMissing: true });
  assert.equal(actions[0].outcome, OUTCOME.CREATE);
  assert.equal(summary.accountsToCreate, 1);
  const { sql, params } = buildInsert(payload.rows[0]);
  assert.match(sql, /insert into users \(email, business, role, status, password_hash\)/);
  assert.match(sql, /values \(\$1,\$2,'customer','active',\$3\)/);
  assert.equal(params[0], 'nina@aurora-optical.test');
  assert.equal(params[1], 'Aurora Optical');
  assert.ok(!/id/.test(sql), 'the database generates the id — the workbook id is never used');
  assert.ok(!/order/i.test(sql), 'no order is relinked');

  /* A placeholder-only address is not something to create an account around. */
  const ph = await fakePayload([FAKE[4]]);
  const r2 = planMigration(ph.rows, [], { createMissing: true });
  assert.equal(r2.actions[0].outcome, OUTCOME.SKIP_INVALID);
  /* Nor a business name that appears twice. */
  const dupRows = [FAKE[0], ['5098', 'E', 'Aurora Optical', 'other@aurora2.test', 'fake-Passw0rd-H!']];
  const r3 = planMigration((await fakePayload(dupRows)).rows, [], { createMissing: true });
  assert.ok(r3.actions.every(a => a.outcome === OUTCOME.SKIP_AMBIGUOUS));
});

test('an email that belongs to a staff account is a role skip, never a create', async () => {
  const payload = await fakePayload([FAKE[0]]);
  const { actions } = planMigration(payload.rows,
    [dbUser({ n: 'adm', email: 'nina@aurora-optical.test', role: 'admin' })],
    { createMissing: true });
  assert.equal(actions[0].outcome, OUTCOME.SKIP_ROLE);
});

test('reports carry masked emails, outcomes and reasons — never a secret', async () => {
  const payload = await fakePayload();
  const { actions, summary } = planMigration(payload.rows, [
    dbUser({ n: 'd', email: 'nina@aurora-optical.test', status: 'disabled' }),
    dbUser({ n: 's', email: 'omar@borealis.test', role: 'warehouse' }),
  ]);
  const text = problemLines(actions).join('\n');
  assert.match(text, /row 2 · id 5001 · Aurora Optical · n\*\*\*@aurora-optical\.test · skip_disabled/);
  for (const row of FAKE) {
    assert.ok(!text.includes(row[4]), 'no password in a report');
    assert.ok(!text.includes(row[3]), 'no unmasked email in a report');
  }
  assert.ok(!/\$2[aby]\$/.test(text), 'no hash in a report');
  assert.deepEqual(Object.keys(summary).sort(), [
    'accountsToCreate', 'alreadyActive', 'ambiguousSkips', 'disabledSkips',
    'emailConflictSkips', 'exactEmailMatches', 'invalidSkips', 'missingAccounts',
    'pendingToActivate', 'placeholderSuppliedEmails', 'roleMismatchSkips',
    'safePlaceholderBusinessMatches', 'totalSafeUpdates', 'workbookRows',
    'wouldCreateWithFlag'].sort());
});

/* ============ the transaction ============ */

/** Records every statement; `fail` lets a test force an unexpected row count. */
function fakeClient({ rowCounts = {}, failAt = null } = {}) {
  const calls = [];
  return {
    calls,
    sql: () => calls.map(c => c.sql.trim().split(/\s+/).slice(0, 2).join(' ')),
    async query(sql, params) {
      calls.push({ sql, params });
      const kind = sql.trim().split(/\s+/)[0].toLowerCase();
      if (failAt && calls.length === failAt) throw new Error('database went away');
      if (kind === 'update' && sql.includes('users')) return { rowCount: rowCounts.update ?? 1 };
      if (kind === 'insert' && sql.includes('users')) return { rowCount: rowCounts.insert ?? 1 };
      return { rowCount: 1, rows: [] };
    },
  };
}

test('a dry run performs no writes at all', async () => {
  const payload = await fakePayload();
  const client = fakeClient();
  /* Planning is pure: it is handed rows and returns decisions. Nothing in the
     planning path can reach a database. */
  planMigration(payload.rows, [dbUser({ n: '1', email: 'nina@aurora-optical.test' })]);
  assert.equal(client.calls.length, 0, 'planning issued no statements');
  const src = readSrc('scripts/apply-credential-migration.mjs');
  assert.match(src, /if \(!APPLY\)/, 'the dry run branch returns before applyPlan');
  const applyAt = src.indexOf('applyPlan(client');
  const dryAt = src.indexOf('DRY RUN — nothing was written');
  assert.ok(dryAt > 0 && dryAt < applyAt, 'the dry-run message precedes any write path');
});

test('apply runs every write in ONE transaction and commits once', async () => {
  const payload = await fakePayload([FAKE[0], FAKE[1]]);
  const users = [
    dbUser({ n: '1', email: 'nina@aurora-optical.test', status: 'pending' }),
    dbUser({ n: '2', email: 'omar@borealis.test', status: 'active' }),
  ];
  const { actions, summary } = planMigration(payload.rows, users);
  const client = fakeClient();
  const { applied } = await applyPlan(client, { actions, payload, summary });

  const verbs = client.sql();
  assert.equal(verbs[0], 'begin', 'a transaction is opened first');
  assert.equal(verbs.at(-1), 'commit', 'and committed exactly once');
  assert.equal(verbs.filter(v => v === 'begin').length, 1);
  assert.equal(verbs.filter(v => v === 'commit').length, 1);
  assert.equal(verbs.filter(v => v === 'rollback').length, 0);
  assert.deepEqual(applied, { updated: 2, emailsReplaced: 0, activated: 1, created: 0 });
  /* Both user updates, then the settings record, then the audit entry. */
  assert.equal(client.calls.filter(c => /^update users/.test(c.sql.trim())).length, 2);
  assert.equal(client.calls.filter(c => /audit_log/.test(c.sql)).length, 1);
});

test('an unexpected update count rolls the whole thing back', async () => {
  const payload = await fakePayload([FAKE[0], FAKE[1]]);
  const users = [
    dbUser({ n: '1', email: 'nina@aurora-optical.test' }),
    dbUser({ n: '2', email: 'omar@borealis.test' }),
  ];
  const { actions, summary } = planMigration(payload.rows, users);

  for (const rowCount of [0, 2]) {
    const client = fakeClient({ rowCounts: { update: rowCount } });
    await assert.rejects(() => applyPlan(client, { actions, payload, summary }),
      /expected to update exactly 1 row, updated /);
    const verbs = client.sql();
    assert.equal(verbs[0], 'begin');
    assert.equal(verbs.at(-1), 'rollback', `rowCount ${rowCount} must roll back`);
    assert.equal(verbs.filter(v => v === 'commit').length, 0, 'nothing is committed');
    assert.equal(client.calls.filter(c => /audit_log/.test(c.sql)).length, 0);
  }
});

test('a mid-transaction failure rolls back and never commits', async () => {
  const payload = await fakePayload([FAKE[0], FAKE[1]]);
  const users = [
    dbUser({ n: '1', email: 'nina@aurora-optical.test' }),
    dbUser({ n: '2', email: 'omar@borealis.test' }),
  ];
  const { actions, summary } = planMigration(payload.rows, users);
  const client = fakeClient({ failAt: 3 });
  await assert.rejects(() => applyPlan(client, { actions, payload, summary }), /database went away/);
  assert.equal(client.sql().at(-1), 'rollback');
  assert.equal(client.sql().filter(v => v === 'commit').length, 0);
});

test('apply refuses a create unless --create-missing was passed', async () => {
  const payload = await fakePayload([FAKE[0]]);
  const { actions, summary } = planMigration(payload.rows, [], { createMissing: true });
  const client = fakeClient();
  await assert.rejects(
    () => applyPlan(client, { actions, payload, summary, createMissing: false }),
    /a create was planned without --create-missing/);
  assert.equal(client.sql().at(-1), 'rollback');
});

test('apply re-checks the hash and refuses anything that is not one', async () => {
  const payload = await fakePayload([FAKE[0]]);
  const { actions, summary } = planMigration(payload.rows,
    [dbUser({ n: '1', email: 'nina@aurora-optical.test' })]);
  const tampered = { ...payload, rows: [{ ...payload.rows[0], passwordHash: 'hunter2' }] };
  await assert.rejects(() => applyPlan(fakeClient(), { actions, payload: tampered, summary }),
    /is not bcrypt cost 10/);
});

test('the recorded summary is sanitised and carries the workbook digest', async () => {
  const payload = await fakePayload([FAKE[0]]);
  const { actions, summary } = planMigration(payload.rows,
    [dbUser({ n: '1', email: 'nina@aurora-optical.test' })]);
  const client = fakeClient();
  const { entry } = await applyPlan(client, { actions, payload, summary });
  assert.equal(entry.sha256, payload.source.sha256);
  assert.ok(entry.at);
  assert.deepEqual(findPlaintext(entry), []);
  const recorded = JSON.stringify(client.calls.map(c => c.params));
  for (const row of FAKE) {
    assert.ok(!recorded.includes(row[4]), 'no password is recorded');
  }
  assert.ok(!/\$2[aby]\$\d\d\$/.test(JSON.stringify(entry)), 'no hash is recorded in the summary');
  assert.match(client.calls.find(c => /audit_log/.test(c.sql)).sql,
    /customer credentials migrated/);
});

test('the same workbook is refused a second time unless forced', () => {
  const sha = crypto.createHash('sha256').update('fake-workbook').digest('hex');
  const settings = { [MIGRATION_SETTINGS_KEY]: [{ sha256: sha, at: '2026-08-01T10:00:00.000Z' }] };
  assert.ok(alreadyApplied(settings, sha), 'a repeat is detected');
  assert.ok(alreadyApplied(settings, sha.toUpperCase()), 'case-insensitively');
  assert.equal(alreadyApplied(settings, 'f'.repeat(64)), null);
  assert.equal(alreadyApplied({}, sha), null);

  const src = readSrc('scripts/apply-credential-migration.mjs');
  assert.match(src, /if \(prior && !FORCE\)/);
  assert.match(src, /refusing to apply the same workbook twice/);
  const guardAt = src.indexOf('alreadyApplied(');
  assert.ok(guardAt > 0 && guardAt < src.indexOf('applyPlan(client'),
    'the repeat check happens before any write');
});

/* ============ the scripts stay in their lane ============ */

test('the apply script uses only production dependencies', () => {
  const src = readSrc('scripts/apply-credential-migration.mjs');
  const imports = [...src.matchAll(/^import[^;]*?from '([^']+)';/gm)].map(m => m[1]);
  const pkg = JSON.parse(readSrc('package.json'));
  for (const spec of imports) {
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(pkg.dependencies, spec),
      `${spec} is not a production dependency — it will not exist after npm ci --omit=dev`);
  }
  /* Comments stripped: the file legitimately EXPLAINS that it uses no parser. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
                  .replace(/(^|[^:])\/\/[^\r\n]*/g, '$1 ');
  assert.ok(!/exceljs|xlsx/i.test(code), 'no spreadsheet parser on the server');
  assert.ok(!/bcrypt/i.test(code), 'the server never hashes — hashes arrive ready made');
  /* And no new dependency was added to the image. */
  assert.equal(pkg.devDependencies, undefined, 'no devDependencies were introduced');
});

test('the local scripts never talk to a database', () => {
  for (const f of ['scripts/prepare-credential-migration.mjs', 'scripts/verify-credential-logins.mjs']) {
    const src = readSrc(f);
    assert.ok(!/from 'pg'/.test(src), `${f} must not import pg`);
    assert.ok(!/DATABASE_URL/.test(src), `${f} must not read DATABASE_URL`);
  }
});

test('the verification tool is bounded, masked and production-shy', () => {
  const src = readSrc('scripts/verify-credential-logins.mjs');
  assert.match(src, /const MAX_DEFAULT = 5;/, 'at most five accounts by default');
  assert.match(src, /if \(chosen\.length > MAX_DEFAULT\) chosen = chosen\.slice\(0, MAX_DEFAULT\)/,
    'and never more, however it was asked');
  assert.match(src, /PRODUCTION_LIKE\.test\(host\) && !has\('allow-production'\)/);
  assert.match(src, /a successful sign-in is a REAL sign-in/, 'it warns about the side effects');
  assert.match(src, /last_login_at/, 'and names them');
  assert.match(src, /maskEmail\(r\.emailNormalised\)/);
  assert.ok(!/log\([^)]*password/i.test(src), 'no password is ever logged');
  assert.match(src, /sheet\.passwords\[i\] = null;/, 'each plaintext is dropped after use');
});

test('prepare drops each plaintext the moment it is hashed', () => {
  const src = readSrc('scripts/prepare-credential-migration.mjs');
  assert.match(src, /const hash = await bcrypt\.hash\(sheet\.passwords\[i\], BCRYPT_COST\);\s*\n\s*sheet\.passwords\[i\] = null;/,
    'the plaintext reference is cleared immediately after hashing');
  assert.match(src, /sheet\.passwords\.length = 0;/, 'and the array is emptied');
  assert.match(src, /findPlaintext\(payload\)/, 'the payload is checked before it is emitted');
  assert.match(src, /process\.stdout\.write\(serialised\)/);
  assert.equal((src.match(/process\.stdout\.write/g) || []).length, 1,
    'stdout carries the payload and nothing else');
});

/* ============ no real data is present ============ */

test('this test file contains no real workbook data', () => {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  /* Every fake address uses a reserved TLD that can never resolve. */
  for (const [, , , email] of FAKE) {
    assert.ok(/\.(test|invalid|local)$/.test(email.split('@')[1]),
      `${email} must use a reserved domain`);
  }
  /* Built from parts, so the needle itself is never a literal in this file. */
  assert.ok(!self.includes(['veyora', 'credentials', 'prod'].join('-')),
    'the real workbook is not named here');
  assert.ok(!self.includes(['secure', 'credentials'].join('-')),
    'the real folder is not named here');
  assert.ok(!self.includes('D:' + String.fromCharCode(92) + 'Veyora'),
    'no path to the real workbook');
  /* Fake passwords are obviously fake. */
  for (const row of FAKE) assert.match(row[4], /^fake-/);
});

test('no source file references the real workbook location', () => {
  for (const f of ['src/credential-migration.js', 'src/xlsx-lite.js',
                   'scripts/prepare-credential-migration.mjs',
                   'scripts/apply-credential-migration.mjs',
                   'scripts/verify-credential-logins.mjs']) {
    const src = readSrc(f);
    assert.ok(!src.includes(['veyora', 'credentials', 'prod'].join('-')),
      `${f} hard-codes the real workbook name`);
    assert.ok(!src.includes(['secure', 'credentials'].join('-')),
      `${f} hard-codes the real workbook folder`);
  }
});
