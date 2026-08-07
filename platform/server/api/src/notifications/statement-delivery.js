/* Statement delivery wiring (Final Handover, Phase 6).
 *
 * The two hooks that join the notification worker to account statements,
 * deliberately kept OUT of `worker.js`: the worker should know about queues
 * and adapters, not about PDFs and balances.
 *
 *   `statementAttachmentResolver` — regenerates the statement PDF at send
 *     time, so nothing binary is ever stored.
 *   `markStatementSentOnDelivery`  — the ONLY path by which a statement's
 *     status becomes 'sent'.
 *
 * WHY THE PDF IS REGENERATED RATHER THAN STORED
 *
 * A stored blob would be a second copy of a customer's full financial history,
 * in a table nobody remembers to include in a retention policy. Regenerating
 * from the recorded inputs keeps one copy of the truth, and means a corrected
 * brand configuration improves every historical statement rather than none.
 *
 * The trade-off is honest and worth stating: a statement re-sent after the
 * underlying ledger changed would carry the corrected figures rather than the
 * originals. That is the right behaviour for a supplier statement — it is a
 * current view of an account, not an immutable demand like an invoice — and
 * the period, currency, opening and closing balances AS SENT are recorded on
 * the statement row either way, so a discrepancy is always discoverable.
 */

import { renderStatementPdf } from '../documents/statement-pdf.js';
import { statementFilename } from '../documents/statement.js';

/**
 * Builds the attachment for one queued notification.
 *
 * Returns `[]` for anything that is not a statement — the worker calls this
 * for every notification, and an enquiry alert has no attachment.
 *
 * THROWS on a statement it cannot rebuild. The worker treats that as a
 * RETRYABLE failure: a statement email with no statement attached would be
 * worse than one that arrives a few minutes late.
 */
export function statementAttachmentResolver({ db, buildStatementFor, brand = null }) {
  return async function resolve(row) {
    if (row.source_type !== 'account_statement') return [];

    const { rows } = await db.query(
      `select id, customer_id, period_from, period_to, currency, generated_at
         from account_statements where id = $1 limit 1`,
      [row.source_id]
    );
    const statementRow = rows[0];
    if (!statementRow) {
      throw new Error(`no account_statement row for notification source ${row.source_id}`);
    }

    const { rows: customers } = await db.query(
      `select customer_number from users where id = $1 limit 1`, [statementRow.customer_id]);

    const statement = await buildStatementFor(db, statementRow.customer_id, {
      from: String(statementRow.period_from).slice(0, 10),
      to: String(statementRow.period_to).slice(0, 10),
      currency: statementRow.currency,
      /* The generation time AS RECORDED, not now(): the document a customer
         receives should carry the moment the statement was produced. */
      generatedAt: statementRow.generated_at instanceof Date
        ? statementRow.generated_at : new Date(statementRow.generated_at),
      brand,
    });

    return [{
      filename: statementFilename(
        customers[0]?.customer_number,
        String(statementRow.period_from).slice(0, 10),
        String(statementRow.period_to).slice(0, 10)
      ),
      content: await renderStatementPdf(statement),
      contentType: 'application/pdf',
    }];
  };
}

/**
 * Records a confirmed delivery against the statement.
 *
 * The `where status = 'queued'` clause makes this idempotent and safe against
 * an out-of-order or duplicated confirmation: a statement already marked sent
 * stays as it was, with its original timestamp.
 */
export function markStatementSentOnDelivery({ db }) {
  return async function onDelivered(row, providerReference, now) {
    if (row.source_type !== 'account_statement') return;
    await db.query(
      `update account_statements
          set status = 'sent', sent_at = $2, last_error = ''
        where id = $1 and status = 'queued'`,
      [row.source_id, now]
    );
  };
}

/**
 * Records a terminal failure against the statement, so the screen can show it.
 *
 * Called from reconciliation rather than from the worker's hot path: a
 * statement whose notification exhausted its retries is a thing a person needs
 * to see, and the outbox already holds the reason.
 */
export async function syncFailedStatements(db, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `update account_statements s
        set status = 'failed', last_error = n.last_error
       from notification_outbox n
      where n.id = s.notification_id
        and n.status = 'failed'
        and s.status = 'queued'
      returning s.id`
  ).catch(() => ({ rows: [] }));
  return { failed: rows.length };
}
