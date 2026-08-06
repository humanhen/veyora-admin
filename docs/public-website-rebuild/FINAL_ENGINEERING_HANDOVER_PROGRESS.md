# Final Engineering Handover — Progress

The last broad implementation workstream before engineering handover. Nine phases, each ending in a
**local** checkpoint commit. Nothing is pushed, deployed, or run against production.

---

## Run metadata

| | |
|---|---|
| **Branch** | `mathew/public-website-rebuild` |
| **Starting commit** | `c48b47f` — *fix: align warehouse interface with narrow workflows* |
| **Starting tree** | clean, `git diff --check` clean, full history |
| **Free space at start** | 8.2 GB |
| **Started** | 2026-08-07 |

### Baseline at the starting commit — verified, not assumed

| Suite | Result |
|---|---|
| API | 1,229 passing |
| Root admin frontend | 213 passing |
| Astro web | 466 passing |
| **Total** | **1,908 passing, 0 failing** |
| Release gates | **17/17 in 146 s** |

Matches the brief's expected baseline exactly.

---

## Safety boundary

Not done at any point: production or VPS access, live database connection, DNS changes, deployment,
capability bootstrap SQL, permission grants to real accounts, real catalogue or customer data
processing, real email, live Stripe keys, live Stripe API calls, live webhook registration, branch
merges, fast-forward of `main`, or `git push`.

Scope frozen as instructed: no Apple Pay or Google Pay as separate requirements, no
direct-to-consumer checkout, no forced payment at checkout, no automatic statement scheduling, no new
CRM or accounting platform, no application-wide redesign, no returns or warranty modules.

---

## Two decisions taken at Phase 0

### The approved invoice reference is ABSENT

`source-assets/invoice-reference/approved-invoice-reference.pdf` does not exist, and there is no
`source-assets/` directory at all.

Per the brief, Phase 5 therefore implements a **clean neutral Veyora invoice template** with all
functional PDF behaviour complete, and records **final visual matching as the only unresolved
invoice-design item**. No company legal details are invented — every unknown is an explicit,
labelled configuration placeholder carried into the client activation checklist.

### PDF generation needs a dependency, and the repository has none

The API has exactly eight runtime dependencies (`bcryptjs`, `cookie-parser`, `csv-parse`, `express`,
`jsonwebtoken`, `multer`, `nodemailer`, `pg`) and nothing capable of producing a PDF.

The repository has a strong precedent for hand-built format writers — `src/xlsx-lite.js` writes XLSX
with no dependency — and the same is technically possible for PDF. It was **rejected** for this one
reason: correct **font metrics**. A financial document that silently overflows a column because the
text width was estimated is a real defect, and glyph-width tables are exactly the part a hand-rolled
writer gets wrong. The brief permits one PDF dependency where no suitable existing one is present.

Size, footprint and the exact pinned version are recorded in the Phase 5 log below, with free space
before and after.

---

## Phase status

| Phase | Status | Checkpoint |
|---|---|---|
| 0 — Verify, plan, handoff | complete | *(no commit — Phase 0 alone does not check point)* |
| 1 — Notification outbox and enquiry delivery | **complete** | `feat: add reliable enquiry notification delivery` |
| 2 — Customer/store contacts | **complete** | `feat: add governed store contact management` |
| 3 — Stripe test-mode payment architecture | pending | |
| 4 — Auditable finance operations | pending | |
| 5 — Invoice PDF | pending | |
| 6 — Account statements | pending | |
| 7 — Duplicate-submission sweep | pending | |
| 8 — Final handover package | pending | |
| 9 — Regression, security sweep, final checkpoint | pending | |

---

## Log

### Phase 0 — complete

- Verified branch, commit `c48b47f`, clean tree, full history, 8.2 GB free.
- Ran the release gate: **17/17**, and recorded the suite totals above as the baseline every later
  phase is measured against.
- Read the enquiry forms and operations documents, the quality gates, the security hardening record
  and its handoff, and the audit and readiness documents 31–34.
- Established that the invoice reference is absent and that PDF generation needs a dependency.
- Created this document.
- **Files changed:** this document (new).
- **Tests run:** the full gate, as the baseline.
- **Next:** Phase 1 — durable notification outbox and enquiry delivery.

### Phase 1 — complete

**The defect.** An enquiry submitted on the public website was written to `form_submissions`, the
visitor was told it had been received, and **nothing was ever sent to anybody**. There was no queue,
no worker, no recipient configuration and no way to find out. Findings **ENQ-006** and **NOT-006**.

The existing `src/mail.js` made it worse rather than better: with no SMTP configuration it returns
`{ logged: true }` and writes the whole message body to the console. A caller cannot distinguish
that from a send, so a delivery status built on it would have reported success for every enquiry
ever received.

