/* Governed store contact operations API (Final Handover, Phase 2).

   Mounted at /admin/customer-contacts, BEFORE the general /admin router, so
   this router's own capability gate is the one that runs. The general router
   admits several roles for operational work; a store contact is a named person
   with a mobile number and none of those roles implies authority to read one.

   AUTHORITY

   Two new capabilities, and no reuse of any existing one:

     - `customer_contacts.view`   — read the people at a customer
     - `customer_contacts.manage` — add, edit, archive, reactivate, set primary,
                                    link or unlink a portal account

   There is no role fallback and no wildcard. An `admin` role alone satisfies
   nothing on this router, and neither capability is granted by any migration.
   Being able to edit a customer's payment terms does not confer either — the
   commercial record and the people are different things, which is the whole
   point of this phase.

   WHAT THIS API CANNOT DO

     - It cannot delete a contact. There is no DELETE route and no DELETE
       statement. Archival (`is_active` false) is the only way a contact
       leaves, so an order or an audit entry naming the buyer still resolves
       to a person after that person moves on.
     - It cannot create a portal account. `portal_user_id` is set only by
       linking an account that ALREADY exists, and the link route refuses any
       account that is not an active portal user for this same customer.
     - It cannot send anything. The admin screen renders tel:, mailto: and
       WhatsApp links for a human to click; nothing here contacts anybody.
     - It cannot infer a responsibility. Every responsibility is an explicit
       choice from a closed set.
     - It cannot record consent or a marketing subscription. There is no such
       column and no such field.

   Nothing here logs a contact's name, number or address. Failures record the
   contact id and the error code. */

import { Router } from 'express';
import { pool, tx as realTx, audit } from '../db.js';
import { requireAuth } from '../authmw.js';
import { requirePermission, getUserPermissions } from '../permissions.js';
import {
  CONTACT_CONTRACT,
  makeContactToken,
  serializeContact,
  validateContactInput,
} from '../customer-contacts.js';

export const CONTACT_CAPABILITIES = Object.freeze({
  view: 'customer_contacts.view',
  manage: 'customer_contacts.manage',
});

export class ContactApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : body?.error || 'error');
    this.status = status;
    this.body = typeof body === 'string' ? { error: body } : body;
  }
}

/* Explicit columns everywhere — never SELECT *. `email_normalised` and
   `mobile_normalised` are deliberately absent: they exist for matching, and a
   screen that showed them alongside the typed values would be showing the same
   number twice with one of them subtly wrong-looking. */
const COLUMNS = `id, customer_id, first_name, last_name, job_title, responsibilities,
  mobile, office_phone, office_extension, email, preferred_contact_method,
  preferred_language, is_primary, is_active, portal_user_id, notes,
  last_verified_at, created_at, updated_at`;

/* ---------------------------------------------------------------------------
   Capability discovery
   --------------------------------------------------------------------------- */

/* Same reasoning as the enquiry router: the admin panel's session carries
   {id, name, role} and no capabilities, so the browser cannot tell a viewer
   from a manager without asking. Authenticated but ungated, so an account
   holding neither gets an honest all-false answer and can render an accurate
   no-access state. Resolved fresh on every call, so a revocation takes effect
   immediately. */
