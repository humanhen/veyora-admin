# 45 — Client Feedback Implementation (A–M)

**Branch:** `mathew/final-integration-2026-08-07`
**Baseline:** `22e937f` (Final Release Correction)
**Nothing was pushed. `main` was not merged or fast-forwarded. `mathew/public-website-rebuild` was
not modified.**

Numbered 45 because `41_FINANCE_OPERATIONS.md` and `42_DUPLICATE_SUBMISSION_SWEEP.md` already exist,
and `44` is this run's branch integration report. The brief's suggested numbers would have
overwritten completed work.

---

## 1. The run

| Phase | Outcome | Commit |
|---|---|---|
| 1 | Consolidate the other developer's storefront work | `2218c28` |
| 2 | Apply the prepared Stripe payment control | `fe1df67` |
| 3 | Client feedback **A** | `3eea07c` |
| 3 | Client feedback **B, C** | `5938c83` |
| 3 | Client feedback **D, E, F** | `24e8437` |
| 3 | Client feedback **G, H, I, J** | `f4d93be` |
| 3 | Client feedback **K, L, M** | `8974c53` |
| 4–5 | Regression and static integrity QA | `43b2f18` |

| Suite | Start | End |
|---|---|---|
| API | 1,669 | **1,802** |
| Admin panel | 298 | **325** |
| Public website | 466 | **466** |
| **Total** | **2,433** | **2,593 passing, 0 failing** |

Release gate **18/18**. `npm audit`: **0 vulnerabilities**.

---

## 2. Every item

### A — emoji are not icons

Forty call sites across both surfaces used emoji as functional controls: 🛒 for the cart, 👤 for the
account, 🗑 to remove a line, 📷 to upload a photo.

An emoji renders in the operating system's own colour and shape, so it ignores the design entirely;
it changes between Windows, macOS, Android and iOS; and a screen reader announces its CLDR name
("wastebasket", "bust in silhouette") rather than what the control does. On a wholesale ordering
system for opticians it reads as consumer chat.

`platform/server/storefront/js/icons.js` is **one** registry of 32 icons on a shared 24×24 grid, in
the style already hand-written across these pages: no fill, `stroke="currentColor"`, round caps.
`currentColor` is the load-bearing part — an icon takes the colour of the control it sits in, so the
dark topbar and a white card need one copy rather than two.

`NAVICON` was a **second** hand-written registry of the same shapes; it now derives from the shared
one. The admin panel already had its own registry (`I` in `util.js`) containing `money`, `fileCsv`,
`pdf`, `check` and `plus`, so its seven emoji needed no new icons at all.

**Accessibility did not regress.** Every icon is `aria-hidden` and `focusable="false"` — it is
decoration inside a control that carries its own name. Where replacing a glyph with a picture would
have *lost* that name, the control gained an explicit `aria-label`, and a test asserts every
icon-only button still has one.

**Typographic arrows were deliberately kept.** `pending → shipped` in an audit line is punctuation,
and turning it into an image would be worse for a screen reader. An arrow used as the *label of a
control* is a different thing, caught by its own assertion — which found `← Back to sign in` in two
places.

### B — a return is an operation on an order

`POST /user/returns` **had no test at all.** That is how it came to accept:

| Accepted | Consequence |
|---|---|
| `orderNumber` as free text, never verified | Any customer could file a return citing **any other customer's** order |
| any `sku` string | A frame the customer never bought — or that never existed — could be returned |
| an unbounded `qty` | One frame could be returned ten times |
| **a `price` from the request body** | A return is a credit note in waiting, so a browser could **name its own refund amount** |

`src/returns.js` re-derives all of it. The order must be the caller's own and must have shipped;
every SKU must be a line on it; the quantity may not exceed what remains un-returned across all
previous returns; and **the price and name are read from the order line.** The route now touches
`req.body` exactly once — to hand it to the validator — and inserts only the validated plan.

Validation runs **inside the transaction, with the transaction client**, after `select … for update`
on the order row. Reading returnable quantities on the pool while inserting on a client would let two
simultaneous returns both spend the last unit.

An order belonging to somebody else answers **identically** to one that does not exist, so trying
order numbers reveals nothing — the same reasoning the invoice payment routes already use.

