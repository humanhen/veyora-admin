# 42 — Duplicate-Submission and Reliability Sweep

**Status:** complete (Final Handover, Phase 7)

---

## 1. The standard applied

> Two immediate click / Enter / programmatic calls must not create two financial or operational
> mutations.

And, from the brief: **do not rely only on the disabled HTML property.**

That second rule matters because `button.disabled = true` is bypassed by three ordinary things:

- a handler called directly (`b.onclick()`), which every test in this repository does;
- Enter on a focused control, firing before a re-render replaces the node;
- **a re-render between the two clicks**, producing a *new* button whose `disabled` was never set —
  and these screens re-render after almost every action.

A browser guard stops the second request being **made**. Only the server stops it **mattering**, and
the server is what a retrying proxy, a resubmitted `fetch` or a second tab talks to directly. Both
halves are required.

---

## 2. Classification

| # | Path | Server guard | Browser guard | Verdict |
|---|---|---|---|---|
| 1 | **Order creation** (checkout) | `for update` cart lock (no `skip locked`, so the loser waits and finds nothing), full cart-snapshot equality check, guarded stock decrement `where qty >= $1` | `disabled` only | **server-idempotent** |
| 2 | **Order patch / fulfilment** | `for update`; shipped precondition; every write ABSOLUTE (`set collected = least($3, qty)`), total recomputed from stored lines | **fixed** — `runBusy` flag added | **server-idempotent** ¹ |
| 3 | **Invoice issuance** | `for update` on the order + `alreadyInvoiced` early return + `on conflict (idempotency_key)` on the ledger | `disabled` | **server-idempotent** |
| 4 | **Backorder conversion** | `for update` + explicit `alreadyConverted` replay branch returning the existing order | `disabled` in the confirm callback; `Modal.confirm` detaches before firing | **server-idempotent** |
| 5 | **Inventory adjust / transfer** | `for update` on stock, negative-stock floor — **and now an optional idempotency key** | **real `_busy` flag** (pre-existing) | **fixed** |
| 6 | **Inventory CSV import** | rides `/admin/sync`; absolute overwrite of the *doubled local value* | **NONE — fixed** | **was vulnerable** |
| 7 | **Purchase-order receipt** | rides `/admin/sync`; `received` and stock are INCREMENTS | none; saved only by a synchronous `close()` — **fixed** | **was fragile** |
| 8 | **Permission changes** | `for update` + optimistic concurrency token + desired-set diffing | `busy` flag | **server-idempotent** |
| 9 | **Content publication** | `for update` + token + gate re-run inside the transaction; publish is an absolute state set | `decisionBusy`, checked twice | **server-idempotent** |
| 10 | **Public form submission** | **NONE** — only a per-process in-memory IP throttle | deferred `disabled`, no flag, no POST-redirect-GET | **was vulnerable — fixed** |
| 11 | **Enquiry retry** | status precondition in the `WHERE` clause | `retrying` id flag | **server-idempotent** |
| 12 | **Customer contacts** | concurrency token + partial unique index on the active primary | `busy` id flag | **server-idempotent** |
| 13 | **Payment sessions** | partial unique index (one live session per invoice) + unique idempotency key | `busy` flag | **server-idempotent** |
| 14 | **Offline payments** | unique idempotency key + unique ledger key, both inside one transaction | `busy` flag | **server-idempotent** |
| 15 | **Credit notes** | unique idempotency key | `busy` flag | **server-idempotent** |
| 16 | **Refunds** | unique idempotency key + typed confirmation | `sending` flag | **server-idempotent** |
| 17 | **Statements** | unique idempotency key covering customer + period + currency + day | `busy` flag | **server-idempotent** |
| 18 | **Stripe webhook** | `provider_event_id` UNIQUE + every transition written as a no-op when already applied | n/a | **server-idempotent** |

¹ One genuine defect: `patch.comment` appends (`comments = coalesce(comments,'[]') || $n::jsonb`),
so a duplicated request added the same comment twice. The `runBusy` flag closes it.

---

## 3. What was actually broken

### 3.1 Public enquiries had no server guard at all — **fixed**

A refresh of the POST result, a synthetic `requestSubmit()`, a second tab, or scripting simply being
off each produced a second stored enquiry **and a second alert to every configured recipient**. The
only mitigation was an in-process IP throttle whose own comment disclaims it as "a mitigation against
casual abuse and accidental double-posting, not a security control".

