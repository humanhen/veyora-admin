/* Public enquiry form definitions and validation (Fast-Track Phase 3).

   Pure and dependency-free, so every rule below is testable without a server
   or a database.

   The design principle is that a public, unauthenticated POST endpoint is the
   most hostile surface this platform exposes, so everything about it is a
   closed allowlist: which forms exist, which fields each accepts, how long
   each may be, and what shape a value may take. An unknown field is rejected
   rather than ignored — silently dropping it would let a mis-built client, or
   a probe, believe it had been accepted.

   Three things are deliberately NOT accepted from a client under any
   circumstance, because they are the server's to decide:
     - `delivery_state` (always starts 'pending'),
     - any actor, approver or user identity,
     - any submission id.
   They are not in an allowlist to be forgotten from; they are named in a
   forbidden set and rejected explicitly. */

export const FORM_TYPES = Object.freeze(['contact', 'request-b2b-account', 'private-label-enquiry']);

/* The honeypot. A real visitor never sees it (the field is hidden and
   aria-hidden), so anything in it came from something filling every input it
   found. Named plausibly rather than `honeypot`, which a targeted bot would
   skip. */
export const HONEYPOT_FIELD = 'website';

const MAX = { short: 120, medium: 200, long: 4000, phone: 40, country: 80 };

/** kind: text | email | phone | longtext | choice | consent */
const FIELDS = {
  contact: {
    name: { kind: 'text', max: MAX.short, required: true, label: 'Your name' },
    email: { kind: 'email', max: MAX.short, required: true, label: 'Email address' },
    company: { kind: 'text', max: MAX.short, required: false, label: 'Company' },
    phone: { kind: 'phone', max: MAX.phone, required: false, label: 'Phone' },
    message: { kind: 'longtext', max: MAX.long, required: true, label: 'Message' },
    consent: { kind: 'consent', required: true, label: 'Contact consent' },
  },
  'request-b2b-account': {
    name: { kind: 'text', max: MAX.short, required: true, label: 'Your name' },
    email: { kind: 'email', max: MAX.short, required: true, label: 'Business email address' },
    company: { kind: 'text', max: MAX.short, required: true, label: 'Business name' },
    businessType: {
      kind: 'choice', required: true, label: 'Business type',
      values: ['Independent optician', 'Optical chain', 'Distributor', 'Online retailer', 'Other'],
    },
    country: { kind: 'text', max: MAX.country, required: true, label: 'Country' },
    phone: { kind: 'phone', max: MAX.phone, required: false, label: 'Phone' },
    message: { kind: 'longtext', max: MAX.long, required: false, label: 'Anything else' },
    consent: { kind: 'consent', required: true, label: 'Contact consent' },
  },
  'private-label-enquiry': {
    name: { kind: 'text', max: MAX.short, required: true, label: 'Your name' },
    email: { kind: 'email', max: MAX.short, required: true, label: 'Business email address' },
    company: { kind: 'text', max: MAX.short, required: true, label: 'Business name' },
    country: { kind: 'text', max: MAX.country, required: true, label: 'Country' },
    projectType: {
      kind: 'choice', required: false, label: 'Project type',
      values: ['New private label', 'Existing label extension', 'Capsule collection', 'Not yet decided'],
    },
    message: { kind: 'longtext', max: MAX.long, required: true, label: 'Tell us about the project' },
    consent: { kind: 'consent', required: true, label: 'Contact consent' },
  },
};

/* Fields a client must never set. Kept separate from "unknown field" so a
   rejection can say WHY — a client sending `deliveryState` has a real
   misunderstanding, not a typo. */
const SERVER_CONTROLLED = new Set([
  'deliveryState', 'delivery_state', 'attempts', 'lastError', 'last_error',
  'id', 'submissionId', 'userId', 'user_id', 'actor', 'actorId',
  'approverId', 'approver_id', 'approvedAt', 'approved_at',
  'createdAt', 'created_at', 'updatedAt', 'updated_at', 'consentAt', 'consent_at',
]);

export function formDefinition(formType) {
  return Object.prototype.hasOwnProperty.call(FIELDS, formType) ? FIELDS[formType] : null;
}

/* ---------------------------------------------------------------------------
   Normalisation
   --------------------------------------------------------------------------- */

/** Collapses whitespace, normalises Unicode, and strips control characters.
    Control characters are removed rather than rejected: they are almost
    always a copy-paste artefact, and failing a genuine enquiry over an
    invisible character would be worse than cleaning it. */