**Also fixed:** `parseInt` turned a quantity of `1.5` into `1` and `"3 pairs"` into `3`, so a
customer who typed something the system could not honour was silently given a different number rather
than told.

### C — the exchange frame is chosen, not typed

The form asked people to type "the SKU of the frame you want instead". Nobody knows a SKU by heart,
so the realistic outcomes were a typo or a blank.

There is now a bounded server search — 20 rows, 2-character minimum, **both enforced where the query
runs** — feeding a debounced combobox with arrow keys, Enter, Escape and `aria-activedescendant`. A
type-ahead reachable by any signed-in browser is a catalogue export unless the limit lives in the
SQL, not in the page that calls it.

It returns **no price**: identifying a frame does not require one, and a hide-prices account must not
be handed prices through a search box the catalogue withholds. LIKE metacharacters are escaped, so
typing `50%` searches for `50%`.

Editing the text after picking clears the hidden SKU — otherwise a customer could see one frame in
the box and submit another.

### D — purchase history and reorder presentation

- **"In Stock" is capitalised**, and so is every other availability label. `Available to Backorder`
  beside it was already capitalised while `in stock` was not, which is precisely what made it look
  careless. A test walks each label word by word rather than pinning the one string reported.
- **The white thumbnail border is gone.** The photos are already cut out on white, so a white plate
  with a grey outline drew a second rectangle around every frame.
- **The narrow wrapping is fixed.** The reorder row carries a thumbnail, SKU, name, cadence, an
  overdue badge, a stock pill and a button, and the name column was the only element allowed to
  yield — so it collapsed to its 80px basis and wrapped to four lines while everything else kept its
  width. It has a 220px basis, and the full row on a phone.

### E — Back navigation

`history.back()` alone is not good enough. A customer arriving on a deep link from an email or a
bookmark has no previous entry inside the portal, so `back()` either does nothing or walks them out
of the site and loses the session. Both look broken.

Back is **history-first, fallback-always**: history is used only while we know we put those entries
there (counted per in-app navigation), and otherwise the customer goes to the parent of the current
screen — derived from the route, so it is the same answer every time rather than "wherever you
happened to come from". If a history step does not move the hash within 120 ms, the deterministic
fallback runs anyway, so the control is never dead.

**Screens with no parent render no Back control at all.** A control that goes nowhere is worse than
no control.

One case needed its own rule: `#/order` is only ever rendered with an id, so `#/order/SO-100` must
consult the parent table (`#/orders`) rather than falling back to its own key and landing on a screen
that does not exist. A test walks every registered route and asserts every fallback is a real one.

### F — less bubbly, more robust

Twenty-two fully-round shapes were the main driver. The change is made in **tokens** —
`--radius-badge`, `--radius-chip`, `--radius` — so the decision lives in one reviewable place rather
than in twenty-two rules, and both surfaces share it.

Status labels and chips became rectangles: a badge is a *label*, and a label with a straight edge
reads as trade software. **Round shapes survive where the shape means something** — count bubbles,
circular icon buttons. This is a change of register, not a purge. Colour swatches stopped being round
because a round crop cut the frame off.

The card shadow stacked a tight shadow under an 18px soft one, which lifted every card and made a
dense ordering screen look like floating tiles. One shadow, close to the surface, on both surfaces.

### G — Balance & Payments, and the credit limit

One screen answering what an optician rings up to ask: what do I owe, what have I paid, and how much
can I still order.

Migration **0017** adds `users.credit_limit` — nullable, no default, no backfill — mirrored in
`ensureSchema()` per the parity contract established at `22e937f`. The parity suite was **tampered
first** to confirm it would have caught the omission. It did.

> **NULL IS NOT UNLIMITED.** It means nobody has set one, and every account in the database reads
> NULL the moment 0017 runs — so treating the two as the same would grant infinite credit to the
> entire customer base in a single deploy.

`creditLimit` travels as `null` with `creditLimitConfigured: false`, no headroom is computed, and the
page says **"Not configured"** in those words. Nor is it coerced to `0`, which would say the
opposite: that they may order nothing.

