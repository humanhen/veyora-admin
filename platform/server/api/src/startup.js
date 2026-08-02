/* Startup sequencing — deliberately FAIL-CLOSED.

   The API used to do:
       ensureSchema().catch(log).finally(() => { app.listen(); startZoho(); })
   so a failed migration was logged and the server started anyway. /health only
   checks `select 1`, so it passed, the deploy looked successful, and the API
   served traffic against a schema it did not have — writing orders whose
   columns were missing and failing at request time instead of at boot.

   Schema readiness is a precondition for serving. If it cannot be established
   the process logs a fatal error and exits non-zero so the deploy fails loudly.

   Everything is injected so both outcomes can be tested without binding a real
   port or killing the test runner. */

/**
 * @param deps.ensureSchema  () => Promise      schema top-ups
 * @param deps.listen        (port) => Promise  begin serving
 * @param deps.startSchedule () => void         background jobs (Zoho)
 * @param deps.port          number
 * @param deps.logger        {log, error}
 * @param deps.exit          (code) => void
 * @returns { ok, listening, scheduled, error }
 */
export async function startServer({
  ensureSchema, listen, startSchedule, port = 3000,
  logger = console, exit = process.exit,
} = {}) {
  try {
    await ensureSchema();
  } catch (err) {
    // No listen, no scheduler, non-zero exit. A half-migrated API must not
    // accept traffic, and the deploy must not look healthy.
    logger.error(
      '[migrate] FATAL: schema is not ready, so the API will NOT start. ' +
      'Fix the migration and redeploy. Cause: ' + (err?.message || err),
      err?.stack || '');
    exit(1);
    return { ok: false, listening: false, scheduled: false, error: err };
  }

  await listen(port);
  logger.log(`veyora api listening on :${port}`);
  startSchedule();
  return { ok: true, listening: true, scheduled: true, error: null };
}
