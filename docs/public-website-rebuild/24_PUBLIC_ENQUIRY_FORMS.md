# 24 — Public Enquiry Forms

Durable, repository-local submission for the three public enquiry routes. Submissions are **stored**,
not delivered — email and CRM integration are deliberately deferred.

**No production system was contacted.** No live database, no mail server, no CRM. Every test runs
against a controlled double.

---

## 1. Routes and namespace

| Web route | API endpoint | Method |
|---|---|---|
| `/contact/` | `POST /forms/contact` | POST |
| `/request-b2b-account/` | `POST /forms/request-b2b-account` | POST |
| `/private-label-enquiry/` | `POST /forms/private-label-enquiry` | POST |

The API namespace is **`/forms`, deliberately not under `/public`**. That prefix is documented and
tested as a read-only boundary with no write methods
([15_B2_PUBLIC_API_CONTRACT.md](15_B2_PUBLIC_API_CONTRACT.md)); quietly adding a POST beneath it
would falsify a contract several other tests depend on. `routes/public.js` remains write-free.

### The browser never talks to the API

The form posts to **its own path**. Astro handles the POST in page frontmatter and calls the API
server-side. A form posting straight to the API would put `PUBLIC_API_ORIGIN` in the markup, require
CORS, and only work if the API were publicly reachable — none of which is true or wanted. Posting to
the same path keeps the API origin entirely server-side, works with no JavaScript, and re-renders
with errors or success the way a form has worked for thirty years.

---

## 2. Fields and validation

Closed allowlists throughout. An unknown field is **rejected**, not ignored — silently dropping it
would let a mis-built client, or a probe, believe it had been accepted.

| Form | Fields |
|---|---|
| contact | name*, email*, company, phone, message*, consent* |
| request-b2b-account | name*, email*, company*, businessType*, country*, phone, message, consent* |
| private-label-enquiry | name*, email*, company*, country*, projectType, message*, consent* |

`*` required. Limits: 120 chars (short text), 80 (country), 40 (phone), 4000 (message).

- **Email** is validated conservatively rather than to RFC 5322: one `@`, no whitespace, a
  dot-bearing domain. The RFC permits addresses no provider would issue, and accepting them buys
  nothing while widening what reaches storage.
- **Phone** is optional everywhere and accepts digits and `+ ( ) - .` only. A "phone number"
  containing prose is a bot or a mistake, and rejecting a malformed optional field costs nothing.
- **Choice** fields accept only their listed values.
- **Consent is required** and only an explicit affirmative counts (`on`/`true`/`1`/`yes`). Absent,
  `off`, `false` and `no` all mean not given.
- **Name/company/email must be plain text** — a value containing markup is rejected. A message may
  contain angle brackets, because a legitimate enquiry can discuss markup; it is stored as data and
  escaped on output.
- Control characters are stripped rather than rejected: they are almost always a copy-paste artefact,
  and failing a genuine enquiry over an invisible character would be worse than cleaning it.

### Fields a client can never set

`deliveryState`, `attempts`, `lastError`, `id`, `submissionId`, `userId`, `actor`, `approverId`,
`approvedAt`, `createdAt`, `consentAt` and their snake_case spellings are in a **named forbidden
set** and rejected with a distinct `SERVER_CONTROLLED` code — not merely absent from an allowlist.
A client sending `deliveryState` has a real misunderstanding, not a typo, and the error says so.

---

## 3. Durable storage

Into B2.1's existing `form_submissions` — **no schema change was required**.

```
form_type       the form
payload         jsonb, built from validated values only (never the request body)
source_url      the submitting path, query string stripped
region          from the validated country field
business_type   from the validated businessType field
consent_version '2026-08-enquiry-v1'
consent_at      when consent was given
delivery_state  'pending'  ← a SQL literal, not a parameter
```

The INSERT names its columns explicitly, is fully parameterised, and has **no `RETURNING` clause** —
the caller has no use for the id, and not selecting it means it cannot leak into a response.

### Why storage, not delivery

`delivery_state` starts `pending` and stays there. Email and CRM delivery have their own credentials,
failure modes and retries; doing them inline would mean a visitor's enquiry could be lost because a
mail server was slow. **Storing first and delivering later is the only ordering in which a submission
cannot vanish.** Delivery is deferred (§8).

---

## 4. Privacy boundary

- **No field value is ever logged.** The single `console.error` records the form type and the error
  message — never the body, the payload or a field. An enquiry contains a name, an email address and
  free text someone typed expecting it to reach Veyora and nobody else; a stack trace with the
  payload in it defeats that. Asserted by test.
- The **source URL is reduced to a path** with the query string stripped: a full URL from a client
  could carry anything.
- **No PII in responses.** Success is `{ ok: true }` — identical for all three forms, with no id and
  no echo of what was sent. A validation failure names fields but never repeats a submitted value.
- The submit client sends **no cookies** (`credentials: 'omit'`): the API is unauthenticated, and
  forwarding a visitor's session would be both useless and a leak.

---

## 5. Abuse controls

