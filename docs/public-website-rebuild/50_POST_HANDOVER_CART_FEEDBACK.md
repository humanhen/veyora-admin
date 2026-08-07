# 50 — Post-Handover Client Feedback: Direct Add to Cart

**Canonical branch:** `mathew/public-website-rebuild`
**This work was done on the working branch `mathew/cart-direct-add-2026-08-07`, branched from the
canonical branch. Nothing was merged. `main` was not touched. Nothing was deployed. No production
system, database, credential or DNS record was accessed.**

---

## 1. Why this document exists, and what it does NOT say

`48_HANDOVER_EXHAUSTION.md` asked whether anything material remained that Mathew could implement
without another party supplying information, credentials, data, approval or access. It answered
**no**, and **that answer was correct when it was written**. Nothing here contradicts it.

What happened afterwards is not a defect in that audit: **the client reviewed the product ordering
interaction and asked for a different one.** New instruction is new scope, and it arrived after the
audit closed. `48` is therefore left standing as the historical record it is, with a pointer to
this document rather than a rewrite.

The production activation instructions in `49_PRODUCTION_ACTIVATION_RUNBOOK.md` and the client
inputs in `49A_CLIENT_INPUTS_REQUIRED.md` remain valid and unchanged. This work changed a
storefront interaction and added one API operation. It unblocked nothing and blocked nothing.

---

## 2. The feedback

The product detail modal used to be a two-stage interaction: dial a quantity on each colourway with
a `+`/`−` box, then press one **Add to cart** button at the bottom to submit the whole selection.

The client asked for the direct interaction instead:

1. No pre-selection quantity control on the product detail modal.
2. Each orderable colourway carries its own visible **Add to cart**.
3. One click adds **exactly one** unit of **that exact SKU** to the real cart.
4. Repeated clicks mean repeated units — first click 1, second 2, third 3.
5. The row shows the **actual quantity in the cart** for that SKU — `In cart: 3` — not a
   selected-but-unsubmitted number.
6. The header cart badge moves immediately.
7. The bottom "submit the quantities you chose" step is gone.
8. `+`/`−` editing stays **inside the cart**, where decrementing 1 removes the line.

---

## 3. What was implemented

### 3.1 A distinct server operation — `POST /user/add-one-to-cart`

`POST /user/add-to-cart` means **set this line to this absolute quantity**, and its meaning is
load-bearing: the cart's own `+`/`−` controls, "Scan your list", Quick reorder and the checkout
snapshot comparison in `ordering.js` all depend on it, and `qty <= 0` is how a line is removed. It
was **not** changed, and the direct-add button was **not** built on it — posting `{qty: 1}`
repeatedly would pin the line at one.

The new operation lives in `platform/server/api/src/cart-operations.js`, which imports no database
module (the query function is passed in, mirroring `ordering.js`) so the rule can be tested on its
own. The route is a thin shell over it.

### 3.2 Concurrency

The increment is **one statement**, not a read followed by a write:

```
insert into cart_items (user_id, sku, qty)
select $1, v.sku, 1 from variations v
 where v.sku = $2 and v.is_active and (backorders-allowed or stock >= 1)
on conflict (user_id, sku) do update
   set qty = cart_items.qty + 1
 where backorders-allowed or cart_items.qty + 1 <= <available stock>
returning cart_items.qty
```

Three guarantees come from that single statement:

| Guarantee | How |
|---|---|
| The SKU is real and active | The inserted row comes from `variations`; an unknown or de-activated SKU produces no row at all, so it is not a check a caller can forget |
| No lost update | On conflict the row is **locked and then read**, so `cart_items.qty + 1` is computed from the newest committed value. Five overlapping clicks — or two tabs, or two devices on one account — produce five units |
| The stock cap holds under concurrency | With backorders **off**, `cart_items.qty + 1 <= available` is a predicate evaluated on the **locked** row, after any concurrent increment has committed. Two requests racing for one remaining unit cannot both win; the loser writes nothing and is told why |

