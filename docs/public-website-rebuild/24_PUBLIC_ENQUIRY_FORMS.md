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

> **Superseded by §10 (morning correction).** This fix has now been verified end to end against the
> real built server behind a Node-core reverse proxy: a same-origin proxied POST succeeds and every
> hostile origin is refused. An RC smoke test over real HTTPS is still required — §11.

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

- ~~**The end-to-end POST is not exercised at HTTP level.**~~ **Resolved — see §10.** The placeholder
  has been removed and replaced by `test/enquiry-e2e.test.ts` (21 tests), which submits all three
  forms through a Node-core reverse proxy into the real built server. The root cause was the test
  topology, not the configuration: the overnight suite posted directly to the internal port, which
  correctly cannot reconstruct a matching origin and is refused by design.

- **The web field list duplicates the API's.** Deliberate and narrow: a form cannot render a control
  it does not know about, and a round-trip per page render to discover the list would be worse. A
  test asserts the two agree field-by-field, including kind and requiredness.
- **No file upload**, by design.
- **No spam scoring** beyond the honeypot.
- **Success is a 200 re-render, not POST-redirect-GET.** A redirect would need a session or a query
  flag to carry the success state, and a query flag on a public page is both indexable and forgeable.
  A refresh therefore re-posts, producing a second stored enquiry rather than corruption.

---

## 10. CSRF behind a reverse proxy — verified (morning correction, 2026-08-06)

§7 recorded the `allowedDomains` fix as *"reasoned from the Astro source but NOT yet verified end to
end"*, and §9 recorded four end-to-end POST tests as removed. Both are now resolved. **CSRF was not
disabled, not broadened, and no wildcard was introduced.**

### Root cause

Two separate things, and the overnight run conflated them.

1. **The production defect was real and the fix was correct.** With `security.allowedDomains` empty,
   `NodeApp.createRequest()` cannot validate the request `Host` or `X-Forwarded-Proto`, so it falls
   back to the literal `http://localhost`. Behind Caddy the browser's `Origin` would never match and
   every submission would answer 403. Deriving the allowlist from `PUBLIC_SITE_ORIGIN` fixes it.

2. **The test failure had a different cause.** The overnight suite posted **directly to the
   standalone server on its internal port**. That skips the reverse proxy entirely — no rewritten
   `Host`, no `X-Forwarded-*` — so Astro reconstructed an origin that could not match, exactly as it
   should. The tests were failing because the topology was wrong, not because the configuration was.

A reproduction settled it. Measured against the real built server:

| Request path | Astro's `url.origin` | Form POST |
|---|---|---|
| Direct to internal port, Host `127.0.0.1:4340` | `http://localhost` | **403** for any Origin |
| Direct, where the configured origin *is* that host | `http://127.0.0.1:4340` | **200** |
| **Proxied** — Host + `X-Forwarded-*` rewritten to the public origin | the public origin | **200** |
| Proxied, `Origin: https://evil.test` | the public origin | **403** |
| Proxied, no `Origin` header | the public origin | **403** |

The configuration was right the whole time. It had simply never been exercised through the topology
it was written for.

*(A related, incidental discovery: two earlier diagnostic attempts had failed because Astro excludes
`_`-prefixed files from routing altogether, so the probe endpoints were never registered.)*

### Allowed-domain behaviour, exactly

`astro.config.mjs` derives one entry from `PUBLIC_SITE_ORIGIN`:

```js
security: { allowedDomains: [{ hostname, protocol, ...(port ? { port } : {}) }] }
```

- **Exactly one host**, parsed from the configured origin. Never a literal, never a wildcard — a test
  asserts both.
- **Protocol is pinned** (`http` or `https`), so an `X-Forwarded-Proto` claiming the other scheme is
  not honoured.
- **Port is omitted when the origin has none**, because Astro's `matchPort` treats an absent pattern
  port as "any" — which is what makes `https://<domain>` on 443 match in production.
- **Malformed configuration fails the build.** `npm run build` runs `scripts/validate-env.mjs` first
  (rejecting a missing, non-http(s) or path-bearing origin in production), and `astro.config.mjs`
  now *also* validates independently, so a bare `astro build` that skips the npm script cannot emit a
  weakened allowlist either. Failing is the right outcome: a silently-widened allowlist surfaces
  later as either a broken form or a trusted host nobody chose.

### Direct-server policy

**A POST straight to the internal Astro server is rejected, and that is intended.** The internal
server is not an alternative public host. `allowedDomains` names the public origin only, so a request
arriving with the internal `host:port` cannot reconstruct a matching origin.

Broadening the allowlist so both hosts pass would mean trusting a host the site is never served on —
the opposite of what the allowlist is for. Public traffic arrives through the proxy; that is the
boundary. `GET /healthz` is unaffected, so health checks and internal probes keep working.

This is tested rather than assumed (`enquiry-e2e.test.ts`).

### Test topology

`test/helpers/reverse-proxy.ts` is a reverse proxy built from Node core only — no dependency, no
TLS, loopback only. It reproduces the header contract Caddy provides: `Host` rewritten to the public
host, plus `X-Forwarded-Proto`, `-Host`, `-Port` and `-For`. It can also be told to omit the
forwarding headers or to forge one, so misconfiguration and spoofing are exercised rather than
assumed.

