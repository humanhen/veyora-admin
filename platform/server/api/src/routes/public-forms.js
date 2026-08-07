/* Public enquiry form submission (Fast-Track Phase 3).

   Three unauthenticated POST endpoints, mounted at /forms — a dedicated
   namespace, deliberately NOT under /public. That prefix is documented and
   tested as a read-only boundary with no write methods
   (15_B2_PUBLIC_API_CONTRACT.md), and quietly adding a POST under it would
   falsify a contract other tests depend on.

   A submission is STORED FIRST and delivered by a worker afterwards. Doing
   delivery inline would mean a visitor's enquiry could be lost because a mail
   server was slow; storing first is the only ordering where a submission
   cannot vanish.

   The staff alert is queued in the SAME transaction as the submission
   (notifications/outbox.js), so an accepted enquiry always has a notification
   — findings ENQ-006 / NOT-006, where a submission was stored and nothing
   ever told anybody. The alert carries no enquirer detail; it is a pointer to
   the governed Enquiries screen.

   Nothing here logs a field value. An enquiry contains a name, an email
   address and free text a person typed expecting it to reach Veyora and
   nobody else; a stack trace with the payload in it defeats that. Failures
   log the form type and the error, never the content. */

import { createHash } from 'node:crypto';
import { Router } from 'express';
import express from 'express';
import { pool, tx as realTx } from '../db.js';
import { validateSubmission, buildPayload, FORM_TYPES, formDefinition } from '../public-forms.js';
import { enqueue } from '../notifications/outbox.js';
import { buildEnquiryTemplateData, TEMPLATE_VERSION } from '../notifications/templates.js';
import { enquiryAlertRecipients } from '../config.js';
import { adminLink } from '../origins.js';

/* A tight body limit for this router only. The app-wide 64mb exists for image
   uploads; an enquiry that large is an attack, and 413 is the right answer
   long before the JSON is parsed. */
const BODY_LIMIT = '32kb';

/* ---------------------------------------------------------------------------
   Throttle
   --------------------------------------------------------------------------- */

