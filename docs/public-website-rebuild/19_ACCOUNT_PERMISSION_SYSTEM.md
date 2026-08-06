# 19 — B2.4P Account-Specific Capability Permissions

Per-account capability grants, replacing role-only authority on the public-content administrative
API. This is the implementation of management's stated requirement, *"Specific permissions for
specific accounts."*

Scope is B2.4P only: schema, registry, resolution, enforcement, management API, tests and this
document. **No permission was granted to any account. No frontend was built. No unrelated
role-protected route was rewritten. Nothing was deployed.**

---

## 1. What changed, in one paragraph

Before B2.4P the platform had role-based access control only — `users.role`, a single text enum, so
every `admin` had identical authority (risk R-17). B2.4P adds an additive `account_permissions`
table holding **grants to individual accounts**, a frozen registry of exactly four capability keys,
a resolution service, and a middleware. The public-content router's authorisation seam
(`requirePublicContentAdmin()`, introduced in B2.4A precisely so this swap would be one edit) now
proves **identity only**; authority is a per-route capability. Two `admin` accounts with different
grants now genuinely differ in what they can do, and an `admin` with no grant can do nothing on this
API.

---

## 2. The capabilities

> **Update, Fast-Track WS2 Phase 2 (2026-08-06).** Two capabilities were added — `enquiries.view`
> and `enquiries.manage`. This section described four; it now describes six. Everything else below
> is unchanged, and §14 records what adding them involved. The registry order is
> `public_content.view`, `public_content.edit`, `public_content.publish`, `permissions.manage`,
> `enquiries.view`, `enquiries.manage`.

The registry is a frozen constant in `platform/server/api/src/permission-registry.js`. It is the
single source of truth, and it is closed:

| Key | Grants |
|---|---|
| `public_content.view` | Read public-content records in the admin API, and run the publication-gate evaluation (a read-only dry run). |
| `public_content.edit` | Modify public-content fields (`PATCH`). Does **not** permit publishing. |
| `public_content.publish` | Publish and unpublish. Does **not** permit editing. |
| `permissions.manage` | Grant and revoke capabilities on other accounts. |
| `enquiries.view` | Read public enquiry submissions, including the enquirer's contact details and message. Changes nothing. |
| `enquiries.manage` | Record how an enquiry is being handled. Never deletes a submission and never edits what was submitted. |

**There are no other keys, and no way to invent one.** This is enforced at four independent layers,
so a bypass at any one of them still fails:

1. **Database** — a `CHECK` constraint listing every registered literal (`0008`, widened by `0009`).
   An unknown key cannot be stored.
2. **Registry** — `isRegisteredPermission()` does an exact match with no normalisation, trimming or
   case-folding.
3. **API validation** — `validatePermissionKeyList()` rejects an unknown key with `400` rather than
   silently dropping it, so a typo is visible instead of quietly under-granting.
4. **Resolution** — `getUserPermissions()` filters its own database output through the registry, so
   a row inserted by hand outside the API still resolves to nothing.

### Deliberately excluded

**No wildcards, prefixes or hierarchy.** `*`, `public_content.*` and `public_content` are not keys
and never resolve. There is no prefix matching, no `LIKE`, no dotted-segment expansion — the dot in
`public_content.view` is part of an opaque string, not a tree. A wildcard would mean a future
capability is granted retroactively to people who were never reviewed for it.

**No role names as keys.** `admin`, `warehouse` and `agent` are not permission keys.

**No client-defined names.** The key list arrives from the client only as a set of *choices among the
four*; the client can never name a new one.

---

## 3. Schema

`platform/server/db/migrations/0008_account_permissions.sql`, mirrored idempotently in
`ensureSchema()` in `platform/server/api/src/migrate.js`. Additive only: no existing table, column,
constraint or role meaning was altered, and `users.role` keeps working exactly as before.