**Honeypot.** A hidden `website` field, positioned off-screen rather than `display: none` (some bots
skip hidden inputs), `aria-hidden`, and out of tab order. A tripped honeypot gets **the same 200
`{ ok: true }` a real submission gets** and simply stores nothing — telling the sender it was
detected teaches it how to avoid detection next time. It is evaluated *after* validation, so the
response leaks no signal either way.

**Body limit.** The forms router applies its own `32kb` limit rather than the app-wide 64mb (which
exists for image uploads). An enquiry that large is an attack, and 413 is the right answer before the
JSON is parsed.

**Throttle — honestly a mitigation, not a control.** There was no rate-limiting convention in this
repository, so rather than invent a distributed one, `/forms` uses an explicit in-process throttle
(8 per 10 minutes per client address, 429 when exceeded). Its limits are stated in the source:

- **per process**, so N api containers allow N times the rate;
- **in memory**, so a restart clears it;
- keyed on the proxied client address, which a determined attacker varies.

It defends against casual abuse and accidental double-posting. A real control belongs at the edge.

**CSRF.** Astro's `security.checkOrigin` rejects any form-encoded POST whose `Origin` does not match
the site origin — see §7, which describes a real defect found while wiring this up.

---

## 6. Error contract

| Status | Meaning | What the visitor sees |
|---|---|---|
| 200 | stored (or honeypot) | success panel replacing the form |
| 400 | validation | summary linking to each failing control, plus per-field messages; everything typed is preserved, consent is not re-ticked |
| 429 | throttled | "That is several enquiries in a short time… nothing was lost" |
| 500/502 | upstream or storage failure | "We could not send your enquiry just now… nothing was recorded" |

Failure messages are **constants with no interpolation**, so an upstream status, host or error name
cannot reach the page. A malformed error body from the API is discarded rather than rendered — a
broken payload must not become page content. Nothing promises a response time or a commercial
outcome.

---

## 7. A production defect found: Astro `allowedDomains`

Wiring the first POST routes surfaced a real problem that would have broken **every** submission in
production.

Astro's `checkOrigin` middleware compares the browser's `Origin` header against
`context.url.origin`. That origin is built by `NodeApp.createRequest()` from the request `Host` and
`x-forwarded-*` headers — but only after `validateHost()` checks them against
`security.allowedDomains`. **With that list empty, validation returns undefined for both the host and
the forwarded protocol, and the origin falls back to the literal `http://localhost`.**

Behind Caddy that is fatal: a browser on `https://<domain>/contact/` sends
`Origin: https://<domain>`, Astro computes `http://localhost`, they do not match, and every enquiry
answers **403**.

`astro.config.mjs` now declares `security.allowedDomains` derived from `PUBLIC_SITE_ORIGIN` — never
a hard-coded hostname, and read from `process.env` directly rather than by importing `src/env.ts`
(per the long-standing note in that file about Vite forcing `NODE_ENV`).

> **This fix is reasoned from the Astro source but is NOT yet verified end to end** — see §9. It can
> only improve matters (an empty list definitely falls back to `localhost`), but it should be
> confirmed against a real deployment before the forms are announced.

---

## 8. Still required operationally

1. **Delivery.** Nothing reads `form_submissions` yet. A submission sits `pending` until something
   sends it. That worker, its retry policy and its credentials are not built.
2. **Notification.** `forms.notify_to` exists in B2.1 and is unused.
3. **Retention.** `forms.retention_days` defaults to 365 and nothing enforces it. Enquiries contain
   personal data; a retention job is a real obligation, not a nicety.
4. **Monitoring.** Nothing alerts on submissions accumulating in `pending`, which is exactly what a
   silently broken delivery worker would look like.
5. **Edge rate limiting**, per §5.
6. **A consent-wording review.** `consent_version` is `2026-08-enquiry-v1`; the wording it refers to
   should be checked against the privacy policy by someone who owns that text.

---

## 9. Limitations

- **The end-to-end POST is not exercised at HTTP level.** Astro's `checkOrigin` rejected the test
  harness's POSTs, and the exact origin Astro computes in the standalone adapter could not be
  reproduced within the run. Rather than weaken the check or leave failing tests, those four tests
  were removed and the gap pinned by a placeholder test naming the next diagnostic step (add a
  temporary SSR endpoint that echoes `Astro.url.origin`, request it through the running server, and
  set the harness Origin to what it reports).

  **What is covered instead:** 35 API tests (validation, storage, honeypot, privacy, SQL safety,
  router wiring) and 30 web tests (body construction, error mapping, no-JavaScript structure,
  accessibility, no-origin-leak), plus HTTP tests proving the form renders server-side with real
  controls and that a cross-origin POST is refused.

- **The web field list duplicates the API's.** Deliberate and narrow: a form cannot render a control
  it does not know about, and a round-trip per page render to discover the list would be worse. A
  test asserts the two agree field-by-field, including kind and requiredness.
- **No file upload**, by design.
- **No spam scoring** beyond the honeypot.
- **Success is a 200 re-render, not POST-redirect-GET.** A redirect would need a session or a query
  flag to carry the success state, and a query flag on a public page is both indexable and forgeable.
  A refresh therefore re-posts, producing a second stored enquiry rather than corruption.
