# 43 — Migration / Runtime Schema Parity

**Status:** closed (Final Release Correction)

---

## 1. Two paths to a schema

Veyora builds its database two different ways, with two different pieces of code:

| Path | When it runs | What runs it |
|---|---|---|
| `platform/server/db/migrations/*.sql` | **Only on a completely fresh database volume** | The postgres container's `docker-entrypoint-initdb.d` |
| `ensureSchema()` in `src/migrate.js` | **Every API boot** | `startServer()`, which refuses to listen if it fails |

An existing database *only ever executes the second one.*

And the two cannot be the same code. `docker-compose.yml` mounts the migrations into the **postgres**
container alone:

```yaml
- ./db/migrations:/docker-entrypoint-initdb.d:ro
```

The API image is built from `platform/server/api` and does not contain that directory, so
`ensureSchema()` cannot read or execute the canonical SQL at runtime. It is a **hand-written
mirror** — and hand-written mirrors drift.

---

## 2. They had drifted

Six schema objects across three migrations were never mirrored:

| Migration | Object | Used at runtime by |
|---|---|---|
| 0003 | `return_items.exchange_sku` | `INSERT` in `routes/admin.js` and `routes/orders.js`; read by both |
| 0004 | `purchase_orders` (table) | The `purchaseOrders` sync collection, `shape.js` |
| 0004 | `purchase_orders.number` UNIQUE, `status` CHECK | The same |
| 0004 | `po_number_seq` (sequence) | **`seqNext('po_number_seq')` on every `/admin/snapshot`** |
| 0005 | `orders.zoho_so_id` | Read and written by `src/zoho.js` on every Zoho order push |

**None of these degrades gracefully.** A database that never ran 0004 fails the request that loads
the entire admin panel. A database that never ran 0003 throws on every return creation.

### Why nobody noticed

The failure is invisible under normal conditions. A fresh volume gets all three from the migrations;
the deployed database already had them. The gap only surfaces when a database is **restored from a
backup predating them**, or brought up by a path that skips `docker-entrypoint-initdb.d` — exactly
the situations in which somebody is already under pressure.

The gap-matrix row DEP-004 asserted that `ensureSchema` "mirrors every migration idempotently". That
was simply not true, and nothing checked it.

---

## 3. The parity matrix

Every migration, classified. Built by parsing both definitions rather than by reading them.

| Migration | Objects | In `ensureSchema` | Classification |
|---|---|---|---|
| `0001_schema.sql` | 347 | no | **Intentionally migration-only** |
| `0002_views.sql` | 1 view | no | **Intentionally migration-only** |
| `0003_return_exchange.sql` | 1 | **now yes** | *Was missing* |
| `0004_purchasing.sql` | table + sequence | **now yes** | *Was missing* |
| `0005_order_zoho_push.sql` | 1 | **now yes** | *Was missing* |
| `0006`–`0016` | 407 | yes | Already equivalent |

### The two intentional exclusions

Each is a **decision with a stated reason**, held in `MIGRATION_ONLY` in the parity suite — and each
reason is itself tested, so an exclusion cannot quietly become wrong.

**`0001_schema.sql` — the base schema.** It *is* the database: every core table, sequence and
trigger the platform starts from. Mirroring it would mean maintaining a second complete copy of the
entire schema in JavaScript, with two definitions of `users` to keep in step — a far larger risk than
the one it would close. `ensureSchema()`'s own header states its scope: *"tables added after go-live
are ensured here instead."*

> **Tested:** test 8 asserts `ensureSchema` never creates `users`, `products`, `orders`, `variations`
> or `stock`. If it ever starts, the exclusion is wrong and the suite says so.

**`0002_views.sql` — reporting views.** `units_sold_by_model` and friends are analyst-facing SQL.
Nothing in the API reads them, so a database lacking them loses no runtime behaviour.

> **Tested:** test 7 walks every `.js` file under `src/` and asserts no view name appears. The day
> one is used, the exclusion fails.

### Nothing was classified "unsafe to reproduce"

Every missing object is an additive `create ... if not exists` or `add column if not exists`. There
was no case requiring `ensureSchema` to detect and report a prerequisite it could not create.

---

## 4. The fix

Three blocks added to `ensureSchema()`, in chronological position before the 0006 mirror, each
naming the migration it mirrors and why the object matters:

```js
await q(`alter table return_items add column if not exists exchange_sku text`);

await q(`create table if not exists purchase_orders ( … )`);
await q(`create sequence if not exists po_number_seq`);

await q(`alter table orders add column if not exists zoho_so_id text`);
```

Additive, idempotent, safe to repeat, no data rewrite, no drop, no renumbering, and **no historical
migration was edited**.

---

## 5. The mechanism that stops it recurring

Adding three blocks fixes the symptom. The cause is that nothing compared the two definitions.

`platform/server/api/test/schema-parity.test.js` (10 tests) **parses both** and compares them
structurally:

| Test | Property |
|---|---|
| 1 | Every migration is in scope, or has a stated reason in `MIGRATION_ONLY` that is more than a shrug — and the exclusion list cannot name a migration that no longer exists |
| 2 | **Every table, column, index, sequence, function and trigger in an in-scope migration exists in `ensureSchema`** |
| 3 | The three specific objects that were missing are present — a named regression test |
| 4 | `purchase_orders` matches **semantically**: every status in the CHECK, the UNIQUE on `number`, the primary key, and both defaults |
| 5 | Every mirrored statement is idempotent — every `CREATE` is `if not exists`, every `ADD COLUMN` is `if not exists`, every constraint drop is `if exists` |
| 6 | `ensureSchema` is never destructive |
| 7 | The excluded views really are unused by the API |
| 8 | The base schema exclusion still holds |
| 9 | Every mirrored migration announces which file it mirrors |
| 10 | The runtime-critical objects are present, each with the path that would break |

**Test 2 is the one that matters**: it is exhaustive and automatic, so a migration written next year
is covered without anybody remembering to extend a list.

### Proved, not assumed

Five regressions were injected one at a time, with the source restored after each:

| Injected | Caught |
|---|---|
| A brand-new migration (`0017`) nobody mirrored | yes — named the table, sequence and column |
| `exchange_sku` removed from the mirror | yes |
| `po_number_seq` removed from the mirror | yes |
| A `CREATE` without `if not exists` | yes |
| The `purchase_orders` status CHECK silently narrowed | yes — *"must allow 'partially received'"* |

**5/5.**

### And it cannot be deleted quietly

The suite is listed in the `critical-invariants` release gate, alongside the four objects themselves.
Deleting the file, or removing any of the four, fails the gate — because the defect this guards is
exactly the kind that hides: nothing failed for the life of the project while three migrations went
unmirrored.

---

## 6. A note on the checker itself

The first version of the parity check used single-space regexes and reported four **correctly
mirrored** indexes in 0007 as missing, because both files align their columns:

```
create index        if not exists products_brand_id_idx     on products (brand_id);
```

That was fixed before the suite was trusted. It is recorded because a parity checker that cries wolf
over whitespace is worse than none — the next real gap gets waved through with the false ones.

---

## 7. Still outstanding

This closes a **repository-level** risk. It does not close the operational one:

- **Migration rehearsal** against a copy of production data — **not done**;
- **Deployment rehearsal** of the release candidate — **not done**.

Both require a real disposable database and deployment environment, and neither can be performed from
this repository. See `40A_CLIENT_ACTIVATION_CHECKLIST.md` §H and gap-matrix rows **QA-005** and
**DEP-004**, which remain open.
