/* The one gate both the build and the standalone server run through before
   doing anything else. Run as a separate process ahead of `astro build` and
   ahead of `node dist/server/entry.mjs` (see package.json "build"/"start"
   and the Dockerfile CMD), so a rejection here means the following command
   never runs at all — no half-finished build output, no bound port.

   This deliberately has no logic of its own: it imports the same
   resolveEnv() that src/env.ts already exports and that test/env.test.ts
   already exercises. One validator, reused at every gate — a build-only or
   startup-only reimplementation is exactly the divergence this file exists
   to avoid. */
try {
  // Dynamic import, not a static one: src/env.ts also eagerly evaluates
  // resolveEnv() at its own top level (its `export const env`), and a
  // static `import ... from` runs before this file's own body — including
  // this try block — so a rejection would surface as a raw, uncaught stack
  // trace instead of the clear message below. A dynamic import's rejection
  // is a normal promise rejection, so it lands in this catch like any
  // other error.
  const { resolveEnv } = await import('../src/env.ts');
  resolveEnv(process.env);
} catch (err) {
  console.error(`[env] FATAL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