**The fix:** a `dedupe_fingerprint` column with a partial unique index, and `on conflict do nothing`
on the insert.

The fingerprint is a hash of the form type, the submitted content **and a coarse two-minute time
bucket**. The bucket matters:

> Two genuine enquiries can be identical — somebody asks the same question a week later, or two
> people at one shop send the same request. A permanent uniqueness constraint on content would refuse
> the second. **A lost enquiry is invisible; a duplicated one is merely untidy.**

The bucket is floored rather than rolling, so two submissions either side of a boundary are both
accepted. That is the right way round to be wrong.

The submitter still receives `{ ok: true }` for a duplicate — telling them it failed would make them
send a third.

### 3.2 The inventory CSV import doubled every delta — **fixed**

`#ic-apply` had **no guard at all**, not even `disabled`. A second click re-applied every `adjust`
row to the local dataset; `DB.save()` is debounced by 700 ms, so both clicks coalesced into a single
sync request carrying **doubled quantities**, which the server wrote as one absolute value with no
way to know it was wrong. (`set` mode was always safe.)

Fixed with an `applying` flag, a synchronous `disabled`, and clearing the parsed rows so the file
must be deliberately re-chosen.

### 3.3 The stock ledger could not attribute a movement — **fixed**

`admin-inventory.js` passed `variation_id` / `warehouse_id` / `ref_type` / `ref_id` while
`recordMovement()` reads `variationId` / `warehouseId` / `refType` / `refId`. **Every adjustment and
transfer since the security-hardening batch wrote `variation_id = NULL`.**

This is my own defect from that batch, and it is worse than cosmetic: an unattributable movement is
precisely what you would need in order to *detect* a duplicated adjustment after the fact.

### 3.4 The purchase-order receipt was fragile — **fixed**

`received` and the stock quantity are both **increments**, so a replay is not idempotent. It escaped
doubling only because the whole handler is synchronous and `close()` detaches the modal first —
inserting a single `await` anywhere above would have broken it. Now guarded explicitly.

### 3.5 Inventory adjustments had no server-side idempotency — **fixed**

An adjustment applies a **signed delta**, so it is inherently non-idempotent: two identical requests
legitimately mean +20, and there is no absolute value the server could compare against.

So the key identifies **the press, not the content**. The server does not derive one from the
request — identical content is exactly what a genuine second adjustment looks like, and refusing it
would make correcting a count twice in a row impossible. The admin panel supplies one per press;
omitting it preserves the old behaviour for every existing caller (the ordering path, the sync path
and every historical movement pass none).

When the ledger refuses the movement, the handler **throws**, which rolls the stock write back too —
without that, the quantity would move a second time against a ledger entry that already exists and
the two would disagree forever.

---

## 4. Deliberately not changed

- **Order status, collected counts and the order total.** These are ABSOLUTE writes
  (`set collected = least($3, qty)`; the total is recomputed from stored lines), so replaying them
  is already a no-op. A key would be ceremony without a property.
- **Low-risk presentation controls** — filters, pagination, tab switches, search. The brief excludes
  them and they mutate nothing.
- **A general order state machine.** `pending → shipped → pending` is currently permitted, which is
  a missing *transition* guard rather than a duplicate-submission hazard. Recorded here as a known
  gap rather than fixed inside a sweep whose scope is duplicates.
- **The public-form throttle key.** It is keyed on the Astro container's IP rather than the
  visitor's, so the 8-per-window budget is shared across all visitors. That is an availability
  concern, not a duplication one, and is carried to the handover.

---

## 5. Shared helpers

`js/util.js` gained `guarded()`, `keyedGuard()` and `bindAction()` — one in-flight primitive so
future controls get the guard and the affordance together, rather than only the second.

---

## 6. Verification

`test/idempotency-sweep.test.js` — 37 tests. Each fires the same operation two or three times and
asserts exactly one row, one movement or one message.

One property of that suite is worth recording, because getting it wrong made every test pass for the
wrong reason first time: **the database double serialises transactions**. A naive snapshot-and-restore
rollback interleaves under `Promise.allSettled`, so the second transaction's rollback wipes the
first's committed writes — reporting a balance that moved zero times when the code moved it once.
Every contended path here takes `for update` on the row it is about, so PostgreSQL serialises them in
practice; the mutex models that, and it is what lets the second transaction *see* the first's writes
and collide with the unique constraint as it should.