export async function getContactCapabilities(db, userId) {
  const held = new Set(await getUserPermissions(db, userId));
  return {
    view: held.has(CONTACT_CAPABILITIES.view),
    manage: held.has(CONTACT_CAPABILITIES.manage),
  };
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

async function loadCustomer(db, customerId) {
  const { rows } = await db.query(
    `select id, business, first_name, last_name, email, customer_number, role, status, agent_id
       from users where id = $1 limit 1`,
    [customerId]
  );
  const row = rows[0];
  if (!row) throw new ContactApiError(404, { error: 'Customer not found' });
  return row;
}

/* The internal Veyora sales rep assigned to this store. Read-only here, and
   returned as a NAME and a role only: it is context for whoever is looking at
   the contacts ("who at Veyora owns this store?"), not an account record. This
   router never writes `users.agent_id`. */
async function loadSalesRep(db, agentId) {
  if (!agentId) return null;
  const { rows } = await db.query(
    `select id, first_name, last_name, business, role, email
       from users where id = $1 limit 1`,
    [agentId]
  );
  const row = rows[0];
  if (!row) return null;
  const name = `${row.first_name || ''} ${row.last_name || ''}`.trim() || row.business || '';
  return { id: String(row.id), name, role: String(row.role || ''), email: String(row.email || '') };
}

/**
 * Every contact for one store.
 *
 * Ordered primary first, then active, then by surname — the order somebody
 * reading a store's contacts wants, not insertion order. `id` breaks ties so
 * the ordering is total and two rows created in the same transaction cannot
 * swap places between reads.
 */
export async function listContacts(db, customerId, { includeArchived = true } = {}) {
  const customer = await loadCustomer(db, customerId);

  const where = includeArchived ? '' : 'and is_active';
  const { rows } = await db.query(
    `select ${COLUMNS} from customer_contacts
      where customer_id = $1 ${where}
      order by is_primary desc, is_active desc, lower(last_name), lower(first_name), id`,
    [customerId]
  );

  const contacts = rows.map(serializeContact);
  return {
    customer: {
      id: String(customer.id),
      business: String(customer.business || ''),
      customerNumber: String(customer.customer_number || ''),
      status: String(customer.status || ''),
    },
    salesRep: await loadSalesRep(db, customer.agent_id),
    contacts,
    /* An explicit fact rather than something a screen infers from an empty
       array: an existing customer legitimately has no contacts yet, and that
       is a state to show plainly, not an error and not a blank panel. */
    hasPrimary: contacts.some((c) => c.isPrimary && c.isActive),
    contract: CONTACT_CONTRACT,
  };
}

export async function getContact(db, customerId, contactId) {
  const { rows } = await db.query(
    `select ${COLUMNS} from customer_contacts where id = $1 and customer_id = $2 limit 1`,
    [contactId, customerId]
  );
  if (!rows[0]) throw new ContactApiError(404, { error: 'Contact not found' });
  return serializeContact(rows[0]);
}

/* ---------------------------------------------------------------------------
   Shared helpers for the writes
   --------------------------------------------------------------------------- */

const invalid = (errors) => new ContactApiError(400, { error: 'That contact could not be saved.', code: 'INVALID_CONTACT', errors });

const stale = () => new ContactApiError(409, {
  error: 'This contact changed since you loaded it. Reload and reapply your change.',
  code: 'STALE_TOKEN',
});

/** Locks and returns the row, or throws 404. Every write goes through this, so
 *  no write can operate on a contact belonging to a different customer. */
async function lockContact(c, customerId, contactId) {
  const { rows } = await c.query(
    `select ${COLUMNS} from customer_contacts
      where id = $1 and customer_id = $2 limit 1 for update`,
    [contactId, customerId]
  );
  if (!rows[0]) throw new ContactApiError(404, { error: 'Contact not found' });
  return rows[0];
}

/* The audit text for an edit: which FIELD NAMES changed, never the values,
   which are somebody's personal details. Exported and pure so the "no value
   ever reaches the audit log" property is asserted directly rather than
   inferred from a mock — `audit()` writes through the module pool, so a test
   double never sees it. */
export const AUDITED_FIELDS = Object.freeze({
  firstName: 'first_name', lastName: 'last_name', jobTitle: 'job_title',
  mobile: 'mobile', officePhone: 'office_phone', officeExtension: 'office_extension',
  email: 'email', preferredContactMethod: 'preferred_contact_method',
  preferredLanguage: 'preferred_language', notes: 'notes',
});

export function describeUpdate(before, after) {
  const changed = [];
  for (const [key, column] of Object.entries(AUDITED_FIELDS)) {
    if (String(before?.[column] ?? '') !== String(after?.[column] ?? '')) changed.push(key);
  }
  if (String(before?.responsibilities) !== String(after?.responsibilities)) changed.push('responsibilities');
  if (before?.is_active !== after?.is_active) changed.push('isActive');
  return changed.length ? `changed: ${changed.join(', ')}` : 'no field changed';
}

/* Audited after commit, so the log cannot claim a change that rolled back. */
function record(actor, action, contactId, changes) {
  return audit(
    { id: actor?.id, name: actor?.business || actor?.email, role: actor?.role },
    action,
    `contact:${contactId}`,
    changes
  ).catch(() => {});
}

/* ---------------------------------------------------------------------------
   Create
   --------------------------------------------------------------------------- */

/**
 * Adds a contact to a store.
 *
 * `isPrimary` is accepted here because the first contact at a store almost
 * always is one, and forcing a second request to say so is friction with no
 * safety value — the same transaction demotes whoever held it, so the "one
 * active primary" rule holds either way.
 */
export async function createContact(db, customerId, body, actor) {
  const validated = validateContactInput(body, { partial: false });
  if (!validated.ok) throw invalid(validated.errors);
  const v = validated.value;
  const wantsPrimary = body?.isPrimary === true;

  if (wantsPrimary && !v.isActive) {
    throw invalid([{ field: 'isPrimary', code: 'ARCHIVED_NOT_PRIMARY',
      message: 'An archived contact cannot be the primary contact.' }]);
  }

  const row = await db.tx(async (c) => {
    await loadCustomer(c, customerId);

    if (wantsPrimary) await demoteCurrentPrimary(c, customerId);

    const { rows } = await c.query(
      `insert into customer_contacts (
         customer_id, first_name, last_name, job_title, responsibilities,
         mobile, mobile_normalised, office_phone, office_extension,
         email, email_normalised, preferred_contact_method, preferred_language,
         is_primary, is_active, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       returning ${COLUMNS}`,
      [customerId, v.firstName, v.lastName, v.jobTitle, v.responsibilities,
       v.mobile, v.mobileNormalised, v.officePhone, v.officeExtension,
       v.email, v.emailNormalised, v.preferredContactMethod, v.preferredLanguage,
       wantsPrimary, v.isActive, v.notes]
    );
    return rows[0];
  });

  /* No portal account was created, no consent was recorded and no message was
     sent. That is stated in the audit entry rather than left to be inferred,
     because "we added a contact" is exactly the kind of event somebody later
     assumes must have triggered an email. */
  await record(actor, 'contact.create', row.id,
    `added to customer ${customerId}${row.is_primary ? ' as primary' : ''}; no portal account, no consent, nothing sent`);

  return serializeContact(row);
}

/* ---------------------------------------------------------------------------
   Update
   --------------------------------------------------------------------------- */

/**
 * Edits a contact.
 *
 * Partial: a field absent from the body keeps its stored value. Validation
 * still runs over the MERGED contact, so clearing the last email while the
 * preferred method is still 'email' is refused — a field-by-field check would
 * pass it and produce a contact nobody can reach.
 *
 * `isPrimary` is NOT accepted here. Promotion is its own route with its own
 * transaction, because it changes another row.
 */
export async function updateContact(db, customerId, contactId, body, actor) {
  const token = body?.concurrencyToken;

  const result = await db.tx(async (c) => {
    const current = await lockContact(c, customerId, contactId);
    if (token !== makeContactToken(current)) throw stale();

    const existing = serializeContact(current);
    const validated = validateContactInput(body, { existing, partial: true });
    if (!validated.ok) throw invalid(validated.errors);
    const v = validated.value;

    if (current.is_primary && !v.isActive) {
      /* Refused rather than silently demoted: archiving the primary is a
         decision about who the store's main contact is, and doing it as a
         side effect of an edit would leave a store with no primary and
         nobody aware of it. */
      throw new ContactApiError(422, {
        error: 'This is the primary contact. Make another contact primary first, then archive this one.',
        code: 'PRIMARY_MUST_BE_REPLACED',
      });
    }

    const { rows } = await c.query(
      `update customer_contacts set
         first_name = $3, last_name = $4, job_title = $5, responsibilities = $6,
         mobile = $7, mobile_normalised = $8, office_phone = $9, office_extension = $10,
         email = $11, email_normalised = $12, preferred_contact_method = $13,
         preferred_language = $14, is_active = $15, notes = $16
       where id = $1 and customer_id = $2
       returning ${COLUMNS}`,
      [contactId, customerId, v.firstName, v.lastName, v.jobTitle, v.responsibilities,
       v.mobile, v.mobileNormalised, v.officePhone, v.officeExtension,
       v.email, v.emailNormalised, v.preferredContactMethod, v.preferredLanguage,
       v.isActive, v.notes]
    );
    if (!rows[0]) throw stale();

    return { row: rows[0], changes: describeUpdate(current, rows[0]) };
  });

  await record(actor, 'contact.update', contactId, result.changes);

  return serializeContact(result.row);
}

/* ---------------------------------------------------------------------------
   Primary
   --------------------------------------------------------------------------- */

/* Demotion is an UPDATE with no read first: `where is_primary and is_active`
   finds whoever holds it, if anybody does. Reading and then writing would
   leave a window in which two requests both saw no primary. The partial unique
   index is the real guarantee; this is what stops it from being hit. */
async function demoteCurrentPrimary(c, customerId, exceptId = null) {
  const params = [customerId];
  let clause = '';
  if (exceptId) { params.push(exceptId); clause = 'and id <> $2'; }
  await c.query(
    `update customer_contacts set is_primary = false
      where customer_id = $1 and is_primary ${clause}`,
    params
  );
}

/**
 * Makes one contact the store's primary.
 *
 * Idempotent by design: promoting the contact that already holds it succeeds
 * and changes nothing, so a double click is harmless.
 */
export async function makePrimary(db, customerId, contactId, body, actor) {
  const token = body?.concurrencyToken;

  const row = await db.tx(async (c) => {
    const current = await lockContact(c, customerId, contactId);
    if (token !== makeContactToken(current)) throw stale();

    if (!current.is_active) {
      throw new ContactApiError(422, {
        error: 'An archived contact cannot be made primary. Reactivate them first.',
        code: 'ARCHIVED_NOT_PRIMARY',
      });
    }
    if (current.is_primary) return current;

    await demoteCurrentPrimary(c, customerId, contactId);

    const { rows } = await c.query(
      `update customer_contacts set is_primary = true
        where id = $1 and customer_id = $2 and is_active
        returning ${COLUMNS}`,
      [contactId, customerId]
    );
    if (!rows[0]) throw stale();
    return rows[0];
  });

  await record(actor, 'contact.make-primary', contactId, `primary contact for customer ${customerId}`);
  return serializeContact(row);
}

/* ---------------------------------------------------------------------------
   Archive / reactivate
   --------------------------------------------------------------------------- */

/**
 * Archives a contact. NOT a delete — the row stays.
 *
 * The primary cannot be archived directly, for the same reason it cannot be
 * deactivated by an edit: a store must not silently end up with no primary
 * contact. Replace the primary first.
 */
export async function archiveContact(db, customerId, contactId, body, actor) {
  const token = body?.concurrencyToken;

  const row = await db.tx(async (c) => {
    const current = await lockContact(c, customerId, contactId);
    if (token !== makeContactToken(current)) throw stale();

    if (current.is_primary) {
      throw new ContactApiError(422, {
        error: 'This is the primary contact. Make another contact primary first, then archive this one.',
        code: 'PRIMARY_MUST_BE_REPLACED',
      });
    }
    if (!current.is_active) return current; // idempotent

    /* `is_primary = false` is repeated here even though the guard above
       already proved it is false. The database constraint forbids an archived
       primary, and writing the column explicitly means this statement is
       correct on its own terms rather than because of a check somewhere else. */
    const { rows } = await c.query(
      `update customer_contacts set is_active = false, is_primary = false
        where id = $1 and customer_id = $2
        returning ${COLUMNS}`,
      [contactId, customerId]
    );
    if (!rows[0]) throw stale();
    return rows[0];
  });

  await record(actor, 'contact.archive', contactId, 'archived; row retained, nothing deleted');
  return serializeContact(row);
}

/**
 * Reactivates an archived contact.
 *
 * Re-validated on the way back in: a contact archived years ago may no longer
 * satisfy the active rules (the email might have been cleared before
 * archiving). Reactivating something that fails them would put a row in the
 * table the CHECK constraints forbid, and the operator would get a database
 * error instead of a sentence telling them what to fix.
 */
export async function reactivateContact(db, customerId, contactId, body, actor) {
  const token = body?.concurrencyToken;

  const row = await db.tx(async (c) => {
    const current = await lockContact(c, customerId, contactId);
    if (token !== makeContactToken(current)) throw stale();
    if (current.is_active) return current; // idempotent

    const check = validateContactInput({ isActive: true },
      { existing: serializeContact(current), partial: true });
    if (!check.ok) throw invalid(check.errors);

    /* Reactivated as a NON-primary, always. Whoever became primary while this
       person was away keeps it; promoting is a separate, deliberate action. */
    const { rows } = await c.query(
      `update customer_contacts set is_active = true, is_primary = false
        where id = $1 and customer_id = $2
        returning ${COLUMNS}`,
      [contactId, customerId]
    );
    if (!rows[0]) throw stale();
    return rows[0];
  });

  await record(actor, 'contact.reactivate', contactId, 'reactivated as non-primary');
  return serializeContact(row);
}

/* ---------------------------------------------------------------------------
   Verification
   --------------------------------------------------------------------------- */

/**
 * Records that a human confirmed these details are still right.
 *
 * A separate action rather than a side effect of editing, because editing a
 * note is not the same as ringing the store to check the number — and a
 * "verified" date that an unrelated edit refreshes tells you nothing.
 */
export async function verifyContact(db, customerId, contactId, body, actor) {
  const token = body?.concurrencyToken;

  const row = await db.tx(async (c) => {
    const current = await lockContact(c, customerId, contactId);
    if (token !== makeContactToken(current)) throw stale();
    const { rows } = await c.query(
      `update customer_contacts set last_verified_at = now()
        where id = $1 and customer_id = $2
        returning ${COLUMNS}`,
      [contactId, customerId]
    );
    if (!rows[0]) throw stale();
    return rows[0];
  });

  await record(actor, 'contact.verify', contactId, 'details confirmed current');
  return serializeContact(row);
}

/* ---------------------------------------------------------------------------
   Portal account link / unlink
   --------------------------------------------------------------------------- */

/**
 * Links a contact to an EXISTING portal account.
 *
 * Every part of this is a refusal to be clever:
 *
 *   - the account must already exist. Nothing here creates one, and there is
 *     no "invite" that would create one later;
 *   - the account must belong to THIS customer — either it IS the customer
 *     row, or it is an account whose `agent_id` chain says otherwise, which is
 *     not something this router will infer. Concretely: the only account a
 *     contact may be linked to is the customer's own login. Linking a contact
 *     at one store to an account at another would hand that person a session
 *     into somebody else's orders;
 *   - the account must be active. Linking to a disabled account records a
 *     login that does not work as though it did;
 *   - no capability, role or permission is granted, changed or implied. The
 *     link is a statement about which login this person uses, nothing more.
 */
export async function linkPortalUser(db, customerId, contactId, body, actor) {
  const token = body?.concurrencyToken;
  const portalUserId = typeof body?.portalUserId === 'string' ? body.portalUserId : '';
  if (portalUserId === '') {
    throw invalid([{ field: 'portalUserId', code: 'REQUIRED', message: 'Choose the portal account this person signs in with.' }]);
  }

  const row = await db.tx(async (c) => {
    const current = await lockContact(c, customerId, contactId);
    if (token !== makeContactToken(current)) throw stale();

    const { rows: accounts } = await c.query(
      `select id, status, role from users where id = $1 limit 1`,
      [portalUserId]
    );
    const account = accounts[0];
    if (!account) {
      throw new ContactApiError(404, { error: 'That portal account does not exist.', code: 'NO_SUCH_ACCOUNT' });
    }
    /* The customer's own login is the only account a contact may hold. This is
       narrow on purpose: widening it later is a reviewable change, whereas a
       permissive rule shipped today is a cross-tenant session tomorrow. */
    if (account.id !== customerId) {
      throw new ContactApiError(422, {
        error: 'A contact can only be linked to this customer’s own portal account.',
        code: 'ACCOUNT_NOT_FOR_CUSTOMER',
      });
    }
    if (account.status !== 'active') {
      throw new ContactApiError(422, {
        error: 'That portal account is not active, so linking it would record a login that does not work.',
        code: 'ACCOUNT_NOT_ACTIVE',
      });
    }

    const { rows: taken } = await c.query(
      `select id from customer_contacts where portal_user_id = $1 and id <> $2 limit 1`,
      [portalUserId, contactId]
    );
    if (taken[0]) {
      throw new ContactApiError(409, {
        error: 'Another contact is already recorded as using that portal account. Unlink it there first.',
        code: 'ACCOUNT_ALREADY_LINKED',
      });
    }

    const { rows } = await c.query(
      `update customer_contacts set portal_user_id = $3
        where id = $1 and customer_id = $2
        returning ${COLUMNS}`,
      [contactId, customerId, portalUserId]
    );
    if (!rows[0]) throw stale();
    return rows[0];
  });

  await record(actor, 'contact.link-portal', contactId,
    `linked to portal account ${portalUserId}; no capability granted`);
  return serializeContact(row);
}

/** Unlinks. The portal ACCOUNT is untouched — this records that the person no
 *  longer uses it, and does not disable, delete or alter the login. */
export async function unlinkPortalUser(db, customerId, contactId, body, actor) {
  const token = body?.concurrencyToken;

  const row = await db.tx(async (c) => {
    const current = await lockContact(c, customerId, contactId);
    if (token !== makeContactToken(current)) throw stale();
    if (current.portal_user_id == null) return current; // idempotent

    const { rows } = await c.query(
      `update customer_contacts set portal_user_id = null
        where id = $1 and customer_id = $2
        returning ${COLUMNS}`,
      [contactId, customerId]
    );
    if (!rows[0]) throw stale();
    return rows[0];
  });

  await record(actor, 'contact.unlink-portal', contactId,
    'portal link removed; the account itself was not changed');
  return serializeContact(row);
}

/* ---------------------------------------------------------------------------
   Router
   --------------------------------------------------------------------------- */

const liveDb = { query: (sql, params) => pool.query(sql, params), tx: realTx };

const r = Router();

/* Authentication once for the whole router; capability per route below.
   `requireAuth()` takes no role arguments deliberately — the authority here is
   the capability, not the role. */
r.use(requireAuth());

const canView = () => requirePermission(CONTACT_CAPABILITIES.view);
const canManage = () => requirePermission(CONTACT_CAPABILITIES.manage);

function send(res, next, promise, shape = (v) => v) {
  promise
    .then((value) => res.json(shape(value)))
    .catch((err) => {
      if (err instanceof ContactApiError) return res.status(err.status).json(err.body);
      next(err);
    });
}

// ---- capability discovery (authenticated, ungated — see above) ----
r.get('/capabilities', (req, res, next) =>
  send(res, next, getContactCapabilities(liveDb, req.user?.id), (capabilities) => ({
    capabilities,
    contract: CONTACT_CONTRACT,
  }))
);

// ---- reads ----
r.get('/:customerId', canView(), (req, res, next) =>
  send(res, next, listContacts(liveDb, req.params.customerId, {
    includeArchived: req.query.includeArchived !== 'false',
  }))
);

r.get('/:customerId/:contactId', canView(), (req, res, next) =>
  send(res, next, getContact(liveDb, req.params.customerId, req.params.contactId),
    (contact) => ({ contact }))
);

/* ---- writes ----
   Every one of these takes the actor from `req.user` and NEVER from the body,
   so an operator cannot record a change as somebody else. Each is a named
   action on its own path rather than a general PATCH with a mode field: a
   route that can do six things is a route whose authorisation has to be
   re-derived from the payload on every read of the code. */
r.post('/:customerId', canManage(), (req, res, next) =>
  send(res, next, createContact(liveDb, req.params.customerId, req.body, req.user),
    (contact) => ({ contact }))
);

r.post('/:customerId/:contactId/update', canManage(), (req, res, next) =>
  send(res, next, updateContact(liveDb, req.params.customerId, req.params.contactId, req.body, req.user),
    (contact) => ({ contact }))
);

r.post('/:customerId/:contactId/make-primary', canManage(), (req, res, next) =>
  send(res, next, makePrimary(liveDb, req.params.customerId, req.params.contactId, req.body, req.user),
    (contact) => ({ contact }))
);

r.post('/:customerId/:contactId/archive', canManage(), (req, res, next) =>
  send(res, next, archiveContact(liveDb, req.params.customerId, req.params.contactId, req.body, req.user),
    (contact) => ({ contact }))
);

r.post('/:customerId/:contactId/reactivate', canManage(), (req, res, next) =>
  send(res, next, reactivateContact(liveDb, req.params.customerId, req.params.contactId, req.body, req.user),
    (contact) => ({ contact }))
);

r.post('/:customerId/:contactId/verify', canManage(), (req, res, next) =>
  send(res, next, verifyContact(liveDb, req.params.customerId, req.params.contactId, req.body, req.user),
    (contact) => ({ contact }))
);

r.post('/:customerId/:contactId/link-portal', canManage(), (req, res, next) =>
  send(res, next, linkPortalUser(liveDb, req.params.customerId, req.params.contactId, req.body, req.user),
    (contact) => ({ contact }))
);

r.post('/:customerId/:contactId/unlink-portal', canManage(), (req, res, next) =>
  send(res, next, unlinkPortalUser(liveDb, req.params.customerId, req.params.contactId, req.body, req.user),
    (contact) => ({ contact }))
);

/* No DELETE route, deliberately. Archival is how a contact leaves — see the
   header. */

export default r;
