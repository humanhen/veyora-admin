/* Governed store contacts (Final Handover, Phase 2).

   Real handlers against a controlled database double with real transaction and
   "one active primary" semantics. No live database, and no real people: every
   contact here is invented and uses example.test addresses.

   The double implements the primary rule the way the DATABASE does — a partial
   unique index that refuses a second active primary — so a handler that forgot
   to demote fails here rather than passing on a double that was too kind. */
import './helpers/test-env.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTACT_CONTRACT, CONTACT_METHODS, RESPONSIBILITIES,
  VERIFICATION_STALE_DAYS,
  cleanText, isContactMethod, isEmailish, isPhoneish, isResponsibility,
  makeContactToken, normaliseEmail, normalisePhone, serializeContact,
  validateContactInput, verificationState,
} from '../src/customer-contacts.js';
import contactRouter, {
  CONTACT_CAPABILITIES, ContactApiError,
  archiveContact, createContact, getContact, getContactCapabilities,
  linkPortalUser, listContacts, makePrimary, reactivateContact,
  unlinkPortalUser, updateContact, verifyContact, describeUpdate,
} from '../src/routes/admin-customer-contacts.js';
import {
  DECISIONS, REASONS, approvedDecisions, assess, plan, toCSV, toJSON,
} from '../src/contact-migration-planner.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = path.join(ROOT, 'src');
const MIGRATIONS = path.join(path.dirname(ROOT), 'db', 'migrations');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
/* Comments are stripped before any source assertion. Twice now a test has
   passed because it matched an explanatory comment rather than the code. */
