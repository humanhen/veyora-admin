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
| 3 — Stripe test-mode payment architecture | **complete** (one item prepared, not applied — see the log) | `feat: add Stripe invoice payment foundation` |
| 4 — Auditable finance operations | **complete** | `fix: govern payment and settlement mutations` |
| 5 — Invoice PDF | **complete** (visual matching pending the historical reference) | `feat: generate production invoice PDFs` |
| 6 — Account statements | **complete** | `feat: generate and deliver account statements` |
| 7 — Duplicate-submission sweep | **complete** | `fix: enforce idempotent critical operations` |
| 8 — Final handover package | **complete** | `docs: final engineering handover package` |
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

### Phase 3 — complete

**The approved flow, implemented exactly.** Order → Veyora invoice → **the customer remains on
account terms** → an authorised user creates a Stripe-hosted payment session → the customer follows
the secure link → a **signed webhook** confirms payment → Veyora records settlement transactionally.

Paying online is an **option beside** account terms, never a precondition for ordering. Nothing in
this phase touches `orders`, checkout, or the existing invoicing route, and a deployment with no
Stripe configuration behaves exactly as it does today.

#### The one security property everything else rests on

> **Only a verified webhook may settle an invoice.**

A browser arriving on the success page proves that a browser followed a redirect. A signed webhook
is a statement by Stripe verified against a shared secret. Those are different things, and the
subsystem is built on the difference:

- there is **no route** that sets `settlement_state = 'paid'` — a test asserts that no route file
  contains such a statement, and that `webhook.js` does;
- no route reads a `session_id` or `success` query parameter and settles on it;
- the webhook is mounted with `express.raw()` **before** `express.json()`, because the signature is
  computed over the exact bytes and a re-serialised body would never verify. That ordering is
  load-bearing and is asserted;
- with no webhook secret configured, startup **throws** rather than accepting unverified webhooks.

#### Configuration that cannot be half-live

`resolveStripeConfig()` is pure, takes an env map, and has three properties:

1. **The API boots without Stripe.** Unset, or `STRIPE_ENABLED=false`, gives a *disabled*
   configuration with a stated reason — not a throw. `enabled: false` is a first-class state and
   every payment action refuses with a sentence rather than a broken page.
2. **A half-configured Stripe is a refusal, not a guess.** Enabled with no webhook secret, or no
   return URLs, throws at startup.
3. **Test and live are never confused.** The mode is derived from the key prefix, a mismatched
   test/live pair throws, and **a live key outside production is refused outright** — the usual way
   that happens is a staging box copied from production configuration, and the usual outcome is a
   real card charged during a test.

The API version is pinned. `publicView()` is the only shape a browser sees: `enabled`, `mode`,
`testMode`, `disabledReason` — no key of any kind, asserted.

#### Money

Every new column is `bigint` **minor units**, because that is what the provider speaks and every
conversion between representations is a chance to be out by a factor of a hundred. `toMinorUnits()`
is the single conversion and it **refuses rather than rounds**: `pg` returns `numeric` as a string
precisely so no precision is lost, and parsing it into a float reintroduces exactly that error.
`29.97 * 100` is `2996.9999999999995`; this returns `2997`.

#### Schema (0013, additive)

`invoices.status` is **not** reused. It defaults to `'paid'` alongside `provider = 'Green Invoice'`
and records something about the legacy external invoicing arrangement — overloading it would make
"the external system issued this" and "a customer paid us" indistinguishable, the same mistake 0009
avoided with `delivery_state`. Settlement gets its own column whose default, `on_terms`, is a true
statement about every existing row, so nothing is back-filled.

Constraints that make the failure modes unrepresentable:

```sql
check (settlement_state <> 'paid'
       or (settled_at is not null and settlement_reference <> '' and amount_settled_minor > 0))
check (amount_refunded_minor >= 0 and amount_refunded_minor <= amount_settled_minor)
create unique index payment_sessions_one_live_idx on payment_sessions (invoice_id)
  where status in ('created', 'open');
provider_event_id text not null unique   -- the deduplication mechanism
```

`payments` is **extended, not replaced** — a second payments table would mean two answers to "what
has this customer paid" — with a unique `settlement_key` so a replayed webhook cannot record the
same money twice.

#### The webhook, in detail

- **signature first** — an unverified body never reaches the database, and the 400 says nothing
  about *why* it failed;
