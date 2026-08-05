// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import { resolveEnv } from './src/env.ts';

// `site` drives Astro's own absolute-URL helpers (unused in B1.1 — there is
// no sitemap or canonical builder yet). It is sourced from the same
// resolveEnv() that gates the build (scripts/validate-env.mjs, run before
// `astro build` — see package.json) and startup, rather than a second,
// separately-maintained fallback — so there is exactly one place that
// decides what a "safe" origin default is. By the time this config file
// loads during `npm run build`, validate-env.mjs has already exited the
// process on a production misconfiguration, so this call is confirmed safe;
// it is not itself the enforcement point.
const { siteOrigin } = resolveEnv(process.env);

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  site: siteOrigin,
});
