# 48 — Handover Exhaustion

**Canonical branch:** `mathew/public-website-rebuild`
**This document was produced on the temporary branch `mathew/handover-exhaustion-2026-08-07`.
Nothing was pushed. `main` was not touched. Nothing was deployed.**

The question this answers is narrow and deliberately blunt:

> **Is there anything material Mathew can still implement without somebody else supplying
> information, credentials, data, approval or access?**

**No.** Section 3 is the reasoning; section 4 is what now needs another party, and who.

---

## 1. What was completed

| Area | Outcome |
|---|---|
| **Public website** | Astro, server-rendered, own 404, structured data, accessibility and responsive QA, enquiry forms without JavaScript |
| **B2B portal** | Catalogue, cart, ordering, backorders, returns against real orders, exchange search, balance & payments, invoices, Back navigation, phone nav |
| **Admin panel** | Enquiries, store contacts, permissions, finance, invoices, statements, receivables dashboard with drill-down, credit limits, credit reviews, warehouse controls |
| **API** | Express + `pg`, no ORM, explicit column lists, allowlist serialisers, capability authorisation with no role fallback |
| **Payments** | Stripe test-mode: hosted sessions, verified webhook, settlement. **Only a verified webhook may settle an invoice** |
| **Invoices** | Server-generated PDFs; regenerating an unchanged invoice is byte-identical |
| **Statements** | Generated, and delivered through the outbox so nothing reports as sent without provider confirmation |
| **Contacts** | Store contacts separated from the login; nothing back-filled, a planner proposes for human review |
| **Enquiries** | Transactional outbox, leased claims, bounded retry, terminal failure recorded |
| **Credit** | Account limits, server-authoritative order-time evaluation, and a governed approve/decline workflow |
| **Security** | Capability model, cookie security, trust-proxy hop count, origin contract, append-only audit, idempotency, rate limiting |
| **Integration** | The second developer's storefront work audited, consolidated and regression-tested |
| **Client feedback** | Items A–M implemented |
| **Release** | 18/18 gate, 2,720 tests, `npm audit` 0 |

Full detail: `40`, `43`–`47`.

---

## 2. Closed in this final run

Three items the earlier handover listed as remaining engineering limitations. All three were fully
determined by repository evidence and needed nothing from anybody.

### 2.1 Public-form throttle identity

The forms work without JavaScript, so the browser POSTs to Astro and the **server** forwards to the
API. Every enquiry therefore arrived from the Astro container and the API's per-IP throttle counted
the whole internet into one bucket of 8 per ten minutes.

Fixed at the Astro boundary — the only point in the chain that can tell one visitor from another.
The visitor is derived by **counting in from the right of `X-Forwarded-For` by the number of proxies
we actually have**, because Caddy *appends* the peer it observed, so the right-most entry is the
trustworthy one and anything a client forges is pushed left and ignored. This is the same discipline
the API already applies through `trust proxy`, and reads the **same `TRUST_PROXY_HOPS` variable** so
the two cannot drift apart.

The API's limiter is unchanged and remains correct for the other way in — `POST /api/forms/…`
reaches it directly with the visitor's real address.

### 2.2 Order state transitions

`sanitizeOrderPatch` checked a status was one of the eight and nothing compared it to the status the
order already had, so a cancelled order could be revived and a completed one sent back to pending.

A closed contract now governs it, enforced on the locked row. **No status was added or removed** and
no new lifecycle was invented: the contract admits exactly the workflows the shipped panel already
performs. `shipped` and `cancelled` are terminal; `completed` may still go forward or be cancelled
but not backwards; the five pre-finish states stay freely correctable because operations rely on
that.

> **One correction to the earlier notes.** They cite `pending → shipped → pending` as permitted. It
> has not been since `daa1342` — a bespoke guard already refused un-shipping. The *class* of defect
> was real; that particular instance was not.

### 2.3 Authenticated font CDN

The portal fetched Montserrat from Google Fonts on every page of the signed-in area: a third-party
request carrying the visitor's IP and Referer on every screen, and a hard dependency on a host
Veyora does not run. Removed; the stack still names Montserrat first and falls back to system faces.
**No font binary was added** — the unlicensed commercial faces stay excluded.

---

## 3. What Mathew could still do locally

**Nothing material.**

That is a claim, so here is the reasoning rather than the assertion:

- The three remaining *engineering* limitations in the handover set are the three closed above.
- The gap matrix was re-audited against the current tree. Eighteen rows still reading MISSING or
  PARTIAL were closed by work that already exists — Stripe, invoice PDFs, statements, the enquiry
  outbox, idempotency, dependency controls, receivables. They now say so, each with its evidence.
- The rows that remain open were checked against the categories in section 4. **Every one requires a
  business decision, a credential, authoritative data, production access, or acceptance.** None is a
  case of "could have been implemented locally and was not".
- Two categories were deliberately *not* entered, because they are product scope rather than
  exhaustion: warranty, CRM, catalogue editorial content, and further integrations. They are listed
  as post-handover enhancements, not as unfinished work.