- **an exact six-event allowlist** — anything else is acknowledged with 200 so Stripe stops
  retrying, and recorded as `ignored`. Acknowledging is not acting;
- **persistent deduplication** via the unique constraint, not an application-level "have I seen
  this?" that races with itself;
- **amount and currency verified** against Veyora's own session *and* against the invoice, so a
  session created before the amount changed cannot settle it. A mismatch is a reconciliation
  exception, never a settlement;
- **out-of-order safe** — every transition is a no-op when already applied, so an expiry arriving
  after a completion does not un-pay an invoice;
- **`payment_status` is what settles**, not session status: `checkout.session.completed` fires for
  delayed methods where nothing was captured;
- **no raw payload is stored or logged** — an allowlisted summary is built key by key from a fresh
  object literal;
- **a dispute does not flip the invoice back to unpaid** — the money has not moved, and doing so
  would misstate receivables for something often resolved in Veyora's favour;
- **no automatic refund.** `charge.refunded` *records* a refund that already happened; nothing a
  customer can send moves money outward.

#### Four capabilities, not one

`payments.view`, `payments.collect`, `payments.refund`, `payments.reconcile`. Seeing that an invoice
was paid, asking a customer to pay, sending money back, and correcting the books are four different
jobs. No role fallback, no wildcard, and none granted by any migration. A test asserts no
`payments.*` or `payments.manage` catch-all exists.

A refund additionally requires an explicit `confirm: true`, a stated reason of 3–500 characters, and
an amount within what remains refundable. The admin UI confirms by **typing REFUND**, not by
clicking.

#### The dependency

The official Stripe Node SDK, `stripe@22.4.0`, pinned exactly. **Zero runtime dependencies**,
16 MB unpacked (almost all TypeScript definitions). Free space 8.1 GB before, 8.0 GB after — well
above the 6 GB floor. Loaded **dynamically** and only when Stripe is enabled, so an API with no
payment configuration never instantiates it; a test asserts no module imports it statically.

It was chosen over a hand-built client — against this repository's own `xlsx-lite` precedent — for
one reason: `constructEvent`. Webhook verification is an HMAC over a timestamped payload with a
tolerance window and a timing-safe comparison, and it is the only thing between the internet and
"this invoice is paid". A subtly wrong reimplementation does not fail loudly; it accepts forged
events.

**Pre-existing finding, not introduced here:** `npm audit` reports a high-severity advisory against
`nodemailer` ≤ 9.0.0 (the repository has `^6.9.13`). Stripe contributes nothing to it. Upgrading is
a breaking change outside this phase's scope and is carried into the Phase 8 handover package.

#### What was NOT delivered, and why

**The storefront "Pay securely" control is a prepared patch, not an applied change.**
`platform/server/storefront/` is a protected path under an existing repository guard
(`test/admin-shell.test.js`), whose stated reason is *"the storefront, which another developer is
working on."* Editing it would create a conflict for that developer, and editing the guard to permit
it is exactly the reflexive widening the guard's own comment warns against.

Everything the customer flow needs **is built and tested**: `GET /user/invoices/:id/payment` returns
the payment state with a payability verdict and a reason, `POST /user/invoices/:id/pay` returns a
hosted link for the caller's **own** invoice (another customer's is a 404, not a 403), and
`/user/invoices` now carries `settlementState`. The complete, ready-to-apply storefront diff is at
`docs/public-website-rebuild/prepared-patches/storefront-invoice-payment.patch` (97 lines): a
"Pay securely" button shown only for a payable invoice, per-state notes for paid / confirming /
refunded / cancelled, a double-click guard, and a standing note that card payment is optional and
changes nothing about account terms.

**This is the one item in Phase 3 left for the user to apply or authorise.**

#### Files

