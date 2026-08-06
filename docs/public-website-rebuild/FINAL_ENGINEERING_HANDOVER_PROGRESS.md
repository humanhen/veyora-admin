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
| 2 — Customer/store contacts | pending | |
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
