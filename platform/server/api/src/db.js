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

export async function audit(actor, action, target, changes, source = 'web', payload = null) {
  await q(
    `insert into audit_log (actor_id, actor_name, actor_role, action, target, source, changes, payload)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor?.id ?? null, actor?.name ?? 'System', actor?.role ?? 'system',
     action, target ?? '—', source, changes ?? '', payload]
  );
}