#### What was built

**A transactional outbox.** `db/migrations/0011_notification_outbox.sql` (mirrored idempotently in
`ensureSchema()`). A notification row is inserted **in the same transaction as the submission**, so
the two cannot disagree: if the submission commits, the alert exists; if it rolls back, so does the
alert. Six statuses — `pending`, `processing`, `retry_scheduled`, `delivered`, `failed`,
`cancelled` — and two database-level constraints that make a lie unrepresentable rather than merely
discouraged:

```sql
constraint notification_outbox_delivered_evidenced
  check (status <> 'delivered' or (delivered_at is not null and provider_reference <> '')),
constraint notification_outbox_failed_stamped
  check (status <> 'failed' or failed_at is not null)
```

A row cannot be marked delivered without evidence from the provider. Not by the worker, not by a
future caller, not by hand.

**Claim-and-lease worker.** `claimDue()` claims with `for update skip locked` inside a single
`update`, so more than one API process is safe and no two workers take the same row. A claim is a
**lease with an expiry**, not a flag: a worker that dies mid-batch leaves rows whose lease runs out
and which the next tick reclaims. Nothing can be stuck forever because a process was killed.

**Bounded retries.** `[1, 5, 15, 60, 120]` minutes, then terminal failure. Five attempts over just
over three hours, and then it stops and says so. A queue that retries forever is a queue nobody
reads.

**Adapters that cannot lie.** `src/notifications/delivery.js` holds three, under one rule: *no
adapter may report success without actual provider confirmation.* The unconfigured adapter returns
a retryable `NOT_CONFIGURED` and logs nothing at all — deliberately unlike `mail.js`. The SMTP
adapter returns `NO_REFERENCE` if nodemailer hands back no `messageId`, because a send with no
reference is not a send anyone can evidence later.

**Templates that carry no personal data.** An enquiry alert says an enquiry arrived, which form it
came from, and where to read it. It does **not** contain the enquirer's name, email address, phone
number or message. Putting those in an email would copy personal data into however many staff
inboxes, archives and phones the alert reaches — outside the capability system that governs who may
read an enquiry at all. `buildEnquiryTemplateData()` takes named arguments rather than a submission
row, so there is no code path that could spread one in by accident.

**Admin visibility.** The Enquiries detail screen gained a staff-alert panel showing delivery
state, the masked recipient, the attempt count, the last attempt time, the next attempt time for a
retry, the provider's error, and a governed re-send for the states the API will actually re-queue.
The re-send is gated on `enquiries.manage`, not `enquiries.view`: asking the platform to send
another email is an action, not a read. The handler also verifies the notification belongs to
**this** enquiry, so an id alone cannot reach an unrelated message — a statement to a customer, for
instance.

**"Not configured" is a first-class state.** With no recipient configured, no alert is queued, and
the screen says exactly that: *not configured — nobody was emailed about it.* It is never rendered
as delivered and never rendered as pending. That honesty is the whole point; silence rendering as
success is the defect this phase closes.

#### Deliberate non-features

- The alert body carries no enquirer detail (above).
- The panel shows no provider, host, port, credential or provider message id. `recipientMasked`
  arrives already masked from the API and the browser never holds a full address.
- Nothing retries automatically from the browser. A refusal is shown and left alone.
- No dependency was added. `nodemailer` was already present.

#### Configuration

`ENQUIRY_ALERT_EMAILS` (documented in `.env.example`) falls back to `ORDER_ALERT_EMAILS`, so an
existing deployment starts receiving enquiry alerts without editing `/opt/veyora/.env`.
`NOTIFICATION_POLL_SECONDS` and `NOTIFICATION_BATCH_SIZE` are **bounded** in `config.js` — a 0-second
poll would spin the claim query as fast as PostgreSQL could answer it, and a 100,000-row batch would
hold a claim on the whole table while one slow provider timed out. An out-of-range value falls back
to the default rather than failing boot.

#### Files

| File | Change |
|---|---|
| `platform/server/db/migrations/0011_notification_outbox.sql` | new — the outbox table |
| `platform/server/api/src/migrate.js` | idempotent mirror in `ensureSchema()` |
| `platform/server/api/src/notifications/outbox.js` | new — claim, settle, requeue, serialize |
| `platform/server/api/src/notifications/delivery.js` | new — three adapters |
| `platform/server/api/src/notifications/templates.js` | new — allowlisted rendering |
| `platform/server/api/src/notifications/worker.js` | new — bounded batch loop |
| `platform/server/api/src/routes/public-forms.js` | submission + enqueue in one transaction |
| `platform/server/api/src/routes/admin-enquiries.js` | delivery on the detail; governed retry route |
| `platform/server/api/src/config.js` | `enquiryAlertRecipients()`, bounded worker settings |
| `platform/server/api/src/index.js` | worker started with the bounded settings |
| `platform/server/.env.example` | `ENQUIRY_ALERT_EMAILS` and worker tuning documented |
| `js/data.js` | `shapeNotification()`, `delivery` on the detail, `retryEnquiryNotification()` |
| `js/pages_enquiries.js` | the staff-alert panel and its re-send |
| `platform/server/api/test/notification-outbox.test.js` | new — 48 tests |
| `platform/server/api/test/config.test.js` | +6 |
| `platform/server/api/test/public-forms.test.js`, `admin-enquiries.test.js` | extended |
| `test/enquiries-page.test.js` | +10 |

