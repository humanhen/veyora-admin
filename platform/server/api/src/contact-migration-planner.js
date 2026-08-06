/* Store-contact migration planner (Final Handover, Phase 2).

   PROPOSES primary store contacts from the legacy `users` fields. It applies
   nothing, writes nothing, and by default cannot reach a database at all —
   `plan()` takes an array of records somebody handed it.

   WHY A PLANNER AND NOT A BACK-FILL

   `users.first_name`, `users.last_name`, `users.email` and `users.phone` were
   never a store contact. They are whatever was typed when the account was
   created: sometimes the owner, sometimes a shop's generic inbox, sometimes
   the sales rep who set the account up, sometimes "Accounts" with no surname.
   A migration that turned every one of those into a named contact would
   manufacture a person for each customer, assign them nothing, and make the
   contacts table look populated and trustworthy when it is neither.

   So this produces a REVIEW ARTEFACT. Every record comes out in one of three
   states — `propose`, `review` or `skip` — with the reasons attached, and a
   human decides. Nothing downstream may apply a proposal that has not been
   explicitly approved; `approvedDecisions()` is the only shape an applier
   would ever be allowed to read, and it refuses anything not marked approved.

   FOUR RULES THIS PLANNER WILL NOT BREAK

     1. It never infers a job title. Not from the role, not from the email
        local-part, not from anything. `jobTitle` comes out empty, always.
     2. It never infers a responsibility. `responsibilities` comes out empty,
        always. A store's account email being `orders@` is not evidence that
        the person behind it is the buyer.
     3. It never proposes an empty contact. No name, or no reachable channel,
        means `skip` — a row that exists and says nothing is worse than an
        absent row, because it reads as coverage.
     4. It proposes the portal link only as a proposal, and only to the
        customer's own account. It never creates one.

   Determinism: the same input array produces byte-identical JSON and CSV, in
   input order, with no clock and no randomness. `generatedAt` is injected by
   the caller precisely so the artefact can be diffed between runs.
*/

import {
  isEmailish, isPhoneish, cleanText, normaliseEmail, normalisePhone,
  MAX_NAME_LENGTH, MAX_EMAIL_LENGTH, MAX_PHONE_LENGTH,
} from './customer-contacts.js';

/** What the planner decided about one legacy record. */
export const DECISIONS = Object.freeze(['propose', 'review', 'skip']);

/* Reason codes. Closed and stable so a reviewer can filter a 4,000-row CSV by
   code rather than by reading English, and so the counts below mean the same
   thing between runs. */
export const REASONS = Object.freeze({
  NO_NAME: 'no usable first and last name in the legacy fields',
  PARTIAL_NAME: 'only one name part is present, so the other would be invented',
  NO_CHANNEL: 'no usable email address or phone number',
  INVALID_EMAIL: 'the legacy email does not look like an address',
  INVALID_PHONE: 'the legacy phone does not look like a number',
  GENERIC_MAILBOX: 'the email looks like a shared mailbox rather than a person',
  NAME_LOOKS_GENERIC: 'the name looks like a department rather than a person',
  ALREADY_HAS_CONTACTS: 'this customer already has contacts, so nothing is proposed',
  NOT_A_CUSTOMER: 'this account is not a customer record',
  INACTIVE_ACCOUNT: 'the account is not active, so its details may be long stale',
  DUPLICATE_CHANNEL: 'another record in this batch has the same email or mobile',
  PORTAL_LINK_PROPOSED: 'the customer’s own portal account is proposed as the login',
});

/* Local-parts that are a function, not a person. A contact proposed from one
   of these would be a name nobody at the store answers to. They go to
   `review`, not `skip`: the address is real and useful, it just needs a human
   to put a name to it. */
const GENERIC_LOCAL_PARTS = new Set([
  'info', 'sales', 'orders', 'order', 'accounts', 'account', 'accounting',
  'admin', 'office', 'contact', 'enquiries', 'inquiries', 'shop', 'store',
  'mail', 'email', 'support', 'help', 'billing', 'invoices', 'ap', 'ar',
  'purchasing', 'buying', 'reception', 'hello', 'team', 'noreply', 'no-reply',
]);