```
account_permissions
  id              text primary key default veyora_id('perm')
  user_id         text not null → users(id) on delete cascade
  permission_key  text not null   CHECK in the four registered keys
  is_active       boolean not null default false
  granted_by      text → users(id) on delete set null
  granted_at      timestamptz
  revoked_by      text → users(id) on delete set null
  revoked_at      timestamptz
  created_at, updated_at  timestamptz not null default now()

  unique (user_id, permission_key)
  check (is_active = false or granted_at is not null)
  check (is_active = true or revoked_at is null or revoked_by is not null)
```

**`is_active` defaults to `false`.** A row that appears by any means other than a deliberate grant
confers nothing. The table ships empty and **the migration contains no `INSERT`** — no account,
including existing administrators, receives anything automatically. This is the point: an automatic
grant to all admins would reproduce the role model the batch exists to replace.

**One row per (account, capability), for the lifetime of the pairing.** Revocation flips `is_active`
and stamps `revoked_by`/`revoked_at`; it never deletes. A re-grant reactivates the same row. The
history of who granted what, and who took it away, therefore survives in place, and the
`on delete set null` on the two attribution columns means deleting a former manager's account does
not erase the record of what they did. `user_id` cascades because a grant is meaningless without the
account it belongs to.

The two `CHECK` constraints make an unattributed state unrepresentable: an active grant must have a
grant time, and a revoked row must name a revoker.

---

## 4. Resolution

`platform/server/api/src/permissions.js`.

```js
getUserPermissions(db, userId)              // → string[] of registered keys
hasPermission(db, userId, key)              // → boolean
hasAllPermissions(db, userId, keys)         // → boolean
requirePermission(key)                      // express middleware
requireAllPermissions(keys)                 // express middleware
countActiveHolders(db, key)                 // for the last-manager guard
```

An account resolves a capability when **all** of the following hold:

- the account exists and `users.status = 'active'`;
- an `account_permissions` row exists for that exact `(user_id, permission_key)`;
- that row has `is_active = true`;
- the key is in the registry.

Everything else denies. In particular:

- **A role grants nothing.** `permissions.js` never reads `users.role`. There is no admin fallback,
  no superuser, and no "if all else fails, allow" branch.
- **A disabled or pending account resolves nothing**, even with active grants — so suspending an
  account immediately removes its authority without needing to revoke each capability.
- **An unregistered key fails closed before any query runs.** A typo in a `requirePermission(...)`
  call denies everyone rather than admitting everyone.
- **Nothing is read from the request.** The resolver never touches `req.headers`, `req.body` or
  `req.query`; a client cannot assert a permission it does not hold.

**Resolution is deliberately not cached.** Every check re-reads. The alternative — caching grants on
the session or in memory — would mean a revocation does not take effect until the cache expires or
the user logs in again, which is unacceptable for the case that matters most: removing someone's
authority *right now*. The cost is one indexed lookup on a table with at most four rows per account.

### HTTP responses

| Situation | Status | Body |
|---|---|---|
| Not authenticated | `401` | `{ "error": "unauthorized" }` |
| Authenticated, capability not held | `403` | `{ "error": "forbidden" }` |

The `403` body is deliberately identical regardless of *why* the capability was not held (never
granted, revoked, unregistered key, disabled account) — an authorisation failure should not narrate
the permission model to the caller.

---

## 5. Enforcement on the public-content API

`platform/server/api/src/routes/admin-public-content.js`. The B2.4A seam kept its position and lost
its role:

```js
export function requirePublicContentAuth() {
  return requireAuth();          // identity only — NO role arguments
}

export const PUBLIC_CONTENT_CAPABILITIES = Object.freeze({
  read:     'public_content.view',
  evaluate: 'public_content.view',
  edit:     'public_content.edit',
  publish:  'public_content.publish',
});
```

`requireAuth()` is called with no role arguments **on purpose**. Passing `'admin'` here would be a
bypass: every admin would pass the router gate and the per-route capability would be the only thing
standing between them and the data, with the role check silently narrowing who could hold a grant at
all. Authentication proves *who you are*; the capability decides *what you may do*.

| Route | Capability |
|---|---|
| `GET /brands`, `/brands/:id`, `/products`, `/products/:id`, `/variations/:id` | `public_content.view` |
| `POST …/evaluate` | `public_content.view` |
| `PATCH /{brands,products,variations}/:id` | `public_content.edit` |
| `POST …/publish`, `POST …/unpublish` | `public_content.publish` |