function cleanLine(value) {
  return String(value).normalize('NFC').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Same, but newlines survive — a message is allowed paragraphs. Runs of
    blank lines collapse so a submission cannot be padded to its limit with
    whitespace. */
function cleanBlock(value) {
  return String(value)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0b-\x1f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((line) => line.trim()).join('\n')
    .trim();
}

/* Email: deliberately conservative rather than RFC-complete. A single @, no
   whitespace, a dot-bearing domain, no consecutive dots. RFC 5322 permits
   addresses no mail provider would issue, and accepting them here buys
   nothing while widening what reaches storage. */
const EMAIL = /^[^\s@,;:<>()[\]\\"]+@[^\s@.,;:<>()[\]\\"]+(?:\.[^\s@.,;:<>()[\]\\"]+)+$/;

/* Phone: digits, spaces and the punctuation real numbers use. No letters —
   a "phone number" containing prose is a bot or a mistake. Optional
   everywhere, so rejecting a malformed one costs nothing. */
const PHONE = /^[0-9+()\-. ]{6,40}$/;

/** Text that must not look like markup. Not sanitisation — the value is
    stored and rendered as plain text by consumers — but a field that is
    supposed to be a name and contains a tag is not a name. */
const LOOKS_LIKE_MARKUP = /<\s*\/?\s*[a-z][^>]*>|<\s*script|javascript:/i;

/* ---------------------------------------------------------------------------
   Validation
   --------------------------------------------------------------------------- */

const fieldError = (field, code, message) => ({ field, code, message });

function validateField(name, spec, raw, errors) {
  const missing = raw === undefined || raw === null || String(raw).trim() === '';

  if (spec.kind === 'consent') {
    /* A checkbox arrives as its value when ticked and is absent when not.
       Anything other than an explicit affirmative is "not given". */
    const given = raw === true || raw === 'on' || raw === 'true' || raw === '1' || raw === 'yes';
    if (spec.required && !given) {
      errors.push(fieldError(name, 'CONSENT_REQUIRED', 'Please confirm you are happy for us to reply.'));
      return undefined;
    }
    return given;
  }

  if (missing) {
    if (spec.required) errors.push(fieldError(name, 'REQUIRED', `${spec.label} is required.`));
    return spec.kind === 'longtext' || spec.kind === 'text' ? '' : null;
  }

  if (typeof raw !== 'string') {
    errors.push(fieldError(name, 'INVALID_TYPE', `${spec.label} must be text.`));
    return null;
  }

  if (spec.kind === 'choice') {
    const value = cleanLine(raw);
    if (!spec.values.includes(value)) {
      errors.push(fieldError(name, 'INVALID_CHOICE', `Choose one of the listed options for ${spec.label.toLowerCase()}.`));
      return null;
    }
    return value;
  }

  const value = spec.kind === 'longtext' ? cleanBlock(raw) : cleanLine(raw);

  if (value.length > spec.max) {
    errors.push(fieldError(name, 'TOO_LONG', `${spec.label} must be ${spec.max} characters or fewer.`));
    return null;
  }
  if (spec.required && value === '') {
    errors.push(fieldError(name, 'REQUIRED', `${spec.label} is required.`));
    return null;
  }

  if (spec.kind === 'email' && value !== '' && !EMAIL.test(value)) {
    errors.push(fieldError(name, 'INVALID_EMAIL', 'Enter an email address we can reply to.'));
    return null;
  }
  if (spec.kind === 'phone' && value !== '' && !PHONE.test(value)) {
    errors.push(fieldError(name, 'INVALID_PHONE', 'Enter a phone number using digits and + ( ) - only, or leave it blank.'));
    return null;
  }
  if ((spec.kind === 'text' || spec.kind === 'email' || spec.kind === 'choice') && LOOKS_LIKE_MARKUP.test(value)) {
    errors.push(fieldError(name, 'INVALID_CONTENT', `${spec.label} must be plain text.`));
    return null;
  }

  return value;
}

/**
 * Validates a submission body against one form's closed contract.
 *
 * @returns {{ok:true, formType, values, consentGiven, honeypotTripped}
 *          |{ok:false, errors}}
 */
export function validateSubmission(formType, body) {
  const fields = formDefinition(formType);
  if (!fields) {
    return { ok: false, errors: [fieldError(null, 'UNKNOWN_FORM', 'Unknown form.')] };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors: [fieldError(null, 'INVALID_BODY', 'The submission was not readable.')] };
  }

  const errors = [];

  for (const key of Object.keys(body)) {
    if (key === HONEYPOT_FIELD) continue;
    if (SERVER_CONTROLLED.has(key)) {
      errors.push(fieldError(key, 'SERVER_CONTROLLED',
        'This value is set by the server and cannot be supplied.'));
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      errors.push(fieldError(key, 'UNKNOWN_FIELD', 'This form does not accept that field.'));
    }
  }

  const values = {};
  let consentGiven = false;
  for (const [name, spec] of Object.entries(fields)) {
    const result = validateField(name, spec, body[name], errors);
    if (spec.kind === 'consent') consentGiven = result === true;
    else values[name] = result;
  }

  if (errors.length) return { ok: false, errors };

  /* The honeypot is evaluated AFTER validation so a bot cannot use the
     response to distinguish "you tripped the trap" from "your data was
     fine". The caller decides what to do with the flag. */
  const honeypotTripped = typeof body[HONEYPOT_FIELD] === 'string' && body[HONEYPOT_FIELD].trim() !== '';

  return { ok: true, formType, values, consentGiven, honeypotTripped };
}

/** The stored payload: an explicit object built from validated values only.
    Never the request body, never a spread. */
export function buildPayload(formType, values) {
  const fields = formDefinition(formType);
  const payload = {};
  for (const name of Object.keys(fields)) {
    if (fields[name].kind === 'consent') continue;   // recorded as consent_at
    if (values[name] === undefined || values[name] === null || values[name] === '') continue;
    payload[name] = values[name];
  }
  return payload;
}

/** The field list a renderer needs, in a stable order. */
export function formFields(formType) {
  const fields = formDefinition(formType);
  if (!fields) return [];
  return Object.entries(fields).map(([name, spec]) => ({
    name,
    kind: spec.kind,
    label: spec.label,
    required: Boolean(spec.required),
    max: spec.max ?? null,
    values: spec.values ?? null,
  }));
}

export const PUBLIC_FORM_CONTRACT = Object.freeze({
  formTypes: [...FORM_TYPES],
  honeypotField: HONEYPOT_FIELD,
  serverControlled: [...SERVER_CONTROLLED].sort(),
  limits: { ...MAX },
});
