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
  // The full route set uses trailing slashes throughout
  // (05_ROUTE_TEMPLATE_MATRIX.md §6.1: "one form, enforced ... tested in
  // both directions"). This makes Astro's own link/route handling agree
  // with that convention; the redirect middleware that enforces it for
  // arbitrary incoming requests is B1's WP-05, not yet built.
  trailingSlash: 'always',
});