`evaluate` is a **read**: it reports whether a record *would* pass the publication gate and changes
nothing, so someone who may look at content may check why it is not publishable, without being able
to publish it.

Edit and publish are **separate capabilities, not a hierarchy.** An editor who may write copy cannot
push it live; a publisher who may push live cannot rewrite copy first. Either can be granted alone,
and holding both is a deliberate decision recorded as two grants.

### Unchanged by design

- **The public read-only API (`/public/*`)** is untouched: still unauthenticated, still read-only,
  still no write route. Public visitors are not accounts and hold no capabilities.
- **Existing role-protected admin routes** keep `requireAuth('admin', 'warehouse')` exactly as
  before. B2.4P did not rewrite the platform's authorisation; it introduced capabilities where the
  requirement demanded them. Migrating the rest is a separate, larger decision.

---

## 6. Management API

`platform/server/api/src/routes/account-permissions.js`, mounted at **`/admin/account-permissions`**.

Every route is behind `requireAuth()` **and** `requirePermission('permissions.manage')`. An `admin`
without that capability is refused — **there is no self-grant path**. This is the property that makes
the whole model meaningful: if any admin could grant themselves `public_content.publish`, the grants
would be decoration.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/registry` | The four capabilities with labels and descriptions, for an assignment screen. |
| `GET` | `/users/:userId` | An account's grants (active and revoked) plus a concurrency token. |
| `PUT` | `/users/:userId` | Replace the account's **active** capability set. |

**There is no `DELETE` route.** Removal happens through `PUT` with the capability omitted, which
revokes in place and preserves history. A `DELETE` would invite row deletion and destroy the audit
trail.

### `PUT` semantics

Request:

```json
{ "permissions": ["public_content.view", "public_content.edit"],
  "concurrencyToken": "perms:u_abc:…" }
```

The body is the **complete desired active set**. Keys present are granted; registered keys absent
are revoked; **grants that are already correct are left completely alone** — no row is rewritten, so
`granted_by`/`granted_at` keep their original attribution and `updated_at` does not churn. An empty
array is valid and means "revoke everything".

Response echoes the account, all permission rows, `activePermissions`, a **new** `concurrencyToken`,
and `granted` / `revoked` arrays naming what actually changed.

### Attribution

`granted_by` and `revoked_by` come from `req.user` — the authenticated session — and **never from the
request body**. The router passes `actor: req.user` and nothing else. A caller cannot attribute their
own grant to someone else.

The audit log is written **after the transaction commits**, and **only when something actually
changed**, so it can never record a change that rolled back or a no-op replacement.

### Data exposure

`GET /users/:userId` returns only `{ id, displayName, role, status }` for the target account —
deliberately **not** email, phone, address, tax id, balance or pricing. A permissions screen is not a
customer-record screen, and this endpoint is reachable by everyone holding `permissions.manage`,
which may well be a smaller and different group than those cleared to see customer data.

---

## 7. Concurrency and the last-manager guard

### Optimistic concurrency

The token is `perms:{userId}:{version}`, where the version is every row's
`key:active:updated_at`, sorted. It is **bound to the account id**, so a token issued while viewing
one account cannot be replayed against another. Any change by another manager — grant, revoke or
re-grant — changes the version.

`PUT` runs in a transaction that first takes `SELECT … FOR UPDATE` on the account's permission rows,
then compares the token. A mismatch throws, which rolls back, so **a stale attempt writes nothing**
and returns:

```json
{ "error": "These permissions changed since you loaded them. Reload and reapply your change.",
  "code": "STALE_TOKEN" }
```

The lock and the token do different jobs: the lock stops two transactions interleaving; the token
stops a *lost update*, where a manager overwrites a change they never saw. A missing token is treated
as stale, so an unversioned client cannot bypass the check.

### Last-manager protection

Revoking `permissions.manage` counts the remaining active holders **inside the transaction, after the
lock**, via `countActiveHolders`. If one or fewer would remain, it returns:

```json
{ "error": "This would remove the last account able to manage permissions. …",
  "code": "LAST_PERMISSION_MANAGER" }