/* Names that are a department. Same treatment and the same reasoning. */
const GENERIC_NAMES = new Set([
  'accounts', 'accounting', 'admin', 'administrator', 'billing', 'buyer',
  'buying', 'contact', 'customer', 'info', 'manager', 'office', 'orders',
  'owner', 'purchasing', 'reception', 'sales', 'shop', 'store', 'support',
  'team', 'the', 'n/a', 'na', 'none', 'unknown', 'test',
]);

const CUSTOMER_ROLES = new Set(['customer', 'special customer']);

const isGenericName = (s) => GENERIC_NAMES.has(String(s || '').trim().toLowerCase());

function genericMailbox(email) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[._-]?\d+$/, '');
  return GENERIC_LOCAL_PARTS.has(local);
}

/* ---------------------------------------------------------------------------
   Planning
   --------------------------------------------------------------------------- */

/**
 * Assesses one legacy customer record.
 *
 * @param record `{ id, business, customerNumber, firstName, lastName, email,
 *   phone, role, status, existingContactCount }` — a plain object the caller
 *   built. This function never queries anything.
 */
export function assess(record, { seenChannels = null } = {}) {
  const r = record && typeof record === 'object' ? record : {};
  const customerId = String(r.id ?? '');
  const reasons = [];

  const firstName = cleanText(r.firstName, MAX_NAME_LENGTH) || '';
  const lastName = cleanText(r.lastName, MAX_NAME_LENGTH) || '';
  const email = cleanText(r.email, MAX_EMAIL_LENGTH) || '';
  const phone = cleanText(r.phone, MAX_PHONE_LENGTH) || '';

  const base = {
    customerId,
    customerNumber: String(r.customerNumber ?? ''),
    business: String(r.business ?? ''),
    /* The proposed contact. Note what is NOT here: no jobTitle, no
       responsibilities, no preferredContactMethod beyond the default, no
       consent field. Every one of those would be a guess. */
    proposed: {
      firstName,
      lastName,
      email: isEmailish(email) ? email : '',
      mobile: '',
      officePhone: isPhoneish(phone) ? phone : '',
      jobTitle: '',
      responsibilities: [],
      isPrimary: true,
    },
    portalUserIdProposed: null,
  };

  // ---- records this planner has nothing to say about ----
  if (!CUSTOMER_ROLES.has(String(r.role ?? ''))) {
    return { ...base, decision: 'skip', reasons: ['NOT_A_CUSTOMER'] };
  }
  if (Number(r.existingContactCount) > 0) {
    return { ...base, decision: 'skip', reasons: ['ALREADY_HAS_CONTACTS'] };
  }

  // ---- channel quality ----
  const hasEmail = base.proposed.email !== '';
  const hasPhone = base.proposed.officePhone !== '';
  if (email !== '' && !hasEmail) reasons.push('INVALID_EMAIL');
  if (phone !== '' && !hasPhone) reasons.push('INVALID_PHONE');
  if (!hasEmail && !hasPhone) {
    return { ...base, decision: 'skip', reasons: [...reasons, 'NO_CHANNEL'] };
  }

  // ---- name quality ----
  if (firstName === '' && lastName === '') {
    /* Skip, not review-with-a-guess. There is no honest way to derive a
       person's name from a company name or an email local-part, and a
       reviewer staring at a blank name field learns nothing they did not
       already know from the business name. */
    return { ...base, decision: 'skip', reasons: [...reasons, 'NO_NAME'] };
  }
  if (firstName === '' || lastName === '') reasons.push('PARTIAL_NAME');
  if (isGenericName(firstName) || isGenericName(lastName)) reasons.push('NAME_LOOKS_GENERIC');
  if (hasEmail && genericMailbox(base.proposed.email)) reasons.push('GENERIC_MAILBOX');

  // ---- account state ----
  if (String(r.status ?? '') !== 'active') reasons.push('INACTIVE_ACCOUNT');

  // ---- duplicates within the batch ----
  if (seenChannels) {
    const keys = [];
    if (hasEmail) keys.push(`e:${normaliseEmail(base.proposed.email)}`);
    if (hasPhone) keys.push(`p:${normalisePhone(base.proposed.officePhone)}`);
    if (keys.some((k) => seenChannels.has(k))) reasons.push('DUPLICATE_CHANNEL');
    for (const k of keys) seenChannels.add(k);
  }

  /* The portal link is a PROPOSAL of the customer's own account, which is the
     only account the API would accept anyway. It is never applied here, and
     an approved decision still goes through the governed link route. */
  if (String(r.status ?? '') === 'active') {
    base.portalUserIdProposed = customerId;
    reasons.push('PORTAL_LINK_PROPOSED');
  }

  /* Anything with a doubt attached goes to `review`. PORTAL_LINK_PROPOSED is
     informational and does not itself demote a clean record — it says what
     would happen, not that something is wrong. */
  const doubts = reasons.filter((c) => c !== 'PORTAL_LINK_PROPOSED');
  return { ...base, decision: doubts.length ? 'review' : 'propose', reasons };
}