A **zero** limit *is* configured — a deliberate pro-forma-only decision. Pinned for the number `0` as
well as the string `'0.00'`, because `pg` returns numeric as a string today and a truthiness check
passes on `'0.00'` by accident.

**The customer may never set it.** The route is a `GET` with no companion write; the page contains no
input element and calls no write method; and `credit_limit` is deliberately **absent from the users
sync collection** in `shape.js`, so a whole-row diff posted by a browser cannot carry it either.

A `processing` invoice still counts as **outstanding**. A completed checkout is not a settled invoice
until a signed webhook says so.

### H — invoices are prominent

Balance & Invoices sits in the main navigation beside Orders, and the screen **reuses the existing
pay control** rather than re-implementing which invoice is payable — two implementations is how two
screens come to disagree.

### I — orders expand, and carry the address as it was

Orders expand in place to their lines, with photos, fetched on first expand rather than for twenty
rows nobody opened. The caret and the row are separate targets, so neither has to guess.

**And a real defect.** `shipping_address` was stored as `req.body?.shippingAddress ?
JSON.stringify(…) : null` — the browser's word for it, and NULL when the browser said nothing. Most
orders therefore carried **no address**, so any screen showing one had to fall back to the customer's
*current* profile address.

> That is the one thing an order record must never do. A customer who moves would see every
> historical order redirected to their new premises, and a dispute about where goods actually went
> would be unanswerable.

Both the order and the backorder insert now stamp a complete snapshot from the customer record,
bounded per field, with a supplied address allowed to override but never to empty it. The storefront
renders **only** the stamp, and says plainly when an older order has none.

### J — the phone navigation

Home, Products, Orders, Cart, Account. **Spare Parts is moved, not removed**: it keeps its route, its
page and its main-nav entry, and simply stops occupying one of five slots a buyer uses daily.

### K — the dashboard drills down

Tiles with a screen behind them are anchors to it — focusable, announced as links, ctrl-click and
middle-click work. A test walks every destination and asserts it is a registered admin route, because
a tile pointing at a renamed screen is a dead end.

**ACTIVE CARTS deliberately stays a plain tile.** Abandoned-cart tracking does not exist, and a tile
leading somewhere unrelated is worse than one that leads nowhere — so it says "abandoned-cart
tracking is not yet available" instead.

### L — accounts receivable

There was a Collection & Debt list of flagged customers and no view of the receivable as a whole.
`js/receivables.js` is a pure calculation — no DOM, no database — producing Revenue, Open AR, Past
Due, Future Due, Total AR and a five-bucket ageing, in integer cents throughout.

**Open AR and Total AR come from different places on purpose.** Open AR is the unsettled invoices;
Total AR is the customer ledger, which also carries payments on account and credit notes. When they
disagree the difference is usually unapplied cash or an unmatched credit — the single most useful
thing on the screen — so the page **reports the gap** rather than quietly picking one.

Three judgements worth stating:

| Decision | Why |
|---|---|
| An unrecognised invoice status counts as **open** | Under-stating a debt is the more dangerous error |
| An invoice due **exactly today is not late** | Off-by-one there is how an ageing report starts chasing customers a day early |
| A customer with no terms is aged on the default, **and the count is shown** | A silent default across a hundred accounts makes an estimate look like a measurement |

Found while testing the third: `Number(null)` and `Number('')` are both `0`, so the first version read
"no terms recorded" as "due the day it was issued" — which would have shown a whole ledger as past
due.

### M — backorders in the same design system

The page had its own hand-rolled line markup with no photos while orders had been given both; both
now use one `orderLineRow()`. Backorders also show the stamped delivery address, which matters most
there: a backorder ships later, often much later, which is exactly when a stale address would bite.

The last two `window.confirm()` calls are gone. That renders the *browser's* dialog — it carries the
page URL, cannot be styled, and on a phone it is a system sheet that looks nothing like the portal.
`confirmModal()` replaces them, with **Cancel focused** so a reflex Enter cannot confirm a deletion,
and closing or clicking away counted as declining.

---

## 3. Defects closed, beyond the feedback