| File | Change |
|---|---|
| `platform/server/db/migrations/0013_stripe_payments.sql` | new |
| `platform/server/api/src/migrate.js` | mirror; capability CHECK widened |
| `platform/server/api/src/permission-registry.js` | four payment capabilities |
| `platform/server/api/src/payments/stripe-config.js` | new — validated configuration |
| `platform/server/api/src/payments/stripe-client.js` | new — the client boundary |
| `platform/server/api/src/payments/client-instance.js` | new — lazy, dynamic SDK load |
| `platform/server/api/src/payments/invoice-payments.js` | new — money, payability, serializers |
| `platform/server/api/src/payments/sessions.js` | new — session service |
| `platform/server/api/src/payments/webhook.js` | new — verification and settlement |
| `platform/server/api/src/routes/admin-payments.js` | new — four gated surfaces + refunds |
| `platform/server/api/src/routes/payments.js` | new — customer routes + webhook |
| `platform/server/api/src/routes/orders.js` | `settlementState` on the customer invoice list |
| `platform/server/api/src/index.js` | raw-body webhook mount before the JSON parser |
| `platform/server/.env.example` | the whole Stripe block |
| `js/data.js`, `js/app.js`, `js/pages_finance.js` | payment client, probe, admin UI |
| `platform/server/api/test/stripe-payments.test.js` | new — 80 tests |
| `test/invoice-payment-page.test.js` | new — 27 tests |
| `docs/public-website-rebuild/prepared-patches/storefront-invoice-payment.patch` | new — the unapplied customer UI |

#### Verification

| Suite | Before | After |
|---|---|---|
| API | 1,365 | **1,446** |
| Root admin frontend | 253 | **280** |
| Astro web | 466 | **466** |
| **Total** | 2,084 | **2,192 passing, 0 failing** |

Release gate: **17/17 in 140 s**. `git diff --check` clean. Free space 8.0 GB.
No test contacts Stripe; there is no key, no network call and no SDK instance in the suite, asserted
structurally.

- **Next:** Phase 4 — auditable finance operations.

### Phase 4 — complete

**The defect.** Money moved through a whole-database row diff. `invoices`, `payments`,
`creditNotes` and `users.balance` were all in the `POST /admin/sync` path, so a browser could set a
customer's balance to any number, create or **delete** a payment as an ordinary row, and edit an
invoice amount after issue — with no record of the prior value, no reason and no reference, because
a row diff has no such concept.

The `deletes` list was the dangerous half: it is *every id the tab has not seen*, so a stale
browser posting a snapshot taken before a real payment arrived would silently remove it.

**A latent bug fell out of the same inspection.** The payment form offered `method: 'credit card'`
— with a space. `payments.method` has a CHECK constraint listing `credit_card`. PostgreSQL would
have refused the write. The form now renders the SERVER's method list.

#### What was built

**The block.** `checkSyncPayload()` refuses the whole request before a transaction opens.
`balance: 0` is refused exactly as `balance: 5000` is — the check is `hasOwnProperty`, not
truthiness, because zeroing a balance is the most damaging version. The collections stay READABLE:
blocking writes must not blind the finance screens. `collectionFlags` is deliberately not blocked —
a receivables chase note is workflow, not money.

**Four capabilities, kept apart.** `finance.invoice`, `finance.record`, `finance.credit`,
`finance.reconcile`. The third is separate from the second for one reason: "we received £4,000"
and "we have decided they owe £4,000 less" look identical on a balance and are completely different
events. The person who keys in bank transfers all day should not be able to forgive a debt.

**`finance_events` — an append-only ledger,** written inside the same transaction as the mutation,
carrying prior balance, new balance, signed minor units, currency, reference, reason, actor name as
recorded, and the capability that admitted the request. UPDATE and DELETE are blocked by a trigger,
the same mechanism 0010 used for `audit_log`.

The balance is reconstructible from the ledger **independently** of `users.balance`, so a
disagreement between the two is now discoverable rather than invisible.

**One function moves every balance.** `applyMovement()` locks the row, reads before, applies a
relative movement, reads after, writes the event. There is exactly one `set balance = …` statement
in the file. If the event collides on its idempotency key it **throws**, rolling the balance
movement back — a retried request must not move the balance a second time against a ledger entry
that already exists.

#### Deliberate refusals

- **A client can never record a Stripe payment.** `stripe` is absent from the offline method set,
  so the validator refuses it. Settlement stays the exclusive result of a verified webhook.
- **A Stripe payment cannot be voided** — the money really was taken. Refunding is the correct act,
  behind its own capability.
- **Resolving an exception settles nothing.** If the conclusion is that money arrived, the next
  action is to record a payment — separately gated, separately logged. Otherwise the reconciliation
  queue becomes a way to mark invoices paid by hand.
- **No DELETE anywhere.** A payment keyed in error is voided with a reason and the row stays.

#### The bootstrap position (carried to handover)