```

Counting inside the transaction is the whole point. A check performed before the transaction began
would let two concurrent revocations each observe one other manager and both proceed — locking
everybody out of permission management, with no route back except a manual database operation on
production. The count also requires `users.status = 'active'`, so a disabled manager does not count
as cover.

---

## 8. Bootstrap — creating the first permissions manager

**The first `permissions.manage` grant cannot come from the API**, because the API requires that
capability to use it. It also must not come from a migration, because a migration that grants
authority runs unreviewed on every deployment. It is therefore a deliberate, reviewed, one-time
database operation.

> **This has not been performed.** No permission has been assigned to any real account. The SQL
> below uses a placeholder and is documentation of the intended procedure, not a script that was
> run. B2.4P was explicitly forbidden from contacting a live database.

### Procedure

1. **Choose the account deliberately.** It should be an account whose holder is authorised to decide
   who may publish to the public website. Identify it by a unique attribute you have verified — not
   by guessing an id.

2. **Find its id and confirm it is the right account, before granting anything:**

   ```sql
   select id, username, role, status from users where username = '<REPLACE_WITH_USERNAME>';
   ```

   Confirm exactly one row, that `status` is `active`, and that it is the intended person.

3. **Grant `permissions.manage`, substituting the id from step 2:**

   ```sql
   insert into account_permissions (user_id, permission_key, is_active, granted_by, granted_at)
   values ('<REPLACE_WITH_USER_ID>', 'permissions.manage', true, '<REPLACE_WITH_USER_ID>', now())
   on conflict (user_id, permission_key)
   do update set is_active = true, granted_at = now(), revoked_by = null, revoked_at = null;
   ```

   `granted_by` is set to the account itself: this grant has no prior grantor, and recording it
   self-attributed is honest about that. Every later grant is attributed to a real actor by the API.

4. **Verify:**

   ```sql
   select u.username, ap.permission_key, ap.is_active, ap.granted_at
     from account_permissions ap
     join users u on u.id = ap.user_id
    where ap.permission_key = 'permissions.manage' and ap.is_active;
   ```

   Expect exactly one row, naming the intended account.

5. **Roll back if wrong** — revoke rather than delete, so the mistake and its correction are both on
   record:

   ```sql
   update account_permissions
      set is_active = false, revoked_by = '<REPLACE_WITH_ACTOR_USER_ID>', revoked_at = now()
    where user_id = '<REPLACE_WITH_USER_ID>' and permission_key = 'permissions.manage';
   ```

   If the row was created entirely in error and never used, `delete from account_permissions where
   user_id = '…' and permission_key = 'permissions.manage';` is acceptable — but prefer revocation.

### Warnings

- **Grant `permissions.manage` to at least two active accounts** as soon as the first manager can use
  the API. The last-manager guard prevents lockout by *revocation*, but it cannot help if the single
  manager's account is disabled, lost or belongs to someone who leaves.
- **Run every statement above inside a transaction** and confirm the verification query before
  committing.
- **Never widen the `CHECK` constraint by hand** to store an unregistered key. The resolver filters
  through the registry, so such a row confers nothing — it only creates a misleading record implying
  authority that does not exist.
- **Do not script this into deployment.** Its value is that a human reviewed it once.

---

## 9. Tests

`test/permissions.test.js` (29) and `test/account-permissions.test.js` (41) — 70 new tests. The full
API suite is **797 passing, 0 failing**. Real handlers and real middleware run against injected
database doubles; source inspection is used only for structural properties that cannot be observed at
runtime (for example, that the resolver contains no `startsWith` prefix matching).

Coverage includes: schema/`ensureSchema` alignment and the absence of any automatic grant; the closed
registry, with wildcards, prefixes, role names and case variants all rejected; resolution for
granted, ungranted, revoked, disabled and unknown-key cases; **a role-only administrator denied on a
capability route, and a non-admin holding the grant allowed**; permission forgery attempts via
headers, body and query; the full route→capability mapping; transactional rollback; stale-token
`409`; cross-account token replay; last-manager `422` with the count proven to run after the lock;
revocation preserving history; the absence of a `DELETE` route; and the serializer's exclusion of
customer data.

Three B2.4A tests that asserted the *role* model were updated to assert the capability model. That is
the intended supersession, not a weakening: the replacements are stricter, additionally requiring
that no role name gates any route.

---

## 10. What is deliberately not done

- ~~**No assignment UI.** The management API exists; the screen that drives it does not.~~
  **Delivered in B2.4B1 (2026-08-06)** — see §11.
- **No real permission assigned to any account**, and no bootstrap performed.
- **No automatic grant to existing administrators.**
- **No migration of unrelated admin routes** to capabilities.
- **No changes to the Astro site, the storefront, the public API or deployment.**

R-17 therefore remains **open**, with its likelihood reduced. It closes when the assignment interface
exists and the controlled production bootstrap has been performed and verified.

---

## 11. Interface status — B2.4B1, 2026-08-06

**The assignment interface now exists.** The admin panel (the vanilla-JS SPA at the repository root)
has an **Account Permissions** screen at `#/account-permissions`: it reuses the existing account
list, renders the four registry capabilities as checkboxes, shows grant and revocation history,
requires an explicit save, sends the complete intended set with the concurrency token, and handles
`401`, `403`, `404`, `409` and `422` in operator-facing language. 53 frontend tests pass. Full
contract: [20_ACCOUNT_PERMISSION_INTERFACE.md](20_ACCOUNT_PERMISSION_INTERFACE.md).

