/* Lightweight, idempotent schema top-ups applied on every API boot.
   The base schema (db/migrations/0001_schema.sql) only runs on a fresh
   database, so tables added after go-live are ensured here instead — this
   lets a plain `deploy.sh` roll them out with no manual psql step. Every
   statement must be safe to run repeatedly (create ... if not exists). */
import { q } from './db.js';

export async function ensureSchema() {
  await q(`create table if not exists shared_lists (
    slug        text primary key,
    name        text not null default '',
    skus        text[] not null default '{}',
    created_by  text references users(id) on delete set null,
    created_at  timestamptz not null default now()
  )`);
  await q(`create index if not exists shared_lists_created_at_idx
    on shared_lists (created_at desc)`);
}
