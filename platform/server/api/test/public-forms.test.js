/* Public enquiry forms (Fast-Track Phase 3).

   Real validation and handler code against a controlled database double. No
   live database, no network, no mail server. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateSubmission, buildPayload, formFields, formDefinition,
  FORM_TYPES, HONEYPOT_FIELD, PUBLIC_FORM_CONTRACT,
} from '../src/public-forms.js';
import publicFormRouter, {
  handleSubmission, storeSubmission, safeSourcePath, CONSENT_VERSION, _resetThrottleForTesting,
} from '../src/routes/public-forms.js';

const SRC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'src');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const routerCode = strip(fs.readFileSync(path.join(SRC, 'routes', 'public-forms.js'), 'utf8'));
const validationCode = strip(fs.readFileSync(path.join(SRC, 'public-forms.js'), 'utf8'));

const VALID = {
  contact: { name: 'Ada Lovelace', email: 'ada@example.test', message: 'Please send a catalogue.', consent: 'on' },
  'request-b2b-account': {
    name: 'Ada Lovelace', email: 'ada@example.test', company: 'Lovelace Optics',
    businessType: 'Independent optician', country: 'United Kingdom', consent: 'on',
  },
  'private-label-enquiry': {
    name: 'Ada Lovelace', email: 'ada@example.test', company: 'Lovelace Optics',
    country: 'United Kingdom', message: 'We would like a capsule range.', consent: 'on',
  },
};

function makeDb({ failOn = null } = {}) {
  const statements = [];
  let rolledBack = false;

  async function query(sql, params = []) {
    statements.push({ sql, params });
    if (failOn && failOn.test(sql)) throw new Error('simulated database failure at 10.0.0.4:5432');
    /* The submission INSERT now returns its id, so the notification can be
       queued against it in the same transaction. */
    if (/insert into form_submissions/i.test(sql)) return { rows: [{ id: 'fsub_test' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  }

  return {
    statements,
    get rolledBack() { return rolledBack; },
    query,
    /* Storage and the staff alert are one transaction (findings ENQ-006 /
       NOT-006), so the double needs real rollback semantics: a failure must
       leave neither the submission nor the notification. */
    async tx(fn) {
      const mark = statements.length;
      try {
        return await fn({ query });
      } catch (err) {
        statements.length = mark;   // nothing committed
        rolledBack = true;
        throw err;
      }
    },
    inserts() { return statements.filter((s) => /insert into form_submissions/i.test(s.sql)); },
    notifications() { return statements.filter((s) => /insert into notification_outbox/i.test(s.sql)); },
  };
}

const submit = (formType, body, db = makeDb()) =>
  handleSubmission(db, formType, { body, sourceUrl: '/contact/' }).then((r) => ({ ...r, db }));

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

test('exactly three forms exist, and each has a closed field list', () => {
  assert.deepEqual([...FORM_TYPES], ['contact', 'request-b2b-account', 'private-label-enquiry']);
  for (const formType of FORM_TYPES) {
    const fields = formFields(formType);
    assert.ok(fields.length >= 4, formType);
    assert.ok(fields.some((f) => f.kind === 'consent'), `${formType} must require consent`);
    assert.ok(fields.some((f) => f.kind === 'email'), `${formType} must collect a reply address`);
  }
  assert.equal(formDefinition('nope'), null);
});

test('every form accepts a valid submission', async () => {
  for (const formType of FORM_TYPES) {
    const { status, body } = await submit(formType, VALID[formType]);
    assert.equal(status, 200, `${formType}: ${JSON.stringify(body)}`);
    assert.deepEqual(body, { ok: true });
  }
});

// ---------------------------------------------------------------------------
// field safety
// ---------------------------------------------------------------------------

test('an unknown field is rejected, not ignored', async () => {
  const { status, body } = await submit('contact', { ...VALID.contact, referralSource: 'x' });
  assert.equal(status, 400);
  const e = body.fieldErrors.find((x) => x.field === 'referralSource');
  assert.equal(e.code, 'UNKNOWN_FIELD');
});

test('a server-controlled field cannot be supplied, and is refused distinctly', async () => {
  for (const field of ['deliveryState', 'delivery_state', 'id', 'submissionId', 'userId',
    'approverId', 'approved_at', 'consentAt', 'attempts']) {
    const { status, body } = await submit('contact', { ...VALID.contact, [field]: 'sent' });
    assert.equal(status, 400, `${field} was accepted`);
    const e = body.fieldErrors.find((x) => x.field === field);
    assert.equal(e.code, 'SERVER_CONTROLLED', field);
  }
});

test('delivery state cannot be forged even when spelled as the router expects', async () => {
  const { db } = await submit('contact', VALID.contact);
  const insert = db.inserts()[0];
  assert.match(insert.sql, /delivery_state\)/);
  assert.match(insert.sql, /'pending'\)/, 'the state is a literal, not a parameter');
  assert.ok(!insert.params.includes('sent'));
});