const code = (...p) => read(...p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const migrationRaw = fs.readFileSync(path.join(MIGRATIONS, '0012_customer_contacts.sql'), 'utf8');
/* SQL comments stripped: an assertion that the migration contains no INSERT
   must not be satisfied — or defeated — by a comment saying so. */
const migration = migrationRaw.replace(/--[^\n]*/g, ' ');
const migrateJs = read('migrate.js');
const routeSrc = code('routes', 'admin-customer-contacts.js');
const plannerSrc = code('contact-migration-planner.js');
const stripJs = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const plannerCli = stripJs(
  fs.readFileSync(path.join(ROOT, 'scripts', 'plan-store-contacts.js'), 'utf8'));

const ACTOR = { id: 'u_ops', email: 'ops@example.test', role: 'admin' };

/* ---------------------------------------------------------------------------
   An in-memory customer_contacts with real primary and transaction semantics
   --------------------------------------------------------------------------- */

const CUSTOMER = {
  id: 'u_cust1', business: 'Example Optics', customer_number: '1001',
  first_name: 'Sam', last_name: 'Example', email: 'sam@example.test',
  role: 'customer', status: 'active', agent_id: 'u_rep1',
};
const REP = {
  id: 'u_rep1', first_name: 'Rae', last_name: 'Rep', business: '',
  role: 'agent', email: 'rae@example.test',
};

function makeDb({ contacts = [], users = [CUSTOMER, REP] } = {}) {
  let table = contacts.map((c) => ({ ...c }));
  let seq = 0;
  const audits = [];

  const row = (over = {}) => ({
    id: `cc_${++seq}`, customer_id: CUSTOMER.id, first_name: '', last_name: '',
    job_title: '', responsibilities: [], mobile: '', mobile_normalised: '',
    office_phone: '', office_extension: '', email: '', email_normalised: '',
    preferred_contact_method: 'email', preferred_language: '',
    is_primary: false, is_active: true, portal_user_id: null, notes: '',
    last_verified_at: null, created_at: new Date('2026-08-01T00:00:00.000Z'),
    updated_at: new Date('2026-08-01T00:00:00.000Z'), ...over,
  });

  /* The partial unique index, enforced. */
  function assertOnePrimary() {
    const primaries = table.filter((c) => c.is_primary && c.is_active);
    const byCustomer = new Map();
    for (const p of primaries) {
      if (byCustomer.has(p.customer_id)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint "customer_contacts_one_primary_idx"'), { code: '23505' });
      }
      byCustomer.set(p.customer_id, p);
    }
    for (const c of table) {
      if (!c.is_active && c.is_primary) {
        throw Object.assign(new Error('violates check constraint "customer_contacts_archived_not_primary"'), { code: '23514' });
      }
    }
  }

  async function query(sql, params = []) {
    if (/^\s*select .*from users/is.test(sql)) {
      const u = users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }
    if (/^\s*insert into customer_contacts/is.test(sql)) {
      const [customerId, firstName, lastName, jobTitle, responsibilities, mobile,
        mobileNorm, officePhone, ext, email, emailNorm, method, language,
        isPrimary, isActive, notes] = params;
      const created = row({
        customer_id: customerId, first_name: firstName, last_name: lastName,
        job_title: jobTitle, responsibilities, mobile, mobile_normalised: mobileNorm,
        office_phone: officePhone, office_extension: ext, email,
        email_normalised: emailNorm, preferred_contact_method: method,
        preferred_language: language, is_primary: isPrimary, is_active: isActive,
        notes,
      });
      table.push(created);
      assertOnePrimary();
      return { rows: [{ ...created }] };
    }
    if (/^\s*select .*from customer_contacts\s+where customer_id = \$1/is.test(sql)) {
      const activeOnly = /and is_active/i.test(sql);
      const rows = table
        .filter((c) => c.customer_id === params[0] && (!activeOnly || c.is_active))
        .sort((a, b) => Number(b.is_primary) - Number(a.is_primary)
          || Number(b.is_active) - Number(a.is_active)
          || a.last_name.toLowerCase().localeCompare(b.last_name.toLowerCase())
          || a.first_name.toLowerCase().localeCompare(b.first_name.toLowerCase())
          || a.id.localeCompare(b.id));
      return { rows: rows.map((c) => ({ ...c })) };
    }
    if (/^\s*select [\s\S]*from customer_contacts\s+where id = \$1 and customer_id = \$2/is.test(sql)) {
      const c = table.find((x) => x.id === params[0] && x.customer_id === params[1]);
      return { rows: c ? [{ ...c }] : [] };
    }
    if (/^\s*select id from customer_contacts where portal_user_id = \$1/is.test(sql)) {
      const c = table.find((x) => x.portal_user_id === params[0] && x.id !== params[1]);
      return { rows: c ? [{ id: c.id }] : [] };
    }
    if (/set is_primary = false/is.test(sql)) {
      for (const c of table) {
        if (c.customer_id === params[0] && c.is_primary && (!params[1] || c.id !== params[1])) {
          c.is_primary = false;
        }
      }
      return { rows: [] };
    }
    if (/^\s*update customer_contacts set\s+first_name/is.test(sql)) {
      const [id, customerId, firstName, lastName, jobTitle, responsibilities, mobile,
        mobileNorm, officePhone, ext, email, emailNorm, method, language,
        isActive, notes] = params;
      const c = table.find((x) => x.id === id && x.customer_id === customerId);
      if (!c) return { rows: [] };
      Object.assign(c, {
        first_name: firstName, last_name: lastName, job_title: jobTitle,
        responsibilities, mobile, mobile_normalised: mobileNorm,
        office_phone: officePhone, office_extension: ext, email,
        email_normalised: emailNorm, preferred_contact_method: method,
        preferred_language: language, is_active: isActive, notes,
        updated_at: new Date('2026-08-02T00:00:00.000Z'),
      });
      assertOnePrimary();
      return { rows: [{ ...c }] };
    }
    if (/set is_primary = true/is.test(sql)) {
      const c = table.find((x) => x.id === params[0] && x.customer_id === params[1] && x.is_active);
      if (!c) return { rows: [] };
      c.is_primary = true;
      c.updated_at = new Date('2026-08-02T00:00:00.000Z');
      assertOnePrimary();
      return { rows: [{ ...c }] };
    }
    if (/set is_active = false/is.test(sql)) {
      const c = table.find((x) => x.id === params[0] && x.customer_id === params[1]);
      if (!c) return { rows: [] };
      Object.assign(c, { is_active: false, is_primary: false, updated_at: new Date('2026-08-02T00:00:00.000Z') });
      assertOnePrimary();
      return { rows: [{ ...c }] };
    }
    if (/set is_active = true/is.test(sql)) {
      const c = table.find((x) => x.id === params[0] && x.customer_id === params[1]);
      if (!c) return { rows: [] };
      Object.assign(c, { is_active: true, is_primary: false, updated_at: new Date('2026-08-02T00:00:00.000Z') });
      assertOnePrimary();
      return { rows: [{ ...c }] };
    }
    if (/set last_verified_at = now\(\)/is.test(sql)) {
      const c = table.find((x) => x.id === params[0] && x.customer_id === params[1]);
      if (!c) return { rows: [] };
      Object.assign(c, { last_verified_at: new Date('2026-08-02T00:00:00.000Z'), updated_at: new Date('2026-08-02T00:00:00.000Z') });
      return { rows: [{ ...c }] };
    }
    if (/set portal_user_id = \$3/is.test(sql)) {
      const c = table.find((x) => x.id === params[0] && x.customer_id === params[1]);
      if (!c) return { rows: [] };
      Object.assign(c, { portal_user_id: params[2], updated_at: new Date('2026-08-02T00:00:00.000Z') });
      return { rows: [{ ...c }] };
    }
    if (/set portal_user_id = null/is.test(sql)) {
      const c = table.find((x) => x.id === params[0] && x.customer_id === params[1]);
      if (!c) return { rows: [] };
      Object.assign(c, { portal_user_id: null, updated_at: new Date('2026-08-02T00:00:00.000Z') });
      return { rows: [{ ...c }] };
    }
    if (/insert into audit_log/is.test(sql)) { audits.push(params); return { rows: [] }; }
    return { rows: [] };
  }

  return {
    query,
    get table() { return table; },
    get audits() { return audits; },
    /* Real rollback: a throw inside the callback restores the snapshot, so a
       test asserting "nothing was written" is asserting something true. */
    async tx(fn) {
      const snapshot = table.map((c) => ({ ...c }));
      try {
        return await fn({ query });
      } catch (err) {
        table = snapshot;
        throw err;
      }
    },
  };
}

const person = (over = {}) => ({
  firstName: 'Ada', lastName: 'Buyer', email: 'ada@example.test', ...over,
});

const tokenOf = (db, id) => makeContactToken(db.table.find((c) => c.id === id));

// ===========================================================================
// 1-10 — schema and capability registration
// ===========================================================================

test('1 — every specified field exists in the migration and in the mirror', () => {
  for (const field of [
    'id', 'customer_id', 'first_name', 'last_name', 'job_title', 'responsibilities',
    'mobile', 'mobile_normalised', 'office_phone', 'office_extension', 'email',
    'email_normalised', 'preferred_contact_method', 'preferred_language',
    'is_primary', 'is_active', 'portal_user_id', 'notes', 'last_verified_at',
    'created_at', 'updated_at',
  ]) {
    assert.ok(migration.includes(field), `migration missing ${field}`);
    assert.ok(migrateJs.includes(field), `ensureSchema missing ${field}`);
  }
});

test('2 — the two new capabilities are in the registry, the migration and the mirror', async () => {
  const { PERMISSION_KEYS } = await import('../src/permission-registry.js');
  for (const key of ['customer_contacts.view', 'customer_contacts.manage']) {
    assert.ok(PERMISSION_KEYS.includes(key), `registry missing ${key}`);
    assert.ok(migration.includes(`'${key}'`), `migration CHECK missing ${key}`);
    assert.ok(migrateJs.includes(`'${key}'`), `ensureSchema CHECK missing ${key}`);
  }
});

test('3 — the widened CHECK is a strict superset of the previous set', () => {
  /* A capability silently dropped from the constraint would make every
     existing grant of it unstorable on the next migration run. */
  for (const key of ['public_content.view', 'public_content.edit', 'public_content.publish',
    'permissions.manage', 'enquiries.view', 'enquiries.manage']) {
    assert.ok(migration.includes(`'${key}'`), `0012 dropped ${key}`);
  }
});

test('4 — the migration is additive: it never alters or drops users', () => {
  assert.doesNotMatch(migration, /alter table users/i);
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /drop column/i);
  assert.doesNotMatch(migration, /delete from/i);
  assert.doesNotMatch(migration, /update users/i);
});

