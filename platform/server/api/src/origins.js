/* THE origin and cookie-security contract for the API (Security Hardening Phase 1).
 *
 * One module decides three things that were previously derived, ambiguously,
 * from a single variable named `PUBLIC_URL`:
 *
 *   1. where a portal link points,
 *   2. where an admin link points,
 *   3. whether an authentication cookie carries `Secure`.
 *
 * WHY THIS EXISTS
 *
 * `PUBLIC_URL` today means "the portal". After the catch-all cutover
 * (08_RISKS_AND_OPEN_DECISIONS.md R-01) it is the natural name for "the public
 * website". The old code read it for BOTH the links in transactional email AND
 * the `Secure` cookie flag:
 *
 *     const SECURE_COOKIES = /^https:/i.test(process.env.PUBLIC_URL || '');
 *
 * so repointing it at the public site, unsetting it, or setting it without a
 * scheme silently dropped `Secure` from both session cookies — no error, no log
 * line, no test failure. That is the defect AUTH-002 records.
 *
 * The rule this module enforces: **no security behaviour is derived from a
 * variable that also names a general-purpose link.** Cookie security comes from
 * its own explicit setting, defaulting to secure in production.
 *
 * DESIGN
 *
 * Pure and dependency-free. `resolveOrigins()` takes an environment map rather
 * than reading `process.env` itself, so every rule below is exercised in tests
 * without mutating global state — the same shape the Astro site's `env.ts`
 * already uses, deliberately, so there is one idea to learn and not two.
 *
 * FAIL CLOSED. In production a malformed origin throws at startup rather than
 * resolving to something plausible. A server that refuses to boot is a much
 * smaller problem than one that mints insecure cookies. */

/* Development defaults. Deliberately loopback, deliberately not any real
   Veyora host, so a misconfigured production deploy cannot silently fall back
   to something that looks right. */
export const DEV_DEFAULT_PORTAL_ORIGIN = 'http://localhost:8080';
export const DEV_DEFAULT_PUBLIC_SITE_ORIGIN = 'http://localhost:4321';

/** The admin panel is served from a path on the portal host today
 *  (`/admin/`, see platform/server/Caddyfile). ADMIN_ORIGIN exists so that
 *  can change to its own host without touching a line of application code. */
export const DEFAULT_ADMIN_PATH = '/admin';

export class OriginConfigError extends Error {}

/* ---------------------------------------------------------------------------
   Validation
   --------------------------------------------------------------------------- */

/**
 * Validates one origin value and returns its normalised form.
 *
 * @param allowPath when true the value may carry a path (ADMIN_ORIGIN may be
 *   `https://portal.example/admin`). Everything else must be origin-only.
 */