The honest residue is this: a handful of matrix rows describe features nobody has asked for
(a warranty module, campaign reporting, an HTML sitemap). They are open because they are unbuilt,
not because they are blocked — and building them now would be inventing scope at the moment the
project should be handed over.

---

## 4. What now requires another party

### 4.1 Business decision

| Input required | Who | What it unblocks | Where |
|---|---|---|---|
| Which capability each person should hold, and **at least two** permission managers | Veyora | The entire capability bootstrap; nothing works until the first grants exist | `49` STEP 2 |
| Who may set credit limits (`finance.credit_limit`) and who may approve over-limit orders (`finance.credit_review`) — **deliberately separate** | Veyora | Credit screens become usable | `47`, `49` STEP 2 |
| The credit limit for each account | Veyora | Credit control does commercial work. Every account reads NULL = *not configured* | `46` §1.1 |
| Per-jurisdiction tax rules | Veyora's accountant | Tax beyond what the order record carries | `49` STEP 1 |
| Whether any analytics runs at all, and on what consent basis | Veyora | Analytics is off by default and stays off | `46` §5 |
| Cookie / privacy position | Veyora | Legal copy and any future consent mechanism | `49A` |

### 4.2 Credentials and account access

| Input required | Who | What it unblocks | Where |
|---|---|---|---|
| Stripe account, verification, payout bank, **test** then **live** keys and webhook secret | Veyora | Card payment. Test mode first; nothing live has been used | `49` STEP 1, STEP 4 |
| SMTP provider, credentials, sender identity, SPF/DKIM/DMARC | Veyora | Every outbound message. The adapter reports `NOT_CONFIGURED` until then, and never claims a send | `49` STEP 1, STEP 4 |
| Enquiry and order alert recipients | Veyora | Who is told when something arrives | `49` STEP 4 |

### 4.3 Authoritative data

| Input required | Who | What it unblocks | Where |
|---|---|---|---|
| **The catalogue** — the authoritative product source and its mapping | **Client / other developer** | Publication. See §5 | `49` STEP 3 |
| **Which 2026 price list is authoritative**, and what the other represents | **Veyora** | Any price import. See §5 | `49` STEP 3 |
| Reviewed store contacts | Veyora | The contact planner's proposals become records. Nothing is back-filled | `49` STEP 3 |
| Invoice legal identity: registered name, company number, tax number, address, bank details, footer text, logo | Veyora | Invoices stop showing visibly-unset defaults | `49` STEP 1 |
| The historically approved invoice PDF | Veyora | The final visual match. Functionally complete, visually neutral without it | `49` STEP 10 |

### 4.4 Production / VPS access

| Input required | Who | What it unblocks | Where |
|---|---|---|---|
| A copy/export of production data and a disposable Postgres | Whoever holds VPS access | Migration rehearsal — **never performed** | `49` STEP 5 |
| VPS access and a deployment window | Veyora / infrastructure owner | RC deployment, then cutover | `49` STEP 6, STEP 8 |
| DNS control | Veyora | The public hostname switch | `49` STEP 8 |
| Stripe webhook endpoint registration | Veyora | Live settlement. Verification is built; registration needs the live account | `49` STEP 4 |
| Monitoring, alerting, restore testing | Infrastructure owner | Operational readiness | `49` STEP 9 |

### 4.5 Acceptance and sign-off

| Input required | Who | What it unblocks | Where |
|---|---|---|---|
| Review of the release candidate on the RC host | Veyora | Cutover approval | `49` STEP 7 |
| Approved Privacy Policy and Terms | Veyora's legal adviser | Publication of the policy pages | `49` STEP 1 |
| Named cutover approver | Veyora | STEP 8 may begin | `49A` |

---

## 5. The catalogue — read this before importing anything

> **CLASSIFICATION: AUTHORITATIVE DATA. CLIENT / OTHER-DEVELOPER OWNED.**

Two 2026 Veyora price-list documents exist outside this repository. **They contain conflicting price
sets.** Neither has been identified as authoritative, and nothing in this repository establishes
which is.

**Therefore:**

- **DO NOT import those prices** until Veyora states which list is authoritative and what the other
  one represents — a different customer tier, a different season, a superseded draft, or something
  else entirely.
- **Catalogue verification and population are client / other-developer owned.** Nothing in the
  catalogue should be treated as verified for publication today.
- **No catalogue fact was invented here.** No price, no product, no editorial copy.

The tooling is ready and waiting: `platform/server/api/src/catalogue-audit/` audits and plans a
backfill, and the release gate runs a catalogue-chain check. It becomes useful the moment validated
source data is supplied — and not before.

---

## 6. Where to go next

| You want to | Read |
|---|---|
| Get Veyora live | **`49_PRODUCTION_ACTIVATION_RUNBOOK.md`** |
| Ask the client for what is needed | **`49A_CLIENT_INPUTS_REQUIRED.md`** |
| Review the code | `40B_WEEKEND_REVIEWER_START_HERE.md` |
| Understand a subsystem | `38`, `39`, `41`, `42`, `43`, `46`, `47` |
