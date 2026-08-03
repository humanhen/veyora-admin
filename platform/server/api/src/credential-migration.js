/* ================= Credential migration — decision logic =================

   Batch 1K. Existing customers must be able to keep signing in with the
   passwords held in the employer's credential workbook. That workbook contains
   PLAINTEXT passwords, so the architecture is built around one rule:

       THE PLAINTEXT NEVER LEAVES THE OPERATOR'S OWN MACHINE.

   Stage 1 (local)  reads the workbook, validates it, bcrypt-hashes every
                    password locally and streams a JSON payload of HASHES to
                    stdout.
   Stage 2 (server) reads that payload from stdin inside the API container and
                    plans or applies it against PostgreSQL. It never sees, and
                    cannot see, a plaintext password.

   This module holds every DECISION both stages make and is deliberately
   dependency-free — no pg, no bcrypt, no spreadsheet parser — so the matching
   rules, the safety refusals and the plaintext guard are all testable without a
   database, a network or a real workbook.                                     */
'use strict';

export const PAYLOAD_KIND = 'veyora-credential-migration';
export const PAYLOAD_VERSION = 1;

export const REQUIRED_HEADERS = ['id', 'external_id', 'business_name', 'email', 'password'];

export const PLACEHOLDER_EMAIL_DOMAIN = '@import.veyora.local';

/** Cost 10 — the same factor the API uses everywhere else, so a migrated
    password verifies exactly like one set through the site. */
export const BCRYPT_COST = 10;

export const MIN_PASSWORD_LENGTH = 8;

/** Only these roles may be touched. A staff account must never have its
    password rewritten from a customer workbook. */
export const CUSTOMER_ROLES = ['customer', 'special customer'];

/* ------------------------------------------------------------------ *
 * Normalisation                                                       *
 * ------------------------------------------------------------------ */

export function normaliseEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return s || null;
}

