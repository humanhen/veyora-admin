/* Store contact model (Final Handover, Phase 2).

   Pure and dependency-free: no database, no driver, no request object. Every
   rule below is testable without a server, and there is exactly one place a
   rule lives.

   THE THREE CONCEPTS THIS MODULE KEEPS APART

     Veyora sales rep  — an internal Veyora agent. `users.agent_id`. Not
                         modelled here; this module never reads or writes it.
     Store contact     — a person who works for the customer. This module.
                         Has no login, no capability and no authority.
     Portal user       — an account that may authenticate. Still `users`.
                         A contact MAY be linked to one, explicitly.

   They are separate because conflating them is the defect: `users` currently
   carries a store's commercial terms and one person's mobile number in the
   same row, so replacing the buyer means editing the login.

   WHAT THIS MODULE WILL NOT DO

     - It will not infer a responsibility from a job title. "Office Manager"
       is not evidence that someone handles accounts payable, and a system
       that guesses will eventually route an invoice to the wrong person.
     - It will not create a portal account, or propose one.
     - It will not record consent or a marketing subscription. Knowing who the
       buyer is is not permission to market to them.
     - It will not delete. `is_active` false is how a contact leaves, because
       an order or an audit entry that names the buyer must still resolve to a
       person after that person moves on.
*/

/* ---------------------------------------------------------------------------
   Closed sets
   --------------------------------------------------------------------------- */

/** What a contact is responsible for. Machine-readable and closed, unlike
 *  `job_title`, which is free text because a job title is what somebody calls
 *  themselves. `other` exists so a real responsibility that does not fit is
 *  recorded honestly rather than forced into the nearest wrong bucket. */
export const RESPONSIBILITIES = Object.freeze([
  'owner',
  'store_manager',
  'buyer',
  'accounts_payable',
  'receiving',
  'returns_warranty',
  'other',
]);

/** How a person prefers to be reached. */
export const CONTACT_METHODS = Object.freeze([
  'email',
  'mobile_call',
  'whatsapp',
  'office_phone',
]);

/* Which stored channel each preference actually needs. A preference for a
   channel the person does not have is refused rather than silently accepted:
   "prefers WhatsApp" against an empty mobile is a routing instruction nobody
   can follow, and it looks like coverage on a screen. */
const METHOD_REQUIRES = Object.freeze({
  email: 'email',
  mobile_call: 'mobile',
  whatsapp: 'mobile',
  office_phone: 'officePhone',
});

export const MAX_NAME_LENGTH = 120;
export const MAX_TITLE_LENGTH = 120;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_PHONE_LENGTH = 40;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_EXTENSION_LENGTH = 12;
export const MAX_LANGUAGE_LENGTH = 35;

export const isResponsibility = (v) => typeof v === 'string' && RESPONSIBILITIES.includes(v);
export const isContactMethod = (v) => typeof v === 'string' && CONTACT_METHODS.includes(v);

/* ---------------------------------------------------------------------------
   Normalisation
   --------------------------------------------------------------------------- */

/* Control characters are stripped for the same reason the public forms strip
   them: a value that reaches a CSV export, an email header or a log line must
   not be able to carry a newline. Nothing else is altered — a name is
   whatever the person says it is. */
const stripControl = (s) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, '');

export function cleanText(value, maxLength) {
  const text = stripControl(value).trim();
  if (text.length > maxLength) return null;
  return text;
}

const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

/** Canonical form for matching. Stored ALONGSIDE the typed value, never
 *  instead of it: lower-casing an address for comparison is right, and
 *  showing somebody a lower-cased version of what they typed is not. */
export function normaliseEmail(value) {
  const text = cleanText(value, MAX_EMAIL_LENGTH);
  if (text === null || text === '') return '';
  return text.toLowerCase();
}

/** Canonical form for a phone number: digits, with a leading + preserved.
 *
 *  Deliberately NOT a country-code guess. Prefixing a bare local number with
 *  whatever country the customer record happens to say would produce a number
 *  that dials somewhere real and wrong. Two numbers written differently in the
 *  same format compare equal; a local and an international form of the same
 *  number do not, and that is the honest answer when nobody has told us the
 *  country. */
export function normalisePhone(value) {
  const text = cleanText(value, MAX_PHONE_LENGTH);
  if (text === null || text === '') return '';
  const plus = text.trimStart().startsWith('+') ? '+' : '';
  const digits = text.replace(/\D+/g, '');
  if (digits === '') return '';
  return plus + digits;
}

export function isEmailish(value) {
  return typeof value === 'string' && value !== '' && value.length <= MAX_EMAIL_LENGTH
    && EMAIL_RE.test(value);
}

/** A phone number is usable if it has enough digits to be one. Seven is the
 *  shortest a subscriber number gets in the markets Veyora sells into; below
 *  that it is a typo or an extension somebody put in the wrong box. */
export function isPhoneish(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits.length >= 7 && digits.length <= 20;
}

/* ---------------------------------------------------------------------------
   Validation
   --------------------------------------------------------------------------- */

