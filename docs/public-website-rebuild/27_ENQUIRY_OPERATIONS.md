# 27 — Governed Enquiry Operations

How submissions from the public website's enquiry forms are read, handled and retained — and why
reading one requires a capability nobody holds by default.

**No real enquiry data was processed.** No production system, VPS or live database was contacted, no
capability was granted to any real account, and every submission in the tests is invented and uses
`example.test` addresses.

---

## 1. What was missing

The public site has been storing enquiries since the forms shipped
([24_PUBLIC_ENQUIRY_FORMS.md](24_PUBLIC_ENQUIRY_FORMS.md)): a submission lands in `form_submissions`
with `delivery_state = 'pending'`, and stays there. Nothing in the platform could read it.

So the situation before this phase was that a visitor could send Veyora their name, email address and
a message, and nobody could see it without a database client. Two things were needed: somewhere to
record how each submission is being handled, and an authority model for reading them.

---

## 2. Two new capabilities, and no reuse of an existing one

| Key | Confers |
|---|---|
| `enquiries.view` | Read submissions, including the enquirer's contact details and message. Changes nothing. |
| `enquiries.manage` | Record how an enquiry is being handled. Never deletes, never edits what was submitted. |

**Neither is a `public_content` capability, and that is the point.** Publishing brand copy and reading
a member of the public's personal details are different authorities held by different people.
Attaching enquiry access to `public_content.view` would have silently handed every existing content
reviewer a personal-data inbox nobody granted them — the exact "every admin is equivalent" failure
the capability system exists to remove ([19_ACCOUNT_PERMISSION_SYSTEM.md](19_ACCOUNT_PERMISSION_SYSTEM.md) §1).

The rules from B2.4P hold unchanged and are re-asserted by this phase's tests:

- **No role fallback.** `requireAuth()` is called with no role arguments. An `admin` role alone
  satisfies nothing on this router.
- **No wildcard, no prefix matching.** `enquiries.*` is not a key and never resolves.
- **No automatic grant.** Migration `0009` contains no `INSERT` of any kind. No account — including
  one already holding all three `public_content` capabilities and `permissions.manage` — receives
  either key from a deploy. They are granted one account at a time through the management API
  ([20_ACCOUNT_PERMISSION_INTERFACE.md](20_ACCOUNT_PERMISSION_INTERFACE.md)).
- **`view` does not imply `manage`.** A holder of `enquiries.view` reading an enquiry and pressing a
  decision gets a 403 from the API, and gets no buttons from the screen.

---

## 3. Schema — migration 0009

Entirely additive. No column is dropped, no type is changed, no existing default is altered, and
every new column defaults to a value that already describes every existing row, so nothing is
back-filled and no data moves.

### The capability CHECK, widened

`0008` declared its CHECK inline, so PostgreSQL named it
`account_permissions_permission_key_check`. `0009` drops it (`if exists`) and replaces it with an
explicitly named `account_permissions_permission_key_registered` carrying all six keys. Dropping and
re-adding a CHECK moves no data, and the new predicate is a strict superset of the old one, so every
existing row already satisfies it.

**`0008` is not edited.** A migration that has run somewhere is immutable; on a fresh volume `0009`
runs moments later in the same initialisation, so the end state is identical either way.

### Handling state on `form_submissions`

| Column | Type | Notes |
|---|---|---|
| `handling_status` | `text not null default 'new'` | Constrained to the five registered states. |
| `handled_by` | `text references users(id) on delete set null` | Losing the handler's account must never rewrite the enquiry. |
| `handled_at` | `timestamptz` | Null only for `new`. |
| `handling_note` | `text not null default ''` | Internal, staff-authored. Never returned by any `/public` route. |

Two named constraints: `form_submissions_handling_status_valid` (the closed status set) and
`form_submissions_handling_attributed` (anything other than `new` must record who and when). Two
indexes: `handling_status`, and `created_at desc` for the list's ordering.

### `handling_status` is not `delivery_state`

`delivery_state` already exists and records whether the platform managed to forward the submission
onward — a machine's business. `handling_status` records what a person decided to do about it.
Overloading one column to mean both would make "we could not email it" and "we have replied"
indistinguishable.

### Ordering

`db/migrations/*.sql` run **only on a fresh volume**. An existing database picks `0009` up through
`api/src/migrate.js`'s `ensureSchema()`, which mirrors every statement idempotently and runs at API
startup — the mechanism this repository has used since go-live. A test asserts the two definitions
stay aligned fragment by fragment.

---

## 4. The handling model