| # | Defect | Where it came from |
|---|---|---|
| 1 | **A return's price came from the request body.** A browser could name its own refund | Pre-existing, untested route |
| 2 | **A return could cite any customer's order**, and any SKU, in any quantity | Pre-existing |
| 3 | **`shipping_address` was the browser's word for it, and usually NULL** — forcing every screen to fall back to the current profile address | Pre-existing |
| 4 | **A fractional return quantity silently became a different number** | Pre-existing |
| 5 | **"Notify me" was removed whenever backorders were on** — approved functionality dropped by the branch being integrated | Integrated branch |
| 6 | **Four product images declared `height="800"` for `800×1003` files** | Integrated branch |
| 7 | **`Number(null)` aged an invoice as due on issue** | **My own**, caught by its own test |

---

## 4. Tests that were passing for the wrong reason

Two, both found by tampering rather than by reading.

**The cross-customer returns tests.** They passed because the *test double* filtered rows by
customer — not because the SQL did. Dropping `customer_id = $2` from the order lookup changed
nothing. The boundary is now also pinned in the **query text**, which is the part a double cannot
fake, and the tamper is caught.

**The storefront load test.** It read `ctx.Routes` and would have passed against the empty stub
forever: `const Routes = {}` at the top level of a plain script is **not** a property of the global
object. It now evaluates the name inside the sandbox.

---

## 5. Assertions retargeted, and why that is not weakening

Nine existing assertions failed because they pinned an implementation detail rather than the property
they were named for. Every one was rewritten to assert the property, and **every rewrite was
re-proved by injecting the regression it exists to catch**.

| Assertion | Pinned | Now asserts |
|---|---|---|
| "no third-party asset or dependency" | *any* outbound URL | nothing is **fetched** from any host; links go to an allowlist |
| "no image container is excessively tall" | the old 4:5 tile shape | the box is **bounded**, whatever the shape |
| "every photograph is cropped to its subject" | `object-position` on product tiles | product tiles use `object-fit:contain` — nothing cropped |
| "a QUANTITY BOX renders" | `type="number"` | **numeric entry**, however spelled |
| "the qty box children are fixed-size" | single-line CSS formatting | the rule, whitespace-independent |
| "the pulse tiles name their currency" | `<div class="stat-label">…` | the **label** names the currency |
| "the backorders page keeps every detail" | inline line markup | the same facts, where they now live |
| account-permissions destructive-SQL guard | everything after 0008 to EOF | its **own section**, plus a direct invariant across the whole file |

**Total tamper tests this run: 47 injected regressions, 47 caught.**

---

## 6. Schema

One migration, **0017**, entirely additive: one nullable column, no default, no backfill, no drop, no
truncate, no retype. Mirrored in `ensureSchema()`; the parity suite and the `critical-invariants`
gate both pass unchanged, and the parity contract was verified by tampering before the mirror was
written.

---

## 7. Still outstanding

1. **No account holds any capability.** By design. Unchanged.
2. **Credit limits are all NULL** until Veyora sets them. The commercial control around them was
   completed in a later run — capability, audited admin endpoint, and server-authoritative
   order-time evaluation. See `46_COMMERCIAL_CREDIT_AND_PRIVACY.md`.
3. **Migration and deployment rehearsal** remain undone; both need a real disposable database.
4. ~~**The Meta Pixel on the storefront**~~ **CLOSED 2026-08-07** — removed entirely; see `46_COMMERCIAL_CREDIT_AND_PRIVACY.md` §5. The original finding, for the record: it loads
   `connect.facebook.net` on every page of an **authenticated** portal and tracks every in-app
   navigation for signed-in trade customers, with a hard-coded pixel id and no consent gate. The
   comment says it is deliberate ("same pixel the old veyora.com uses"), so this is a marketing and
   privacy decision for the client to confirm — not something to remove unilaterally. The same page
   loads Google Fonts from a CDN.
5. **The invoice's final visual match** still needs the historical reference PDF.

---

## 8. What did not happen

No production or VPS access. No live database. No DNS change. No deployment. No Stripe call, live key
or webhook. No real email. No destructive migration. No capability bootstrap. No branch pushed. No
merge or fast-forward of `main`. `mathew/public-website-rebuild` was not modified.