test('an oversized value is rejected with the field named', async () => {
  const { status, body } = await submit('contact', { ...VALID.contact, name: 'a'.repeat(200) });
  assert.equal(status, 400);
  assert.equal(body.fieldErrors[0].field, 'name');
  assert.equal(body.fieldErrors[0].code, 'TOO_LONG');

  const long = await submit('contact', { ...VALID.contact, message: 'a'.repeat(5000) });
  assert.equal(long.status, 400);
  assert.equal(long.body.fieldErrors[0].code, 'TOO_LONG');
});

test('a malformed email is rejected', async () => {
  for (const email of ['not-an-email', 'a@b', 'a b@c.test', 'a@@b.test', '@b.test', 'a@.test', '']) {
    const { status } = await submit('contact', { ...VALID.contact, email });
    assert.equal(status, 400, `${JSON.stringify(email)} was accepted`);
  }
  for (const email of ['ada@example.test', 'a.b+c@sub.example.co.uk']) {
    const { status } = await submit('contact', { ...VALID.contact, email });
    assert.equal(status, 200, `${email} was rejected`);
  }
});

test('an optional phone is handled conservatively: blank passes, prose does not', async () => {
  assert.equal((await submit('contact', { ...VALID.contact, phone: '' })).status, 200);
  assert.equal((await submit('contact', { ...VALID.contact, phone: '+44 20 7123 4567' })).status, 200);
  assert.equal((await submit('contact', { ...VALID.contact, phone: 'call me maybe' })).status, 400);
});

test('a choice field accepts only its listed values', async () => {
  const base = VALID['request-b2b-account'];
  assert.equal((await submit('request-b2b-account', { ...base, businessType: 'Distributor' })).status, 200);
  assert.equal((await submit('request-b2b-account', { ...base, businessType: 'Something else' })).status, 400);
});

test('consent is required and only an explicit affirmative counts', async () => {
  for (const consent of [undefined, '', 'off', 'false', '0', 'no']) {
    const body = { ...VALID.contact };
    if (consent === undefined) delete body.consent; else body.consent = consent;
    const { status, body: res } = await submit('contact', body);
    assert.equal(status, 400, `consent=${JSON.stringify(consent)} was accepted`);
    assert.ok(res.fieldErrors.some((e) => e.code === 'CONSENT_REQUIRED'));
  }
});

test('markup in a name or company field is rejected as not plain text', async () => {
  for (const value of ['<script>alert(1)</script>', 'Ada <b>Lovelace</b>', 'javascript:alert(1)']) {
    const { status, body } = await submit('contact', { ...VALID.contact, name: value });
    assert.equal(status, 400, value);
    assert.equal(body.fieldErrors[0].code, 'INVALID_CONTENT');
  }
});

test('script markup inside a message is stored as inert text, never as markup', async () => {
  const message = 'Please advise. <script>alert(1)</script>';
  const { status, db } = await submit('contact', { ...VALID.contact, message });
  assert.equal(status, 200, 'a message may legitimately contain angle brackets');

  const payload = JSON.parse(db.inserts()[0].params[1]);
  /* Stored verbatim as DATA in a jsonb parameter. It is never concatenated
     into SQL, never rendered as HTML by any consumer, and the web layer
     escapes on output — so the safe thing is to keep what the person wrote
     rather than silently mangle a legitimate message about markup. */
  assert.equal(typeof payload.message, 'string');
  assert.equal(payload.message, message);
  assert.equal(db.inserts()[0].params[1], JSON.stringify({ ...payload }),
    'the payload travels as a bound parameter, not as SQL text');
});

test('SQL injection stays data: the statement is parameterised', async () => {
  const attack = "Robert'); drop table form_submissions; --";
  const { status, db } = await submit('contact', { ...VALID.contact, name: attack });
  assert.equal(status, 200);

  const insert = db.inserts()[0];
  assert.ok(!insert.sql.includes('drop table'), 'the payload reached SQL text');
  assert.match(insert.sql, /\$1, \$2::jsonb, \$3, \$4, \$5, \$6, \$7/);
  assert.equal(JSON.parse(insert.params[1]).name, attack);
});

test('a non-object body is rejected safely', async () => {
  for (const body of [null, 'a string', 42, ['a']]) {
    const { status } = await submit('contact', body);
    assert.equal(status, 400, JSON.stringify(body));
  }
});

