/* Side-effect-only module: sets the environment variables that some src
   modules require at import time, for tests that need to import them.

   Why this exists as its own module rather than an assignment at the top of
   a test file: ESM hoists imports and evaluates them before any top-level
   statement, so `process.env.X = ...` in a test file runs too late. ESM
   *does* evaluate imports in source order, so importing this first — before
   any `../src/...` import — reliably sets the variable in time.

   (Top-level `await import()` also works around the ordering, but breaks
   node:test: tests registered after a top-level await are cancelled with
   "Promise resolution is still pending but the event loop has already
   resolved".)

   This does NOT weaken the production fail-closed check in authmw.js —
   that check is exactly right and stays. Nothing here signs or verifies a
   token; the value only has to be present so the module can load. */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-used-for-signing';
