# 22 — B2.4B2B Publication Evaluation, Publish and Unpublish Interface

The administrative publication workflow: checking a record against the publication gate, publishing
it, and withdrawing it. Completes the public-content administration surface begun in B2.4B2A.

Scope is B2.4B2B only. **No record was published or unpublished, no permission was granted to any
account, no bootstrap SQL was executed, no schema was changed, and nothing was deployed.**

---

## 1. A deadlock found and fixed

B2.4B2A closed a real bypass: `PATCH` could no longer move a brand into or out of `published`,
because for brands `publication_state = 'published'` *is* the live flag. That fix was correct — and
it exposed a second, pre-existing defect that made the correct path unusable.

**The gate required a record to already be published in order to be publishable.**
`governanceReasons()` in `publication-gate.js` emitted `*_STATE_NOT_PUBLISHED` unless
`publication_state === 'published'`. For brands this was circular and, once PATCH could no longer
reach that state, **unsatisfiable: no brand could ever be published.**

It was broken for every entity type in a second way too. `unpublishEntity` returns a record to
`'approved'` — which the same rule then refused to re-publish, making **unpublication one-way**.

That `'approved'` is exactly the state unpublish leaves behind is the evidence for what the rule was
always meant to say: the record must have been **signed off**, not already live.

**Fix** (`publication-gate.js`, a permitted path): `approved` and `published` both pass. `draft` and
`verified` are not yet signed off; `retired` keeps its own separate reason. The reason **code is
unchanged** — it is a stable part of the API contract that consumers key on — while the message now
carries the accurate requirement. One existing test that pinned `approved` as blocked was updated to
use `verified`, the nearest genuinely-not-signed-off state.

The publication lifecycle is now coherent and reversible:

```
draft → verified → approved ──publish endpoint──▶ published
                      ▲                              │
                      └────── unpublish endpoint ────┘
```

---

## 2. Route and capability mapping

All nine endpoints already existed in B2.4A; this batch adds no route and changes no response shape.

| Action | Endpoint | Capability |
|---|---|---|
| Evaluate | `POST /admin/public-content/{brands\|products\|variations}/:id/evaluate` | `public_content.view` |
| Publish | `POST …/:id/publish` | `public_content.publish` |
| Unpublish | `POST …/:id/unpublish` | `public_content.publish` |

**Evaluation is gated on `view`, not `publish`** — that is the API's existing contract, and it is
right: the check is a read that computes a verdict and writes nothing, so a reviewer can see why a
record is not ready without being able to act on it. The interface follows the contract rather than
narrowing it.

**Publish and unpublish require `public_content.publish` and nothing else.** They do not require
`edit`; the API has never required it, and requiring it in the UI would have invented a stricter
rule than the server enforces. A publish-only account therefore gets the decisions with every form
control disabled.

The three capabilities remain mutually independent: `view` does not imply `edit`, `edit` does not
imply `publish`, `publish` does not imply `edit` or `view`. Frontend role or admin status grants
nothing, and logout clears all capability state.

---

## 3. API client

Nine narrow functions on `DB`, fixed paths, `apiCall` still private, no generic helper:

```
DB.evaluateBrand(id)      DB.publishBrand(id, token, note)      DB.unpublishBrand(id, token, note)
DB.evaluateProduct(id)    DB.publishProduct(id, token, note)    DB.unpublishProduct(id, token, note)
DB.evaluateVariation(id)  DB.publishVariation(id, token, note)  DB.unpublishVariation(id, token, note)
```

- **Evaluate sends no body at all** and returns `{allowed, reasons[]}` shaped through an explicit
  allowlist. It does not return a refreshed token, and the client does not touch the held one.
- **Publish and unpublish send exactly `{concurrencyToken}` plus an optional `note`.** There is no
  way to send an actor, an approver, an approval timestamp, `is_published` or `publication_state` —
  the server takes the decision-maker from the authenticated session and writes the
  `content_approvals` row itself.
- `allowed` is read strictly (`=== true`), so a malformed or partial verdict reads as **blocked**.
- `400`, `401`, `403`, `404`, `409`, `422` and server failure stay distinguishable via `err.status`.
- **No mutation is retried automatically.** A publication decision that may already have been applied
  is never replayed by a machine.

---

## 4. Evaluation workflow

A **Publication** panel on every brand, product and variation record.

- **Evaluation is explicit.** Opening a record never evaluates and never mutates. (The detail `GET`
  happens to embed a gate verdict; the interface deliberately ignores it, so what is displayed is
  always a verdict the operator asked for, at a moment they can identify.)