test('5 — the migration back-fills nothing', () => {
  /* A contact created by a migration is a person nobody chose, with a number
     nobody confirmed. The planner proposes; a human decides. */
  assert.doesNotMatch(migration, /insert into customer_contacts/i);
  assert.doesNotMatch(migration, /insert into account_permissions/i);
});

test('6 — one active primary per store is a unique index, not a trigger', () => {
  assert.match(migration, /create unique index[\s\S]*customer_contacts_one_primary_idx[\s\S]*where is_primary and is_active/i);
  assert.match(migrateJs, /customer_contacts_one_primary_idx/);
});

test('7 — an archived contact cannot remain primary, at the database level', () => {
  assert.match(migration, /customer_contacts_archived_not_primary[\s\S]*check \(is_active or not is_primary\)/i);
  assert.match(migrateJs, /check \(is_active or not is_primary\)/);
});

test('8 — an active contact must be named and reachable, at the database level', () => {
  assert.match(migration, /customer_contacts_active_named/);
  assert.match(migration, /customer_contacts_active_reachable/);
  assert.match(migrateJs, /customer_contacts_active_named/);
  assert.match(migrateJs, /customer_contacts_active_reachable/);
});

test('9 — a portal account belongs to at most one contact', () => {
  assert.match(migration, /customer_contacts_portal_user_unique_idx/);
  assert.match(migrateJs, /customer_contacts_portal_user_unique_idx/);
});

test('10 — there is no consent or marketing column anywhere', () => {
  /* Recording that somebody is the buyer is not consent to market to them,
     and a nullable boolean defaulting to anything would eventually be read
     as one. */
  for (const forbidden of ['consent', 'marketing', 'subscribe', 'opt_in', 'newsletter']) {
    assert.ok(!migration.toLowerCase().includes(`${forbidden} `), `migration mentions ${forbidden}`);
  }
});

// ===========================================================================
// 11-20 — closed sets and normalisation
// ===========================================================================

test('11 — the responsibility allowlist is exactly the seven specified', () => {
  assert.deepEqual([...RESPONSIBILITIES], [
    'owner', 'store_manager', 'buyer', 'accounts_payable', 'receiving',
    'returns_warranty', 'other',
  ]);
});

test('12 — the contact methods are exactly the four specified', () => {
  assert.deepEqual([...CONTACT_METHODS], ['email', 'mobile_call', 'whatsapp', 'office_phone']);
});