The interface consumes the three endpoints from §6 unchanged. **No API endpoint was added or
modified, and no schema was touched.**

Because the panel's session carries a role and no capabilities, the screen determines access by
calling `GET …/registry` — itself gated on `permissions.manage` — and reading `200` versus `403`.
Anything else, including a network failure, is treated as *not held*. Hiding the nav entry is
convenience only; the API remains the sole authority, and there is no role bypass, no environment
flag and no hard-coded account anywhere in it.

### The bootstrap requirement is UNCHANGED

**Still outstanding, and still the blocker.** The interface cannot create the first permissions
manager and deliberately contains no bypass to do so:

- `account_permissions` remains empty. No permission has been granted to any real account.
- Every capability probe therefore returns `403`, so **the screen is currently unreachable by every
  account**, including every existing administrator, and the public-content API is unusable by
  everyone. This is the intended fail-closed state.
- The first `permissions.manage` grant must still be performed as the reviewed, one-time database
  operation in **§8** — it cannot come from the API (which requires the capability) and must not
  come from a migration (which would run unreviewed on every deployment).
- Immediately afterwards, that first manager should use the new screen to grant `permissions.manage`
  to **a second trusted active account**. The last-manager guard prevents lockout by revocation but
  cannot help if a single manager's account is lost or disabled.

Until §8 has been performed and verified in production, B2.4P and B2.4B1 together deliver a complete
but **dormant** permission system.

---

## 12. Capability consumption status — B2.4B2A, 2026-08-06

All four capabilities now have a working consumer, except publish.

| Capability | Consumed by |
|---|---|
| `permissions.manage` | Account Permissions screen (B2.4B1) — [20_ACCOUNT_PERMISSION_INTERFACE.md](20_ACCOUNT_PERMISSION_INTERFACE.md) |
| `public_content.view` | Public Content lists and read-only editors (B2.4B2A) — [21_PUBLIC_CONTENT_EDITOR.md](21_PUBLIC_CONTENT_EDITOR.md) |
| `public_content.edit` | Draft editing in the same screens (B2.4B2A) |
| `public_content.publish` | **No interface yet.** The API endpoints exist and are gated; the controls are B2.4B2B. |

B2.4B2A added `GET /admin/public-content/capabilities`, which reports the caller's own three
public-content capabilities as booleans. It is authenticated but **ungated**, so an account holding
none receives an honest all-false answer. §6's endpoints could not express that: a 200/403 probe
proves only `view` and cannot distinguish a viewer from an editor without attempting a write.