- A visible checking state while the request is in flight, announced via `aria-live`.
- The outcome renders as **allowed** or **blocked with every reason listed**.
- **Server order is preserved exactly.** The API sorts reasons by code so two evaluations are
  byte-identical; nothing is re-sorted, regrouped, deduplicated or reworded. An unrecognised code
  still renders, carrying the server's own message.
- Each reason shows its message, its field path (including nested paths like `variations[0].color`,
  rendered as escaped text), and its stable code — the code is what an editor quotes in a bug report.
- Where a reason names a field that is an editable control on this screen, a **Go to field** button
  focuses it. Where it names a related record, no link is offered and the reason still renders.
- **Advisories are separate.** They come only from the product detail response, never from the
  evaluate endpoint, and are labelled as not blocking publication. A note can never be mistaken for
  a blocker, or a blocker for a note.
- No raw JSON is ever dumped.

**Readiness is never claimed from frontend validation.** The verdict shown is always the server's.

---

## 5. Publish workflow

Publish appears only with `public_content.publish`, and only for a record that is not currently
published. It is enabled only when a **fresh** evaluation said allowed.

On activation: an explicit confirmation naming the record and explaining that it will become visible
on the public website, with an optional note. On confirmation the client sends the current token; the
button disables itself on the first click so a double submission cannot produce two decisions.

Local state is replaced **only after confirmed API success**, from the server's response, so the new
publication state and the refreshed token both come from what actually happened. The spent token is
gone. The readiness verdict is discarded, because it described the pre-decision record.

**A blocked record cannot be published.** Publish stays disabled, the reasons are shown, and there is
**no bypass control** — no "publish anyway", no override, and no `published` option in the
publication-state select at any capability level.

The frontend cannot set `is_published` or `publication_state` as a substitute: `is_published` is on
the API's immutable list, the client's allowlist filter drops it, and the B2.4B2A boundary guard
refuses a `published` transition through `PATCH`.

---

## 6. Unpublish workflow

Unpublish appears only with `public_content.publish`, and only for a currently published record. It
requires **no readiness check** — withdrawing something from public view must always be possible,
immediately, which is why the API does not gate it.

The confirmation says plainly what happens and, just as importantly, what does not:

> The public website will stop returning this record. **Nothing is deleted** — the content, its
> approval history and its URLs are preserved, and it can be published again later.

**Unpublish is never presented as deletion.** The words *delete*, *destroy* and *permanently* appear
nowhere in the panel, asserted by test. The server preserves content, approvals and redirect history;
this batch verifies that with regression tests rather than assuming it.

Success replaces the token and the visible state, and discards any stale verdict. Because of the §1
fix, a withdrawn record can be published again.

---

## 7. Confirmation behaviour

Built on the panel's existing `Modal` — no new dependency.

- Real `<button>` elements, keyboard operable, with visible focus styling.
- The confirming button says exactly what it will do (**Publish** / **Unpublish**), never a generic
  *OK*.
- Explicit **Cancel**, plus the dialog's close control; both abandon without acting, tested for each.
- The record is named in the dialog.
- Publish and Unpublish are visually and textually distinct (unpublish uses the danger styling).
- The action button disables itself and relabels on the first click; a second click does nothing.

---

## 8. Concurrency

The token from the record's own `GET` is held and returned unchanged on a decision. An evaluation
never disturbs it. A variation is decided with **its own** token from its own endpoint, never the
product's — asserted by test.

On `409`:

- The decision is **not** retried, silently or otherwise (exactly one request, asserted).
- The screen reports that another administrator changed the record and that **nothing was changed**.
- A **Reload current version** action re-reads the record.
- Reloading discards the stale verdict and disables Publish until a fresh check.

---

## 9. Dirty-edit policy

A publication decision acts on the **stored** record. If the form showed unsaved edits, the operator
could reasonably read a verdict — or a publish — as applying to what is on screen. So:

- **Unsaved edits block evaluation.** The check would describe the saved record while the form shows
  something else.
- **Unsaved edits block publish and unpublish**, both by disabling the buttons and by a second guard
  in the handler.
- The panel explains why, in place, as soon as the record becomes dirty.
- **Edits are never silently discarded.** The operator saves or resets; nothing else clears them.
- An edit made while a verdict is displayed marks it **out of date** immediately, and a stale verdict
  can never enable Publish.
- Saving clears the block and discards the pre-save verdict, so Publish waits for a fresh check.

All of this is applied in place, without a full re-render, so the field being typed into does not
lose the caret.

---

## 10. Error handling