A refused write is silent at the SQL level (zero rows, no error). The operation then asks one
follow-up question — *unknown SKU, or refused by stock?* — so the customer gets the right sentence.
That second statement only runs on the refusal path.

With backorders **on** the predicate is skipped entirely: deliberately ordering more than is on the
shelf is what a backorder is.

### 3.3 The product detail interaction

`platform/server/storefront/js/pages_catalog.js`:

- `variationOrderControls(v)` now renders `In cart: N` · **Add to cart** · **Notify me**. The modal
  calls that helper, so the markup under test is the markup that ships — previously the helper
  produced a `.vactions` wrapper the page never rendered.
- The count element is rendered **empty**. It is filled from the authoritative cart when the modal
  opens and after every add, so it can never show a number the server has not agreed to. A customer
  who already holds three Black frames sees `In cart: 3` the moment the modal opens.
- `createDirectAddController` owns the click behaviour. It is optimistic — the row count and the
  header badge move on the click, before the server answers — while remaining correct:
  - requests for one SKU are **queued**, one at a time;
  - a server cart is only **adopted once nothing is still in flight**, so a reply that is already
    behind the customer cannot drag the count backwards;
  - **any** failure (stock refusal, network, server, withdrawn SKU) drops that SKU's remaining
    queued clicks, re-reads the authoritative cart, repaints rows and badge from it, and tells the
    customer. An optimistic number is never left standing on an add that did not happen.
- The modal **does not close** after an add.
- The per-row backorder note (`6 now · 6 on backorder`) is now driven by the **server's own**
  `inStockQty` / `backorderQty` for that line rather than a client subtraction.
- One polite live region announces the colour that changed (`Black — SKU 1844.1: 3 in cart`); each
  button's accessible name carries the colour and SKU, because every visible label reads
  "Add to cart".

### 3.4 What deliberately did not change

The actual cart (`#/cart`), "Scan your list", Quick reorder, Frame Lists, `qtyBox()`/`bindQtyBox()`,
customer-specific pricing, the salesperson ordering context, hide-prices/presentation mode, the
backorder policy, Notify Me, and `POST /user/add-to-cart` itself.

`1 → decrement → 0` in the cart removing the line was **verified rather than assumed**, and is now
pinned by regression tests on both halves: the shipped `bindQtyBox` floors at zero and emits `0`,
and the route deletes the line at `qty <= 0`.

---

## 4. Verification

All figures below are **actual results from this branch**, not carried forward.

| Control | Result |
|---|---|
| API suite | **1,999 passing, 0 failing** (baseline 1,914) |
| Admin panel suite | **325 passing, 0 failing** |
| Astro site suite | **481 passing, 0 failing** |
| **Total** | **2,805 passing, 0 failing** (baseline 2,720) |
| `npm audit` — API | **0 vulnerabilities** |
| `npm audit` — web | **4 (2 high, 1 moderate, 1 low)** — see §5 |
| Production Astro build | succeeds |
| `node scripts/verify-release.mjs` | **17/18** — see §6 |

### 4.1 Mutation testing

23 representative regressions were injected one at a time, the focused suites run against each, and
the file restored from git afterwards. **23 effective, 23 caught, 0 survivors, no semantic no-ops.**

Two assertion gaps were found and closed in the process:

- The route could have stopped delegating to the atomic operation and assembled its own cart write —
  a second, unguarded increment path no test reached. Pinned.
- Two mutations initially appeared to survive; they had in fact been applied to a *comment* rather
  than the SQL, because the explanatory prose quotes the clause verbatim. The mutation targets were
  corrected and both were then caught.

### 4.2 Responsive and accessibility review — real browser

The shipped product-detail markup was rendered with the shipped stylesheet in headless Chrome at
**360, 390, 768 and 1440**, across five fixtures: mixed stock with counts in the cart, a
40-character colour name with a long SKU and varying prices, hidden prices (presentation mode),
salesperson mode, and backorders disabled. Loopback only; the browser's DNS is dead except for
`127.0.0.1`.