/* There is no rate-limiting convention in this repository, so rather than
   invent a distributed one this is an explicit, in-process, best-effort
   throttle. Its limits are honest:

     - it is PER PROCESS, so N api containers allow N times the rate;
     - it holds state in memory, so a restart clears it;
     - it keys on the proxied client address, which a determined attacker
       varies.

   It is therefore a mitigation against casual abuse and accidental
   double-posting, not a security control. Documented as such in
   24_PUBLIC_ENQUIRY_FORMS.md. A real control belongs at the edge. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 8;
const hits = new Map();

function throttled(key, now = Date.now()) {
  /* Opportunistic sweep — this map only grows while traffic does, and a
     public form endpoint sees little of it. */
  if (hits.size > 5000) {
    for (const [k, times] of hits) {
      const kept = times.filter((t) => now - t < WINDOW_MS);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

export function _resetThrottleForTesting() { hits.clear(); }

/* ---------------------------------------------------------------------------
   Storage
   --------------------------------------------------------------------------- */

/**
 * Stores one submission AND queues its staff alert, in one transaction.
 *
 * Both or neither (findings ENQ-006 / NOT-006). Before this, a submission was
 * stored and nothing ever told anybody — a public form that silently
 * accumulates sales leads is worse than no form, because the business
 * believes it is receiving enquiries.
 *
 * The alert deliberately carries NO enquirer detail: not the message, not the
 * address, not the phone number. It says an enquiry arrived and where to read
 * it. Putting the content in an email would copy personal data into however
 * many inboxes the alert reaches, outside the capability system that governs
 * who may read an enquiry at all. See notifications/templates.js.
 *
 * @returns the submission id, so the caller can relate the two.
 */
export async function storeSubmission(db, { formType, payload, sourceUrl, region, businessType, consentGiven },
  { recipients = [], adminUrl = '', now = () => new Date() } = {}) {
  return db.tx(async (c) => {
    const submittedAt = now();

    /* A short-window duplicate guard (Final Handover Phase 7).

       Before this, a public enquiry had NO server-side protection at all. A
       refresh of the POST result, a synthetic `requestSubmit()`, a second tab,
       or scripting simply being off each produced a second stored enquiry AND
       a second alert to every configured recipient.

       The fingerprint carries a coarse TIME BUCKET rather than being a plain
       content hash. Two genuine enquiries can be identical — somebody asks the
       same question a week later, or two people at one shop send the same
       request — and refusing the second permanently would be worse than
       accepting a duplicate: a lost enquiry is invisible, a duplicated one is
       merely untidy. */
    const fingerprint = submissionFingerprint({ formType, payload, at: submittedAt });

    const { rows } = await c.query(
      `insert into form_submissions
         (form_type, payload, source_url, region, business_type, consent_version, consent_at,
          delivery_state, dedupe_fingerprint)
       values ($1, $2::jsonb, $3, $4, $5, $6, $7, 'pending', $8)
       on conflict (dedupe_fingerprint) where dedupe_fingerprint is not null do nothing
       returning id`,
      [
        formType,
        JSON.stringify(payload),
        sourceUrl,
        region,
        businessType,
        /* The consent wording a submitter agreed to. Versioned so a later
           wording change does not retroactively reinterpret consent already
           given. */
        consentGiven ? CONSENT_VERSION : '',
        consentGiven ? submittedAt : null,
        fingerprint,
      ]
    );

    /* No row means this exact enquiry already arrived inside the window. The
       CALLER still gets `{ ok: true }` — the submitter did what they meant to
       and telling them it failed would make them send a third. Nothing is
       queued, so the staff alert is not duplicated either. */
    if (!rows[0]) return null;

    const submissionId = rows[0].id;

    /* No configured recipient is a real, visible state — the enquiry screen
       shows "not configured" — not a silent no-op. Queuing a notification to
       nobody would be worse: it would look delivered. */
    for (const recipient of recipients) {
      await enqueue(c, {
        notificationType: 'enquiry_received',
        sourceType: 'form_submission',
        sourceId: submissionId,
        recipientAddress: recipient,
        templateKey: 'enquiry_received',
        templateVersion: TEMPLATE_VERSION,
        templateData: buildEnquiryTemplateData({
          formType,
          submittedAt: submittedAt.toISOString(),
          region,
          businessType,
          adminUrl,
        }),
      });
    }

    return submissionId;
  });
}

export const CONSENT_VERSION = '2026-08-enquiry-v1';

/** How wide the duplicate window is. Two minutes catches a double click, a
 *  refresh, a second tab and an impatient resubmit; it does not catch somebody
 *  legitimately asking the same thing again later in the day. */
export const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

/**
 * The fingerprint of one submission.
 *
 * Built from the form type, the SUBMITTED CONTENT and a coarse time bucket.
 * Hashed rather than concatenated: the value goes in an indexed column that a
 * database administrator reads, and a submitter's message should not be
 * legible there.
 *
 * The bucket is floored, not rolling, which means two submissions can land
 * either side of a boundary and both be accepted. That is the right way round
 * to be wrong — an occasional duplicate is untidy, a refused enquiry is lost.
 */
export function submissionFingerprint({ formType, payload, at }) {
  const bucket = Math.floor(new Date(at).getTime() / DEDUPE_WINDOW_MS);
  /* Keys sorted, so two submissions of the same content hash the same
     regardless of the order the validator happened to build the object in. */
  const canonical = Object.keys(payload || {}).sort()
    .map((k) => `${k}=${String(payload[k] ?? '')}`).join('');
  return createHash('sha256')
    .update(`${formType}${bucket}${canonical}`)
    .digest('hex')
    .slice(0, 48);
}

/** A source URL is recorded for context, but only as a PATH: a full URL from
    a client could carry a query string with anything in it. */
export function safeSourcePath(value) {
  if (typeof value !== 'string' || value === '') return '';
  const path = value.startsWith('/') ? value : `/${value}`;
  const cleaned = path.split('?')[0].split('#')[0];
  return /^\/[a-z0-9\-/]*$/i.test(cleaned) && cleaned.length <= 200 ? cleaned : '';
}

/* ---------------------------------------------------------------------------
   Handler
   --------------------------------------------------------------------------- */

export async function handleSubmission(db, formType, { body, sourceUrl, recipients = [], adminUrl = '' }) {
  const validated = validateSubmission(formType, body);
  if (!validated.ok) {
    return { status: 400, body: { error: 'Some details need attention.', fieldErrors: validated.errors } };
  }

  /* A tripped honeypot gets the SAME response a real submission gets, and is
     simply not stored. Telling the sender it was detected teaches it how to
     avoid detection next time. */
  if (validated.honeypotTripped) {
    return { status: 200, body: { ok: true } };
  }

  const payload = buildPayload(formType, validated.values);
  /* Storage and the staff alert are ONE transaction. A rejected, honeypotted
     or throttled submission never reaches here, so none of them can produce a
     notification — the three cases the brief calls out, satisfied by where
     this line sits rather than by a check. */
  await storeSubmission(db, {
    formType,
    payload,
    sourceUrl: safeSourcePath(sourceUrl),
    region: typeof validated.values.country === 'string' ? validated.values.country : '',
    businessType: typeof validated.values.businessType === 'string' ? validated.values.businessType : '',
    consentGiven: validated.consentGiven,
  }, { recipients, adminUrl });

  /* Generic and identical for every form. No id, no echo of the submitted
     values, nothing that varies with what was sent. */
  return { status: 200, body: { ok: true } };
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();
r.use(express.json({ limit: BODY_LIMIT }));

for (const formType of FORM_TYPES) {
  r.post(`/${formType}`, async (req, res) => {
    const key = String(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
    if (throttled(key)) {
      return res.status(429).json({ error: 'Too many enquiries from this connection. Please try again shortly.' });
    }
    try {
      const result = await handleSubmission(liveDb, formType, {
        body: req.body,
        sourceUrl: req.body?.sourceUrl ?? req.get('referer') ?? '',
        recipients: enquiryAlertRecipients(),
        adminUrl: adminLink('/#/enquiries'),
      });
      return res.status(result.status).json(result.body);
    } catch (e) {
      /* Form type and error only. Never the payload, never the body, never a
         field value — an enquiry is private to the person who wrote it. */
      console.error('[public-forms] submission failed', formType, e.message);
      return res.status(500).json({ error: 'We could not record your enquiry. Please try again shortly.' });
    }
  });
}

/* A definition endpoint so a renderer never hard-codes a second copy of the
   field list. Read-only and free of any submitted data. */
r.get('/definitions/:formType', (req, res) => {
  if (!formDefinition(req.params.formType)) return res.status(404).json({ error: 'Unknown form.' });
  return res.json({ formType: req.params.formType, consentVersion: CONSENT_VERSION });
});

export default r;