/**
 * Assesses a whole batch.
 *
 * @param records injected. There is no default source and no database client
 *   parameter: this function cannot read the platform's data even by accident.
 * @param generatedAt injected too, so two runs over the same input produce
 *   identical artefacts and can be diffed.
 */
export function plan(records, { generatedAt = null } = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError('plan() takes an array of injected legacy records; it never reads a database.');
  }
  const seenChannels = new Set();
  const entries = records.map((record) => assess(record, { seenChannels }));

  const counts = { propose: 0, review: 0, skip: 0 };
  for (const e of entries) counts[e.decision] += 1;

  return {
    version: 1,
    kind: 'veyora.customer-contacts.migration-plan',
    generatedAt: generatedAt == null ? null : String(generatedAt),
    /* Restated in the artefact itself, because the artefact is what gets
       emailed around and opened six weeks later by somebody who never read
       this file. */
    appliesNothing: true,
    requiresApproval: true,
    total: entries.length,
    counts,
    reasonLegend: { ...REASONS },
    entries,
  };
}

/* ---------------------------------------------------------------------------
   Artefacts
   --------------------------------------------------------------------------- */

export function toJSON(planResult) {
  return `${JSON.stringify(planResult, null, 2)}\n`;
}

const CSV_COLUMNS = Object.freeze([
  'decision', 'customerId', 'customerNumber', 'business',
  'firstName', 'lastName', 'email', 'officePhone',
  'jobTitle', 'responsibilities', 'portalUserIdProposed', 'reasons', 'approved',
]);

/* Every field is quoted and every embedded quote doubled — unconditionally,
   not only when a comma appears. A business name with a comma in it silently
   shifting every later column is exactly how a review spreadsheet ends up
   with somebody's phone number in the job-title column. */
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function toCSV(planResult) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const e of planResult.entries) {
    lines.push([
      e.decision, e.customerId, e.customerNumber, e.business,
      e.proposed.firstName, e.proposed.lastName, e.proposed.email, e.proposed.officePhone,
      e.proposed.jobTitle, e.proposed.responsibilities.join(' '),
      e.portalUserIdProposed ?? '', e.reasons.join(' '),
      /* Left blank deliberately. A reviewer types `yes` here; nothing arrives
         pre-approved, and a planner that shipped its own approvals would make
         the review step decorative. */
      '',
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/* ---------------------------------------------------------------------------
   Approval
   --------------------------------------------------------------------------- */

const APPROVED = new Set(['yes', 'y', 'true', 'approved', '1']);

/**
 * The ONLY shape an applier may act on.
 *
 * Takes the reviewed decisions back — `[{ customerId, approved }]` — and
 * returns the subset that is both approved by a human AND still proposable.
 * Everything else is returned as a refusal with a reason, so a run that
 * applies less than expected says why rather than quietly doing less.
 *
 * A `skip` entry can NEVER be approved into existence: approving a record the
 * planner refused would recreate exactly the empty-contact problem the planner
 * exists to prevent, and a reviewer ticking a box in a spreadsheet is not a
 * decision to override a rule they may not have read.
 */
export function approvedDecisions(planResult, reviewedRows) {
  const byId = new Map();
  for (const row of Array.isArray(reviewedRows) ? reviewedRows : []) {
    const id = String(row?.customerId ?? '');
    if (id !== '') byId.set(id, String(row?.approved ?? '').trim().toLowerCase());
  }

  const approved = [];
  const refused = [];
  for (const entry of planResult.entries) {
    const mark = byId.get(entry.customerId);
    if (!APPROVED.has(mark ?? '')) {
      refused.push({ customerId: entry.customerId, code: 'NOT_APPROVED' });
      continue;
    }
    if (entry.decision === 'skip') {
      refused.push({ customerId: entry.customerId, code: 'CANNOT_APPROVE_SKIPPED' });
      continue;
    }
    approved.push(entry);
  }
  return { approved, refused };
}