The first run found **two real layout defects**, both pre-existing fragilities that the wider
control block made reachable, and both fixed:

- `.pdetail .vctrl` is `justify-self:end`, which sizes a grid item to its **content** — so
  `flex-wrap` never fired. The control block overflowed its grid area to the **left** and rendered
  on top of the colour name and the stock pill at 360 and 390. It is now capped at `max-width:100%`,
  which is what makes the wrap engage, and on a phone it takes its own full-width row.
- The row's name track was a bare `max-content`, which cannot shrink below its text. A long
  colourway pushed the whole row past the modal at 768, putting the price, count, button and
  Notify me outside the viewport. It is now `minmax(0,max-content)` and ellipsises, as the
  surrounding CSS already intended.

Re-audited after the fix: **no horizontal overflow, no overlap, no element outside the viewport, no
clipped count or backorder note, no console error, every control keyboard-reachable with its focus
ring intact, add button 90×40 on mobile and 88×36 on desktop, no emoji in a functional control.**
Both defects are now pinned by tests.

---

## 5. Dependency drift found during this run

`platform/server/api` still reports **0 vulnerabilities**.

`platform/server/web` now reports **4** — `astro` (high, direct), `@astrojs/node` (moderate,
direct), `sharp` (high, transitive), `esbuild` (low, transitive). **No dependency was changed by
this work**; `package.json` and both lockfiles are untouched on this branch. These are advisories
published against the pinned versions since `48` was written, and `npm audit fix` resolves them only
by installing **Astro 7, a major upgrade**.

That is deliberately **not** done here. This is a bounded interaction correction, and a framework
major is its own piece of work with its own regression run. It is recorded so the receiving
developer decides with the facts rather than discovering it at deploy time.

---

## 6. The release gate on a working branch

`node scripts/verify-release.mjs` reports **17/18**. The single failure is `release-branch`, the
gate that refuses to package from a branch that is not `mathew/public-website-rebuild`.

**That is a branch-name policy failure, not an engineering failure.** Every other gate passed:
`diff-check`, `merge-markers`, `secret-and-host-scan`, all three suites, `deployment-config`,
`forbidden-data`, `forbidden-data-rendered`, `json-ld`, `accessibility-responsive`,
`env-validation`, `astro-build`, `build-output-scan`, `catalogue-chain`, `critical-invariants`,
`deploy-payload`.

`VEYORA_RELEASE_BRANCH_OVERRIDE` **was not used.** The gate exists precisely so that a release is
not packaged from an unreviewed branch, and satisfying it by setting the variable would have
produced a green report that meant nothing. **18/18 may only be claimed once this work is promoted
to the canonical branch and the gate is run there.**

---

## 7. Promotion

This branch is pushed and nothing else was touched. To promote, on the canonical branch:

```bash
git checkout mathew/public-website-rebuild
git pull --ff-only
git merge --no-ff mathew/cart-direct-add-2026-08-07
node scripts/verify-release.mjs          # expect 18/18 here
git push origin mathew/public-website-rebuild
```

The API is a plain Express router change plus one new module, and the storefront is static assets
under `platform/server/storefront` — both inside what `deploy.sh` already ships. **No migration, no
schema change, no new environment variable, no new dependency.** `cart_items` already carries the
`unique (user_id, sku)` constraint the increment relies on.

---

## 8. Where to go next

| You want to | Read |
|---|---|
| Get Veyora live | **`49_PRODUCTION_ACTIVATION_RUNBOOK.md`** — unchanged and still valid |
| Ask the client for what is needed | **`49A_CLIENT_INPUTS_REQUIRED.md`** — unchanged |
| See what was complete at handover | `48_HANDOVER_EXHAUSTION.md` |
| Review this change | `platform/server/api/src/cart-operations.js`, `platform/server/api/test/cart-increment.test.js`, `platform/server/api/test/storefront-direct-add.test.js` |
