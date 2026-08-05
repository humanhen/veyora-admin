/* Legacy portal continuity — the ONE decision function behind the bridge
   script Base.astro loads on every page (see B1.3's "Programme correction
   — legacy hash bridge location" in 04_TARGET_ARCHITECTURE.md,
   05_ROUTE_TEMPLATE_MATRIX.md and 08_RISKS_AND_OPEN_DECISIONS.md).

   Why this exists at all: a URL like `{ORIGIN}/#/login` sends only `/` to
   the server — the fragment after `#` is never transmitted, so no
   server-side redirect (middleware, Caddy) can ever see it or act on it.
   The only place that can read `location.hash` is the browser, after the
   page has already loaded. Placing this on the 404 page alone (the
   original plan) misses every root-level fragment URL, since `/` is a
   real, 200-status route — it never reaches 404.

   Security model: strict allowlist, no decoding, no case-folding.
   - Only a hash beginning with the EXACT two characters "#/" is
     considered at all.
   - The first path segment after that is compared for EXACT, literal,
     case-sensitive equality against a fixed allowlist. Nothing is
     percent-decoded and nothing is lower-cased first — an encoded or
     mixed-case attempt (e.g. "#/LOGIN", "#/%6c%6fgin") simply fails the
     equality check and is left alone. This is deliberately the *safest*
     possible implementation, not a lenient one: matching more leniently
     would require decode-then-compare logic, which is exactly the kind of
     "brittle trick" the B1.3 brief says to avoid, and every extra
     transform is another chance to accidentally admit a bypass.
   - The destination is always `portalOrigin + hash` verbatim — the
     validated fragment is preserved exactly, never rebuilt or
     reformatted, so a legitimate token/slug deeper in the path (e.g.
     "#/set-password/<token>") survives untouched.
   - portalOrigin is never a user-supplied value; it comes only from the
     server-validated environment contract (src/env.ts), rendered into the
     page once and read back by the script — never taken from the URL,
     a query string, or any other user-controlled input. */

export const LEGACY_HASH_ALLOWED_PREFIXES: readonly string[] = [
  'products',
  'login',
  'set-password',
  'list',
  'cart',
  'orders',
  'dashboard',
  'account',
  'backorders',
  'returns',
  'favourites',
  'replenishment',
  'spare-parts',
  'customers',
  'lists',
  'home',
];

/** Given the browser's current `location.hash` and the server-validated
 * PORTAL_ORIGIN, returns the exact destination to redirect to, or null to
 * do nothing. Pure and framework-free so it can run identically in a
 * Node test and in the bundled browser script. */
export function resolveLegacyHashRedirect(
  hash: string,
  portalOrigin: string | undefined | null,
  allowedPrefixes: readonly string[] = LEGACY_HASH_ALLOWED_PREFIXES
): string | null {
  if (!portalOrigin) return null;
  if (hash.slice(0, 2) !== '#/') return null;

  const rest = hash.slice(2);
  const firstSegment = rest.split('/')[0];

  if (!allowedPrefixes.includes(firstSegment)) return null;

  return portalOrigin + hash;
}