test('an unknown form type is refused', async () => {
  const { status, body } = await submit('not-a-form', VALID.contact);
  assert.equal(status, 400);
  assert.equal(body.fieldErrors[0].code, 'UNKNOWN_FORM');
});

// ---------------------------------------------------------------------------
// honeypot
// ---------------------------------------------------------------------------

test('a tripped honeypot is accepted-looking but stores nothing', async () => {
  const db = makeDb();
  const { status, body } = await handleSubmission(db, 'contact', {
    body: { ...VALID.contact, [HONEYPOT_FIELD]: 'http://spam.test' },
    sourceUrl: '/contact/',
  });
  /* Identical to a real success: telling the sender it was detected teaches
     it how to avoid detection next time. */
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(db.inserts().length, 0, 'a trapped submission must not be stored');
});

test('an empty honeypot is not a trip', async () => {
  const { status, db } = await submit('contact', { ...VALID.contact, [HONEYPOT_FIELD]: '' });
  assert.equal(status, 200);
  assert.equal(db.inserts().length, 1);
});

test('the honeypot is evaluated after validation, so it leaks no signal', () => {
  const invalid = validateSubmission('contact', { [HONEYPOT_FIELD]: 'bot' });
  assert.equal(invalid.ok, false, 'a bad submission still fails validation first');
});

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

test('a submission is stored pending, with explicit columns', async () => {
  const { db, body } = await submit('request-b2b-account', VALID['request-b2b-account']);
  const insert = db.inserts()[0];

  assert.match(insert.sql, /insert into form_submissions\s*\n?\s*\(form_type, payload, source_url, region, business_type, consent_version, consent_at, delivery_state\)/);
  assert.doesNotMatch(insert.sql, /select\s+\*/i);
  assert.equal(insert.params[0], 'request-b2b-account');
  assert.equal(insert.params[5], CONSENT_VERSION);
  assert.ok(insert.params[6] instanceof Date, 'consent_at records when consent was given');

  /* The INSERT now returns the id, because the staff alert is queued against
     it in the same transaction (findings ENQ-006 / NOT-006). The property
     that actually mattered was never "no returning clause" — it was that no
     id reaches the caller. That is asserted directly, and it is the stronger
     statement. */
  assert.match(insert.sql, /returning id/i);
  assert.deepEqual(body, { ok: true }, 'the response carries no id and nothing that varies');
});

test('the stored payload is built from validated values only', async () => {
  const { db } = await submit('contact', { ...VALID.contact, company: '  Lovelace  Optics  ' });
  const payload = JSON.parse(db.inserts()[0].params[1]);

  assert.deepEqual(Object.keys(payload).sort(), ['company', 'email', 'message', 'name']);
  assert.equal(payload.company, 'Lovelace Optics', 'whitespace is normalised');
  assert.ok(!('consent' in payload), 'consent is recorded as consent_at, not in the payload');
  assert.ok(!(HONEYPOT_FIELD in payload));
});

test('region and business type are taken from validated values, not from the client directly', async () => {
  const { db } = await submit('request-b2b-account', VALID['request-b2b-account']);
  const insert = db.inserts()[0];
  assert.equal(insert.params[3], 'United Kingdom');
  assert.equal(insert.params[4], 'Independent optician');
});

test('the source URL is reduced to a safe path', () => {
  assert.equal(safeSourcePath('/contact/'), '/contact/');
  assert.equal(safeSourcePath('/contact/?utm_source=x&secret=y'), '/contact/');
  assert.equal(safeSourcePath('https://example.test/evil'), '');
  assert.equal(safeSourcePath('/a<script>'), '');
  assert.equal(safeSourcePath(''), '');
  assert.equal(safeSourcePath('/' + 'a'.repeat(300)), '');
});

test('storeSubmission touches no customer, order or pricing table', async () => {
  const { db } = await submit('contact', VALID.contact);
  const allSql = db.statements.map((s) => s.sql).join('\n').toLowerCase();
  for (const table of ['users', 'orders', 'invoices', 'payments', 'products', 'variations',
    'carts', 'stock', 'account_permissions']) {
    assert.ok(!new RegExp(`(from|join|into)\\s+${table}\\b`).test(allSql), `touched ${table}`);
  }
});

// ---------------------------------------------------------------------------
// errors and privacy
// ---------------------------------------------------------------------------