#### Verification

| Suite | Before | After |
|---|---|---|
| API | 1,229 | **1,284** |
| Root admin frontend | 213 | **223** |
| Astro web | 466 | **466** |
| **Total** | 1,908 | **1,973 passing, 0 failing** |

Release gate: **17/17 in 135 s**. `git diff --check` clean. Free space 8.1 GB.

Three defects were found by these tests and fixed rather than worked around: the forms test double
had no `.tx()` and hid that the enqueue was outside the transaction; `render()` threw on absent
optional data, which would have failed a notification terminally over a missing region; and the
schema-mirror assertion compared whitespace rather than structure.

- **Next:** Phase 2 — governed customer and store contact management.

### Phase 2 — complete

**The defect.** `users` conflates three different things. A row with role `customer` is a **business**
— customer number, payment terms, balance, pricing — and it simultaneously carries `first_name`,
`last_name`, `email` and `phone` as though it were a **person**. It is also the **login**.

That breaks the moment reality intrudes. A store has an owner, a manager, a buyer and someone in
accounts payable. The buyer leaves. Whoever edits the customer record to put the new buyer's mobile
in has just changed the login email, or overwritten the owner's number, or both — and there was
never anywhere to record that the person who left was the buyer in the first place.

#### The three concepts, now separate

| Concept | Meaning | Where it lives |
|---|---|---|
| **Veyora sales rep** | An internal Veyora agent | `users.agent_id` — **unchanged**, and this phase never writes it |
| **Store contact** | A person who works for the customer | `customer_contacts` — new. No login, no capability, no authority |
| **Portal user** | An account that may authenticate | Still `users`. A contact *may* be linked to one, explicitly |

#### Schema

`0012_customer_contacts.sql` (mirrored idempotently in `ensureSchema()`), with the full specified
field set. Entirely additive: `users` is not altered — no column added, dropped or retyped, no
default changed, no constraint touched, and **no row back-filled**.

Four database-level rules, so the failure modes are unrepresentable rather than merely discouraged:

```sql
-- one active primary per store, as a partial unique index rather than a trigger
create unique index customer_contacts_one_primary_idx
  on customer_contacts (customer_id) where is_primary and is_active;

constraint customer_contacts_archived_not_primary check (is_active or not is_primary),
constraint customer_contacts_active_named        check (not is_active or (first_name <> '' and last_name <> '')),
constraint customer_contacts_active_reachable    check (not is_active or email <> '' or mobile <> '' or office_phone <> '')
```

The primary rule is an index and not a trigger for a specific reason: two concurrent requests cannot
both read "no primary yet" and both write one. A fifth partial unique index stops two contacts
claiming the same portal account, where neither record would look wrong on its own.

`email_normalised` and `mobile_normalised` are stored **alongside** the typed values, never instead
of them. A person's number should be displayed the way they gave it; matching it needs a canonical
form. The phone normaliser deliberately does **not** guess a country code — prefixing a bare local
number with whatever country the customer record says would produce a number that dials somewhere
real and wrong.

#### Capabilities

`customer_contacts.view` and `customer_contacts.manage`. No automatic grant, no role fallback, no
wildcard, and not implied by `users.manage`: being able to edit a customer's payment terms is not
authority to read the named people who work there.

#### API

Ten narrow routes at `/admin/customer-contacts`, mounted before the general `/admin` router so its
own gate runs first. Each action is a **named path**, not a mode field in a body — a route that can
archive or promote depending on a payload key is one whose authorisation has to be re-derived from
the payload on every read of the code.

Everything the brief asked for is enforced:

- **archive, never delete** — no DELETE route, no DELETE statement, no client method that could
  reach one. An order or an audit entry naming the buyer must still resolve to a person after that
  person moves on;
- **the primary is replaced, not vacated** — archiving it, or deactivating it through an ordinary
  edit, is refused with a sentence telling the operator what to do instead;
- **reactivation re-validates** — a contact archived years ago may no longer satisfy the active
  rules, and the operator gets an explanation rather than a database error;
- **partial updates validate the MERGED contact** — clearing the last email while the preferred
  method is still `email` is refused. A field-by-field check passes it and produces a contact nobody
  can reach;
