/* Enquiry handling model (Fast-Track WS2 Phase 2).

   Pure and dependency-free apart from the public form contract, so every rule
   below is testable without a server or a database.

   This module owns three things:

     1. WHICH HANDLING STATES EXIST and which transitions between them are
        legal. The transition map is a closed allowlist, so an unrecognised
        state or an undeclared move is refused rather than applied. Fail
        closed: `canTransition` returns false for anything it does not
        positively recognise, including undefined, null and non-strings.

     2. WHAT A SUBMISSION LOOKS LIKE ON THE WAY OUT. Two serializers, both
        building fresh object literals with fixed keys — never spreading a
        database row, and never returning the raw `payload` jsonb. The list
        serializer deliberately omits the message body; the detail serializer
        includes it, field by field, filtered through the same closed field
        allowlist the public form used on the way in.

     3. RETENTION METADATA. Derived, never stored: a retention period plus a
        created_at gives a date, and computing it means the answer cannot drift
        from the policy the way a stamped column would.

   An enquiry contains a name, an email address and free text a member of the
   public typed expecting it to reach Veyora and nobody else. That is why the
   serializers are allowlists, why nothing here logs a value, and why reading
   one at all requires a capability nobody holds by default. */

import { formFields, FORM_TYPES } from './public-forms.js';

/* ---------------------------------------------------------------------------
   Handling states
   --------------------------------------------------------------------------- */

/** Every state a submission's handling can be in. Order is stable — it is the
 *  order an operations screen lists filters in, and tests rely on it. */
export const HANDLING_STATUSES = Object.freeze([
  'new',        // received, nobody has picked it up
  'in_review',  // someone is working on it
  'responded',  // a reply has been sent
  'closed',     // finished, no further action
  'spam',       // not a genuine enquiry
]);

/** The initial state. Set by the database default, never by a client. */
export const INITIAL_STATUS = 'new';

/* The transition allowlist.

   Read as: from this state, an operator holding `enquiries.manage` may move to
   any of these. Everything absent is refused.

   Two properties are deliberate:

     - NO STATE IS TERMINAL. `closed` and `spam` both lead back to `in_review`,
       because a misfiled enquiry from a real customer must be recoverable
       without a database operation. A one-way door here would mean the only
       fix for a mis-click is somebody with production SQL access.
     - THERE IS NO PATH BACK TO `new`. It means "nobody has touched this",
       which stops being true the moment somebody does. Allowing a return
       would let an operator erase the fact that the enquiry was seen. */
const TRANSITIONS = Object.freeze({
  new:       Object.freeze(['in_review', 'responded', 'closed', 'spam']),
  in_review: Object.freeze(['responded', 'closed', 'spam']),
  responded: Object.freeze(['in_review', 'closed']),
  closed:    Object.freeze(['in_review']),
  spam:      Object.freeze(['in_review']),
});

export function isHandlingStatus(value) {
  return typeof value === 'string' && HANDLING_STATUSES.includes(value);
}

/** The states reachable from `from`, or an empty array for anything
 *  unrecognised. Used by the API to tell a screen which buttons to render, so
 *  the UI never has a second copy of this map to drift from. */
export function allowedTransitions(from) {
  if (!isHandlingStatus(from)) return [];
  return [...TRANSITIONS[from]];
}

/**
 * Whether one exact transition is permitted.
 *
 * A no-op transition (`from === to`) is refused. It is never a real intent:
 * either a double-click, or a screen working from a state it read before
 * somebody else changed it — and treating it as success would report a
 * transition that did not happen and stamp a handler who did nothing.
 */
export function canTransition(from, to) {
  if (!isHandlingStatus(from) || !isHandlingStatus(to)) return false;
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

/* ---------------------------------------------------------------------------
   Filters
   --------------------------------------------------------------------------- */

/** Normalises a caller-supplied status filter. Returns null for absent, and
 *  throws nothing — an unrecognised value is reported so the caller can 400
 *  rather than silently listing everything, which would look like a working
 *  filter that quietly leaked the states it was meant to exclude. */
export function parseStatusFilter(value) {
  if (value === undefined || value === null || value === '') return { ok: true, status: null };
  if (!isHandlingStatus(value)) {
    return { ok: false, error: 'Unknown handling status.' };
  }
  return { ok: true, status: value };
}

export function parseFormTypeFilter(value) {
  if (value === undefined || value === null || value === '') return { ok: true, formType: null };
  if (typeof value !== 'string' || !FORM_TYPES.includes(value)) {
    return { ok: false, error: 'Unknown form type.' };
  }
  return { ok: true, formType: value };
}

/** Pagination, clamped. A caller cannot ask for the whole table in one
 *  response: an enquiry list is personal data, and an unbounded page is how a
 *  screen accidentally becomes an export. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export function parsePaging({ limit, offset } = {}) {
  const parsedLimit = Number.parseInt(limit, 10);
  const parsedOffset = Number.parseInt(offset, 10);
  return {
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE,
    offset: Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0,
  };
}

/* ---------------------------------------------------------------------------
   Retention
   --------------------------------------------------------------------------- */

/** Mirrors `forms.retention_days`' default in 0007. Used when no form
 *  definition row exists — which is the current state of every environment,
 *  since nothing seeds `forms`. */
export const DEFAULT_RETENTION_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Derived retention facts for one submission.
 *
 * Computed rather than stored, so changing the policy changes every answer at
 * once instead of leaving already-stamped rows describing the old one.
 * `daysRemaining` goes negative once the period has elapsed — that is the
 * signal an operator needs, and rounding it up to zero would hide it.
 */
export function retentionMetadata(createdAt, { retentionDays = DEFAULT_RETENTION_DAYS, now = new Date() } = {}) {
  const days = Number.isFinite(retentionDays) && retentionDays > 0
    ? Math.floor(retentionDays)
    : DEFAULT_RETENTION_DAYS;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) {
    return { retentionDays: days, retainUntil: null, daysRemaining: null, expired: null };
  }
  const until = new Date(created.getTime() + days * DAY_MS);
  const reference = now instanceof Date ? now : new Date(now);
  const remaining = Math.ceil((until.getTime() - reference.getTime()) / DAY_MS);
  return {
    retentionDays: days,
    retainUntil: until.toISOString(),
    daysRemaining: remaining,
    expired: remaining <= 0,
  };
}

