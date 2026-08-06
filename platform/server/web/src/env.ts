/* The public-site environment contract — deliberately FAIL-CLOSED in production.

   PUBLIC_SITE_ORIGIN and PORTAL_ORIGIN determine every canonical URL, the
   B2B login link and (later) the sitemap and Organization schema. Neither
   domain is decided yet (DECISION-01 / DECISION-02 in
   docs/public-website-rebuild/08_RISKS_AND_OPEN_DECISIONS.md), so both must
   stay pure configuration with no real Veyora domain hard-coded anywhere in
   this application.

   In development, missing values fall back to documented localhost defaults
   so the app is runnable with zero setup. In production, a missing or
   malformed origin throws immediately and clearly — mirroring the API's
   fail-closed startServer() pattern (platform/server/api/src/startup.js),
   which exists precisely because a service that silently limps along on bad
   configuration is worse than one that refuses to start. */

export const DEV_DEFAULT_SITE_ORIGIN = 'http://localhost:4321';
export const DEV_DEFAULT_PORTAL_ORIGIN = 'http://localhost:4322';
/* The internal API origin the SERVER calls to reach /public/*. In the
   deployed stack this is the Docker-internal `http://api:3000`
   (04_TARGET_ARCHITECTURE.md §5.1) — never a public hostname, and never
   reachable from a browser. Locally it is the API's own dev port. */
export const DEV_DEFAULT_API_ORIGIN = 'http://localhost:3000';

export interface PublicEnv {
  siteOrigin: string;
  portalOrigin: string;
  /* SERVER-SIDE ONLY. Deliberately NOT named with Astro's `PUBLIC_` client
     -exposure prefix semantics in mind: Astro only inlines `import.meta.env.
     PUBLIC_*` into client bundles, and nothing in this application reads
     this value through `import.meta.env` — it is read from `process.env`
     here, in a module only ever imported by server-side code (src/lib/
     public-api.ts, itself server-only). The name matches the one the
     architecture document already specified for the compose service, so
     operators configure one variable, not two. */
  apiOrigin: string;
  nodeEnv: string;
}

/** Validates and normalises a single origin value. Throws with a message
 * that names the variable and the value, never a bare "invalid URL". */
function normalizeOrigin(raw: string, varName: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `${varName} must be an absolute http(s) URL, got: "${raw}"`
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `${varName} must use http or https, got: "${raw}"`
    );
  }
  // An origin, not a page: no path beyond "/", no query, no fragment.
  // Both "https://x.com" and "https://x.com/" are accepted and normalise to
  // the same value — this is the "trailing slashes normalised consistently"
  // requirement.
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(
      `${varName} must be an origin with no path, query or fragment, got: "${raw}"`
    );
  }
  /* A concrete host, never a pattern. `new URL()` accepts "https://*.example"
     quite happily — `*` is a legal hostname character as far as the parser is
     concerned — so nothing above catches it.
     astro.config.mjs already refused a wildcard when deriving
     security.allowedDomains, but this resolver did not, and that divergence is
     precisely what this module's header says must not exist: the config guard
     runs at BUILD time, so a container starting from an already-built image
     with a wildcard origin passed validation, started, and emitted canonical
     URLs and sitemap entries containing a literal "*". Found by the
     env-validation gate in scripts/verify-release.mjs. */
  if (url.hostname === '' || url.hostname.includes('*')) {
    throw new Error(
      `${varName} must name a single concrete host, not a pattern, got: "${raw}"`
    );
  }
  return url.origin;
}

/** Pure resolver: given a raw environment map, returns the validated public
 * environment or throws. Takes the env as an argument (rather than reading
 * process.env internally) so it can be exercised in tests without mutating
 * global process state. */
export function resolveEnv(rawEnv: Record<string, string | undefined> = {}): PublicEnv {
  const nodeEnv = rawEnv.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const rawSite = rawEnv.PUBLIC_SITE_ORIGIN?.trim();
  const rawPortal = rawEnv.PORTAL_ORIGIN?.trim();
  const rawApi = rawEnv.PUBLIC_API_ORIGIN?.trim();

  if (isProduction && !rawSite) {
    throw new Error(
      'PUBLIC_SITE_ORIGIN is required in production and was not set. Refusing to start.'
    );
  }
  if (isProduction && !rawPortal) {
    throw new Error(
      'PORTAL_ORIGIN is required in production and was not set. Refusing to start.'
    );
  }
  if (isProduction && !rawApi) {
    throw new Error(
      'PUBLIC_API_ORIGIN is required in production and was not set. Refusing to start.'
    );
  }

  const siteOrigin = normalizeOrigin(rawSite || DEV_DEFAULT_SITE_ORIGIN, 'PUBLIC_SITE_ORIGIN');
  const portalOrigin = normalizeOrigin(rawPortal || DEV_DEFAULT_PORTAL_ORIGIN, 'PORTAL_ORIGIN');
  const apiOrigin = normalizeOrigin(rawApi || DEV_DEFAULT_API_ORIGIN, 'PUBLIC_API_ORIGIN');

  return { siteOrigin, portalOrigin, apiOrigin, nodeEnv };
}

/* Evaluated once, against the real process environment, the moment any
   module imports { env } from here. Wiring this into the server's actual
   boot sequence — so a misconfigured production container refuses to bind
   its port, the way startServer() refuses to serve on a broken schema — is
   deferred to the routing/middleware work in the next batch; that machinery
   (src/middleware.ts) is explicitly out of scope for this foundation batch.
   The contract itself is complete and fully tested here. */
export const env: PublicEnv = resolveEnv(process.env);
