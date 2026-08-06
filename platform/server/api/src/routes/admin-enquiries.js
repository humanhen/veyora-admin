/* Governed enquiry operations API (Fast-Track WS2 Phase 2).

   Mounted at /admin/enquiries, BEFORE the general /admin router, so this
   router's own capability gate is the one that runs. The general router admits
   several roles for operational work; none of them has any business reading a
   member of the public's contact details, and letting the broader role check
   run first would mean exactly that.

   AUTHORITY

   Two new capabilities, and no reuse of any existing one:

     - `enquiries.view`   — read submissions
     - `enquiries.manage` — record how one is being handled

   `public_content.*` is deliberately NOT accepted here. Publishing brand copy
   and reading somebody's name, email address and message are different
   authorities held by different people; granting the first must not silently
   confer the second. There is no role fallback and no wildcard — an `admin`
   role alone satisfies nothing on this router, and neither capability is
   granted by any migration.

   WHAT THIS API CANNOT DO

     - It cannot delete a submission. There is no DELETE route, no DELETE
       statement, and no 'deleted' handling status. A submission is closed or
       marked spam; erasure is a retention matter with its own deliberate
       process, not a button.
     - It cannot edit what was submitted. `payload`, `consent_at`,
       `consent_version`, `form_type`, `source_url`, `region` and
       `business_type` are never written here. The only columns this router
       writes are the four handling columns 0009 added.
     - It cannot edit or re-send a delivered message. It CAN re-queue a failed
       staff notification (`POST /:id/notifications/:notificationId/retry`),
       which is gated on `enquiries.manage` because asking the platform to
       send another email is an action, not a read. `delivery_state` on the
       submission itself is still neither read out nor written.

   Nothing here logs a field value. Failures record the submission id and the
   error, never the content. */

