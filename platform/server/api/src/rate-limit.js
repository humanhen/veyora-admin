/* Bounded authentication abuse controls (Security Hardening Phase 2).
 *
 * Findings AUTH-004 / SEC-011: the authentication endpoints had no attempt
 * counter, no lockout and no delay of any kind.
 *
 * WHAT THIS PROTECTS, AND WHY THE LIMITS DIFFER
 *
 *   /auth/login              — bcrypt makes each guess expensive, but nothing
 *                              stopped an attacker making them indefinitely.
 *   /auth/verify-*-otp       — THE SHARPEST RISK. A six-digit code is 900,000
 *                              values with a 15-minute window. Unthrottled,
 *                              that is minutes of automated requests to take
 *                              over an account through password reset. These
 *                              get the strictest limit in the file.
 *   /auth/forgot-password    — sends an email. Unthrottled it is an outbound
 *   /auth/request-*-otp        email cannon aimed at whoever the attacker
 *                              names, and a way to burn the sender's
 *                              reputation. Limited per account AND per client.
 *   /auth/set-password       — token-bound, but a token is guessable in
 *   /auth/reset-password       principle; limited per client.
 *
 * DESIGN — AN ADAPTER, DELIBERATELY
 *
 * `MemoryRateLimitStore` is an in-process fixed-window counter. That is
 * honest for the current topology (ONE api container, see
 * docker-compose.yml) and dishonest for any other, so:
 *
 *   - the storage sits behind a tiny interface (`hit`, `reset`, `size`), so
 *     replacing it with Redis or a table is one class, not a rewrite;
 *   - it is BOUNDED. Entries expire, a sweep runs on write, and a hard cap
 *     evicts the oldest rather than growing without limit. An unbounded
 *     limiter is a memory-exhaustion bug wearing a security hat;
 *   - the limitations are documented here and in 34_SECURITY_HARDENING.md §4
 *     rather than being discovered later.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - No password, token, or full email address ever enters a key or a log
 *     line. Account keys are a truncated SHA-256 of the normalised identifier,
 *     which is enough to count against and useless to read.
 *   - No account-enumeration signal. The limiter's response is identical
 *     whether or not the account exists, because it never looks.
 *   - No Redis, no new dependency, no infrastructure that was not already
 *     approved.
 */

import crypto from 'node:crypto';

/* ---------------------------------------------------------------------------
   Store
   --------------------------------------------------------------------------- */

/** Hard cap on tracked keys. Beyond this the oldest are evicted: a limiter
 *  must not become the thing that exhausts the process. 20k keys is far more
 *  than this service's legitimate traffic and costs a few megabytes. */
const MAX_TRACKED_KEYS = 20_000;

export class MemoryRateLimitStore {
  constructor({ maxKeys = MAX_TRACKED_KEYS } = {}) {
    /** key -> { count, resetAt } */
    this.entries = new Map();
    this.maxKeys = maxKeys;
  }

  /** Records one attempt. Returns the current state of the window. */
  hit(key, windowMs, now) {
    this.sweep(now);

    const existing = this.entries.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      /* Re-insert at the end so Map iteration order stays oldest-first, which
         is what makes the eviction below actually evict the oldest. */
      this.entries.delete(key);
      this.entries.set(key, fresh);
      this.evictIfNeeded();
      return fresh;
    }
    existing.count += 1;
    return existing;
  }

  /** Removes expired entries. Called on every write, so a quiet period cannot
   *  leave stale keys behind indefinitely. */
  sweep(now) {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
      /* Map preserves insertion order and entries are re-inserted on refresh,
         so the first still-live entry means everything after it is live too. */
      else break;
    }
  }

  evictIfNeeded() {
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  reset(key) {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
  }

  get size() { return this.entries.size; }
}

/* ---------------------------------------------------------------------------
   Keys
   --------------------------------------------------------------------------- */

/** A stable, non-reversible account key.
 *
 *  The normalised identifier is hashed and truncated: enough to count
 *  attempts against one account, useless as a record of who tried to log in.
 *  A limiter that stores email addresses is a PII store nobody reviewed. */
export function accountKey(identifier) {
  const normalised = String(identifier ?? '').trim().toLowerCase();
  if (!normalised) return null;
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 24);
}