```
                    ┌──────────────┐
        new ───────►│  in_review   │◄──────── closed
         │          └──────┬───────┘◄──────── spam
         │                 │        ◄──────── responded
         ├───────────►  responded ──────────► closed
         ├───────────►  closed
         └───────────►  spam
```

| From | May move to |
|---|---|
| `new` | `in_review`, `responded`, `closed`, `spam` |
| `in_review` | `responded`, `closed`, `spam` |
| `responded` | `in_review`, `closed` |
| `closed` | `in_review` |
| `spam` | `in_review` |

The map is a closed allowlist in `api/src/enquiry-operations.js`. Anything absent is refused, and
`canTransition` returns false for anything it does not positively recognise — including `undefined`,
`null` and non-strings.

Two properties are deliberate:

- **No state is terminal.** `closed` and `spam` both lead back to `in_review`, because a real
  customer's enquiry filed as spam by a mis-click must be recoverable without a database operation.
  A one-way door here would mean the only fix is somebody with production SQL access.
- **Nothing returns to `new`.** It means "nobody has touched this", which stops being true the moment
  somebody does. Allowing a return would let an operator erase the fact that the enquiry was seen.

A no-op transition (`from === to`) is refused rather than reported as success: it is either a
double-click or a screen working from a state somebody else has already changed, and treating it as
success would stamp a handler who did nothing.

---

## 5. API

Mounted at `/admin/enquiries`, **before** the general `/admin` router — that router admits several
roles for operational work, and none of them has any business reading a member of the public's
contact details.

| Route | Capability | Notes |
|---|---|---|
| `GET /capabilities` | authenticated only | Two booleans plus the frozen handling contract. |
| `GET /` | `enquiries.view` | Paginated, filtered, newest first. |
| `GET /:id` | `enquiries.view` | Full record, retention metadata, concurrency token. |
| `POST /:id/status` | `enquiries.manage` | The only write. |

There are exactly four routes, asserted by test.

### Capability discovery is deliberately ungated

An authenticated account holding neither capability must still get an honest all-false answer, so the
UI can render an accurate no-access state rather than a failure. A 200/403 probe on a gated route
could not substitute: 200 on a read only ever proves `view`, and discovering `manage` by attempting a
transition would mean changing an enquiry to find out whether you may.

It returns two booleans describing only the caller — no user record, no role, no other capability
(a caller holding `permissions.manage` learns nothing about it here), nothing about any other
account — resolved fresh on every call so a revocation takes effect immediately.

### What the API cannot do

- **It cannot delete a submission.** No DELETE route, no `DELETE` statement, no `'deleted'` status.
  A submission is a record of something a member of the public sent us; it is closed or marked spam,
  never erased on an operator's say-so. Removal is a retention matter (§7).
- **It cannot edit what was submitted.** The only `UPDATE` in the router names four columns, all of
  them the handling columns `0009` added. `payload`, `consent_at`, `consent_version`, `form_type`,
  `source_url`, `region` and `business_type` never appear on either side of a `SET`.
- **It cannot re-send anything.** `delivery_state` is neither read out nor written.

### Serialization

Explicit allowlists building fresh object literals, never spreading a database row.

- **The list row omits the free text and the email address.** A list exists to let an operator find
  the enquiry they need; rendering everyone's message on one screen is how a support inbox becomes a
  data-exposure surface over a colleague's shoulder. The detail view is one click away.
- **The detail record re-filters `payload` through the current form field allowlist**, rather than
  returning it as stored. A field removed from a form stops being surfaced, and a value that reached
  the column another way is never echoed to a screen.
- **Delivery mechanics never reach an operations screen.** `delivery_state`, `attempts` and
  `last_error` are absent from both serializers: they describe a mechanism that is not built, and
  showing "failed" would tell an operator something is wrong when nothing is.

### Paging

`limit` is clamped to 100 and defaults to 25. An unbounded page is how a screen accidentally becomes
an export. Ordering is `created_at desc, id desc` — the tiebreak makes it total, so two submissions
stored in the same transaction cannot swap places between pages and hide a row.

### Filters

`status` and `formType` are validated against closed sets **before any SQL runs**; an unrecognised
value is a 400. A filter that appears to work and silently does not is how a screen shows an operator
rows they believed they had excluded. Both are also parameterised.

### Concurrency

The token is `enquiry:<id>:<handling_status>:<handled_at>`, bound to the submission id so a token
issued while viewing one enquiry cannot be replayed against another. Any transition by another
operator invalidates a token a concurrent one is holding.