`POST /admin/orders/:id/invoice` keeps its admin-role gate rather than moving to `finance.invoice`:
no account holds the capability until somebody grants it, and silently making invoicing impossible
for every administrator would be worse than the problem being fixed. The brief permits this as an
explicitly documented bootstrap stage.

It **delegates** to the same `issueInvoice()` implementation, so there is one guard reached two ways
rather than two copies. Recorded in `41_FINANCE_OPERATIONS.md` §6 with the retirement step.

A dead `invoice_number_seq` entry in the sync catch-up map was removed — surfaced by one of this
phase's own tests. Sync can no longer write an invoice, so there is no client-assigned number to
catch up with.

#### Files

`0014_finance_operations.sql`, `migrate.js`, `permission-registry.js`, `src/finance-operations.js`
(new), `src/routes/admin-finance.js` (new), `src/admin-data.js`, `src/routes/admin.js`,
`src/index.js`, `js/data.js`, `js/app.js`, `js/pages_finance.js`,
`docs/…/41_FINANCE_OPERATIONS.md` (new), plus `test/finance-operations.test.js` (58) and
`test/finance-page.test.js` (18).

#### Verification

| Suite | Before | After |
|---|---|---|
| API | 1,446 | **1,505** |
| Root admin frontend | 280 | **298** |
| Astro web | 466 | **466** |
| **Total** | 2,192 | **2,269 passing, 0 failing** |

Release gate: **17/17 in 143 s**. Free space 7.5 GB.

- **Next:** Phase 5 — production invoice PDFs.

### Phase 5 — complete

**What it replaces.** The admin panel's "Download PDF" button produced a toast saying no document
existed. There is now a real server-generated invoice.

#### The reference is absent — stated, not worked around

`source-assets/invoice-reference/approved-invoice-reference.pdf` does not exist and there is no
`source-assets/` directory. Per the brief, this is a clean neutral Veyora template with **all
functional behaviour complete**.

> **Recorded handover item:** *Final visual matching of the generated invoice against the approved
> invoice from the previous Veyora system remains pending receipt of that historical reference.*

This is a visual acceptance dependency, not an unfinished generator.

#### Nothing is invented

Every legal and business fact comes from `brand-config.js`, where each is an environment variable
whose default is `null` — a visibly-unset marker, never a plausible guess. A company number this
codebase made up would look exactly as authoritative as a real one and would be wrong on every
invoice Veyora ever sends.

An unset field is **omitted** from the document rather than printed as `«NOT CONFIGURED»`: an
invoice with no VAT line is a normal invoice, while one carrying a placeholder is a document nobody
should send. `configurationGaps()` reports every unset required field, separately from optional
ones, so the handover checklist is generated from the code rather than kept by hand.

#### The dependency

`pdf-lib@1.17.1`, pinned exactly. 19.5 MB unpacked, four small dependencies, pure JS with no native
bindings. Free space 7.5 GB before, 7.4 GB after — above the 6 GB policy floor.

Chosen over a hand-built writer, against this repository's own `xlsx-lite` precedent, for **font
metrics**: `font.widthOfTextAtSize()` is exact because pdf-lib carries the AFM tables. A financial
document that silently overflows a column because the width was estimated is a real defect, and
glyph widths are exactly the part a hand-rolled writer gets wrong.

#### Layout

A thin primitive layer (`pdf-layout.js`) over pdf-lib: a text cursor, exact measurement, wrapping,
ellipsis truncation, and a table that breaks across pages and **repeats its header**. Every cell is
wrapped before a row is drawn, so the row's height is known first — drawing and then discovering it
does not fit is how a table ends up with a header on one page and its first line on the next. A
table wider than the page **throws** rather than silently overflowing.

#### Determinism

No clock is read anywhere in the generator. The PDF's creation and modification dates come from the
invoice's own `issued_on`, and `overdue` is decided by an injected `asOf`. Regenerating an unchanged
invoice is **byte-identical** — asserted — so "is this the same document I sent?" is answerable by
comparing files.

#### What the document says

Issuer identity, address, company and tax numbers, bank block; customer business, address, tax
number, and the **accounts-payable contact** where the store has one (the person who actually has to
pay it); invoice number, issue date, **derived** due date, terms, order number and the customer's own
PO reference; itemised SKU / description / colour / quantity / unit price / discount; subtotal,
discount, shipping, tax, total, paid, refunded, balance due; the stamped FX rate **only** when the
order currency differs from the invoice's; a live hosted payment link where one is open; and the
configured footer.

