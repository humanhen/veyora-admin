-- ============================================================================
-- Append-only audit history (Security Hardening Phase 4)
--
-- Finding SEC-015: `audit` was in the admin panel's synced-collection set, so
-- the generic whole-database sync endpoint could UPDATE and DELETE audit rows
-- like any other table. An audit log that the audited party can rewrite is not
-- an audit log — it is a record of whatever the last writer wanted it to say.
--
-- This applies the SAME pattern the inventory ledger has used since it was
-- built (`inventory_movements_immutable()` in api/src/migrate.js): a trigger
-- function that raises on UPDATE and DELETE. One idea, used twice, rather than
-- a second mechanism to learn.
--
-- ENTIRELY ADDITIVE AND NON-DESTRUCTIVE.
--   * No existing row is modified, converted or deleted.
--   * No column is dropped and no type is changed.
--   * INSERT is untouched, so the server-side writer in api/src/db.js keeps
--     working exactly as before.
--   * Existing rows stay readable by every account that could read them.
--
-- CORRECTIONS ARE COMPENSATING RECORDS, NOT MUTATIONS. If an entry is wrong,
-- the answer is a new entry describing the correction — the same discipline
-- accounting has used for centuries, and the same one the inventory ledger
-- already follows.
--
-- ON THE `undone` COLUMN. It exists and is left in place: dropping a column is
-- destructive and this migration is not. Nothing can flip it any more, which is
-- correct — the admin panel's "Undo" control never reverted anything; it set
-- this flag and wrote a second row claiming a reversal had happened. That is
-- finding REP-007, and it is removed in the same change as this migration.
--
-- As with every migration since go-live, this file runs only on a completely
-- fresh database volume. An existing database picks it up through
-- api/src/migrate.js's ensureSchema(), which mirrors it idempotently.
-- ============================================================================

create or replace function audit_log_immutable() returns trigger as $$
begin
  raise exception 'audit_log is append-only (% blocked)', tg_op;
end $$ language plpgsql;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 't_audit_log_no_update') then
    create trigger t_audit_log_no_update before update on audit_log
      for each row execute function audit_log_immutable();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 't_audit_log_no_delete') then
    create trigger t_audit_log_no_delete before delete on audit_log
      for each row execute function audit_log_immutable();
  end if;
end $$;