export function normalizeOrigin(raw, varName, { allowPath = false } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new OriginConfigError(`${varName} is required and was not set.`);
  }
  const value = raw.trim();

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OriginConfigError(`${varName} must be an absolute http(s) URL, got: "${value}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OriginConfigError(`${varName} must use http or https, got: "${value}"`);
  }

  /* Embedded credentials in a URL that ends up in an email is a credential
     leak with extra steps. Rejected outright. */
  if (url.username || url.password) {
    throw new OriginConfigError(`${varName} must not contain embedded credentials.`);
  }

  if (url.hash) {
    throw new OriginConfigError(`${varName} must not contain a fragment, got: "${value}"`);
  }
  if (url.search) {
    throw new OriginConfigError(`${varName} must not contain a query string, got: "${value}"`);
  }

  /* A wildcard is a pattern, not a host. `new URL()` accepts it happily —
     `*` is a legal hostname character to the parser — which is exactly how the
     same defect reached the Astro site's env contract and was fixed there. */
  if (url.hostname === '' || url.hostname.includes('*')) {
    throw new OriginConfigError(`${varName} must name a single concrete host, not a pattern, got: "${value}"`);
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (!allowPath && path !== '') {
    throw new OriginConfigError(`${varName} must be an origin with no path, got: "${value}"`);
  }

  return allowPath ? `${url.origin}${path}` : url.origin;
}

/** Parses an explicit boolean environment value. Anything unrecognised is an
 *  error rather than a silent false — "COOKIE_SECURE=yes" must not read as
 *  "insecure". */
function parseBool(raw, varName) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new OriginConfigError(`${varName} must be true or false, got: "${raw}"`);
}

/* ---------------------------------------------------------------------------
   Resolution
   --------------------------------------------------------------------------- */

/**
 * Resolves the complete origin and cookie-security contract.
 *
 * @param rawEnv an environment map (`process.env` in production, a literal in
 *   tests).
 * @returns {{portalOrigin, publicSiteOrigin, adminOrigin, cookieSecure,
 *            trustProxyHops, isProduction, deprecations}}
 * @throws {OriginConfigError} in production on any malformed or contradictory
 *   configuration.
 */
export function resolveOrigins(rawEnv = {}) {
  const isProduction = rawEnv.NODE_ENV === 'production';
  const deprecations = [];

  /* ---- portal origin ----
     PUBLIC_URL is accepted as a deprecated fallback so an existing deployment
     keeps working across this change: its current value IS the portal, so
     reading it here is correct today and wrong only once somebody repoints it.
     Every use of it is reported, so the deprecation is visible in the logs
     rather than discovered later. */
  let rawPortal = rawEnv.PORTAL_ORIGIN;
  if (!rawPortal && rawEnv.PUBLIC_URL) {
    rawPortal = rawEnv.PUBLIC_URL;
    deprecations.push(
      'PORTAL_ORIGIN is not set; falling back to the deprecated PUBLIC_URL. '
      + 'Set PORTAL_ORIGIN explicitly — PUBLIC_URL becomes ambiguous at the public-site cutover.'
    );
  }
  if (!rawPortal) {
    if (isProduction) {
      throw new OriginConfigError(
        'PORTAL_ORIGIN is required in production and was not set. Refusing to start.'
      );
    }
    rawPortal = DEV_DEFAULT_PORTAL_ORIGIN;
  }
  const portalOrigin = normalizeOrigin(rawPortal, 'PORTAL_ORIGIN');

  /* ---- public site origin ----
     Only ever used to link OUT to the public website. Never used for a
     security decision and never for a portal link.

     DELIBERATELY OPTIONAL, even in production. No API link points at the
     public website today — every one of them is a portal or admin
     destination — so requiring it would make an existing deployment refuse to
     start for a value it does not use. `publicSiteLink()` fails closed at the
     point of use instead, which is where the requirement actually exists. */
  const publicSiteOrigin = rawEnv.PUBLIC_SITE_ORIGIN
    ? normalizeOrigin(rawEnv.PUBLIC_SITE_ORIGIN, 'PUBLIC_SITE_ORIGIN')
    : (isProduction ? null : DEV_DEFAULT_PUBLIC_SITE_ORIGIN);

  /* ---- admin origin ----
     Defaults to the approved location: /admin on the portal host. */
  const adminOrigin = rawEnv.ADMIN_ORIGIN
    ? normalizeOrigin(rawEnv.ADMIN_ORIGIN, 'ADMIN_ORIGIN', { allowPath: true })
    : `${portalOrigin}${DEFAULT_ADMIN_PATH}`;

  /* ---- internal API origin ----
     Server-to-server only. Validated so a malformed value fails at startup,
     and asserted by test never to appear in rendered public output. */
  const internalApiOrigin = rawEnv.INTERNAL_API_ORIGIN
    ? normalizeOrigin(rawEnv.INTERNAL_API_ORIGIN, 'INTERNAL_API_ORIGIN')
    : null;

  /* ---- cookie security ----
     THE POINT OF THIS MODULE. Explicit setting first; otherwise secure in
     production, insecure only outside it. It is never derived from a link
     variable. */
  const explicitSecure = parseBool(rawEnv.COOKIE_SECURE, 'COOKIE_SECURE');
  const cookieSecure = explicitSecure === null ? isProduction : explicitSecure;

  /* A production deployment that disables Secure is almost always a mistake,
     and is refused unless the operator states plainly that it is deliberate.
     The escape hatch exists because a genuine plain-HTTP internal deployment
     is conceivable; requiring a second variable makes it a decision rather
     than an accident. */
  if (isProduction && !cookieSecure && rawEnv.ALLOW_INSECURE_COOKIES !== 'i-accept-plaintext-sessions') {
    throw new OriginConfigError(
      'COOKIE_SECURE=false in production would send session cookies over plain HTTP. '
      + 'If that is genuinely intended, also set '
      + 'ALLOW_INSECURE_COOKIES=i-accept-plaintext-sessions. Refusing to start.'
    );
  }

  /* Contradiction check: a secure cookie is only ever returned to an https
     origin, so `Secure` with an http portal means the portal session can never
     be established. Better to refuse than to ship a login that cannot work. */
  if (cookieSecure && portalOrigin.startsWith('http://') && isProduction) {
    throw new OriginConfigError(
      `COOKIE_SECURE is on but PORTAL_ORIGIN is plain http (${portalOrigin}); `
      + 'the session cookie would never be sent back. Refusing to start.'
    );
  }

  /* ---- reverse-proxy trust ----
     Express's `trust proxy` was `true`, meaning "trust every hop", which lets
     a client set X-Forwarded-For and choose its own `req.ip`. The approved
     topology has exactly one proxy (Caddy), so the default is 1 hop.
     See 26_RELEASE_DEPLOYMENT_ARCHITECTURE.md §4. */
  const rawHops = rawEnv.TRUST_PROXY_HOPS;
  let trustProxyHops = 1;
  if (rawHops !== undefined && String(rawHops).trim() !== '') {
    const n = Number(rawHops);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      throw new OriginConfigError(
        `TRUST_PROXY_HOPS must be an integer between 0 and 10, got: "${rawHops}"`
      );
    }
    trustProxyHops = n;
  }

  return Object.freeze({
    portalOrigin,
    publicSiteOrigin,
    adminOrigin,
    internalApiOrigin,
    cookieSecure,
    trustProxyHops,
    isProduction,
    deprecations: Object.freeze([...deprecations]),
  });
}

/* ---------------------------------------------------------------------------
   The live contract
   --------------------------------------------------------------------------- */

/* Evaluated once against the real environment. A configuration error throws
   here, during module load, which means the process exits before binding a
   port — the same fail-closed shape the schema check in startup.js uses. */
export const origins = resolveOrigins(process.env);

for (const message of origins.deprecations) {
  console.warn(`[origins] DEPRECATION: ${message}`);
}

/** Cookie options for every authentication cookie.
 *
 *  `sameSite: 'lax'` is the narrowest setting that still works: the portal
 *  navigates to `/#/set-password/<token>` from an email link, and `strict`
 *  would withhold the session cookie on that first cross-site navigation.
 *  `path: '/'` because the portal, the admin panel and the API all share the
 *  portal host today. No `domain` is set, so the cookie stays host-only and
 *  is never shared with a sibling subdomain. */
export const COOKIE_OPTIONS = Object.freeze({
  httpOnly: true,
  sameSite: 'lax',
  secure: origins.cookieSecure,
  path: '/',
});

/** A portal link. Password set/reset, order views, shared lists. */
export const portalLink = (path = '') => `${origins.portalOrigin}${path}`;

/** An admin-panel link. Staff-facing only; never sent to a customer. */
export const adminLink = (path = '') => `${origins.adminOrigin}${path}`;

/** A public-website link. Deliberately separate, and deliberately unused by
 *  the authentication and ordering paths — none of their links belong there.
 *
 *  Fails closed rather than returning `null/...`: if something ever does need
 *  a public-site link, the requirement should surface as a clear error naming
 *  the missing variable, not as a broken URL in a customer's email. */
export function publicSiteLink(path = '') {
  if (!origins.publicSiteOrigin) {
    throw new OriginConfigError(
      'PUBLIC_SITE_ORIGIN is not configured, so a public-website link cannot be built.'
    );
  }
  return `${origins.publicSiteOrigin}${path}`;
}
