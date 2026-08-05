/* Pure redirect-decision function — no Astro/request types here, so it is
   directly unit-testable and the middleware that calls it stays a thin
   wrapper. Implements only the safe B1 static layer named in the B1.3
   brief: the four specification-named legacy paths
   (05_ROUTE_TEMPLATE_MATRIX.md §6.2) and trailing-slash normalisation
   (§6.1). Database-backed redirects and product-slug mappings are B7/B2
   work and are deliberately not started here.

   Canonical-host enforcement (redirecting a non-canonical host to
   PUBLIC_SITE_ORIGIN) was explicitly optional in the B1.3 brief ("may be
   prepared") and is NOT implemented in this batch: this application is
   validated exclusively against localhost/127.0.0.1 origins today, and a
   host-enforcing redirect risks breaking that local validation the moment
   the request's Host header and the configured origin's hostname differ
   for an entirely benign reason (e.g. "localhost" vs "127.0.0.1"). Left
   for the Caddy layer (B10) or a later, carefully-tested batch. */

export interface RedirectResult {
  location: string;
  status: 301;
}

/** Exact-path legacy redirects, 05_ROUTE_TEMPLATE_MATRIX.md §6.2. Every
 * destination is a known internal path already in the route set — never a
 * user-supplied or externally-derived value. */
const KNOWN_PATH_REDIRECTS: Readonly<Record<string, string>> = {
  '/about-us/': '/why-veyora/',
  '/contact-us/': '/contact/',
  '/shop/': '/collections/',
  '/index.php': '/',
};

/** Common static-asset extensions. Anything matching this is never
 * redirected, even if it happens to share a name with a known path (there
 * is no such collision today, but the check exists so one future asset
 * cannot be silently redirected). */
const ASSET_EXTENSION = /\.(?:svg|css|js|mjs|png|jpe?g|webp|gif|ico|xml|json|txt|webmanifest|woff2?|ttf)$/i;

function withQuery(path: string, search: string): string {
  return search ? `${path}${search}` : path;
}

/** Given the incoming pathname and raw query string (including its
 * leading "?", or ""), returns the one redirect to perform, or null. Only
 * ever returns an internal, site-relative location — never an absolute
 * URL, another origin, or anything derived from request input — so this
 * cannot become an open redirect by construction. */
export function resolveRedirect(pathname: string, search: string): RedirectResult | null {
  // The health probe is operational, not a public HTML route, and must
  // never be redirected.
  if (pathname === '/healthz') return null;

  // Known legacy paths are checked before the asset-extension guard so
  // `/index.php` (which "looks like" a static asset by extension) still
  // redirects correctly.
  const knownTarget = KNOWN_PATH_REDIRECTS[pathname];
  if (knownTarget) {
    return { location: withQuery(knownTarget, search), status: 301 };
  }

  if (ASSET_EXTENSION.test(pathname)) return null;

  // Trailing-slash normalisation for public HTML routes
  // (05_ROUTE_TEMPLATE_MATRIX.md §6.1: "one form ... enforced by
  // middleware, tested in both directions"). The root path already has no
  // bare-path variant to normalise.
  if (pathname !== '/' && !pathname.endsWith('/')) {
    return { location: withQuery(`${pathname}/`, search), status: 301 };
  }

  return null;
}