/** Deliberately permissive but structural: one @, no spaces, a dotted domain. */
export function isEmailShaped(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isPlaceholderEmail(email) {
  return typeof email === 'string'
    && email.trim().toLowerCase().endsWith(PLACEHOLDER_EMAIL_DOMAIN);
}

/** "Main Street Optical, LLC." and "main street  optical llc" collapse to the
    same key, so a business fallback is not defeated by punctuation or spacing.
    The ORIGINAL string is always kept alongside for reports. */
export function normaliseBusiness(raw) {
  return String(raw ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** "alice@example.com" -> "a***@example.com". Never widen this. */
export function maskEmail(email) {
  const s = String(email ?? '').trim();
  if (!s) return '(blank)';
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return `${s[0]}***${s.slice(at)}`;
}

/* ------------------------------------------------------------------ *
 * Workbook validation                                                 *
 * ------------------------------------------------------------------ */

export function validateHeaders(headers) {
  const got = (headers || []).map(h => String(h ?? '').trim().toLowerCase());
  const trimmed = [...got];
  while (trimmed.length && trimmed[trimmed.length - 1] === '') trimmed.pop();
  if (trimmed.length !== REQUIRED_HEADERS.length
      || REQUIRED_HEADERS.some((h, i) => trimmed[i] !== h)) {
    return { ok: false,
      error: `workbook headers must be exactly [${REQUIRED_HEADERS.join(', ')}] — got [${trimmed.join(', ')}]` };
  }
  return { ok: true };
}

const isBlankRow = cells => !(cells || []).some(c => String(c ?? '').trim() !== '');

/**
 * Validate and normalise one workbook row.
 * `rowNumber` is the spreadsheet row the operator sees (header is row 1).
 * The plaintext password is returned so the caller can hash it and drop it; it
 * is never stored on the returned record.
 */
export function validateRow(cells, rowNumber) {
  const [id, externalId, businessName, email, password] =
    (cells || []).map(c => String(c ?? '').trim());

  const problems = [];
  if (!id) problems.push('missing id');
  if (!businessName) problems.push('missing business_name');

  const emailNormalised = normaliseEmail(email);
  if (!emailNormalised) problems.push('missing email');
  else if (!isEmailShaped(emailNormalised)) problems.push('email is not a usable address');

  if (!password) problems.push('missing password');
  else if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`password is shorter than ${MIN_PASSWORD_LENGTH} characters`);
  }

  if (problems.length) {
    return { ok: false, row: rowNumber, sourceId: id || null,
      businessName: businessName || null,
      maskedEmail: maskEmail(email), reason: problems.join('; ') };
  }
  return {
    ok: true,
    record: {
      row: rowNumber,
      sourceId: id,
      externalId: externalId || null,
      businessName,
      businessNormalised: normaliseBusiness(businessName),
      email,
      emailNormalised,
      placeholderEmail: isPlaceholderEmail(emailNormalised),
    },
    password,
  };
}

/**
 * Validate a whole sheet. Duplicate normalised emails are FATAL: two rows
 * claiming one login means we cannot know which password is current, and
 * guessing would lock a customer out.
 */
export function validateSheet(headers, rows) {
  const headerCheck = validateHeaders(headers);
  if (!headerCheck.ok) return { ok: false, fatal: headerCheck.error, records: [], problems: [] };

  const records = [];
  const passwords = [];
  const problems = [];
  const seenEmail = new Map();
  const duplicates = [];
  let blankRows = 0;

  rows.forEach((cells, i) => {
    const rowNumber = i + 2;                 // header occupies row 1
    if (isBlankRow(cells)) { blankRows++; return; }
    const v = validateRow(cells, rowNumber);
    if (!v.ok) { problems.push(v); return; }
    const prev = seenEmail.get(v.record.emailNormalised);
    if (prev) {
      duplicates.push({ email: maskEmail(v.record.emailNormalised),
        rows: [prev, v.record.row] });
      return;
    }
    seenEmail.set(v.record.emailNormalised, v.record.row);
    records.push(v.record);
    passwords.push(v.password);
  });

  if (duplicates.length) {
    const list = duplicates.map(d => `${d.email} (rows ${d.rows.join(' and ')})`).join(', ');
    return { ok: false, fatal: `duplicate email addresses in the workbook: ${list}`,
      records: [], problems, blankRows, duplicates };
  }

  /* A business name repeated in the workbook cannot be used as a fallback key
     — it would not identify one account. Recorded, not fatal: those rows can
     still match on email. */
  const businessCounts = new Map();
  for (const r of records) {
    businessCounts.set(r.businessNormalised, (businessCounts.get(r.businessNormalised) || 0) + 1);
  }
  for (const r of records) r.businessUniqueInWorkbook = businessCounts.get(r.businessNormalised) === 1;

  return { ok: true, records, passwords, problems, blankRows, duplicates: [] };
}

/* ------------------------------------------------------------------ *
 * The plaintext guard                                                 *
 * ------------------------------------------------------------------ */

/* Any key that could carry a plaintext secret. `passwordHash` is the ONE
   allowed key whose name contains "password". */
const ALLOWED_CREDENTIAL_KEY = /^password_?hash$/i;
const CREDENTIAL_KEY = /(password|passwd|passphrase|pwd|plaintext|secret|credential)/i;

export const BCRYPT_HASH = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

export function isBcryptHash(value) {
  return typeof value === 'string' && BCRYPT_HASH.test(value);
}

export function bcryptCost(value) {
  const m = typeof value === 'string' && value.match(BCRYPT_HASH);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Walk a payload and refuse anything that could be a plaintext credential.
 * Returns a list of problems; empty means clean.
 */
export function findPlaintext(value, trail = '$') {
  const problems = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => problems.push(...findPlaintext(v, `${trail}[${i}]`)));
    return problems;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const at = `${trail}.${k}`;
      if (CREDENTIAL_KEY.test(k) && !ALLOWED_CREDENTIAL_KEY.test(k)) {
        problems.push(`${at}: forbidden key '${k}' — plaintext must never travel`);
        continue;
      }
      if (ALLOWED_CREDENTIAL_KEY.test(k)) {
        if (!isBcryptHash(v)) {
          problems.push(`${at}: is not a bcrypt hash`);
        } else if (bcryptCost(v) !== BCRYPT_COST) {
          problems.push(`${at}: bcrypt cost ${bcryptCost(v)}, expected ${BCRYPT_COST}`);
        }
        continue;
      }
      problems.push(...findPlaintext(v, at));
    }
  }
  return problems;
}