Two deliberate presentation decisions:

- **An invoice on terms is stamped `DUE`, never `UNPAID`.** An invoice outstanding on agreed account
  terms is not delinquent. `OVERDUE` is derived from the due date, so it cannot drift.
- **Zero tax is printed, not omitted.** "Tax 0.00" and no tax line mean different things to a
  bookkeeper, and the first is what is true when tax was calculated and came to nothing.

#### Access

`GET /admin/invoices/:id/pdf` gated on `payments.view`; `GET /user/invoices/:id/pdf` for the
customer's **own** invoice. Ownership is a SQL predicate (`and customer_id = $2`), not a comparison
afterwards — there is no branch in which a row is loaded and then rejected, which is where a
"forgot the check" bug lives. Another customer's invoice is a **404, not a 403**: distinguishing
them would confirm the invoice exists to anyone enumerating ids.

Headers: `application/pdf`, stable filename, `private, no-store` (a shared cache holding an invoice
is a disclosure; a browser cache holding a stale one would show `DUE` on an invoice since paid), and
`nosniff`. Neither route reads a body or a query string.

#### A real defect the tests caught

`canvas.absolute()` measured **unsanitised** text. `widthOfTextAtSize()` throws on a character the
standard font cannot encode, so a single emoji in a customer's business name would have been a
**500 on their invoice download**. All five draw paths now route through `sanitize()` or `wrap()`.

Note that `é` is deliberately *preserved* — it is representable in WinAnsi, and folding it would
corrupt a name the font prints perfectly well. Only the genuinely unrepresentable is substituted.

The test helper had its own version of the same lesson: the first extractor read compressed bytes
and found no text, so every content assertion "passed" against an empty string. It now inflates the
content streams and decodes hex strings — reading the PDF the way a viewer does.

#### Tested

61 tests: short and 80-line multi-page invoices, header repetition, page numbering, long company and
address fields, USD / CAD / EUR, line and order discounts, shipping, zero and non-zero tax, unpaid /
paid / overdue / confirming / cancelled / partly refunded / fully refunded, determinism, ownership,
capability gating, cache headers, and no leakage of cost, supplier price, margin, wholesale, balance
or any Stripe key.

#### Files

`src/documents/brand-config.js`, `src/documents/pdf-layout.js`, `src/documents/invoice-pdf.js`,
`src/routes/invoice-documents.js` (all new), `src/index.js`, `js/pages_finance.js`,
`platform/server/.env.example`, `test/invoice-pdf.test.js` (new, 61).

#### Verification

| Suite | Before | After |
|---|---|---|
| API | 1,505 | **1,566** |
| Root admin frontend | 298 | **298** |
| Astro web | 466 | **466** |
| **Total** | 2,269 | **2,330 passing, 0 failing** |

Release gate: **17/17 in 142 s**. Free space 7.4 GB.

- **Next:** Phase 6 — account statements and delivery.

### Phase 6 — complete

#### The defect

The "Send to Customer" button did this and nothing else:

```js
DB.audit('statement.send', u.business, 'Emailed to ' + u.email);
toast('Statement emailed to ' + u.email);
```

Nothing was generated, nothing was attached, nothing was sent — and the audit log recorded a
delivery that never happened. **A false record is worse than no button, because it is consulted
later and believed.**

A subtler arithmetic fault sat underneath it. The old screen took the customer's **current** balance
as the closing figure and subtracted the period's activity to derive an opening one. So a statement
for *any past period* silently reported today's balance as that period's closing balance.

#### The arithmetic, corrected

The closing balance is now **computed**: opening plus movements. The opening balance is the sum of
everything *before* the period, from the source ledgers. No balance column is read anywhere in the
builder or the route — asserted.

Every figure is in minor units, formatted once. The sign comes from the movement **kind**, so a
negative amount cannot invert a credit.

#### One currency per statement

A running balance mixing USD and EUR is arithmetic nobody can defend. `GET /:customerId/currencies`
reports what a customer actually has activity in; the screen presents the choice and says why. A
movement in another currency never reaches the running balance.

#### Delivery that cannot lie

Statements go through the **notification outbox** built in Phase 1, so they inherit bounded retries
and the rule that nothing is reported delivered without provider confirmation.

