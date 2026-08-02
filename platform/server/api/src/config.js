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
  return String(process.env.ORDER_ALERT_EMAILS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => EMAIL_RE.test(s))
    .filter(s => !PLACEHOLDER_RECIPIENTS.has(s.toLowerCase()));
}

/** Feature flags safe to hand to the browser (no secrets, no addresses). */
export function publicFeatures() {
  return { allowBackorders: allowCustomerBackorders() };
}