import { Router } from 'express';
import { pool, tx as realTx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { requirePermission, getUserPermissions } from '../permissions.js';
import {
  DEFAULT_RETENTION_DAYS,
  HANDLING_STATUSES,
  ENQUIRY_OPERATIONS_CONTRACT,
  allowedTransitions,
  canTransition,
  cleanNote,
  isHandlingStatus,
  makeEnquiryToken,
  parseFormTypeFilter,
  parsePaging,
  parseStatusFilter,
  serializeEnquiryDetail,
  serializeEnquirySummary,
} from '../enquiry-operations.js';
import { findBySource, getById, requeue, serializeNotification } from '../notifications/outbox.js';

/** The capability required by each group of routes. Exported so tests and the
 *  documentation assert against one definition rather than a second copy. */
export const ENQUIRY_CAPABILITIES = Object.freeze({
  view: 'enquiries.view',
  manage: 'enquiries.manage',
});

export class EnquiryApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

/* Explicit columns everywhere — never SELECT *. The list query deliberately
   does not read `payload`'s free text into a summary it would not serialize;
   it reads the column because the summary shows the enquirer's name, and
   PostgreSQL has no cheaper way to reach one jsonb key. delivery_state,
   attempts and last_error are absent from both lists: this API does not
   describe a delivery mechanism that is not built. */
const SUMMARY_COLUMNS = `id, form_type, payload, region, business_type,
  handling_status, handled_at, created_at`;

const DETAIL_COLUMNS = `id, form_type, payload, source_url, region, business_type,
  consent_version, consent_at, handling_status, handled_by, handled_at, handling_note,
  created_at`;

/* ---------------------------------------------------------------------------
   Capability discovery
   --------------------------------------------------------------------------- */

/* The admin panel's session carries {id, name, role} and no capabilities, so
   the browser cannot tell a viewer from a handler without asking. A 200/403
   probe on a gated route cannot distinguish them either: 200 on a read only
   ever proves `view`, and finding out about `manage` by attempting a
   transition would mean changing an enquiry to discover whether you may.

   Deliberately NOT gated on a capability: an authenticated account holding
   neither must still get an honest all-false answer, so the UI can render an
   accurate no-access state instead of a failure. It returns two booleans
   describing only the caller — no user record, no role, no other capability,
   nothing about any other account — resolved fresh on every call so a
   revocation takes effect immediately. */
export async function getEnquiryCapabilities(db, userId) {
  const held = new Set(await getUserPermissions(db, userId));
  return {
    view: held.has(ENQUIRY_CAPABILITIES.view),
    manage: held.has(ENQUIRY_CAPABILITIES.manage),
  };
}

/* ---------------------------------------------------------------------------
   Retention
   --------------------------------------------------------------------------- */

/* `forms.retention_days` is the configured period per form type. Nothing seeds
   that table today, so the lookup falls back to the module default rather than
   failing — an absent configuration row means "the default applies", not "this
   enquiry has no retention policy". */
async function retentionDaysFor(db, formType) {
  if (typeof formType !== 'string' || formType === '') return DEFAULT_RETENTION_DAYS;
  const { rows } = await db.query(
    `select retention_days from forms where type = $1 limit 1`,
    [formType]
  );
  const value = rows[0]?.retention_days;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

/**
 * One page of submissions, newest first.
 *
 * Filters are validated against closed sets before any SQL runs, so an
 * unrecognised value is a 400 rather than a silently ignored filter — a
 * filter that appears to work and does not is how a screen shows an operator
 * rows they thought they had excluded.
 */
export async function listEnquiries(db, { limit, offset, status, formType } = {}) {
  const statusFilter = parseStatusFilter(status);
  if (!statusFilter.ok) throw new EnquiryApiError(400, { error: statusFilter.error, code: 'INVALID_FILTER' });
  const formFilter = parseFormTypeFilter(formType);
  if (!formFilter.ok) throw new EnquiryApiError(400, { error: formFilter.error, code: 'INVALID_FILTER' });

  const paging = parsePaging({ limit, offset });

  /* Both filters are parameterised AND pre-validated against a closed set.
     Either alone would be enough; both is the convention this repository
     already follows on the public routes. */
  const where = [];
  const params = [];
  if (statusFilter.status) {
    params.push(statusFilter.status);
    where.push(`handling_status = $${params.length}`);
  }
  if (formFilter.formType) {
    params.push(formFilter.formType);
    where.push(`form_type = $${params.length}`);
  }
  const clause = where.length ? `where ${where.join(' and ')}` : '';

  const { rows: countRows } = await db.query(
    `select count(*)::int as total from form_submissions ${clause}`,
    params
  );

  /* `created_at desc, id desc` — the id tiebreak makes the ordering total, so
     two submissions stored in the same transaction cannot swap places between
     one page and the next and hide a row. */
  const { rows } = await db.query(
    `select ${SUMMARY_COLUMNS} from form_submissions ${clause}
      order by created_at desc, id desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, paging.limit, paging.offset]
  );

  return {
    enquiries: rows.map(serializeEnquirySummary),
    total: countRows[0]?.total ?? 0,
    limit: paging.limit,
    offset: paging.offset,
    /* The screen renders its filters and its buttons from this, so there is
       never a second copy of the state machine in a browser to drift. */
    statuses: [...HANDLING_STATUSES],
  };
}

export async function getEnquiry(db, id, { now = new Date() } = {}) {
  const { rows } = await db.query(
    `select ${DETAIL_COLUMNS} from form_submissions where id = $1 limit 1`,
    [id]
  );
  const row = rows[0];
  if (!row) throw new EnquiryApiError(404, { error: 'Enquiry not found' });
  const retentionDays = await retentionDaysFor(db, row.form_type);
  const detail = serializeEnquiryDetail(row, { retentionDays, now });

  /* Delivery visibility (findings ENQ-006 / NOT-006). Staff need to know
     whether anyone was actually told, so the notification attempts for this
     submission are attached — through the outbox's own serializer, which
     masks the recipient and never returns template data. An empty list means
     no alert was queued at all: no recipient is configured. */
  const notifications = await findBySource(db, 'form_submission', id);
  detail.delivery = {
    configured: notifications.length > 0,
    notifications: notifications.map(serializeNotification),
  };
  return detail;
}

/**
 * Re-queues a failed notification.
 *
 * Deliberately gated on `enquiries.manage`, not `enquiries.view`: asking the
 * platform to send another email is an action, not a read.
 */
export async function retryEnquiryNotification(db, enquiryId, notificationId, actor, { now = new Date() } = {}) {
  const notification = await getById(db, notificationId);
  /* The notification must belong to THIS enquiry. Without this check the id
     alone would let a holder of enquiries.manage re-send any notification in
     the system, including a statement to a customer. */
  if (!notification || notification.source_type !== 'form_submission' || notification.source_id !== enquiryId) {
    throw new EnquiryApiError(404, { error: 'Notification not found for this enquiry' });
  }
  const requeued = await requeue(db, notificationId, { now });
  if (!requeued) {
    throw new EnquiryApiError(409, {
      error: 'That notification is not in a state that can be retried.',
      code: 'NOT_RETRYABLE',
    });
  }

  await audit(
    { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
    'enquiry.notification.retry',
    `enquiry:${enquiryId}`,
    `notification ${notificationId} requeued`
  ).catch(() => {});

  return serializeNotification(requeued);
}

/* ---------------------------------------------------------------------------
   Transition — transactional, audited, concurrency-checked
   --------------------------------------------------------------------------- */

/**
 * Records a handling decision.
 *
 * @param actor the AUTHENTICATED user. Attribution comes only from here —
 *   `handled_by` is never read from the request body, so an operator cannot
 *   record a transition as somebody else.
 */
export async function transitionEnquiry(db, id, { toStatus, token, note, actor, now = new Date() }) {
  if (!isHandlingStatus(toStatus)) {
    throw new EnquiryApiError(400, {
      error: 'Unknown handling status.',
      code: 'UNKNOWN_STATUS',
      allowed: [...HANDLING_STATUSES],
    });
  }

  const cleanedNote = cleanNote(note);
  if (cleanedNote === null) {
    throw new EnquiryApiError(400, {
      error: 'A handling note must be text of 2000 characters or fewer.',
      code: 'INVALID_NOTE',
    });
  }

  const result = await db.tx(async (c) => {
    /* Locked for the transaction. The token check below stops a lost update
       (an operator overwriting a decision they never saw); the lock stops two
       transactions interleaving and both believing they won. */
    const { rows } = await c.query(
      `select ${DETAIL_COLUMNS} from form_submissions where id = $1 limit 1 for update`,
      [id]
    );
    const row = rows[0];
    if (!row) throw new EnquiryApiError(404, { error: 'Enquiry not found' });

    if (token !== makeEnquiryToken(row)) {
      // Throwing rolls back, so a stale attempt writes nothing.
      throw new EnquiryApiError(409, {
        error: 'This enquiry changed since you loaded it. Reload and reapply your change.',
        code: 'STALE_TOKEN',
      });
    }

    const from = row.handling_status;
    if (!canTransition(from, toStatus)) {
      throw new EnquiryApiError(422, {
        error: `An enquiry that is "${from}" cannot be moved to "${toStatus}".`,
        code: 'ILLEGAL_TRANSITION',
        from,
        allowed: allowedTransitions(from),
      });
    }

    /* The ONLY write in this router, and it names four columns. Nothing the
       enquirer submitted appears on either side of the SET. The WHERE repeats
       the expected current status so the transition is checked once more by
       the database itself — belt and braces behind the row lock. */
    const { rows: updated } = await c.query(
      `update form_submissions
          set handling_status = $2,
              handled_by      = $3,
              handled_at      = now(),
              handling_note   = $4
        where id = $1 and handling_status = $5
        returning ${DETAIL_COLUMNS}`,
      [id, toStatus, actor?.id ?? null, cleanedNote, from]
    );
    if (!updated[0]) {
      throw new EnquiryApiError(409, {
        error: 'This enquiry changed since you loaded it. Reload and reapply your change.',
        code: 'STALE_TOKEN',
      });
    }

    return { row: updated[0], from, to: toStatus };
  });

  const retentionDays = await retentionDaysFor(db, result.row.form_type);

  /* Audited after commit, so the log cannot claim a transition that rolled
     back. The entry records the states and the actor — never the enquirer's
     details, and never the note, which may quote them. */
  await audit(
    { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
    'enquiry.transition',
    `enquiry:${id}`,
    `${result.from} -> ${result.to}`
  ).catch(() => {});

  return serializeEnquiryDetail(result.row, { retentionDays, now });
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();

/* Authentication once for the whole router; capability per route below.
   `requireAuth()` takes no role arguments deliberately — the authority here is
   the capability, not the role, so an admin without a grant is refused and a
   non-admin with one is allowed. */
r.use(requireAuth());

const canView = () => requirePermission(ENQUIRY_CAPABILITIES.view);
const canManage = () => requirePermission(ENQUIRY_CAPABILITIES.manage);

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof EnquiryApiError) return res.status(err.status).json(err.body);
      next(err);
    });
}

// ---- capability discovery (authenticated, ungated — see above) ----
r.get('/capabilities', (req, res, next) =>
  send(res, next, getEnquiryCapabilities(liveDb, req.user?.id), (capabilities) => ({
    capabilities,
    contract: ENQUIRY_OPERATIONS_CONTRACT,
  }))
);

// ---- reads ----
r.get('/', canView(), (req, res, next) =>
  send(
    res,
    next,
    listEnquiries(liveDb, {
      limit: req.query.limit,
      offset: req.query.offset,
      status: typeof req.query.status === 'string' ? req.query.status : null,
      formType: typeof req.query.formType === 'string' ? req.query.formType : null,
    })
  )
);

r.get('/:id', canView(), (req, res, next) =>
  send(res, next, getEnquiry(liveDb, req.params.id), (enquiry) => ({ enquiry }))
);

// ---- handling decision ----
r.post('/:id/status', canManage(), (req, res, next) =>
  send(
    res,
    next,
    transitionEnquiry(liveDb, req.params.id, {
      toStatus: req.body?.status,
      token: req.body?.concurrencyToken,
      note: req.body?.note,
      actor: req.user, // authenticated context only — never req.body
    }),
    (enquiry) => ({ enquiry })
  )
);

/* Re-queue a failed staff alert. `canManage()` because sending another email
   is an action; and the handler additionally checks the notification belongs
   to THIS enquiry, so the id alone cannot reach an unrelated one. */
r.post('/:id/notifications/:notificationId/retry', canManage(), (req, res, next) =>
  send(
    res,
    next,
    retryEnquiryNotification(liveDb, req.params.id, req.params.notificationId, req.user),
    (notification) => ({ notification })
  )
);

/* No DELETE route, deliberately. A submission is closed or marked spam, never
   erased on an operator's say-so — see the header. */

export default r;