- The statement row and its outbox notification are written in **one transaction** — there is never
  a statement claiming to be queued with nothing carrying it.
- A route can only set `queued`. **No route can set `sent`** — asserted — and the only code that
  does is `markStatementSentOnDelivery`, called by the worker after a confirmed delivery.
- Marking sent is idempotent: a duplicated confirmation leaves the original timestamp.
- A `sent` row must carry evidence of where it went, enforced by a CHECK.

The worker gained two injected hooks so it stays free of document code: an attachment resolver and a
delivery callback.

**The PDF is not stored.** The inputs are recorded and the document regenerated deterministically.
That keeps a customer's full financial history out of a second place and means a corrected brand
configuration improves every historical statement rather than none. An attachment that cannot be
rebuilt is a **retryable** failure, not a silent empty email — a statement email with no statement
attached would be worse than one that arrives a few minutes late.

#### Recipients

Accounts-payable contact → primary contact → account email, with an explicit override beating all
three. An archived contact or one with no email is skipped. No recipient at all is reported as such,
never sent to nowhere.

The **reason** is stored on the statement row alongside the address, because "why did this go to the
owner rather than accounts payable?" is asked months later, and reconstructing it from the contact
table as it stands *then* would give the wrong answer.

#### The document

Customer identity, period, opening balance, every invoice / payment / credit note / refund, running
balance, closing balance, currency, generated timestamp, Veyora identity, an ageing breakdown
computed from the invoice lines only, and payment instructions. A credit balance is described as
credit, not as a debt. An empty period says so plainly — "nothing happened" is what a customer
chasing a discrepancy needs told.

A **voided** payment is excluded: the money did not arrive, and showing both the payment and its
void would be internally correct and externally baffling.

#### Authority

`payments.view` to generate, preview and download — that is reading payment state, which the
capability already describes, and a second key would be two grants to keep in step.
`statements.send` for sending, because that is outward-facing. Holding the first confers nothing of
the second.

A preview creates **no record**: checking a figure must not litter the history.

#### No scheduling

There is no cron column, no `next_run_at`, no recurrence rule, and nothing in the router schedules
anything — asserted. Automatic monthly statements are out of scope, and a column anticipating them
would be an invitation to wire one up.

#### Files

`0015_account_statements.sql`, `migrate.js`, `permission-registry.js`,
`src/documents/statement.js`, `src/documents/statement-pdf.js`,
`src/routes/admin-statements.js`, `src/notifications/statement-delivery.js` (all new),
`src/notifications/worker.js` and `delivery.js` (attachment support), `src/index.js`,
`js/data.js`, `js/pages_finance.js`, `test/account-statements.test.js` (new, 56).

#### Verification

| Suite | Before | After |
|---|---|---|
| API | 1,566 | **1,622** |
| Root admin frontend | 298 | **298** |
| Astro web | 466 | **466** |
| **Total** | 2,330 | **2,386 passing, 0 failing** |

Release gate: **17/17 in 144 s**. Free space 7.4 GB.

- **Next:** Phase 7 — duplicate-submission and reliability sweep.

### Phase 7 — complete

Eighteen high-risk mutation paths audited. **Thirteen were already server-idempotent**; three had a
real defect; two were fragile. Full classification in `42_DUPLICATE_SUBMISSION_SWEEP.md`.

#### The three that were genuinely broken

**Public enquiries had no server guard at all.** A refresh of the POST result, a synthetic
`requestSubmit()`, a second tab, or scripting simply being off each produced a second stored enquiry
**and a second alert to every recipient**. The only mitigation was an in-process IP throttle whose
own comment disclaims it as not a security control.

Fixed with a `dedupe_fingerprint` and a partial unique index. The fingerprint hashes the form type,
the content **and a coarse two-minute bucket** — because two genuine enquiries can be identical, and
*a lost enquiry is invisible where a duplicated one is merely untidy*. The submitter still gets
`{ ok: true }`: telling them it failed would make them send a third.

**The inventory CSV import doubled every `adjust` delta.** `#ic-apply` had no guard at all, not even
`disabled`. `DB.save()` is debounced by 700 ms, so two clicks coalesced into one sync request
carrying doubled quantities, which the server wrote as a single absolute value with no way to know
it was wrong. Fixed with an in-flight flag and by clearing the parsed rows.

