/* THE Stripe configuration contract (Final Handover, Phase 3).
 *
 * Pure and dependency-free. `resolveStripeConfig()` takes an environment map
 * rather than reading `process.env`, so every rule below is exercised without
 * mutating global state — the same shape `origins.js` already uses,
 * deliberately, so there is one idea to learn and not two.
 *
 * THE THREE PROPERTIES THIS MODULE EXISTS TO GUARANTEE
 *
 *   1. THE API BOOTS WITHOUT STRIPE. Unset or `STRIPE_ENABLED=false` gives a
 *      disabled configuration, not a throw. B2B ordering on account terms is
 *      the primary flow and must never depend on a payment provider being
 *      configured. `enabled: false` is a first-class state, and every payment
 *      route refuses with a clear reason rather than a broken page.
 *
 *   2. A HALF-CONFIGURED STRIPE IS A REFUSAL, NOT A GUESS. Enabling Stripe
 *      with no webhook secret would accept unverified webhooks; with a secret
 *      key and no return URLs the customer lands nowhere. Either throws, and
 *      the resulting configuration is disabled — never partially live.
 *
 *   3. TEST AND LIVE ARE NEVER CONFUSED. The mode is derived from the key
 *      prefixes themselves (`sk_test_` / `sk_live_`), and a mismatched pair —
 *      a live secret with a test publishable key, or vice versa — throws. A
 *      deployment that believes it is in test mode while charging real cards
 *      is the single worst outcome available here.
 *
 * NOTHING IN THIS MODULE TOUCHES THE NETWORK, and no secret it holds is ever
 * returned by a route. `publicView()` is the only shape a browser may see.
 */

export class StripeConfigError extends Error {}

/** Prefixes Stripe issues. Checked structurally rather than by length, so a
 *  truncated or pasted-with-whitespace key is rejected rather than silently
 *  used until the first API call fails in production. */
const SECRET_PREFIXES = Object.freeze({ sk_test_: 'test', sk_live_: 'live', rk_test_: 'test', rk_live_: 'live' });
const PUBLISHABLE_PREFIXES = Object.freeze({ pk_test_: 'test', pk_live_: 'live' });
const WEBHOOK_PREFIX = 'whsec_';

/* Pinned deliberately. An unpinned API version means Stripe's own upgrade
   schedule can change the shape of a webhook this code parses, without a
   single line of Veyora changing. Bumping it is a reviewed change. */
export const STRIPE_API_VERSION = '2024-06-20';

/* How long a hosted payment session stays usable. Stripe's own maximum for a
   Checkout Session is 24 hours; 12 keeps a stale link from being forwarded
   around an office for a day. */
export const SESSION_TTL_MINUTES = 12 * 60;

