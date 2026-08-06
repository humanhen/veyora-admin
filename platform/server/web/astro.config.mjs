// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
// `site` drives Astro's own absolute-URL helpers (unused in B1.1/B1.2 —
// there is no sitemap or canonical builder yet).
//
// Deliberately does NOT import anything from ./src/env.ts. `astro build`
// runs this config through Vite, which forces its own
// process.env.NODE_ENV = 'production' while evaluating the config — even
// though env.ts's exported `resolveEnv()` itself is not called here,
// merely importing the module runs its top-level `export const env =
// resolveEnv(process.env)`, which then sees Vite's forced value instead of
// the invoking shell's real one and throws on every plain local build with
// no origins set (confirmed by testing this directly). scripts/
// validate-env.mjs runs as a plain, separate `node` process before `astro
// build` ever starts (see package.json's "build" script), is unaffected by
// Vite, and remains the actual fail-closed gate. This literal mirrors
// env.ts's DEV_DEFAULT_SITE_ORIGIN but cannot import it without re-creating
// the same hazard.
const siteOrigin = process.env.PUBLIC_SITE_ORIGIN || 'http://localhost:4321';

/* `security.allowedDomains` — required, and NOT optional hardening.
   (Fast-Track Phase 3, found while adding the first POST routes.)

   Astro's `checkOrigin` CSRF middleware rejects a form-encoded POST whose
   `Origin` header does not equal `context.url.origin`. That origin is built
   by NodeApp.createRequest() from the request's Host and `x-forwarded-*`
   headers — but ONLY after `validateHost()` checks them against
   `allowedDomains`. With the list empty, validation returns undefined for
   both the host and the forwarded protocol, and the origin falls back to
   the literal `http://localhost`.

   Behind Caddy that is fatal: a browser on https://<domain>/contact/ sends
   `Origin: https://<domain>`, Astro computes `http://localhost`, they do not
   match, and EVERY enquiry submission would answer 403. Declaring the site
   origin here is what makes the real Host and X-Forwarded-Proto trusted, so
   the computed origin matches what the browser actually sent.

   Derived from PUBLIC_SITE_ORIGIN, never hard-coded, for the same reason the
   `site` above is — and read from process.env directly rather than by
   importing ./src/env.ts, per the note above. */
/* Parsed defensively rather than trusted. `npm run build` runs
   scripts/validate-env.mjs first, which rejects a missing, malformed or
   non-http(s) PUBLIC_SITE_ORIGIN in production — but a bare `astro build`
   skips that gate, and an allowlist is the wrong thing to derive optimistically.
   Failing the build is the correct outcome: a weakened allowlist would be
   silent, and would surface later as either a broken form or a trusted host
   nobody chose. */
const siteUrl = (() => {
  let url;
  try {
    url = new URL(siteOrigin);
  } catch {
    throw new Error(`PUBLIC_SITE_ORIGIN must be an absolute http(s) URL, got: "${siteOrigin}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`PUBLIC_SITE_ORIGIN must use http or https, got: "${siteOrigin}"`);
  }
  if (url.hostname === '' || url.hostname === '*' || url.hostname.includes('*')) {
    throw new Error(`PUBLIC_SITE_ORIGIN must name an exact host, got: "${siteOrigin}"`);
  }
  return url;
})();

const { hostname: siteHostname, protocol: siteProtocol, port: sitePort } = siteUrl;

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: siteOrigin,
  security: {
    allowedDomains: [
      {
        hostname: siteHostname,
        protocol: siteProtocol.replace(':', ''),
        ...(sitePort ? { port: sitePort } : {}),
      },
    ],
  },
  // Deliberately left at Astro's default ('ignore'), NOT 'always'.
  // B1.2 set this to 'always' with the trailing-slash redirect itself
  // deferred to "B1's WP-05, not yet built" — now that WP-05 IS built
  // (src/middleware.ts + src/lib/redirects.ts, B1.3), 'always' turned out
  // to be actively harmful: Astro enforces it for EVERY route including
  // `/healthz`, which has no trailing slash by design and must never
  // redirect (confirmed by testing directly — `/healthz` was returning
  // 301 Location: /healthz/, breaking the B1.1 health-check contract,
  // even though src/lib/redirects.ts explicitly excludes it). The
  // middleware is now the single place trailing-slash normalisation for
  // public HTML routes happens; Astro's own routing no longer also tries
  // to enforce it.
});