const err = (field, code, message) => ({ field, code, message });

/**
 * Validates and canonicalises a contact submission.
 *
 * @param input the request body — never trusted, never spread.
 * @param existing the current row when updating, so a partial update is
 *   validated against what the contact will BE, not only against what was
 *   sent. Without this, clearing the only email while `preferred_contact_method`
 *   stays 'email' would pass every field-level check and produce a contact
 *   nobody can reach.
 * @returns `{ ok: true, value }` or `{ ok: false, errors }`.
 */
export function validateContactInput(input, { existing = null, partial = false } = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = [];
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

  /* The current value of a field: what was sent if it was sent, otherwise
     what the row already holds, otherwise the empty default. */
  const prior = existing || {};
  const carried = (key, fallback = '') =>
    (prior[key] === undefined || prior[key] === null ? fallback : prior[key]);

  const value = {};

  const textField = (key, max, priorKey = key) => {
    if (!has(key)) {
      if (partial) { value[key] = carried(priorKey); return; }
      value[key] = '';
      return;
    }
    const cleaned = cleanText(body[key], max);
    if (cleaned === null) {
      errors.push(err(key, 'TOO_LONG', `Must be ${max} characters or fewer.`));
      value[key] = '';
      return;
    }
    value[key] = cleaned;
  };

  textField('firstName', MAX_NAME_LENGTH);
  textField('lastName', MAX_NAME_LENGTH);
  textField('jobTitle', MAX_TITLE_LENGTH);
  textField('officeExtension', MAX_EXTENSION_LENGTH);
  textField('preferredLanguage', MAX_LANGUAGE_LENGTH);
  textField('notes', MAX_NOTES_LENGTH);
  textField('mobile', MAX_PHONE_LENGTH);
  textField('officePhone', MAX_PHONE_LENGTH);
  textField('email', MAX_EMAIL_LENGTH);

  /* Channels are checked for plausibility only when non-empty. Empty is
     always allowed at field level — "no mobile" is a fact, not an error. The
     reachability rule below is what refuses a contact with no channel at all. */
  if (value.email !== '' && !isEmailish(value.email)) {
    errors.push(err('email', 'INVALID_EMAIL', 'That does not look like an email address.'));
  }
  if (value.mobile !== '' && !isPhoneish(value.mobile)) {
    errors.push(err('mobile', 'INVALID_PHONE', 'That does not look like a phone number.'));
  }
  if (value.officePhone !== '' && !isPhoneish(value.officePhone)) {
    errors.push(err('officePhone', 'INVALID_PHONE', 'That does not look like a phone number.'));
  }
  if (value.officeExtension !== '' && !/^[0-9#*-]+$/.test(value.officeExtension)) {
    errors.push(err('officeExtension', 'INVALID_EXTENSION', 'An extension may contain digits, -, # and * only.'));
  }

  // ---- responsibilities ----
  if (!has('responsibilities')) {
    value.responsibilities = partial ? [...(carried('responsibilities', []) || [])] : [];
  } else if (!Array.isArray(body.responsibilities)) {
    errors.push(err('responsibilities', 'INVALID_TYPE', 'Must be an array of responsibility keys.'));
    value.responsibilities = [];
  } else if (body.responsibilities.length > RESPONSIBILITIES.length) {
    errors.push(err('responsibilities', 'TOO_MANY', 'More responsibilities supplied than exist.'));
    value.responsibilities = [];
  } else {
    const seen = new Set();
    for (const key of body.responsibilities) {
      if (!isResponsibility(key)) {
        errors.push(err('responsibilities', 'UNKNOWN_RESPONSIBILITY',
          `"${typeof key === 'string' ? key.slice(0, 40) : typeof key}" is not a recognised responsibility.`));
        continue;
      }
      seen.add(key);
    }
    /* Canonical order, not caller order, so the stored array is stable and two
       requests listing the same responsibilities differently produce the same
       row — which is what makes the concurrency token meaningful. */
    value.responsibilities = RESPONSIBILITIES.filter((k) => seen.has(k));
  }

  // ---- preferred contact method ----
  if (!has('preferredContactMethod')) {
    value.preferredContactMethod = partial ? carried('preferredContactMethod', 'email') : 'email';
  } else if (!isContactMethod(body.preferredContactMethod)) {
    errors.push(err('preferredContactMethod', 'UNKNOWN_METHOD',
      'That is not a contact method this system knows.'));
    value.preferredContactMethod = 'email';
  } else {
    value.preferredContactMethod = body.preferredContactMethod;
  }

  // ---- is_active ----
  if (!has('isActive')) {
    value.isActive = partial ? carried('isActive', true) !== false : true;
  } else if (typeof body.isActive !== 'boolean') {
    errors.push(err('isActive', 'INVALID_TYPE', 'Must be true or false.'));
    value.isActive = true;
  } else {
    value.isActive = body.isActive;
  }

  /* ---- the two rules that make a contact a contact ----
     Applied only to an ACTIVE contact. An archived one is a historical record
     of a person who has moved on; holding it to the same completeness bar
     would mean it could never be archived once a detail went stale. */
  if (value.isActive) {
    if (value.firstName === '' || value.lastName === '') {
      errors.push(err('firstName', 'NAME_REQUIRED',
        'An active contact needs a first and last name. Archive the contact instead if the person has left.'));
    }
    const channels = [value.email, value.mobile, value.officePhone].filter((c) => c !== '');
    if (channels.length === 0) {
      errors.push(err('email', 'CHANNEL_REQUIRED',
        'An active contact needs at least one way to reach them — an email address, a mobile or an office phone.'));
    }
    const required = METHOD_REQUIRES[value.preferredContactMethod];
    if (required && value[required] === '') {
      errors.push(err('preferredContactMethod', 'METHOD_UNREACHABLE',
        `The preferred contact method needs a ${required === 'email' ? 'email address' : 'phone number'} that this contact does not have.`));
    }
  }

  if (errors.length) {
    errors.sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code));
    return { ok: false, errors };
  }

  value.emailNormalised = normaliseEmail(value.email);
  value.mobileNormalised = normalisePhone(value.mobile);
  return { ok: true, value };
}