| Status | Behaviour |
|---|---|
| `401` | Session expired — nothing was changed. |
| `403` | This account cannot perform this action — nothing was changed. |
| `404` | The record no longer exists. |
| `409` | Conflict, as §8 — never reported as success. |
| `422` | The gate refused inside the transaction: its reasons replace any earlier verdict, in server order, and the record is no longer presented as ready. State is unchanged and no success is claimed. |
| other | "The action could not be completed. Nothing was changed." |

Raw API bodies are **never rendered**. The only server text shown is gate reason messages and
`fieldErrors[].message` — both type-checked, and both written to be read by an administrator. A test
feeds the screen an error containing SQL, an IP address, a port and a stack trace and asserts none of
it reaches the operator.

---

## 11. Approval-result presentation

The API records a `content_approvals` row for every publish and unpublish, with `approver_id` taken
from the authenticated session and the operator's note attached. **It does not return that row**, and
there is no approval-history endpoint — building one was out of scope.

So the interface presents what the API actually returns: the resulting publication state, the
published indicator, and confirmation that the decision was recorded against the signed-in account.
It does **not** invent an approver name, an approval timestamp or a history list. Surfacing the
recorded history needs a read endpoint that does not exist yet (§14).

---

## 12. Tests

| Suite | Tests | Covers |
|---|---|---|
| `platform/server/api/test/publication-boundary.test.js` | 22 | PATCH cannot cross the boundary in either direction for any transition; editorial transitions still work; the gate cannot be routed around; publish runs the gate and records an approval; a failed gate and a stale token each write nothing; unpublish records a decision and deletes nothing; the approver is never client-supplied; edit and publish are independent; the approved→published→approved round trip |
| `test/publication-workflow.test.js` | 42 | capability separation for all four combinations; explicit evaluation with no mutation; server reason order; nested field paths; blocked vs allowed; advisories; confirmation, cancel and dismiss; double-submission; token send/replace/never-reused; `409`/`422`/`401`/`403`/`404`/generic; dirty-edit blocking; no actor/approver/`is_published`; no bootstrap control; accessibility |

**API suite: 845 passing, 0 failing** (823 baseline + 22). **Frontend suite: 141 passing, 0 failing**
(99 baseline + 42). Frontend tests load the real shipped `js/*.js` in the `vm` harness.

Six earlier tests were updated, all because behaviour genuinely changed: three B2.4B2A tests that
asserted *no publication control exists on this screen* now assert that publication controls are
**capability-gated** (still absent for view-only and edit-only accounts); two asserted error wording
that had to become action-neutral now that one function serves save, evaluate, publish and unpublish;
and one API test pinned `approved` as unpublishable, per §1.

---

## 13. Bootstrap prerequisite — unchanged and still blocking

`account_permissions` is still empty, so `/capabilities` returns all false for every account. **No
account can reach this screen, and no publication decision can be made by anyone**, including every
existing administrator. Nothing here can perform or bypass the bootstrap.

Before the publication workflow can be used:

1. perform the controlled bootstrap in [19_ACCOUNT_PERMISSION_SYSTEM.md](19_ACCOUNT_PERMISSION_SYSTEM.md) §8;
2. grant `permissions.manage` to a second active account;
3. grant `public_content.view`/`.edit` to editorial staff and `public_content.publish` to whoever is
   authorised to put content on the public website.

R-17 is unchanged by this batch: the mechanism and its interfaces exist; the grants do not.

---

## 14. Limitations and B2.4C deferrals

- **No approval history is shown.** The rows are written but there is no endpoint to read them; the
  interface deliberately shows only what the API returns rather than inventing an approver name or
  timestamp. A read endpoint plus a history view is the natural next step.
- **No bulk publication.** Decisions are one record at a time, deliberately.
- **Publishing a product does not cascade to its variations**, and the interface does not imply it
  does — each is published on its own record. There is no combined "publish this model and its
  colours" action.
- **No preview** of how a record will look on the public site before publishing.
- **No scheduled publication.** `scheduled_review_at` is a review reminder, not a publish date.
- **Variation concurrency remains weaker** than brands' and products': `variations` has no
  `updated_at` column, so its token is derived from `created_at` plus its editable fields — the
  pre-existing limitation recorded in `18_B2_ADMIN_PUBLICATION_API.md`, unchanged here.
- **The `*_STATE_NOT_PUBLISHED` reason code now reads narrowly** for what it checks (approved or
  published). The code was kept stable on purpose; the message is accurate.
- **Catalogue backfill, record creation and media upload** remain out of scope, so a real publication
  run still depends on content existing and being signed off.