**The stock ledger could not attribute a movement.** `admin-inventory.js` passed snake_case keys
while `recordMovement()` reads camelCase, so **every adjustment and transfer since the
security-hardening batch wrote `variation_id = NULL`**. My own defect from that batch, and worse
than cosmetic: an unattributable movement is exactly what you would need to *detect* a duplicated
adjustment after the fact.

#### The two that were fragile

**Purchase-order receipt** — `received` and stock are both increments, so a replay is not
idempotent. It escaped doubling only because the handler is synchronous and `close()` detaches the
modal first; one `await` anywhere above would have broken it.

**Order patch** — most fields are absolute writes and replay harmlessly, but `comment` **appends**,
so a duplicated request added the same comment twice.

#### Inventory adjustments now have server-side idempotency

An adjustment applies a **signed delta**, so it is inherently non-idempotent: two identical requests
legitimately mean +20. The key therefore identifies **the press, not the content** — deriving one
from the request would make correcting a count twice in a row impossible. Omitting it preserves the
old behaviour for every existing caller.

When the ledger refuses the movement the handler **throws**, rolling the stock write back too:
without that the quantity would move a second time against a ledger entry that already exists, and
the two would disagree forever.

#### Shared helpers

`js/util.js` gained `guarded()`, `keyedGuard()` and `bindAction()` — one in-flight primitive, so a
future control gets the guard *and* the affordance rather than only the second. `disabled` alone is
bypassed by a direct handler call, by Enter on a focused control, and by a re-render producing a
fresh button — which these screens do after almost every action.

#### One test-harness lesson worth recording

The sweep's database double **serialises transactions**. A naive snapshot-and-restore rollback
interleaves under `Promise.allSettled`, so the second transaction's rollback wipes the first's
committed writes — reporting a balance that moved zero times when the code moved it once. Every
contended path takes `for update`, so PostgreSQL serialises them in practice; the mutex models that,
and it is what lets the second transaction *see* the first's writes and collide as it should.

Without that fix every concurrency test in this phase would have passed for the wrong reason.

#### Files

`0016_duplicate_submission_guards.sql`, `migrate.js`, `src/inventory.js`,
`src/routes/admin-inventory.js`, `src/routes/public-forms.js`, `js/util.js`, `js/data.js`,
`js/pages_catalog.js`, `js/pages_ops.js`, `js/pages_sales.js`, `test/helpers/dom.js`,
`test/idempotency-sweep.test.js` (new, 37), `docs/…/42_DUPLICATE_SUBMISSION_SWEEP.md` (new).

#### Verification

| Suite | Before | After |
|---|---|---|
| API | 1,622 | **1,659** |
| Root admin frontend | 298 | **298** |
| Astro web | 466 | **466** |
| **Total** | 2,386 | **2,423 passing, 0 failing** |

Release gate: **17/17 in 151 s**. Free space 7.4 GB.

- **Next:** Phase 8 — the final handover package.

### Phase 8 — complete

Five documents created:

| Document | Purpose |
|---|---|
| `38_STRIPE_PAYMENT_ARCHITECTURE.md` | The payment model, the settlement authority, and what is test-mode only |
| `39_INVOICE_AND_STATEMENT_SYSTEM.md` | Both document generators, what they replaced, and the outstanding visual match |
| `40_FINAL_ENGINEERING_HANDOVER.md` | Every defect closed — including my own three — capabilities, dependency security, and what did not happen |
| `40A_CLIENT_ACTIVATION_CHECKLIST.md` | Everything outstanding, none of it engineering work. Nothing marked complete |
| `40B_WEEKEND_REVIEWER_START_HERE.md` | Twenty sections: what Veyora is, how to run it safely, what to look at, what not to touch, and how not to rewrite history |

Six existing documents updated in place: 26 (deployment), 27 (enquiries), 28 (quality gates), 31
(readiness), 32B (backlog) and 34 (security hardening). Each is told what changed under it rather
than leaving a reader to discover it elsewhere — including 34, which is where the NULL stock-ledger
defect came from and so is where it is recorded.

No new release gate was needed: the three suite gates are TOTAL, so every test added in this run was
already covered the moment the file existed. That was a deliberate property of the original gate
design and it held.

Release gate: **17/17 in 144 s**.

- **Next:** Phase 9 — nodemailer, full regression, security sweep, final checkpoint.