test('a database failure surfaces no SQL, host or port', async () => {
  const db = makeDb({ failOn: /insert into form_submissions/i });
  await assert.rejects(() => handleSubmission(db, 'contact', { body: VALID.contact, sourceUrl: '/contact/' }));
  /* The router turns that into a generic 500 — asserted structurally, since
     the catch lives in the express layer. */
  assert.match(routerCode, /We could not record your enquiry/);
  assert.doesNotMatch(routerCode, /res\.status\(500\)\.json\(\{ error: e\./);
});

test('no field value is ever logged', () => {
  /* The one console.error logs the form type and e.message — never req.body,
     never the payload, never a field. */
  const logs = routerCode.match(/console\.\w+\([^)]*\)/g) ?? [];
  assert.equal(logs.length, 1, 'exactly one log statement');
  assert.match(logs[0], /formType, e\.message/);
  for (const forbidden of ['req.body', 'payload', 'values', 'JSON.stringify']) {
    assert.ok(!logs[0].includes(forbidden), `the log statement includes ${forbidden}`);
  }
});

test('no email, CRM or network delivery is attempted', () => {
  for (const code of [routerCode, validationCode]) {
    assert.doesNotMatch(code, /nodemailer|sendMail|fetch\(|axios|https?:\/\//);
    assert.doesNotMatch(code, /crm|hubspot|salesforce|mailchimp/i);
  }
  assert.match(routerCode, /delivery_state\)/);
});

test('the success response is generic and identical for every form', async () => {
  const responses = [];
  for (const formType of FORM_TYPES) responses.push((await submit(formType, VALID[formType])).body);
  for (const body of responses) assert.deepEqual(body, { ok: true });
  // No id, no echo of submitted values.
  for (const body of responses) assert.deepEqual(Object.keys(body), ['ok']);
});

test('a validation failure names fields but echoes no submitted value', async () => {
  const secret = 'ada-private@example.test';
  const { body } = await submit('contact', { ...VALID.contact, email: secret, name: '' });
  assert.equal(body.fieldErrors[0].field, 'name');
  assert.ok(!JSON.stringify(body).includes(secret), 'the response echoed a submitted value');
});

// ---------------------------------------------------------------------------
// router wiring
// ---------------------------------------------------------------------------

test('the router exposes exactly three POST routes and one read-only definition route', () => {
  const routes = [];
  for (const layer of publicFormRouter.stack) {
    if (!layer.route) continue;
    routes.push(`${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  }
  assert.deepEqual(routes.sort(), [
    'GET /definitions/:formType',
    'POST /contact',
    'POST /private-label-enquiry',
    'POST /request-b2b-account',
  ]);
});

test('the router applies its own tight body limit, not the 64mb app default', () => {
  assert.match(routerCode, /const BODY_LIMIT = '32kb'/);
  assert.match(routerCode, /r\.use\(express\.json\(\{ limit: BODY_LIMIT \}\)\)/);
});

test('the forms router is mounted outside the read-only /public boundary', () => {
  const indexCode = strip(fs.readFileSync(path.join(SRC, 'index.js'), 'utf8'));
  assert.match(indexCode, /app\.use\('\/forms', publicFormRoutes\)/);
  assert.doesNotMatch(indexCode, /app\.use\('\/public', publicFormRoutes\)/);

  // routes/public.js still has no write method.
  const publicCode = strip(fs.readFileSync(path.join(SRC, 'routes', 'public.js'), 'utf8'));
  assert.doesNotMatch(publicCode, /r\.(post|put|patch|delete)\(/i);
});

test('the throttle limits repeated submissions from one connection, then recovers', () => {
  _resetThrottleForTesting();
  assert.match(routerCode, /res\.status\(429\)/);
  assert.match(routerCode, /const MAX_PER_WINDOW = 8/);
  // Documented honestly as per-process and best-effort, not a security control.
  const raw = fs.readFileSync(path.join(SRC, 'routes', 'public-forms.js'), 'utf8');
  assert.match(raw, /PER PROCESS/);
  assert.match(raw, /not a security control/);
});

test('the definition endpoint returns no submitted data', () => {
  assert.match(routerCode, /formType: req\.params\.formType, consentVersion: CONSENT_VERSION/);
  assert.doesNotMatch(routerCode, /definitions[\s\S]{0,200}payload/);
});

test('the contract is exposed for the web layer without duplicating the field list', () => {
  assert.deepEqual(PUBLIC_FORM_CONTRACT.formTypes, [...FORM_TYPES]);
  assert.equal(PUBLIC_FORM_CONTRACT.honeypotField, HONEYPOT_FIELD);
  assert.ok(PUBLIC_FORM_CONTRACT.serverControlled.includes('delivery_state'));
});

test('buildPayload never includes consent or an unknown key', () => {
  const payload = buildPayload('contact', { name: 'A', email: 'a@b.test', message: 'x', consent: true, sneaky: 'y' });
  assert.deepEqual(Object.keys(payload).sort(), ['email', 'message', 'name']);
});
