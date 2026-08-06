/* Runtime feature configuration, read from the environment.

   Everything here is read at CALL time (not at import time) so a value can be
   changed per-process without reloading modules — which also makes the
   behaviour testable without a running server. */

/** Parse a boolean-ish env var. Unset / empty / unrecognised → `fallback`. */
function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'y'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(v)) return false;
  return fallback;
}

/* Customers may order what is not in stock; the shortfall becomes a backorder.
   This is the documented Monday-release behaviour, so the default is TRUE and
   an unset variable keeps the platform working as the business expects.
   Set ALLOW_CUSTOMER_BACKORDERS=false to restrict ordering to available stock
   (the backorder machinery stays in place — it simply stops being reachable
   from a customer checkout). */
export function allowCustomerBackorders() {
  return envFlag('ALLOW_CUSTOMER_BACKORDERS', true);
}

/* Addresses shipped in .env.example as illustrations. If one of these is still
   in the live configuration nobody has set a real recipient yet, so we skip
   sending rather than mailing a placeholder domain. */
const PLACEHOLDER_RECIPIENTS = new Set(['orders@example.com']);

const EMAIL_RE = /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/;

/** Staff who get a new-order / new-backorder alert. Empty array = feature off. */
export function orderAlertRecipients() {
  return recipientList(process.env.ORDER_ALERT_EMAILS);
}

/** Staff who are told a public enquiry arrived (findings ENQ-006 / NOT-006).
 *
 *  Falls back to ORDER_ALERT_EMAILS so an existing deployment gets enquiry
 *  alerts the moment this ships rather than only after somebody notices a new
 *  variable — an enquiry going nowhere is the exact failure this closes.
 *  Configuring ENQUIRY_ALERT_EMAILS separately overrides it, because sales
 *  enquiries and fulfilment alerts usually want different inboxes.
 *
 *  An empty list means no alert is queued at all. That is a real state, shown
 *  on the enquiry screen as "not configured" — never silently swallowed. */
export function enquiryAlertRecipients() {
  const explicit = recipientList(process.env.ENQUIRY_ALERT_EMAILS);
  return explicit.length ? explicit : orderAlertRecipients();
}

/** Shared parsing. The placeholder in .env.example is filtered out by name:
 *  it exists to show the format, and a deployment that never replaced it must
 *  not start emailing example.com. */
function recipientList(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => EMAIL_RE.test(s))
    .filter(s => !PLACEHOLDER_RECIPIENTS.has(s.toLowerCase()));
}

/* Notification worker tuning (Final Handover Phase 1).

   Both are BOUNDED rather than trusted. A typo that produced a 0ms interval
   would spin the claim query as fast as the database could answer it, and a
   batch size of 100000 would hold a claim on the whole table for as long as
   one slow provider took to answer. An out-of-range or unparseable value
   falls back to the default rather than failing boot: the worker running with
   sane numbers is always better than an API that will not start. */
const WORKER_BOUNDS = Object.freeze({
  intervalMs: { min: 5_000, max: 15 * 60 * 1000, fallback: 30_000 },
  batchSize: { min: 1, max: 200, fallback: 20 },
});

function boundedInt(raw, { min, max, fallback }, scale = 1) {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n)) return fallback;
  const scaled = Math.round(n * scale);
  if (scaled < min || scaled > max) return fallback;
  return scaled;
}

export function notificationWorkerSettings(env = process.env) {
  return {
    intervalMs: boundedInt(env.NOTIFICATION_POLL_SECONDS, WORKER_BOUNDS.intervalMs, 1000),
    batchSize: boundedInt(env.NOTIFICATION_BATCH_SIZE, WORKER_BOUNDS.batchSize),
  };
}

/** Feature flags safe to hand to the browser (no secrets, no addresses). */
export function publicFeatures() {
  return { allowBackorders: allowCustomerBackorders() };
}
