/* Post-commit side effects.

   Once an order or backorder transaction has COMMITTED, the business fact
   exists. Everything that follows — audit rows, customer email, staff alert,
   Zoho dispatch, cache invalidation — is best-effort bookkeeping. None of it
   may turn a committed order into an apparent failure, because the customer
   would then retry and place the order twice.

   This is deliberately NOT a general error suppressor. Use it only after a
   commit. Anything before the commit must still fail normally so the
   transaction rolls back. */

/**
 * Run post-commit work that must never surface as a request failure.
 * Never throws and never rejects: on failure it logs with enough context to
 * investigate and resolves to `fallback` (default null).
 *
 * Accepts sync or async `fn`; a synchronous throw is caught too.
 *
 * @param context short description used in the log line, e.g. "audit order SO11890"
 * @param fn      the work to attempt
 * @param fallback value to resolve to if `fn` fails
 */
export async function afterCommit(context, fn, fallback = null) {
  try {
    return await fn();
  } catch (e) {
    console.error(
      `[post-commit] ${context} FAILED — the database transaction is already ` +
      `committed and stands; this side effect did not complete: ` +
      `${e?.message || e}`,
      e?.stack || '');
    return fallback;
  }
}

/**
 * Fire-and-forget variant for work that should not delay the response
 * (email, Zoho). Returns nothing and can never produce an unhandled rejection.
 */
export function afterCommitDetached(context, fn) {
  // afterCommit never rejects, so this is safe without a further .catch().
  void afterCommit(context, fn);
}