test('13 — an unregistered responsibility or method is refused, not coerced', () => {
  for (const bad of ['owner ', 'OWNER', 'admin', '', null, 42, {}]) {
    assert.equal(isResponsibility(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
  for (const bad of ['sms', 'Email', '', null, [], 7]) {
    assert.equal(isContactMethod(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test('14 — email normalisation lower-cases for matching and keeps the typed value', () => {
  assert.equal(normaliseEmail('  Ada.Buyer@Example.TEST '), 'ada.buyer@example.test');
  const v = validateContactInput(person({ email: 'Ada.Buyer@Example.TEST' }));
  assert.equal(v.ok, true);
  assert.equal(v.value.email, 'Ada.Buyer@Example.TEST', 'the typed value must survive');
  assert.equal(v.value.emailNormalised, 'ada.buyer@example.test');
});

test('15 — phone normalisation keeps a leading + and never guesses a country code', () => {
  assert.equal(normalisePhone('+1 (555) 010-9988'), '+15550109988');
  assert.equal(normalisePhone('555 010 9988'), '5550109988', 'no country code may be invented');
  assert.equal(normalisePhone(''), '');
  assert.equal(normalisePhone('   '), '');
  assert.equal(normalisePhone('ext only'), '');
});

test('16 — control characters are stripped from every text field', () => {
  const v = validateContactInput(person({
    firstName: 'Ada ', lastName: 'Buyer\r\n', notes: 'lineone',
  }));
  assert.equal(v.ok, true);
  assert.equal(v.value.firstName, 'Ada');
  assert.equal(v.value.lastName, 'Buyer');
  assert.equal(v.value.notes, 'lineone');
});

test('17 — a plausibility check refuses a mangled email or phone', () => {
  assert.equal(isEmailish('ada@example.test'), true);
  for (const bad of ['ada', 'ada@', '@example.test', 'a b@example.test', 'a@b', '']) {
    assert.equal(isEmailish(bad), false, `accepted ${bad}`);
  }
  assert.equal(isPhoneish('555 010 9988'), true);
  assert.equal(isPhoneish('123'), false);
  assert.equal(isPhoneish('1'.repeat(21)), false);
});

test('18 — responsibilities come back in canonical order regardless of input order', () => {
  /* Two requests listing the same responsibilities differently must produce
     the same row, or the concurrency token means nothing. */
  const a = validateContactInput(person({ responsibilities: ['buyer', 'owner'] }));
  const b = validateContactInput(person({ responsibilities: ['owner', 'buyer', 'buyer'] }));
  assert.deepEqual(a.value.responsibilities, ['owner', 'buyer']);
  assert.deepEqual(b.value.responsibilities, ['owner', 'buyer']);
});

test('19 — an unknown responsibility is an error, never silently dropped', () => {
  const v = validateContactInput(person({ responsibilities: ['buyer', 'vp_of_vibes'] }));
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, 'UNKNOWN_RESPONSIBILITY');
});

test('20 — the contract a screen renders from is frozen and complete', () => {
  assert.deepEqual([...CONTACT_CONTRACT.responsibilities], [...RESPONSIBILITIES]);
  assert.deepEqual([...CONTACT_CONTRACT.contactMethods], [...CONTACT_METHODS]);
  assert.equal(CONTACT_CONTRACT.verificationStaleDays, VERIFICATION_STALE_DAYS);
  assert.throws(() => { CONTACT_CONTRACT.responsibilities = []; });
});

// ===========================================================================
// 21-32 — the rules that make a contact a contact
// ===========================================================================

test('21 — an active contact requires a first AND a last name', () => {
  for (const missing of [{ firstName: '' }, { lastName: '' }, { firstName: '', lastName: '' }]) {
    const v = validateContactInput(person(missing));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.code === 'NAME_REQUIRED'), JSON.stringify(missing));
  }
});

test('22 — an active contact requires at least one usable channel', () => {
  const v = validateContactInput(person({ email: '', mobile: '', officePhone: '' }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'CHANNEL_REQUIRED'));
});

test('23 — any one of the three channels satisfies the rule', () => {
  for (const only of [{ email: 'a@example.test' }, { mobile: '555 010 9988' }, { officePhone: '555 010 1122' }]) {
    const v = validateContactInput({
      firstName: 'Ada', lastName: 'Buyer', email: '', mobile: '', officePhone: '',
      preferredContactMethod: only.email ? 'email' : (only.mobile ? 'mobile_call' : 'office_phone'),
      ...only,
    });
    assert.equal(v.ok, true, JSON.stringify(v.errors));
  }
});

test('24 — a preferred method the contact cannot receive is refused', () => {
  /* "Prefers WhatsApp" against an empty mobile is a routing instruction
     nobody can follow, and it reads as coverage on a screen. */
  const v = validateContactInput(person({ preferredContactMethod: 'whatsapp' }));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'METHOD_UNREACHABLE'));

  const ok = validateContactInput(person({ mobile: '555 010 9988', preferredContactMethod: 'whatsapp' }));
  assert.equal(ok.ok, true);
});

test('25 — an ARCHIVED contact is held to neither rule', () => {
  /* An archived contact is a historical record of somebody who has moved on.
     Holding it to the completeness bar would mean it could never be archived
     once a detail went stale. */
  const v = validateContactInput({ isActive: false, firstName: '', lastName: '', email: '' });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('26 — a partial update is validated against the MERGED contact', () => {
  /* Clearing the last email while the preferred method is still email passes
     every field-level check and produces a contact nobody can reach. */
  const existing = { firstName: 'Ada', lastName: 'Buyer', email: 'ada@example.test',
    mobile: '', officePhone: '', preferredContactMethod: 'email', isActive: true };
  const v = validateContactInput({ email: '' }, { existing, partial: true });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'CHANNEL_REQUIRED'));
});

test('27 — a partial update keeps fields it did not mention', () => {
  const existing = { firstName: 'Ada', lastName: 'Buyer', email: 'ada@example.test',
    jobTitle: 'Head Buyer', responsibilities: ['buyer'], notes: 'prefers mornings',
    preferredContactMethod: 'email', isActive: true, mobile: '', officePhone: '' };
  const v = validateContactInput({ notes: 'prefers afternoons' }, { existing, partial: true });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.value.jobTitle, 'Head Buyer');
  assert.deepEqual(v.value.responsibilities, ['buyer']);
  assert.equal(v.value.notes, 'prefers afternoons');
});

test('28 — every text field is length-capped', () => {
  for (const [field, max] of [['firstName', 120], ['jobTitle', 120], ['notes', 2000]]) {
    const v = validateContactInput(person({ [field]: 'x'.repeat(max + 1) }));
    assert.equal(v.ok, false, field);
    assert.ok(v.errors.some((e) => e.code === 'TOO_LONG'), field);
  }
});

test('29 — the serializer is an allowlist and never returns the normalised columns', () => {
  const out = serializeContact({
    id: 'cc_1', customer_id: 'u_cust1', first_name: 'Ada', last_name: 'Buyer',
    email: 'Ada@Example.test', email_normalised: 'ada@example.test',
    mobile: '+1 555 010 9988', mobile_normalised: '+15550109988',
    responsibilities: ['buyer', 'not_a_key'], is_primary: true, is_active: true,
    preferred_contact_method: 'email', portal_user_id: null,
    secret_column: 'must not appear', password_hash: 'nope',
  });
  assert.equal(out.email, 'Ada@Example.test');
  assert.equal('emailNormalised' in out, false);
  assert.equal('mobileNormalised' in out, false);
  assert.equal('secret_column' in out, false);
  assert.equal('password_hash' in out, false);
  assert.deepEqual(out.responsibilities, ['buyer'], 'an unregistered key must be filtered out');
});

test('30 — verification state is derived, never a stored boolean', () => {
  const now = new Date('2026-08-07T00:00:00.000Z');
  assert.deepEqual(verificationState({ last_verified_at: null }, { now }),
    { verifiedAt: null, state: 'never', daysSince: null });
  const recent = verificationState({ last_verified_at: '2026-08-01T00:00:00.000Z' }, { now });
  assert.equal(recent.state, 'current');
  assert.equal(recent.daysSince, 6);
  const old = verificationState({ last_verified_at: '2024-01-01T00:00:00.000Z' }, { now });
  assert.equal(old.state, 'stale');
});

test('31 — the concurrency token changes when anything a rival edit could change does', () => {
  const base = { id: 'cc_1', is_active: true, is_primary: false, updated_at: '2026-08-01T00:00:00.000Z' };
  const t = makeContactToken(base);
  assert.notEqual(t, makeContactToken({ ...base, is_active: false }));
  assert.notEqual(t, makeContactToken({ ...base, is_primary: true }));
  assert.notEqual(t, makeContactToken({ ...base, updated_at: '2026-08-02T00:00:00.000Z' }));
  assert.equal(t, makeContactToken({ ...base }));
});

test('32 — cleanText refuses rather than truncating', () => {
  /* Truncating a name silently stores a different person's name. */
  assert.equal(cleanText('x'.repeat(121), 120), null);
  assert.equal(cleanText('  spaced  ', 120), 'spaced');
});

// ===========================================================================
// 33-48 — the governed API
// ===========================================================================

test('33 — capability discovery is honest for an account holding neither', async () => {
  const db = { query: async () => ({ rows: [] }) };
  assert.deepEqual(await getContactCapabilities(db, 'u_nobody'), { view: false, manage: false });
});

test('34 — capability discovery reports exactly what is held', async () => {
  const db = { query: async () => ({ rows: [{ permission_key: 'customer_contacts.view' }] }) };
  assert.deepEqual(await getContactCapabilities(db, 'u_ops'), { view: true, manage: false });
});

test('35 — the capabilities are two new keys and no existing one is reused', () => {
  assert.deepEqual({ ...CONTACT_CAPABILITIES },
    { view: 'customer_contacts.view', manage: 'customer_contacts.manage' });
  /* public_content and enquiries capabilities must not appear on this router:
     being able to publish brand copy, or read an enquiry, is not authority to
     read the people at a customer. */
  assert.ok(!routeSrc.includes('public_content.'), 'a public_content capability leaked in');
  assert.ok(!routeSrc.includes('enquiries.'), 'an enquiry capability leaked in');
});

test('36 — creating a contact stores exactly the validated values', async () => {
  const db = makeDb();
  const contact = await createContact(db, CUSTOMER.id, person({
    jobTitle: 'Head Buyer', responsibilities: ['buyer'], mobile: '555 010 9988',
  }), ACTOR);
  assert.equal(contact.firstName, 'Ada');
  assert.equal(contact.jobTitle, 'Head Buyer');
  assert.deepEqual(contact.responsibilities, ['buyer']);
  assert.equal(contact.isPrimary, false, 'a contact is not primary unless asked');
  assert.equal(contact.portalUserId, null, 'no portal account is ever created');
  assert.equal(db.table[0].mobile_normalised, '5550109988');
});

test('37 — creating never creates a portal account, and the audit says so', async () => {
  const db = makeDb();
  const contact = await createContact(db, CUSTOMER.id, person(), ACTOR);
  assert.equal(contact.portalUserId, null);
  assert.ok(!routeSrc.includes('insert into users'), 'the router must never insert a user');
  /* "We added a contact" is exactly the kind of event somebody later assumes
     must have triggered an email, so the audit entry states that it did not. */
  assert.match(routeSrc, /no portal account, no consent, nothing sent/);
  assert.match(routeSrc, /contact\.create/);
});

test('38 — an invalid contact is a 400 with per-field errors and nothing is written', async () => {
  const db = makeDb();
  await assert.rejects(
    () => createContact(db, CUSTOMER.id, { firstName: 'Ada' }, ACTOR),
    (err) => err instanceof ContactApiError && err.status === 400
      && err.body.code === 'INVALID_CONTACT' && Array.isArray(err.body.errors)
  );
  assert.equal(db.table.length, 0, 'a refused create must write nothing');
});

test('39 — only one active primary can exist, and promoting demotes the other', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person({ isPrimary: true }), ACTOR);
  const b = await createContact(db, CUSTOMER.id, person({ firstName: 'Ben', lastName: 'Manager', email: 'ben@example.test' }), ACTOR);
  assert.equal(a.isPrimary, true);

  const promoted = await makePrimary(db, CUSTOMER.id, b.id, { concurrencyToken: tokenOf(db, b.id) }, ACTOR);
  assert.equal(promoted.isPrimary, true);
  assert.equal(db.table.find((c) => c.id === a.id).is_primary, false, 'the old primary must be demoted');
  assert.equal(db.table.filter((c) => c.is_primary && c.is_active).length, 1);
});