/** Structural check of a received payload, before it is trusted at all. */
export function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload is not an object' };
  if (payload.kind !== PAYLOAD_KIND) return { ok: false, error: `payload kind must be '${PAYLOAD_KIND}'` };
  if (payload.version !== PAYLOAD_VERSION) {
    return { ok: false, error: `payload version ${payload.version} is not supported (expected ${PAYLOAD_VERSION})` };
  }
  if (!payload.source || !/^[a-f0-9]{64}$/i.test(String(payload.source.sha256 || ''))) {
    return { ok: false, error: 'payload is missing a source workbook sha256' };
  }
  if (!Array.isArray(payload.rows) || !payload.rows.length) {
    return { ok: false, error: 'payload contains no rows' };
  }
  const leaks = findPlaintext(payload);
  if (leaks.length) return { ok: false, error: `payload rejected: ${leaks.join('; ')}` };
  for (const r of payload.rows) {
    if (!r.emailNormalised || !isEmailShaped(r.emailNormalised)) {
      return { ok: false, error: `row ${r.row}: unusable email` };
    }
    if (!r.businessNormalised) return { ok: false, error: `row ${r.row}: missing business name` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Matching and planning                                               *
 * ------------------------------------------------------------------ */

export const OUTCOME = {
  UPDATE_EMAIL_MATCH: 'update_email_match',
  UPDATE_BUSINESS_FALLBACK: 'update_business_fallback',
  CREATE: 'create',
  WOULD_CREATE: 'would_create',
  SKIP_DISABLED: 'skip_disabled',
  SKIP_ROLE: 'skip_role',
  SKIP_AMBIGUOUS: 'skip_ambiguous',
  SKIP_EMAIL_CONFLICT: 'skip_email_conflict',
  SKIP_MISSING: 'skip_missing',
  SKIP_INVALID: 'skip_invalid',
};

const WRITE_OUTCOMES = new Set([
  OUTCOME.UPDATE_EMAIL_MATCH, OUTCOME.UPDATE_BUSINESS_FALLBACK, OUTCOME.CREATE]);

export function isWrite(outcome) { return WRITE_OUTCOMES.has(outcome); }

/**
 * Decide what to do with every payload row.
 *
 * @param rows     payload rows (already validated — hashes only)
 * @param dbUsers  every users row, as {id, email, business, role, status,
 *                 customer_number}
 * @param options  { createMissing:boolean }
 * @returns {{ actions: Array, summary: Object }}
 */
export function planMigration(rows, dbUsers, { createMissing = false } = {}) {
  const byEmail = new Map();
  const byBusiness = new Map();
  for (const u of dbUsers || []) {
    const email = normaliseEmail(u.email);
    if (email) byEmail.set(email, u);
    if (CUSTOMER_ROLES.includes(u.role)) {
      const key = normaliseBusiness(u.business);
      if (key) {
        if (!byBusiness.has(key)) byBusiness.set(key, []);
        byBusiness.get(key).push(u);
      }
    }
  }

  const actions = rows.map(r => decide(r, byEmail, byBusiness, createMissing));
  return { actions, summary: summarise(rows, actions) };
}

function base(r, outcome, reason, extra = {}) {
  return {
    row: r.row,
    sourceId: r.sourceId,
    businessName: r.businessName,
    maskedEmail: maskEmail(r.emailNormalised),
    placeholderSuppliedEmail: !!r.placeholderEmail,
    outcome,
    reason,
    ...extra,
  };
}

function decide(r, byEmail, byBusiness, createMissing) {
  /* ---- A. exact email match ---- */
  const hit = byEmail.get(r.emailNormalised);
  if (hit) {
    if (!CUSTOMER_ROLES.includes(hit.role)) {
      return base(r, OUTCOME.SKIP_ROLE,
        `account is '${hit.role}' — a customer workbook may not change staff credentials`);
    }
    if (hit.status === 'disabled') {
      return base(r, OUTCOME.SKIP_DISABLED,
        'account is disabled — a disabled account is never reactivated by a migration');
    }
    return base(r, OUTCOME.UPDATE_EMAIL_MATCH,
      hit.status === 'pending' ? 'password set; pending account activated'
                               : 'password set; account already active',
      { userId: hit.id, activate: hit.status === 'pending',
        wasStatus: hit.status, replaceEmail: false });
  }

  /* ---- B. unique placeholder-business fallback ---- */
  const candidates = byBusiness.get(r.businessNormalised) || [];
  if (candidates.length) {
    if (!r.businessUniqueInWorkbook) {
      return base(r, OUTCOME.SKIP_AMBIGUOUS,
        'the workbook lists this business name more than once, so it cannot identify one account');
    }
    if (candidates.length > 1) {
      return base(r, OUTCOME.SKIP_AMBIGUOUS,
        `${candidates.length} database accounts share this business name`);
    }
    const u = candidates[0];
    if (u.status === 'disabled') {
      return base(r, OUTCOME.SKIP_DISABLED,
        'the matching account is disabled — never reactivated by a migration');
    }
    if (!isPlaceholderEmail(u.email)) {
      return base(r, OUTCOME.SKIP_AMBIGUOUS,
        'the matching account already has a real email address that differs from the workbook');
    }
    /* The workbook email must be free. It is not on any account (no exact match
       above), but check the whole map so a future ordering change cannot make
       this silently wrong. */
    if (byEmail.has(r.emailNormalised)) {
      return base(r, OUTCOME.SKIP_EMAIL_CONFLICT,
        'the workbook email already belongs to another account');
    }
    if (r.placeholderEmail) {
      return base(r, OUTCOME.SKIP_AMBIGUOUS,
        'the workbook supplies a placeholder email, which would not replace the placeholder on file');
    }
    return base(r, OUTCOME.UPDATE_BUSINESS_FALLBACK,
      `placeholder email replaced; password set${u.status === 'pending' ? '; account activated' : ''}`,
      { userId: u.id, activate: u.status === 'pending', wasStatus: u.status,
        replaceEmail: true, previousEmail: maskEmail(u.email) });
  }

  /* ---- C/D. nothing to match ---- */
  if (!createMissing) {
    return base(r, OUTCOME.SKIP_MISSING,
      'no account with this email or business name — run with --create-missing to create it');
  }
  if (r.placeholderEmail) {
    return base(r, OUTCOME.SKIP_INVALID,
      'refusing to create an account whose only address is an import placeholder');
  }
  if (!r.businessUniqueInWorkbook) {
    return base(r, OUTCOME.SKIP_AMBIGUOUS,
      'the workbook lists this business name more than once, so a new account would be a guess');
  }
  return base(r, OUTCOME.CREATE, 'new customer account created, active');
}

/* ------------------------------------------------------------------ *
 * Sanitised reporting                                                 *
 * ------------------------------------------------------------------ */

export function summarise(rows, actions) {
  const count = pred => actions.filter(pred).length;
  const emailMatches = actions.filter(a => a.outcome === OUTCOME.UPDATE_EMAIL_MATCH);
  return {
    workbookRows: rows.length,
    exactEmailMatches: emailMatches.length,
    safePlaceholderBusinessMatches: count(a => a.outcome === OUTCOME.UPDATE_BUSINESS_FALLBACK),
    alreadyActive: emailMatches.filter(a => a.wasStatus === 'active').length,
    pendingToActivate: count(a => isWrite(a.outcome) && a.activate),
    placeholderSuppliedEmails: count(a => a.placeholderSuppliedEmail),
    disabledSkips: count(a => a.outcome === OUTCOME.SKIP_DISABLED),
    roleMismatchSkips: count(a => a.outcome === OUTCOME.SKIP_ROLE),
    ambiguousSkips: count(a => a.outcome === OUTCOME.SKIP_AMBIGUOUS),
    emailConflictSkips: count(a => a.outcome === OUTCOME.SKIP_EMAIL_CONFLICT),
    invalidSkips: count(a => a.outcome === OUTCOME.SKIP_INVALID),
    missingAccounts: count(a => a.outcome === OUTCOME.SKIP_MISSING),
    wouldCreateWithFlag: count(a => a.outcome === OUTCOME.SKIP_MISSING),
    accountsToCreate: count(a => a.outcome === OUTCOME.CREATE),
    totalSafeUpdates: count(a => isWrite(a.outcome)),
  };
}

/** One printable line per row-level problem. Never carries a secret. */
export function problemLines(actions) {
  return actions
    .filter(a => !isWrite(a.outcome))
    .map(a => `  row ${a.row} · id ${a.sourceId ?? '—'} · ${a.businessName ?? '—'} · `
      + `${a.maskedEmail} · ${a.outcome} · ${a.reason}`);
}

/** Settings key holding the sanitised record of every applied migration. */
export const MIGRATION_SETTINGS_KEY = 'credentialMigrations';

/** Has this exact workbook already been applied? */
export function alreadyApplied(settingsData, sha256) {
  const list = settingsData?.[MIGRATION_SETTINGS_KEY];
  if (!Array.isArray(list)) return null;
  return list.find(e => String(e?.sha256 || '').toLowerCase() === String(sha256).toLowerCase()) || null;
}

/* ------------------------------------------------------------------ *
 * The write                                                           *
 * ------------------------------------------------------------------ */

/* The update predicate repeats every safety rule the plan already checked. If
   the database moved between planning and writing — the account was disabled,
   its role changed, it was deleted — the row simply does not match, the
   affected count is not 1, and the whole transaction is rolled back. A
   migration that half-applied would be worse than one that did not run. */
export const UPDATE_GUARD = `id = $1 and role = any($GUARD) and status <> 'disabled'`;

export function buildUpdate(action, row) {
  const sets = ['password_hash = $2', 'updated_at = now()'];
  const params = [action.userId, row.passwordHash];
  if (action.activate) sets.push(`status = 'active'`);
  if (action.replaceEmail) { params.push(row.emailNormalised); sets.push(`email = $${params.length}`); }
  const guardParam = params.length + 1;
  return {
    sql: `update users set ${sets.join(', ')} where id = $1 `
       + `and role = any($${guardParam}) and status <> 'disabled'`,
    params: [...params, CUSTOMER_ROLES],
  };
}

export function buildInsert(row) {
  return {
    sql: `insert into users (email, business, role, status, password_hash) `
       + `values ($1,$2,'customer','active',$3)`,
    params: [row.emailNormalised, row.businessName, row.passwordHash],
  };
}

/**
 * Perform the planned writes inside ONE transaction.
 *
 * `client` only has to provide `query(sql, params) -> {rowCount, rows}`, which
 * is what a pg client gives us and what the tests supply, so the real code
 * below is the code under test.
 *
 * Every failure path rolls back and rethrows: there is no partial apply.
 */
export async function applyPlan(client, { actions, payload, createMissing = false,
                                          summary, forced = false, now = () => new Date() }) {
  const writes = (actions || []).filter(a => isWrite(a.outcome));
  if (!writes.length) throw new Error('the plan contains no safe writes — nothing to apply');

  const byRow = new Map((payload.rows || []).map(r => [r.row, r]));
  const applied = { updated: 0, emailsReplaced: 0, activated: 0, created: 0 };

  await client.query('begin');
  try {
    for (const a of writes) {
      const row = byRow.get(a.row);
      if (!row) throw new Error(`row ${a.row}: hash missing from payload at apply time`);
      if (!isBcryptHash(row.passwordHash) || bcryptCost(row.passwordHash) !== BCRYPT_COST) {
        throw new Error(`row ${a.row}: password hash is not bcrypt cost ${BCRYPT_COST}`);
      }

      if (a.outcome === OUTCOME.CREATE) {
        if (!createMissing) throw new Error(`row ${a.row}: a create was planned without --create-missing`);
        const { sql, params } = buildInsert(row);
        const res = await client.query(sql, params);
        if (res.rowCount !== 1) throw new Error(`row ${a.row}: insert affected ${res.rowCount} rows`);
        applied.created++;
        continue;
      }

      const { sql, params } = buildUpdate(a, row);
      const res = await client.query(sql, params);
      if (res.rowCount !== 1) {
        throw new Error(`row ${a.row} (user ${a.userId}): expected to update exactly 1 row, `
          + `updated ${res.rowCount} — the account changed since the plan was made`);
      }
      applied.updated++;
      if (a.activate) applied.activated++;
      if (a.replaceEmail) applied.emailsReplaced++;
    }

    /* Sanitised record. Checked again on the way out, because this is the one
       thing the migration leaves behind permanently. */
    const entry = {
      sha256: String(payload.source.sha256).toLowerCase(),
      at: now().toISOString(),
      counts: { ...(summary || {}), ...applied },
      createMissing: !!createMissing,
      forced: !!forced,
    };
    const leaks = findPlaintext(entry);
    if (leaks.length) throw new Error(`refusing to record the migration: ${leaks.join('; ')}`);

    await client.query(`
      update settings
         set data = jsonb_set(coalesce(data,'{}'::jsonb), $1::text[],
               coalesce(data->$2, '[]'::jsonb) || $3::jsonb, true)
       where id = 1`,
      [`{${MIGRATION_SETTINGS_KEY}}`, MIGRATION_SETTINGS_KEY, JSON.stringify([entry])]);

    await client.query(`
      insert into audit_log (actor_id, actor_name, actor_role, action, target, source, changes, payload)
      values (null,'Credential migration','system','customer credentials migrated',$1,'script',$2,$3)`,
      [entry.sha256.slice(0, 12),
       `${applied.updated} updated, ${applied.activated} activated, `
         + `${applied.emailsReplaced} placeholder emails replaced, ${applied.created} created`,
       JSON.stringify(entry)]);

    await client.query('commit');
    return { applied, entry };
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}