- **no portal account is ever created**, and a link only ever points at the customer's own active
  account. Linking a contact at one store to an account at another would hand that person a session
  into somebody else's orders;
- **verification is its own action** — an edit never stamps it, because editing a note is not the
  same as ringing the store to check the number;
- **the audit records field names, never values.** `describeUpdate()` is pure and exported precisely
  so that property is asserted directly rather than inferred from a mock.

#### Admin interface

A new governed **Store Contacts** screen showing the assigned Veyora sales rep (read-only), the
primary contact, additional contacts, portal-access relationship, responsibilities, preferred
channel and verification status, with Add, Edit, Make primary, Archive, Reactivate, Mark verified,
and Link/Unlink portal account — each gated on `customer_contacts.manage`.

Call, email and WhatsApp appear as **ordinary links a human clicks**. There is no send anywhere on
this screen, no template and no queue. A contact form pre-ticks **no responsibility at all**: a
responsibility is a statement about what somebody actually does, and defaulting one would be the
system inventing it.

Two states are shown as plain sentences rather than as errors or blank panels: a store with no
contacts (normal — every legacy customer starts that way) and a store with no primary.

#### Migration planner

`src/contact-migration-planner.js` plus `scripts/plan-store-contacts.js`. It **proposes** primary
contacts from the legacy fields and applies nothing. It cannot reach a database — structurally, not
by promise: nothing in the module or the CLI imports `pg`, `db.js`, any network client, or reads
`DATABASE_URL`, and a test asserts it, exactly as one does for `plan-permission-bootstrap.js`.

Three states — `propose`, `review`, `skip` — each with closed, legended reason codes, output as
byte-identical JSON and CSV for the same input. Every CSV field is quoted unconditionally, so a
business name containing a comma cannot shift every later column.

Four rules it will not break: it never infers a job title, never infers a responsibility, never
proposes a contact with no name or no reachable channel, and proposes the portal link as a proposal
only. `approvedDecisions()` is the only shape an applier may read, and a `skip` **can never be
approved into existence** — a tick in a spreadsheet is not a decision to override a rule the
reviewer may not have read.

Run against six invented records in the scratchpad (no real data): 1 propose, 1 review, 4 skip, with
`NO_NAME`, `NOT_A_CUSTOMER`, `ALREADY_HAS_CONTACTS`, `NO_CHANNEL`, `NAME_LOOKS_GENERIC` and
`GENERIC_MAILBOX` all firing as specified.

#### Deliberate non-features

No consent column, no marketing subscription, no automatic portal account, no inferred
responsibility, no back-fill, no bulk applier, and no dependency added.

#### Files

| File | Change |
|---|---|
| `platform/server/db/migrations/0012_customer_contacts.sql` | new — the table, indexes and widened capability CHECK |
| `platform/server/api/src/migrate.js` | idempotent mirror; capability CHECK widened |
| `platform/server/api/src/permission-registry.js` | the two new capabilities |
| `platform/server/api/src/customer-contacts.js` | new — closed sets, validation, normalisation, serializer |
| `platform/server/api/src/routes/admin-customer-contacts.js` | new — ten governed routes |
| `platform/server/api/src/contact-migration-planner.js` | new — the planner |
| `platform/server/api/scripts/plan-store-contacts.js` | new — the CLI |
| `platform/server/api/src/index.js` | router mounted before the general /admin router |
| `js/data.js` | `shapeContact()` and ten client methods |
| `js/app.js` | contact capability probe; nav entry |
| `js/pages_store_contacts.js` | new — the screen |
| `index.html` | the new page script |
| `platform/server/api/test/customer-contacts.test.js` | new — 80 tests |
| `test/store-contacts-page.test.js` | new — 30 tests |
| `test/helpers/dom.js` | `:checked` / `:disabled` / `:enabled` support |
| `account-permissions.test.js`, `permissions.test.js`, `admin-shell.test.js`, `permissions-client.test.js` | capability-set pins extended |

#### Verification

| Suite | Before | After |
|---|---|---|
| API | 1,284 | **1,365** |
| Root admin frontend | 223 | **253** |
| Astro web | 466 | **466** |
| **Total** | 1,973 | **2,084 passing, 0 failing** |

Release gate: **17/17 in 139 s**. `git diff --check` clean. Free space 8.1 GB.

Four existing tests failed and were **extended, not weakened**: three pin the capability set
exhaustively so that adding a key is a deliberate change, and one pins the exact list of server
calls `loadCaps()` makes. A fifth — the nav capability filter — turned out to have a real gap: its
grouped-entry branch never excluded `requires`, because until now no grouped entry had one. It now
asserts both halves.

- **Next:** Phase 3 — Stripe test-mode payment architecture.
