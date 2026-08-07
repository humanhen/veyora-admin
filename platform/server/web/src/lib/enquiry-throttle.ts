/* Per-visitor throttling for the public enquiry forms.

   Enforced HERE, at the Astro boundary, because this is the only place in the
   chain that can honestly tell one visitor from another: the API is reached by
   a server-side fetch and sees the Astro container for every submission.

   THE API'S LIMITER IS NOT REPLACED. It stays exactly as it was, and remains
   correct for the other way in — `POST /api/forms/...` through Caddy reaches
   the API directly with the visitor's real address. Two limiters at two
   boundaries is defence in depth, not duplication: if this one is bypassed the
   API still refuses, and if the API is called directly it still counts per
   visitor.

   Same window and same budget as the API's, deliberately. A visitor who hits
   the limit should be told the same thing wherever they hit it, and two
   different numbers would eventually be explained by nobody.

   NOTHING HERE TOUCHES DUPLICATE PROTECTION. The server-side duplicate guard
   (`form_submissions.dedupe_fingerprint`, migration 0016) is a different
   control answering a different question — "is this the same enquiry twice?"
   rather than "is this too many enquiries?" — and lives in the API where the
   database is. A throttle refusal never reaches it, and a duplicate refusal
   never consumes throttle budget. */

import { visitorKey } from './visitor-identity.ts';

/* Mirrors platform/server/api/src/routes/public-forms.js. */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 8;
/* Bounded so a burst of unique addresses cannot grow this without limit; the
   sweep below keeps it near the number of ACTIVE visitors, not total ones. */
const SWEEP_ABOVE = 5000;

const hits = new Map<string, number[]>();

/**
 * Has this visitor exhausted their budget?
 *
 * Records the attempt when it is allowed, so callers must not call this
 * speculatively.
 */
export function throttleVisitor(
  request: Request,
  { now = Date.now(), env = process.env }: { now?: number; env?: Record<string, string | undefined> } = {}
): { throttled: boolean; key: string } {
  const key = visitorKey(request, env);

  /* Opportunistic sweep, matching the API's approach: this map only grows
     while traffic does, and a public form endpoint sees little of it. */
  if (hits.size > SWEEP_ABOVE) {
    for (const [k, times] of hits) {
      const kept = times.filter((t) => now - t < WINDOW_MS);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }

  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    /* Rewritten so the pruned list is kept: a visitor who stops for the window
       recovers, rather than staying blocked by timestamps nobody removed. */
    hits.set(key, recent);
    return { throttled: true, key };
  }
  recent.push(now);
  hits.set(key, recent);
  return { throttled: false, key };
}

export const ENQUIRY_THROTTLE = Object.freeze({ WINDOW_MS, MAX_PER_WINDOW });

export function _resetEnquiryThrottleForTesting(): void {
  hits.clear();
}