The transition runs in a transaction: `select … for update`, then the token check, then the legality
check, then an `UPDATE` whose `WHERE` repeats the expected current status — belt and braces behind
the row lock. A stale attempt throws, which rolls back, so it writes nothing.

### Attribution and audit

`handled_by` comes only from `req.user`. There is no way to send a handler id, so an operator cannot
record a transition as somebody else.

The audit entry (`enquiry.transition`) records the id and `from -> to`. It deliberately does **not**
carry the payload or the handling note, which may quote the enquirer. It is written after commit, so
the log cannot claim a transition that rolled back.

---

## 6. Admin interface

A new `Enquiries` entry in the root admin panel, gated on `enquiries.view` — hidden without it, and
an access-denied card on a direct visit to `#/enquiries`. As everywhere else in this panel, **frontend
hiding is convenience only; the API is authoritative.**

- `enquiries.view` renders the screens read-only. `enquiries.manage` adds the note box and the
  decision buttons, and only the transitions the server said were legal.
- **There is no delete control, because there is no delete endpoint.**
- **Nothing the enquirer wrote is editable.** The only writable control on the screen is the internal
  handling note, which is sent with the next decision and never on its own — a note is a record of
  how an enquiry was handled, not an independent edit.
- Every displayed value passes through `esc()`. An enquiry is free text a member of the public typed;
  rendering it unescaped would make the public form an injection vector into the admin panel. A test
  submits `<img src=x onerror=…>` and asserts it survives as text and produces no element.
- The capability probe is a **third, separate** call in `App.loadCaps()`. A content capability is
  never used to infer an enquiry one, and every failure path — 401, 403, network, malformed body —
  leaves both unheld.

---

## 7. Retention

Derived, never stored: `forms.retention_days` for the form type (defaulting to 365 when no definition
row exists, which is the current state of every environment) plus `created_at` gives a date. Computing
it means changing the policy changes every answer at once, instead of leaving already-stamped rows
describing the old one.

`daysRemaining` goes negative once the period has elapsed rather than clamping to zero — the overrun
is the signal an operator needs. The detail screen says the record is due for removal, and says
plainly that removal is not performed from that screen.

**Actual deletion after the retention period is not implemented.** It is a scheduled, supervised
operation with its own review, and building it as an unattended job in this phase would mean shipping
an automatic destroyer of customer correspondence. Recorded as a release blocker in §9.

---

## 8. Tests

| Suite | Count | Covers |
|---|---|---|
| `api/test/admin-enquiries.test.js` | 61 | Capabilities and authority, the transition model, serialization, handlers, concurrency, "nothing is deleted". |
| `test/enquiries-page.test.js` | 24 | The rendered screen driven as an operator would: access states, list, detail, decisions, failure handling, escaping. |
| `api/test/permissions.test.js` | +1 | Enquiry keys are distinct from every `public_content` key. |
| `api/test/account-permissions.test.js` | +1 | The widened CHECK is a strict superset and `0008` is not rewritten. |

Full suites after this phase: **API 1091 passing, root admin frontend 166 passing.**

---

## 9. Limitations and release blockers

1. **Nothing was run against a database.** All handler tests use a controlled double, as this
   repository's convention requires. `0009` has not been executed anywhere; a disposable-PostgreSQL
   migration rehearsal is a supervised RC prerequisite
   ([26_RELEASE_DEPLOYMENT_ARCHITECTURE.md](26_RELEASE_DEPLOYMENT_ARCHITECTURE.md) §9).
2. **Nobody holds either capability.** Both must be granted per account before anyone can read a
   single enquiry — a real business decision about who may see customer correspondence, not something
   to be automated. Blocker category B.
3. **Retention deletion is not implemented.** The metadata says when a record is due; nothing removes
   it. Blocker category C.
4. **Onward delivery is still not built.** Every submission remains `delivery_state = 'pending'`.
   This phase makes them readable, which removes the "enquiries are invisible" problem, but an
   email or CRM hand-off remains outstanding
   ([24_PUBLIC_ENQUIRY_FORMS.md](24_PUBLIC_ENQUIRY_FORMS.md) §8).
5. **No export.** Deliberate: a screen that can export personal data in bulk is a different risk from
   a screen that shows one enquiry at a time, and it was not asked for.
6. **No search.** Filters are status and form type only. Searching free text would mean querying
   personal data by content, which deserves its own decision.
7. **No assignment or ownership.** `handled_by` records who last moved an enquiry, not who owns it.
   A queue model was not specified.