test('40 — promoting the contact that already holds it is idempotent', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person({ isPrimary: true }), ACTOR);
  const again = await makePrimary(db, CUSTOMER.id, a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  assert.equal(again.isPrimary, true);
  assert.equal(db.table.filter((c) => c.is_primary).length, 1);
});

test('41 — an archived contact cannot be made primary', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);
  await archiveContact(db, CUSTOMER.id, a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  await assert.rejects(
    () => makePrimary(db, CUSTOMER.id, a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR),
    (err) => err.status === 422 && err.body.code === 'ARCHIVED_NOT_PRIMARY'
  );
});

test('42 — the primary cannot be archived directly; it must be replaced first', async () => {
  /* Otherwise a store silently ends up with no primary contact and nobody is
     aware of it. */
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person({ isPrimary: true }), ACTOR);
  await assert.rejects(
    () => archiveContact(db, CUSTOMER.id, a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR),
    (err) => err.status === 422 && err.body.code === 'PRIMARY_MUST_BE_REPLACED'
  );
  assert.equal(db.table[0].is_active, true, 'nothing may have changed');
});

test('43 — the primary cannot be deactivated through an ordinary edit either', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person({ isPrimary: true }), ACTOR);
  await assert.rejects(
    () => updateContact(db, CUSTOMER.id, a.id, { isActive: false, concurrencyToken: tokenOf(db, a.id) }, ACTOR),
    (err) => err.status === 422 && err.body.code === 'PRIMARY_MUST_BE_REPLACED'
  );
  assert.equal(db.table[0].is_active, true);
});

test('44 — archiving keeps the row; there is no delete anywhere', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);
  const archived = await archiveContact(db, CUSTOMER.id, a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  assert.equal(archived.isActive, false);
  assert.equal(db.table.length, 1, 'the row must survive');

  assert.ok(!/delete\s+from\s+customer_contacts/i.test(routeSrc), 'the router must contain no DELETE');
  assert.ok(!/r\.delete\(/.test(routeSrc), 'the router must expose no DELETE route');
});