```
raw HTTP client (node:http — fetch() cannot set Origin, a forbidden header)
        │  Origin: <public origin>
        ▼
reverse proxy on an ephemeral loopback port   ← PUBLIC_SITE_ORIGIN points here
        │  Host + X-Forwarded-* rewritten
        ▼
built Astro standalone server on 127.0.0.1:4330
        │  server-side submit client
        ▼
mock /forms API on an ephemeral loopback port
```

**This reproduces the required header contract; it is not Caddy.** An RC smoke test is still needed —
see §11.

### Restored tests

`test/enquiry-e2e.test.ts`, **21 tests**, replacing the placeholder:

- a same-origin proxied POST reaches the handler, the mock API and renders the success state — for
  **all three forms**;
- the proxy is asserted to have actually rewritten `Host` and added the forwarding headers, so a
  passing test cannot pass for the wrong reason;
- validation failure returns 400 with per-field links, preserves what was typed, and does not re-tick
  consent;
- a submitted value is escaped, never rendered as markup;
- a hostile `Origin` is rejected for all three forms **and reaches no API**;
- protocol-relative, scheme-less, `null`, wrong-scheme, wrong-port, userinfo-confusion and
  suffix-extension Origins are all rejected;
- a missing `Origin` is rejected — the check fails closed;
- a proxy that omits the forwarding headers fails closed, never open;
- a forged `X-Forwarded-Host` is not trusted over the allowlist;
- a direct internal-port POST is rejected, while `GET /healthz` still works;
- no internal origin, port, `/forms/` path, stack trace or SQL appears in any response, including
  the 403 body.

`test/astro-config.test.ts` gained three tests pinning the allowlist shape, the absence of any
wildcard or literal host, that `checkOrigin` is not disabled, and that a malformed origin is refused.

### Results

Web suite **435 passing** (412 before; the placeholder became 23 real tests). API **998**, root admin
frontend **141**. Astro production build succeeds.

---

## 11. Remaining deployment verification

Local verification is complete; **deployment verification is not, and cannot be from here.**

1. **RC smoke test.** After the next RC deploy, submit each of the three forms from a real browser
   over HTTPS and confirm a 200 and a stored row. That is the only check that proves Caddy's actual
   header behaviour matches the contract this proxy reproduces — in particular that it forwards
   `X-Forwarded-Proto: https` and rewrites `Host` to the public domain.
2. **Confirm `PUBLIC_SITE_ORIGIN` is set to the public HTTPS origin** in the deployed environment. If
   it is unset the container refuses to start (`validate-env.mjs`); if it is set to the wrong host
   the forms will 403 rather than fail open.
3. **Check `form_submissions`** for the RC rows and confirm `delivery_state = 'pending'`.
4. **Then** the delivery, retention and monitoring work in §8 remains outstanding.

**No production system, VPS, live database or DNS was contacted during this correction**, and nothing
was deployed. Astro's CSRF checking was neither disabled nor broadened at any point: the change was
to tell Astro which single origin to trust, and the tests exist to prove everything else is refused.

---

## 12. Submissions are now readable — Fast-Track WS2 Phase 2, 2026-08-06

§3 recorded that a submission is stored and never delivered, and §8 recorded that nothing in the
platform could read one. The second half of that is now fixed: there is a governed operations surface
at `/admin/enquiries` and an Enquiries screen in the root admin panel.
Full detail: [27_ENQUIRY_OPERATIONS.md](27_ENQUIRY_OPERATIONS.md).

### What changed for this document

- **`form_submissions` gained four additive columns** — `handling_status`, `handled_by`, `handled_at`
  and `handling_note` (migration `0009`, mirrored in `ensureSchema()`). The submission columns this
  document describes are untouched, and the enquiry API never writes any of them.
- **`delivery_state` is unchanged and still means what §3 says it means.** `handling_status` is a
  separate column recording what a *person* decided; overloading `delivery_state` to mean both would
  make "we could not email it" and "we have replied" indistinguishable. The enquiry API neither reads
  nor writes `delivery_state`, and never surfaces it on a screen.
- **Reading a submission requires `enquiries.view`**, a new capability nobody holds by default and
  which no `public_content` capability or role implies.
- **The privacy boundary in §4 is extended, not relaxed.** The public router still cannot reach
  `form_submissions` — asserted by test. The new surface is authenticated, capability-gated, and
  serializes through explicit allowlists that re-filter the stored `payload` through the current
  field allowlist rather than returning it as stored. The list view deliberately omits the message
  and the email address; only the detail view shows them.
- **Nothing can delete a submission.** No DELETE route, no `DELETE` statement, no `'deleted'` status.

### Still outstanding from §8

Onward delivery is **still not built** — every submission remains `delivery_state = 'pending'`. What
changed is that an enquiry no longer sits invisible until somebody opens a database client, which was
the sharper of the two problems.

Retention now has **metadata but no enforcement**: the detail screen shows when a record is due for
removal under `forms.retention_days`, and says plainly that removal is not performed from that
screen. An actual retention job is a scheduled, supervised operation and remains outstanding.
