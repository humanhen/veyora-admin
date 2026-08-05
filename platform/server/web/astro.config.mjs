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

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: siteOrigin,
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