/* ---------------------------------------------------------------------------
   Concurrency
   --------------------------------------------------------------------------- */

export function isoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A composite token over everything a concurrent edit could change. Two
 *  operators editing the same contact means the second is told rather than
 *  silently overwriting the first. */
export function makeContactToken(row) {
  return [
    'contact',
    row?.id ?? '',
    row?.is_active === false ? '0' : '1',
    row?.is_primary === true ? '1' : '0',
    isoOrNull(row?.updated_at) ?? '',
  ].join(':');
}

/* ---------------------------------------------------------------------------
   Serializers — fresh object literals, fixed keys, never a spread row
   --------------------------------------------------------------------------- */

const arrayOf = (value) => (Array.isArray(value) ? value.filter(isResponsibility) : []);

/**
 * One contact on the way out.
 *
 * `portalUserId` is returned but no portal-account detail is: the linked
 * account's email, role and status belong to the account surface, which has
 * its own authority. A contacts screen that quietly rendered a portal
 * account's role would be a second, ungoverned view of the account system.
 */
export function serializeContact(row) {
  return {
    id: String(row?.id ?? ''),
    customerId: String(row?.customer_id ?? ''),
    firstName: String(row?.first_name ?? ''),
    lastName: String(row?.last_name ?? ''),
    jobTitle: String(row?.job_title ?? ''),
    responsibilities: arrayOf(row?.responsibilities),
    mobile: String(row?.mobile ?? ''),
    officePhone: String(row?.office_phone ?? ''),
    officeExtension: String(row?.office_extension ?? ''),
    email: String(row?.email ?? ''),
    preferredContactMethod: isContactMethod(row?.preferred_contact_method)
      ? row.preferred_contact_method : 'email',
    preferredLanguage: String(row?.preferred_language ?? ''),
    isPrimary: row?.is_primary === true,
    isActive: row?.is_active !== false,
    portalUserId: row?.portal_user_id == null ? null : String(row.portal_user_id),
    notes: String(row?.notes ?? ''),
    lastVerifiedAt: isoOrNull(row?.last_verified_at),
    createdAt: isoOrNull(row?.created_at),
    updatedAt: isoOrNull(row?.updated_at),
    concurrencyToken: makeContactToken(row),
    /* Derived, never stored. A stamped "verified" boolean would drift the day
       somebody changed the policy; a date plus a period cannot. */
    verification: verificationState(row),
  };
}

/** How stale a contact's details are. A contact nobody has confirmed in a year
 *  is the one whose mobile is disconnected. */
export const VERIFICATION_STALE_DAYS = 365;

export function verificationState(row, { now = new Date() } = {}) {
  const at = isoOrNull(row?.last_verified_at);
  if (!at) return { verifiedAt: null, state: 'never', daysSince: null };
  const days = Math.floor((now.getTime() - new Date(at).getTime()) / 86_400_000);
  return {
    verifiedAt: at,
    state: days > VERIFICATION_STALE_DAYS ? 'stale' : 'current',
    daysSince: days,
  };
}

/** The frozen contract a screen renders its pickers from, so there is never a
 *  second copy of these lists in a browser to drift out of step. */
export const CONTACT_CONTRACT = Object.freeze({
  responsibilities: RESPONSIBILITIES,
  contactMethods: CONTACT_METHODS,
  methodRequires: Object.freeze({ ...METHOD_REQUIRES }),
  verificationStaleDays: VERIFICATION_STALE_DAYS,
  limits: Object.freeze({
    name: MAX_NAME_LENGTH,
    jobTitle: MAX_TITLE_LENGTH,
    notes: MAX_NOTES_LENGTH,
    phone: MAX_PHONE_LENGTH,
    email: MAX_EMAIL_LENGTH,
    extension: MAX_EXTENSION_LENGTH,
    language: MAX_LANGUAGE_LENGTH,
  }),
});
