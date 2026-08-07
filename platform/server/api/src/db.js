import pg from 'pg';
import crypto from 'crypto';

const { Pool, types } = pg;

// numeric → JS number (money is numeric(12,2); safe well below 2^53)
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
// int8 (count(*) etc.) → number
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));
// date → 'YYYY-MM-DD' string (avoid TZ drift)
types.setTypeParser(1082, v => v);

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export async function q(text, params) {
  return pool.query(text, params);
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/* The one audit INSERT. Everything that records an event goes through here or
   through auditIn() below, which shares this statement — so "does every audit
   writer only ever append?" is a question about one line of SQL. */
const AUDIT_INSERT = `insert into audit_log
  (actor_id, actor_name, actor_role, action, target, source, changes, payload)
  values ($1,$2,$3,$4,$5,$6,$7,$8)`;

const auditParams = (actor, action, target, changes, source, payload) => [
  actor?.id ?? null, actor?.name ?? 'System', actor?.role ?? 'system',
  action, target ?? '—', source, changes ?? '', payload,
];

export async function audit(actor, action, target, changes, source = 'web', payload = null) {
  await q(AUDIT_INSERT, auditParams(actor, action, target, changes, source, payload));
}

/**
 * The same append, on a caller-supplied transaction client.
 *
 * `audit()` runs on the pool, so the row it writes commits independently of
 * whatever the caller is doing. That is right for the usual case — a failure
 * to log must never undo a business fact that already happened.
 *
 * It is wrong when the audit row is a statement ABOUT a row being written in
 * the same transaction. An order held for a credit decision is the example: if
 * the order rolls back, a record saying it was reviewed is a lie, and if the
 * record fails while the order commits, an order that never passed a credit
 * check looks like one that did. Both must land together or neither.
 *
 * Deliberately shares AUDIT_INSERT so this remains an append and nothing else.
 */
export async function auditIn(client, actor, action, target, changes, source = 'web', payload = null) {
  await client.query(AUDIT_INSERT, auditParams(actor, action, target, changes, source, payload));
}