test('45 — reactivation re-validates and comes back as NON-primary', async () => {
  const db = makeDb();
  const keeper = await createContact(db, CUSTOMER.id, person({ isPrimary: true }), ACTOR);
  const other = await createContact(db, CUSTOMER.id,
    person({ firstName: 'Ben', lastName: 'Manager', email: 'ben@example.test' }), ACTOR);
  await archiveContact(db, CUSTOMER.id, other.id, { concurrencyToken: tokenOf(db, other.id) }, ACTOR);

  const back = await reactivateContact(db, CUSTOMER.id, other.id, { concurrencyToken: tokenOf(db, other.id) }, ACTOR);
  assert.equal(back.isActive, true);
  assert.equal(back.isPrimary, false, 'whoever became primary keeps it');
  assert.equal(db.table.find((c) => c.id === keeper.id).is_primary, true);
});

test('46 — reactivating a contact that no longer satisfies the active rules is refused clearly', async () => {
  const db = makeDb({ contacts: [{
    id: 'cc_old', customer_id: CUSTOMER.id, first_name: 'Ada', last_name: '',
    job_title: '', responsibilities: [], mobile: '', mobile_normalised: '',
    office_phone: '', office_extension: '', email: '', email_normalised: '',
    preferred_contact_method: 'email', preferred_language: '',
    is_primary: false, is_active: false, portal_user_id: null, notes: '',
    last_verified_at: null, created_at: new Date(), updated_at: new Date(),
  }] });
  await assert.rejects(
    () => reactivateContact(db, CUSTOMER.id, 'cc_old', { concurrencyToken: tokenOf(db, 'cc_old') }, ACTOR),
    (err) => err.status === 400 && err.body.code === 'INVALID_CONTACT'
  );
  assert.equal(db.table[0].is_active, false);
});

test('47 — a stale token is a 409 and writes nothing', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);
  for (const call of [
    () => updateContact(db, CUSTOMER.id, a.id, { notes: 'x', concurrencyToken: 'contact:stale' }, ACTOR),
    () => makePrimary(db, CUSTOMER.id, a.id, { concurrencyToken: 'contact:stale' }, ACTOR),
    () => archiveContact(db, CUSTOMER.id, a.id, { concurrencyToken: 'contact:stale' }, ACTOR),
    () => verifyContact(db, CUSTOMER.id, a.id, { concurrencyToken: 'contact:stale' }, ACTOR),
    () => unlinkPortalUser(db, CUSTOMER.id, a.id, { concurrencyToken: 'contact:stale' }, ACTOR),
  ]) {
    await assert.rejects(call, (err) => err.status === 409 && err.body.code === 'STALE_TOKEN');
  }
  assert.equal(db.table[0].notes, '');
  assert.equal(db.table[0].is_active, true);
});

test('48 — a contact belonging to another customer is invisible to every route', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);
  for (const call of [
    () => getContact(db, 'u_other', a.id),
    () => updateContact(db, 'u_other', a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR),
    () => makePrimary(db, 'u_other', a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR),
    () => archiveContact(db, 'u_other', a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR),
  ]) {
    await assert.rejects(call, (err) => err.status === 404);
  }
});

// ===========================================================================
// 49-56 — sales rep, portal link, listing
// ===========================================================================

test('49 — the list returns the assigned Veyora sales rep as context, not an account', async () => {
  const db = makeDb();
  const result = await listContacts(db, CUSTOMER.id);
  assert.equal(result.salesRep.id, 'u_rep1');
  assert.equal(result.salesRep.name, 'Rae Rep');
  assert.equal(result.salesRep.role, 'agent');
  assert.equal('password_hash' in result.salesRep, false);
  assert.equal('balance' in result.salesRep, false);
});

test('50 — the list states whether a primary exists rather than leaving it to be inferred', async () => {
  const db = makeDb();
  const empty = await listContacts(db, CUSTOMER.id);
  assert.deepEqual(empty.contacts, []);
  assert.equal(empty.hasPrimary, false);

  await createContact(db, CUSTOMER.id, person({ isPrimary: true }), ACTOR);
  const filled = await listContacts(db, CUSTOMER.id);
  assert.equal(filled.hasPrimary, true);
});

test('51 — a legacy customer with no contacts is a normal state, not an error', async () => {
  const db = makeDb();
  const result = await listContacts(db, CUSTOMER.id);
  assert.equal(result.customer.business, 'Example Optics');
  assert.equal(result.contacts.length, 0);
});

test('52 — an unknown customer is a 404', async () => {
  const db = makeDb();
  await assert.rejects(() => listContacts(db, 'u_nope'), (err) => err.status === 404);
});

test('53 — a portal link only ever points at the customer’s own active account', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);
  const linked = await linkPortalUser(db, CUSTOMER.id, a.id,
    { portalUserId: CUSTOMER.id, concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  assert.equal(linked.portalUserId, CUSTOMER.id);
});

test('54 — linking to another customer’s account, a missing one, or a disabled one is refused', async () => {
  const db = makeDb({ users: [CUSTOMER, REP, { id: 'u_off', status: 'disabled', role: 'customer' }] });
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);

  await assert.rejects(
    () => linkPortalUser(db, CUSTOMER.id, a.id, { portalUserId: 'u_ghost', concurrencyToken: tokenOf(db, a.id) }, ACTOR),
    (err) => err.status === 404 && err.body.code === 'NO_SUCH_ACCOUNT'
  );
  await assert.rejects(
    () => linkPortalUser(db, CUSTOMER.id, a.id, { portalUserId: REP.id, concurrencyToken: tokenOf(db, a.id) }, ACTOR),
    (err) => err.status === 422 && err.body.code === 'ACCOUNT_NOT_FOR_CUSTOMER'
  );
  await assert.rejects(
    () => linkPortalUser(db, CUSTOMER.id, a.id, { portalUserId: 'u_off', concurrencyToken: tokenOf(db, a.id) }, ACTOR),
    (err) => err.status === 422
  );
  assert.equal(db.table[0].portal_user_id, null);
});