**A publish bypass was found and fixed.** Because brands have no `is_published` column,
`publication_state = 'published'` is their publication flag — and it was PATCH-editable under
`public_content.edit` alone. Edit could therefore publish a brand to the live public site, bypassing
the `public_content.publish` capability, the publication gate and the approval record. A
transactional boundary guard now refuses that transition in either direction. Detail:
[21_PUBLIC_CONTENT_EDITOR.md](21_PUBLIC_CONTENT_EDITOR.md) §1 and
[18_B2_ADMIN_PUBLICATION_API.md](18_B2_ADMIN_PUBLICATION_API.md) §14.2.

This is worth recording against §5: the capability split is only as strong as the fields each
capability can reach. A field that is editable and also load-bearing for publication silently merges
two capabilities into one.

### The bootstrap requirement is STILL unchanged

No account holds any capability. `/capabilities` returns all false for everyone, so **both**
governance screens are unreachable and public content can be neither read nor edited by anyone,
including every existing administrator. The §8 procedure remains the only way in, and nothing in
either interface can perform or bypass it.

---

## 13. All four capabilities now have an interface — B2.4B2B, 2026-08-06

| Capability | Consumed by |
|---|---|
| `permissions.manage` | Account Permissions screen (B2.4B1) — [20_ACCOUNT_PERMISSION_INTERFACE.md](20_ACCOUNT_PERMISSION_INTERFACE.md) |
| `public_content.view` | Public Content lists, read-only editors, and the publication readiness check (B2.4B2A/B) |
| `public_content.edit` | Draft editing (B2.4B2A) |
| `public_content.publish` | Publish and unpublish decisions (B2.4B2B) — [22_PUBLICATION_WORKFLOW_INTERFACE.md](22_PUBLICATION_WORKFLOW_INTERFACE.md) |

§12 recorded that `public_content.publish` had no interface. It now has one, and the four
capabilities are demonstrably independent end to end: an editor cannot publish, a publisher cannot
edit, and neither can grant themselves anything.

Note that the **readiness check is gated on `view`, not `publish`** — the evaluate route is a read
that computes a verdict and writes nothing, so a reviewer can see why a record is not ready without
being able to act on it. §5's capability table is unchanged; this is simply how the existing gating
reads in practice.

### A second defect, following from the first

§12 recorded the publish bypass B2.4B2A closed. Closing it exposed a deadlock: the gate required a
record to be **already published** before it would allow publishing, which for brands — whose
`publication_state` *is* the live flag — became unsatisfiable once PATCH could no longer reach that
state. It also made unpublication one-way for every entity type, because unpublish returns a record
to `approved`. Fixed in `publication-gate.js`: `approved` and `published` both pass. Detail:
[18_B2_ADMIN_PUBLICATION_API.md](18_B2_ADMIN_PUBLICATION_API.md) §15 and
[22_PUBLICATION_WORKFLOW_INTERFACE.md](22_PUBLICATION_WORKFLOW_INTERFACE.md) §1.

Both defects are worth remembering against §5: **a capability split is only as strong as the state
machine underneath it.** The first merged two capabilities into one; the second made the governed
path impossible, which is the failure mode that would have pushed an operator back toward the bypass.

### The bootstrap requirement is STILL unchanged

No account holds any capability. `/capabilities` returns all false for everyone, so every
public-content screen — review, editing and now publication — is unreachable by every account,
including every existing administrator. §8 remains the only way in, and no interface can perform or
bypass it.

---

## 14. Two capabilities added — Fast-Track WS2 Phase 2, 2026-08-06

`enquiries.view` and `enquiries.manage` are the first capabilities added since B2.4P, and the first
that govern **personal data belonging to members of the public** rather than editorial content.
Full detail: [27_ENQUIRY_OPERATIONS.md](27_ENQUIRY_OPERATIONS.md).

### They are separate keys, deliberately

Reusing `public_content.view` to read enquiries would have been one line and no migration. It was
rejected: publishing brand copy and reading somebody's name, email address and message are different
authorities held by different people, and folding them together would have silently handed every
existing content reviewer a personal-data inbox nobody granted them — §1's failure, reintroduced.