function parseBool(raw, varName) {
  if (raw == null || String(raw).trim() === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new StripeConfigError(`${varName} must be true or false, got: "${raw}"`);
}

function modeOf(value, prefixes, varName, label) {
  const raw = String(value ?? '').trim();
  if (raw === '') throw new StripeConfigError(`${varName} is required when STRIPE_ENABLED is true.`);
  if (raw !== String(value)) {
    throw new StripeConfigError(`${varName} has leading or trailing whitespace, which is almost always a paste error.`);
  }
  for (const [prefix, mode] of Object.entries(prefixes)) {
    if (raw.startsWith(prefix)) return mode;
  }
  throw new StripeConfigError(
    `${varName} does not look like a Stripe ${label} (expected one of: ${Object.keys(prefixes).join(', ')}).`
  );
}

/** A return destination must be an absolute http(s) URL with no credentials
 *  and no fragment — the same bar `origins.js` sets, for the same reason: a
 *  value that "works" in a browser but is not a real origin is how a redirect
 *  ends up somewhere nobody intended. */
function returnUrl(value, varName, { required }) {
  const raw = String(value ?? '').trim();
  if (raw === '') {
    if (required) throw new StripeConfigError(`${varName} is required when STRIPE_ENABLED is true.`);
    return '';
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new StripeConfigError(`${varName} must be an absolute http(s) URL, got: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new StripeConfigError(`${varName} must use http or https, got: "${raw}"`);
  }
  if (url.username || url.password) {
    throw new StripeConfigError(`${varName} must not contain embedded credentials.`);
  }
  if (url.hash) {
    throw new StripeConfigError(`${varName} must not contain a fragment, got: "${raw}"`);
  }
  return url.toString();
}

/**
 * Resolves the Stripe configuration from an environment map.
 *
 * @param env the variables. Never read from `process.env` here.
 * @param isProduction whether this is a production deployment, which is the
 *   only place live keys are tolerated.
 */
export function resolveStripeConfig(env = {}, { isProduction = false } = {}) {
  const enabledFlag = parseBool(env.STRIPE_ENABLED, 'STRIPE_ENABLED');

  /* Unset means OFF. Payments are an addition to a working platform, not a
     precondition for it, so the safe default is the one that changes nothing.
     Opting in is explicit. */
  if (enabledFlag !== true) {
    return Object.freeze({
      enabled: false,
      mode: 'disabled',
      /* Stated rather than left as an absence, so a route can tell an operator
         WHY payment is unavailable instead of failing opaquely. */
      disabledReason: enabledFlag === false
        ? 'STRIPE_ENABLED is false.'
        : 'STRIPE_ENABLED is not set, so online payment is switched off.',
      secretKey: '', webhookSecret: '', publishableKey: '',
      successUrl: '', cancelUrl: '',
      apiVersion: STRIPE_API_VERSION,
      sessionTtlMinutes: SESSION_TTL_MINUTES,
    });
  }

  const secretMode = modeOf(env.STRIPE_SECRET_KEY, SECRET_PREFIXES, 'STRIPE_SECRET_KEY', 'secret key');

  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET ?? '');
  if (webhookSecret.trim() === '') {
    /* Refused rather than defaulted to "skip verification". Without this
       secret, anything that can reach the webhook URL can tell Veyora an
       invoice was paid. */
    throw new StripeConfigError(
      'STRIPE_WEBHOOK_SECRET is required when STRIPE_ENABLED is true. Without it a webhook cannot be verified, and an unverified webhook is an unauthenticated way to mark an invoice paid.'
    );
  }
  if (!webhookSecret.startsWith(WEBHOOK_PREFIX)) {
    throw new StripeConfigError(`STRIPE_WEBHOOK_SECRET does not look like a Stripe signing secret (expected "${WEBHOOK_PREFIX}…").`);
  }

  /* Only required if actually used. The hosted-Checkout flow this phase
     implements redirects the customer to Stripe, so no publishable key is
     needed in the browser at all. It is validated if present — a key that is
     set and wrong is worse than one that is absent. */
  const publishableKey = String(env.STRIPE_PUBLISHABLE_KEY ?? '').trim();
  let publishableMode = null;
  if (publishableKey !== '') {
    publishableMode = modeOf(env.STRIPE_PUBLISHABLE_KEY, PUBLISHABLE_PREFIXES,
      'STRIPE_PUBLISHABLE_KEY', 'publishable key');
  }

  if (publishableMode && publishableMode !== secretMode) {
    throw new StripeConfigError(
      `STRIPE_SECRET_KEY is a ${secretMode}-mode key but STRIPE_PUBLISHABLE_KEY is a ${publishableMode}-mode key. A mismatched pair means one half of the integration is pointing at a different Stripe environment.`
    );
  }

  /* A live key outside production is refused. The usual way this happens is a
     staging box copied from production configuration, and the usual outcome
     is a real card being charged during a test. */
  if (secretMode === 'live' && !isProduction) {
    throw new StripeConfigError(
      'A live-mode Stripe key was supplied outside production. Use a test-mode key (sk_test_…) anywhere that is not the production deployment.'
    );
  }

  const successUrl = returnUrl(env.STRIPE_SUCCESS_URL, 'STRIPE_SUCCESS_URL', { required: true });
  const cancelUrl = returnUrl(env.STRIPE_CANCEL_URL, 'STRIPE_CANCEL_URL', { required: true });

  return Object.freeze({
    enabled: true,
    mode: secretMode,
    disabledReason: '',
    secretKey: String(env.STRIPE_SECRET_KEY),
    webhookSecret,
    publishableKey,
    successUrl,
    cancelUrl,
    apiVersion: STRIPE_API_VERSION,
    sessionTtlMinutes: SESSION_TTL_MINUTES,
  });
}

/**
 * The ONLY shape a browser may see.
 *
 * No secret key, no webhook secret, no publishable key — the hosted flow does
 * not need one in the page, so it is not sent. `mode` is included on purpose:
 * an operator looking at a test-mode deployment should be told, prominently,
 * rather than discovering it when a customer's payment never arrives.
 */
export function publicView(config) {
  return {
    enabled: config?.enabled === true,
    mode: String(config?.mode ?? 'disabled'),
    testMode: config?.mode === 'test',
    disabledReason: String(config?.disabledReason ?? ''),
  };
}

/* Resolved once at import, from the real environment. A throw here is a boot
   failure, which is the intent: a half-configured payment integration must not
   start. `STRIPE_ENABLED` unset — the current state of every deployment — takes
   the disabled branch above and cannot throw. */
let cached = null;
export function stripeConfig(env = process.env) {
  if (cached) return cached;
  cached = resolveStripeConfig(env, { isProduction: env.NODE_ENV === 'production' });
  return cached;
}

/** Test-only: forget the memoised configuration. */
export function resetStripeConfigCache() { cached = null; }