/** The client identity, taken from Express's `req.ip`.
 *
 *  This is only trustworthy because `trust proxy` is now an explicit hop
 *  count (Phase 1). With the previous `true`, `req.ip` came from the
 *  left-most X-Forwarded-For entry and a client could pick its own — which
 *  would have made every limit here decorative.
 *
 *  A request with no resolvable address falls back to a single shared bucket
 *  rather than being exempt: unattributable traffic should be limited more,
 *  not less. */
export function clientKey(req) {
  const ip = req?.ip || req?.socket?.remoteAddress || '';
  return ip ? `ip:${ip}` : 'ip:unknown';
}

/* ---------------------------------------------------------------------------
   Policies
   --------------------------------------------------------------------------- */

const MINUTE = 60_000;

/** Named policies, so a route says what it is rather than carrying numbers.
 *  Every window is deliberately short enough that a locked-out legitimate
 *  user is inconvenienced for minutes, not hours. */
export const POLICIES = Object.freeze({
  /* Credential guessing. bcrypt already makes each attempt costly. */
  login: Object.freeze({ name: 'login', limit: 10, windowMs: 15 * MINUTE, perAccountLimit: 5 }),

  /* THE STRICT ONE. Six digits is 900,000 values; at 5 per 15 minutes an
     exhaustive search takes longer than the code's 15-minute lifetime by
     several orders of magnitude. */
  otpVerify: Object.freeze({ name: 'otp-verify', limit: 10, windowMs: 15 * MINUTE, perAccountLimit: 5 }),

  /* Outbound email. Limited hard per account so nobody can be mail-bombed,
     and per client so one source cannot spray many accounts. */
  otpRequest: Object.freeze({ name: 'otp-request', limit: 5, windowMs: 15 * MINUTE, perAccountLimit: 3 }),

  /* Token-bound, but a token is guessable in principle. */
  passwordSet: Object.freeze({ name: 'password-set', limit: 10, windowMs: 15 * MINUTE, perAccountLimit: null }),
});

/* ---------------------------------------------------------------------------
   Middleware
   --------------------------------------------------------------------------- */

/* One shared store for the process. Exported so tests can reset it
   deterministically rather than waiting out a window. */
export const store = new MemoryRateLimitStore();

/** Clears all limiter state. Tests only. */
export function resetRateLimits() { store.reset(); }

/**
 * Builds a rate-limiting middleware for one policy.
 *
 * @param policy one of POLICIES.
 * @param identify optional `(req) => string | null` returning the account
 *   identifier to limit on, in addition to the client address.
 * @param deps injectable clock and store, for tests.
 */
export function rateLimit(policy, { identify = null, now = () => Date.now(), limiterStore = store } = {}) {
  return (req, res, next) => {
    const at = now();
    const buckets = [];

    buckets.push({ key: `${policy.name}:${clientKey(req)}`, limit: policy.limit });

    if (identify && policy.perAccountLimit) {
      const account = accountKey(identify(req));
      /* An absent identifier is NOT an exemption — the client bucket above
         still applies. It simply means there is no account to count against. */
      if (account) {
        buckets.push({ key: `${policy.name}:acct:${account}`, limit: policy.perAccountLimit });
      }
    }

    let worst = null;
    for (const bucket of buckets) {
      const entry = limiterStore.hit(bucket.key, policy.windowMs, at);
      if (entry.count > bucket.limit) {
        if (!worst || entry.resetAt > worst.resetAt) worst = entry;
      }
    }

    if (worst) {
      const retryAfter = Math.max(1, Math.ceil((worst.resetAt - at) / 1000));
      res.set('Retry-After', String(retryAfter));
      /* Deliberately identical for every policy and every account state. A
         different message, status or timing for "this account exists" would
         reintroduce the enumeration signal the endpoints avoid elsewhere.
         Nothing about the account is logged or returned. */
      return res.status(429).json({
        error: 'Too many attempts. Please try again shortly.',
        retryAfter,
      });
    }

    return next();
  };
}

/** The contract, exported for tests and documentation. */
export const RATE_LIMIT_CONTRACT = Object.freeze({
  policies: Object.fromEntries(
    Object.entries(POLICIES).map(([k, v]) => [k, { ...v }])
  ),
  maxTrackedKeys: MAX_TRACKED_KEYS,
  storage: 'in-process fixed window; single-container topology only',
});