test('55 — one portal account cannot be claimed by two contacts', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);
  const b = await createContact(db, CUSTOMER.id,
    person({ firstName: 'Ben', lastName: 'Manager', email: 'ben@example.test' }), ACTOR);
  await linkPortalUser(db, CUSTOMER.id, a.id, { portalUserId: CUSTOMER.id, concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  await assert.rejects(
    () => linkPortalUser(db, CUSTOMER.id, b.id, { portalUserId: CUSTOMER.id, concurrencyToken: tokenOf(db, b.id) }, ACTOR),
    (err) => err.status === 409 && err.body.code === 'ACCOUNT_ALREADY_LINKED'
  );
});

test('56 — unlinking removes the link and never touches the account', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);
  await linkPortalUser(db, CUSTOMER.id, a.id, { portalUserId: CUSTOMER.id, concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  const out = await unlinkPortalUser(db, CUSTOMER.id, a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  assert.equal(out.portalUserId, null);
  assert.ok(!/update\s+users\s+set/i.test(routeSrc), 'the router must never write to users');
});

test('57 — verification is its own action, not a side effect of editing', async () => {
  const db = makeDb();
  const a = await createContact(db, CUSTOMER.id, person(), ACTOR);
  await updateContact(db, CUSTOMER.id, a.id, { notes: 'called them', concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  assert.equal(db.table[0].last_verified_at, null, 'an edit must not stamp verification');

  const verified = await verifyContact(db, CUSTOMER.id, a.id, { concurrencyToken: tokenOf(db, a.id) }, ACTOR);
  assert.equal(verified.verification.state, 'current');
});

test('58 — the audit records field names, never a name or a number', () => {
  /* Asserted against the pure builder the route uses: audit() writes through
     the module pool, so a database double never observes it, and a test that
     watched a mock would be testing the mock. */
  const before = { first_name: 'Ada', mobile: '5550109988', notes: 'mornings',
    responsibilities: ['buyer'], is_active: true };
  const after = { first_name: 'Adaline', mobile: '5550107766', notes: 'mornings',
    responsibilities: ['buyer'], is_active: true };
  const text = describeUpdate(before, after);
  assert.match(text, /firstName/);
  assert.match(text, /mobile/);
  assert.ok(!text.includes('Adaline'), 'a value must never reach the audit log');
  assert.ok(!text.includes('555'), 'a number must never reach the audit log');
  assert.ok(!text.includes('notes'), 'an unchanged field must not be listed');
  assert.equal(describeUpdate(before, before), 'no field changed');
});

test('59 — the actor comes from the session and can never come from the body', async () => {
  assert.ok(!/req\.body\??\.(actor|handledBy|userId|createdBy)/.test(routeSrc));
  assert.match(routeSrc, /req\.user\)/);
});

test('60 — every write route is capability-gated on manage and every read on view', () => {
  const gated = routeSrc.match(/r\.(get|post)\('([^']+)',\s*(canView|canManage)\(\)/g) || [];
  const posts = routeSrc.match(/r\.post\('([^']+)'/g) || [];
  assert.equal(posts.length, 8, 'expected exactly the eight named write routes');
  for (const m of routeSrc.match(/r\.post\('[^']+',\s*\w+\(\)/g) || []) {
    assert.ok(m.includes('canManage()'), `an ungated or under-gated write route: ${m}`);
  }
  assert.ok(gated.length >= 10);
});

// ===========================================================================
// 61-75 — the migration planner
// ===========================================================================

const legacy = (over = {}) => ({
  id: 'u_c1', customerNumber: '1001', business: 'Example Optics',
  firstName: 'Ada', lastName: 'Sterling', email: 'ada@example.test',
  phone: '555 010 9988', role: 'customer', status: 'active',
  existingContactCount: 0, ...over,
});

test('61 — the planner never contacts a database', () => {
  /* Structural, not a promise: nothing in the module or its CLI imports pg,
     db.js or any network client. */
  for (const src of [plannerSrc, plannerCli]) {
    assert.ok(!/from\s+['"]pg['"]/.test(src));
    assert.ok(!/require\(['"]pg['"]\)/.test(src));
    assert.ok(!/from\s+['"][^'"]*db\.js['"]/.test(src));
    assert.ok(!/DATABASE_URL/.test(src));
    assert.ok(!/node:https?/.test(src));
  }
});

test('62 — plan() refuses anything but an injected array', () => {
  for (const bad of [null, undefined, {}, 'customers', 7]) {
    assert.throws(() => plan(bad), TypeError);
  }
});

test('63 — the planner mutates nothing and says so in its own artefact', () => {
  const result = plan([legacy()]);
  assert.equal(result.appliesNothing, true);
  assert.equal(result.requiresApproval, true);
  assert.ok(!/insert into/i.test(plannerSrc), 'the planner must contain no INSERT');
  assert.ok(!/update\s+\w+\s+set/i.test(plannerSrc), 'the planner must contain no UPDATE');
});

test('64 — a clean record is proposed', () => {
  const e = assess(legacy());
  assert.equal(e.decision, 'propose');
  assert.equal(e.proposed.firstName, 'Ada');
  assert.equal(e.proposed.isPrimary, true);
});

test('65 — a job title is NEVER inferred', () => {
  for (const record of [
    legacy(), legacy({ email: 'buyer@example.test' }), legacy({ role: 'special customer' }),
    legacy({ business: 'Ada Buyer Optical Management' }),
  ]) {
    assert.equal(assess(record).proposed.jobTitle, '', JSON.stringify(record.email));
  }
});

test('66 — a responsibility is NEVER inferred', () => {
  /* An account email of orders@ is not evidence that the person behind it is
     the buyer. */
  for (const email of ['orders@example.test', 'accounts@example.test', 'owner@example.test']) {
    assert.deepEqual(assess(legacy({ email })).proposed.responsibilities, []);
  }
});

test('67 — a record with no usable name is skipped, never guessed at', () => {
  const e = assess(legacy({ firstName: '', lastName: '' }));
  assert.equal(e.decision, 'skip');
  assert.ok(e.reasons.includes('NO_NAME'));
  assert.equal(e.proposed.firstName, '');
});

test('68 — a record with no usable channel is skipped', () => {
  const e = assess(legacy({ email: '', phone: '' }));
  assert.equal(e.decision, 'skip');
  assert.ok(e.reasons.includes('NO_CHANNEL'));
});

test('69 — an empty contact can never be proposed', () => {
  /* The one property that matters most: a row that exists and says nothing
     reads as coverage. */
  const records = [
    legacy({ firstName: '', lastName: '', email: '', phone: '' }),
    legacy({ firstName: '', lastName: '' }),
    legacy({ email: 'not-an-email', phone: '12' }),
    legacy({ email: '', phone: '' }),
  ];
  for (const e of plan(records).entries) {
    if (e.decision === 'skip') continue;
    assert.ok(e.proposed.firstName && e.proposed.lastName, 'proposed with no name');
    assert.ok(e.proposed.email || e.proposed.officePhone, 'proposed with no channel');
  }
});

test('70 — ambiguous records are flagged for review rather than proposed', () => {
  assert.equal(assess(legacy({ lastName: '' })).decision, 'review');
  assert.equal(assess(legacy({ firstName: 'Accounts', lastName: 'Department' })).decision, 'review');
  assert.equal(assess(legacy({ email: 'info@example.test' })).decision, 'review');
  assert.equal(assess(legacy({ status: 'pending' })).decision, 'review');
  assert.equal(assess(legacy({ email: 'bad-address', phone: '555 010 9988' })).decision, 'review');
});

test('71 — a customer that already has contacts is left alone', () => {
  const e = assess(legacy({ existingContactCount: 2 }));
  assert.equal(e.decision, 'skip');
  assert.ok(e.reasons.includes('ALREADY_HAS_CONTACTS'));
});

test('72 — a non-customer account is not a store', () => {
  for (const role of ['agent', 'super-agent', 'admin', 'warehouse', '']) {
    const e = assess(legacy({ role }));
    assert.equal(e.decision, 'skip', role);
    assert.ok(e.reasons.includes('NOT_A_CUSTOMER'));
  }
});

test('73 — a duplicate channel within the batch is flagged', () => {
  const result = plan([legacy({ id: 'u_a' }), legacy({ id: 'u_b' })]);
  assert.equal(result.entries[0].decision, 'propose');
  assert.equal(result.entries[1].decision, 'review');
  assert.ok(result.entries[1].reasons.includes('DUPLICATE_CHANNEL'));
});

test('74 — the portal account is proposed as a LINK only, and only the customer’s own', () => {
  const e = assess(legacy());
  assert.equal(e.portalUserIdProposed, 'u_c1');
  assert.ok(e.reasons.includes('PORTAL_LINK_PROPOSED'));
  assert.equal(assess(legacy({ status: 'pending' })).portalUserIdProposed, null);
  assert.ok(!/insert into/i.test(plannerSrc), 'the planner must never write anything');
});

test('75 — the plan is deterministic: the same input produces identical artefacts', () => {
  const records = [legacy({ id: 'u_a' }), legacy({ id: 'u_b', email: 'ben@example.test', firstName: 'Ben', lastName: 'Manager' })];
  const one = plan(records, { generatedAt: '2026-08-07T00:00:00.000Z' });
  const two = plan(records, { generatedAt: '2026-08-07T00:00:00.000Z' });
  assert.equal(toJSON(one), toJSON(two));
  assert.equal(toCSV(one), toCSV(two));
  assert.deepEqual(one.entries.map((e) => e.customerId), ['u_a', 'u_b'], 'input order is preserved');
});

test('76 — every CSV field is quoted, so a comma in a business name shifts nothing', () => {
  const csv = toCSV(plan([legacy({ business: 'Example Optics, Inc. "The Best"' })]));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"Example Optics, Inc\. ""The Best"""/);
  // Every cell on every line is quoted.
  for (const line of lines) assert.match(line, /^"([^"]|"")*"(,"([^"]|"")*")*$/);
});

test('77 — the CSV ships with the approved column blank', () => {
  const csv = toCSV(plan([legacy()]));
  const header = csv.split('\n')[0];
  assert.ok(header.includes('"approved"'));
  assert.match(csv.split('\n')[1], /,""$/, 'nothing may arrive pre-approved');
});

test('78 — nothing is applied without an explicit approval', () => {
  const result = plan([legacy()]);
  const none = approvedDecisions(result, []);
  assert.equal(none.approved.length, 0);
  assert.equal(none.refused[0].code, 'NOT_APPROVED');

  const yes = approvedDecisions(result, [{ customerId: 'u_c1', approved: 'yes' }]);
  assert.equal(yes.approved.length, 1);
});

test('79 — a skipped record can never be approved into existence', () => {
  /* A tick in a spreadsheet is not a decision to override a rule the reviewer
     may not have read. */
  const result = plan([legacy({ firstName: '', lastName: '' })]);
  const out = approvedDecisions(result, [{ customerId: 'u_c1', approved: 'yes' }]);
  assert.equal(out.approved.length, 0);
  assert.equal(out.refused[0].code, 'CANNOT_APPROVE_SKIPPED');
});

test('80 — the decision vocabulary and reason legend are closed and stable', () => {
  assert.deepEqual([...DECISIONS], ['propose', 'review', 'skip']);
  const result = plan([legacy()]);
  for (const e of result.entries) {
    assert.ok(DECISIONS.includes(e.decision));
    for (const reason of e.reasons) assert.ok(REASONS[reason], `unlegended reason ${reason}`);
  }
  assert.deepEqual(Object.keys(result.reasonLegend).sort(), Object.keys(REASONS).sort());
});
