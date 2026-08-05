/* Public enquiry form submission (Fast-Track Phase 3).

   Three unauthenticated POST endpoints, mounted at /forms — a dedicated
   namespace, deliberately NOT under /public. That prefix is documented and
   tested as a read-only boundary with no write methods
   (15_B2_PUBLIC_API_CONTRACT.md), and quietly adding a POST under it would
   falsify a contract other tests depend on.

   A submission is STORED, never delivered. `delivery_state` starts 'pending'
   and stays there; email and CRM delivery are a separate operational concern
   with their own failure modes, retries and credentials, and doing them
   inline would mean a visitor's enquiry could be lost because a mail server
   was slow. Storing first and delivering later is the only ordering where a
   submission cannot vanish.

   Nothing here logs a field value. An enquiry contains a name, an email
   address and free text a person typed expecting it to reach Veyora and
   nobody else; a stack trace with the payload in it defeats that. Failures
   log the form type and the error, never the content. */

import { Router } from 'express';
import express from 'express';
import { pool } from '../db.js';
import { validateSubmission, buildPayload, FORM_TYPES, formDefinition } from '../public-forms.js';

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
 * Stores one submission.
 *
 * Every value written is either validated input or a server constant. The
 * INSERT is fully parameterised, names its columns explicitly, and returns
 * nothing — the caller has no use for the id, and not selecting it means it
 * cannot leak into a response.
 */
export async function storeSubmission(db, { formType, payload, sourceUrl, region, businessType, consentGiven }) {
  await db.query(
    `insert into form_submissions
       (form_type, payload, source_url, region, business_type, consent_version, consent_at, delivery_state)
     values ($1, $2::jsonb, $3, $4, $5, $6, $7, 'pending')`,
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
      consentGiven ? new Date() : null,
    ]
  );
}

export const CONSENT_VERSION = '2026-08-enquiry-v1';

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

export async function handleSubmission(db, formType, { body, sourceUrl }) {
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
  await storeSubmission(db, {
    formType,
    payload,
    sourceUrl: safeSourcePath(sourceUrl),
    region: typeof validated.values.country === 'string' ? validated.values.country : '',
    businessType: typeof validated.values.businessType === 'string' ? validated.values.businessType : '',
    consentGiven: validated.consentGiven,
  });

  /* Generic and identical for every form. No id, no echo of the submitted
     values, nothing that varies with what was sent. */
  return { status: 200, body: { ok: true } };
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params) };

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