/* ---------------------------------------------------------------------------
   Concurrency
   --------------------------------------------------------------------------- */

/* Bound to the submission id, so a token issued while viewing one enquiry
   cannot be replayed against another. The version component is the handling
   state and the moment it last changed, so any transition by another operator
   invalidates a token a concurrent one is holding. */
export function makeEnquiryToken(row) {
  const id = row?.id ?? '';
  const status = row?.handling_status ?? '';
  const at = isoOrNull(row?.handled_at) ?? '';
  return `enquiry:${id}:${status}:${at}`;
}

/* ---------------------------------------------------------------------------
   Serializers — explicit allowlists, fresh object literals
   --------------------------------------------------------------------------- */

export function isoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* The payload jsonb holds whatever the form validator accepted at the time of
   submission. It is re-filtered on the way out through the CURRENT field
   allowlist rather than returned as stored, so a field removed from a form
   stops being surfaced, and a value that reached the column another way is
   never echoed to a screen. */
function serializePayload(formType, payload) {
  const out = {};
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return out;
  for (const field of formFields(formType)) {
    if (field.kind === 'consent') continue;   // recorded as consentAt, never a payload key
    const value = payload[field.name];
    if (typeof value !== 'string' || value === '') continue;
    out[field.name] = value;
  }
  return out;
}

/** The list row. Deliberately WITHOUT the message body and without the rest of
 *  the payload: a list exists to let an operator find the enquiry they need,
 *  and rendering everyone's free text on one screen is how a support inbox
 *  becomes a data-exposure surface over a colleague's shoulder. The detail
 *  view is one click away and is where the content lives. */
export function serializeEnquirySummary(row) {
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload
    : {};
  return {
    id: row.id,
    formType: row.form_type ?? '',
    /* Enough to recognise the enquiry, and nothing more. */
    name: typeof payload.name === 'string' ? payload.name : '',
    company: typeof payload.company === 'string' ? payload.company : '',
    region: row.region ?? '',
    businessType: row.business_type ?? '',
    handlingStatus: row.handling_status ?? INITIAL_STATUS,
    handledAt: isoOrNull(row.handled_at),
    createdAt: isoOrNull(row.created_at),
  };
}

/** The detail record. Includes the submitted content, the consent record, the
 *  handling trail and derived retention facts.
 *
 *  Deliberately ABSENT: `delivery_state`, `attempts` and `last_error`. They
 *  describe an onward-delivery mechanism that is not built, and surfacing
 *  "failed" on an operations screen would tell an operator something is wrong
 *  when nothing is. */
export function serializeEnquiryDetail(row, { retentionDays = DEFAULT_RETENTION_DAYS, now = new Date() } = {}) {
  const formType = row.form_type ?? '';
  return {
    id: row.id,
    formType,
    fields: serializePayload(formType, row.payload),
    sourcePath: row.source_url ?? '',
    region: row.region ?? '',
    businessType: row.business_type ?? '',
    /* The consent wording agreed to, and when. Versioned, so a later wording
       change does not retroactively reinterpret consent already given. */
    consentVersion: row.consent_version ?? '',
    consentAt: isoOrNull(row.consent_at),
    handlingStatus: row.handling_status ?? INITIAL_STATUS,
    handledBy: row.handled_by ?? null,
    handledAt: isoOrNull(row.handled_at),
    handlingNote: row.handling_note ?? '',
    allowedTransitions: allowedTransitions(row.handling_status ?? INITIAL_STATUS),
    retention: retentionMetadata(row.created_at, { retentionDays, now }),
    createdAt: isoOrNull(row.created_at),
    concurrencyToken: makeEnquiryToken(row),
  };
}

/** A handling note is staff-authored free text. Length-capped and stripped of
 *  control characters for the same reasons the public forms do it, and trimmed
 *  so an empty note stays empty rather than becoming a space. */
export const MAX_NOTE_LENGTH = 2000;

export function cleanNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;      // null = rejected
  const cleaned = String(value)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0b-\x1f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((line) => line.trim()).join('\n')
    .trim();
  return cleaned.length > MAX_NOTE_LENGTH ? null : cleaned;
}

export const ENQUIRY_OPERATIONS_CONTRACT = Object.freeze({
  statuses: [...HANDLING_STATUSES],
  initialStatus: INITIAL_STATUS,
  transitions: Object.fromEntries(HANDLING_STATUSES.map((s) => [s, allowedTransitions(s)])),
  maxPageSize: MAX_PAGE_SIZE,
  defaultPageSize: DEFAULT_PAGE_SIZE,
  defaultRetentionDays: DEFAULT_RETENTION_DAYS,
  maxNoteLength: MAX_NOTE_LENGTH,
});
