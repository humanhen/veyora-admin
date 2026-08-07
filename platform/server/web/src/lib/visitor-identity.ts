/* Who is actually asking? (Handover exhaustion, Phase 1)

   ---------------------------------------------------------------------------
   THE DEFECT THIS EXISTS TO FIX
   ---------------------------------------------------------------------------

   The public forms are submitted without JavaScript: the browser POSTs to the
   Astro page, and `enquiry-submit.ts` forwards that to the API **from the
   server**. So every enquiry reaches the API from the Astro container's own
   address, and the API's per-IP throttle — correct in itself — counted the
   whole world into ONE bucket of 8 per ten minutes.

   One visitor filling in three forms could therefore exhaust a budget shared
   by every other visitor on the site. That is an availability defect, not a
   security one, but it is ours to fix.

   ---------------------------------------------------------------------------
   WHY THIS IS NOT `Astro.clientAddress`
   ---------------------------------------------------------------------------

   Astro's node adapter derives `clientAddress` from the LEFT-MOST
   `X-Forwarded-For` entry. Caddy APPENDS the peer it observed to whatever the
   client sent, so a request arriving with a forged entry already in that
   header reaches Astro as

       X-Forwarded-For: <whatever the client invented>, <the real client>

   and the left-most entry is the value the client chose. Using it would let
   anyone mint a fresh throttle identity per request — which is precisely the
   vulnerability the API removed in the security-hardening batch when
   `trust proxy` stopped being `true` and became an explicit hop count.

   ---------------------------------------------------------------------------
   WHAT THIS DOES INSTEAD
   ---------------------------------------------------------------------------

   The same discipline, on the same reasoning: count in from the RIGHT by the
   number of proxies we actually have. With one trusted hop (Caddy), the
   right-most entry is the address Caddy itself observed, and nothing the
   client sends can displace it — any spoofed entries are pushed further left
   and ignored.

   The hop count is configuration, not a guess: `TRUST_PROXY_HOPS` is the same
   variable the API reads, so the two cannot drift apart in a deployment.

   Neither container publishes a port, so the only way in is through Caddy.
   `TRUST_PROXY_HOPS=0` is still honoured for a topology with no proxy at all,
   where the socket address is the truth and the header must be ignored
   entirely. */

/** Parsed once per call — this runs on a public POST, not in a hot loop. */
function forwardedChain(headers: Headers): string[] {
  const raw = headers.get('x-forwarded-for') ?? '';
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * How many reverse proxies sit in front of the Astro server.
 *
 * Read at call time rather than at module load so a test can vary it, matching
 * how `enquiry-submit.ts` reads its own origin. Anything unparseable falls back
 * to 1 — the approved topology — rather than to 0, because treating a real
 * proxy as absent would make every visitor look like Caddy and re-create the
 * shared bucket this module exists to remove.
 */
export function trustedHops(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw === '') return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 10) return 1;
  return n;
}

/**
 * The visitor's address, as observed by the outermost hop we actually trust.
 *
 * @returns the address, or `''` when none can be established — the caller must
 *   treat that as ONE shared identity rather than as exempt. Unattributable
 *   traffic should be limited more, not less; the API's own `clientKey()` makes
 *   the same choice for the same reason.
 */
export function visitorAddress(
  request: Request,
  env: Record<string, string | undefined> = process.env
): string {
  const hops = trustedHops(env);

  /* No proxy in front of us: the header is attacker-controlled in its
     entirety and must not be consulted at all. */
  if (hops === 0) return '';

  const chain = forwardedChain(request.headers);
  if (!chain.length) return '';

  /* Count in from the right. With one hop that is the last entry — the peer
     Caddy saw. A client that sends its own X-Forwarded-For only pushes junk
     to the left of it. */
  const index = chain.length - hops;
  if (index < 0) {
    /* Fewer entries than there are trusted proxies: the request did not come
       through the topology we expect. Refuse to guess. */
    return '';
  }
  return chain[index] ?? '';
}

/**
 * A stable throttle key for a visitor.
 *
 * Deliberately NOT the raw address in the returned shape's name: this is an
 * identity for counting, and everything downstream should treat it as opaque.
 * An unresolvable visitor collapses to one shared bucket.
 */
export function visitorKey(
  request: Request,
  env: Record<string, string | undefined> = process.env
): string {
  const address = visitorAddress(request, env);
  return address ? `ip:${address}` : 'ip:unknown';
}