A capability is cheap to add and impossible to un-grant retroactively. When in doubt, add the key.

### What adding a capability actually took

The four-layer model in §2 held: each layer had to be changed deliberately, which is the friction
working as designed.

1. **Registry** — two entries appended (order is stable; existing keys did not move).
2. **Database** — migration `0009` drops `0008`'s anonymous CHECK (`if exists`) and adds an
   explicitly named `account_permissions_permission_key_registered` carrying all six keys. **`0008`
   is not edited** — a migration that has run is immutable, and on a fresh volume `0009` runs moments
   later in the same initialisation. `ensureSchema()` mirrors it idempotently.
3. **API validation and resolution** — no change needed. Both read the registry.
4. **Tests** — the exhaustive registry assertion had to be edited, which is the point of writing it
   as `deepEqual` rather than "contains": a capability appearing without anyone approving it is
   exactly what that test exists to catch.

### The bootstrap requirement is STILL unchanged

`0009` contains no `INSERT` of any kind. **No account holds `enquiries.view` or `enquiries.manage`**,
including accounts that already hold every `public_content` capability and `permissions.manage`. Until
§8 is performed and the new keys are granted per account, no enquiry is readable by anyone through
the platform. No interface can perform or bypass that.

---

## 15. Bootstrap safeguards — Security Hardening Phase 5, 2026-08-06

§8's procedure is unchanged and still correct. What was missing was a way to check a **proposed**
bootstrap before running it, and that now exists.

### The planner

```
node platform/server/api/scripts/plan-permission-bootstrap.js --input candidates.json
```

It is **pure and structurally unable to reach a database**: it imports no `pg`, no `db.js`, no
connection variable and no network client, and it refuses a URL as input. A test asserts each of
those. It renders SQL as **text for a person to read and run**; it executes nothing.

Its input comes from a supervised read-only query the operator runs themselves:

```sql
select id, username, email, role, status from users where status = 'active';
```

### Blocking findings — the plan must not be executed

| Code | Why it blocks |
|---|---|
| `TOO_FEW_MANAGERS` | Fewer than **two** active holders would remain. The API refuses to revoke the last one, so a single holder means losing that account locks everybody out with no route back except manual SQL. |
| `INACTIVE_ACCOUNT` | A disabled or pending account resolves no capability, so the grant would be inert. |
| `UNKNOWN_ACCOUNT` | The id matches nothing. Never silently skipped. |
| `DUPLICATE_SELECTION` | The same account is selected twice. |
| `AMBIGUOUS_USERNAME` | More than one account shares that username. **Granting the wrong account is the mistake this exists to prevent, and a duplicated username is how it happens.** |

### Warnings — a human decides

`POSSIBLY_SHARED_ACCOUNT` when a username or email looks shared (`office`, `admin`, `info`, `team`,
`support`, …). The planner cannot know whether "office" is one person; it says so rather than
guessing. **Every audit entry a shared login writes is unattributable**, and `permissions.manage` is
the last capability that should sit behind one.

### The rendered operation

Confirms the accounts with a `SELECT` first · grants inside a **transaction** · verifies in the
**same session before committing** · carries the rollback statement, which **revokes rather than
deletes** so the mistake and its correction both stay on record · grants **only**
`permissions.manage` and nothing else.

### The review checklist

Returned as data by `reviewChecklist()`, so the script and this document cannot drift:

- each selected account belongs to **one named person**, not a shared login;
- each holder is authorised to decide who may publish to the public website;
- **at least two** active holders exist afterwards;
- every account is active, and its id was confirmed by a `SELECT` before granting;
- the grant runs in a transaction, with verification in the same session;
- the rollback statement is to hand **before** the grant is executed;
- no capability other than `permissions.manage` is granted;
- a named person performs it on a supervised connection, and records that they did.

### Still unchanged

**No bootstrap has been performed. No account holds any capability.** Every governed screen remains
unreachable by every account, including every existing administrator, until §8 is carried out.
