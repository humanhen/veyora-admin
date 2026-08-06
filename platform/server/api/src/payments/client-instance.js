/* The process-wide Stripe client (Final Handover, Phase 3).
 *
 * One place decides whether a real client or the refusing disabled one is in
 * use, and it is LAZY: an API with no Stripe configuration never constructs
 * the SDK, never reads a key, and never opens a connection.
 *
 * The SDK is imported dynamically for the same reason. A static
 * `import Stripe from 'stripe'` would load 16 MB of module graph into every
 * process — including every test run and the migration CLI — to support a
 * feature that is switched off by default.
 *
 * Kept separate from `stripe-client.js` so that module stays pure and testable:
 * everything with a global, a cache or a dynamic import lives here.
 */

import { stripeConfig } from './stripe-config.js';
import { createDisabledStripeClient, createStripeClient } from './stripe-client.js';

let instance = null;
let loading = null;

/**
 * The client for this process.
 *
 * Synchronous by design — routes call it inline. When Stripe is enabled the
 * real client is built on the first `initStripeClient()` call at startup; if
 * that has not happened yet, the disabled client is returned, which REFUSES
 * rather than silently doing nothing. A refusal during a startup window is a
 * clear error; a pretend success is not.
 */
export function getStripeClient() {
  if (instance) return instance;
  const config = stripeConfig();
  if (!config.enabled) {
    instance = createDisabledStripeClient(config.disabledReason);
    return instance;
  }
  return createDisabledStripeClient('The payment provider is still starting up. Try again in a moment.');
}

/**
 * Loads the SDK and builds the real client. Called once at startup.
 *
 * Returns the disabled client when Stripe is off, and — deliberately — when
 * the SDK cannot be loaded. A missing dependency must not stop an API whose
 * primary flow is B2B ordering on account terms from booting; it must make
 * payment unavailable and say so.
 */
export async function initStripeClient({ config = stripeConfig(), load = null } = {}) {
  if (!config.enabled) {
    instance = createDisabledStripeClient(config.disabledReason);
    return instance;
  }
  if (loading) return loading;
  loading = (async () => {
    try {
      const mod = load ? await load() : await import('stripe');
      const StripeCtor = mod.default || mod.Stripe || mod;
      instance = createStripeClient(config, StripeCtor);
      return instance;
    } catch (err) {
      instance = createDisabledStripeClient(
        'The payment provider library could not be loaded, so online payment is unavailable.'
      );
      return instance;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Test-only: replace or forget the client. */
export function setStripeClient(client) { instance = client; }
export function resetStripeClient() { instance = null; loading = null; }
