# 20 — B2.4B1 Account Permission Management Interface

The admin-panel screen for viewing and managing the per-account capabilities delivered in B2.4P.

Scope is B2.4B1 only: the interface, its tests and this document. **No API endpoint was added or
changed, no schema was touched, no permission was granted to any real account, and the production
bootstrap was not performed.**

---

## 1. Admin frontend location and framework

| | |
|---|---|
| **Root** | the repository root — `index.html`, `css/`, `js/`, `assets/` |
| **Framework** | none. A dependency-free vanilla-JS single-page app |
| **Module system** | plain `<script>` tags with shared globals (`App`, `DB`, `Auth`, `I`, `Modal`, `esc`, …) — no ESM, no bundler |
| **Build step** | none. `platform/server/deploy.sh` tars exactly `index.html css js assets` to `$DEST/admin`, which Caddy serves from `/srv/admin` at `/admin/` |
| **Routing** | hash routes. `App.register('name', fn)` renders into `#content`; the `NAV` array drives the sidebar |
| **API client** | `DB.*` methods wrapping a **private** `apiCall(method, path, body)` in `js/data.js`. `apiCall` is not exported, so there is no general-purpose request function |
| **Notifications** | `toast(msg, isError)`, `Modal.open/confirm`, and inline card states |

This is the panel referred to elsewhere in these documents as "the root admin frontend". Storefront
(`platform/server/storefront`) and the Astro public site (`platform/server/web`) are separate and
were not touched.

---

## 2. Access model

The signed-in session is `{id, name, role}` and carries **no capabilities**. The browser therefore
cannot know from the session whether the account holds `permissions.manage`.

Deriving it from the `admin` role was rejected outright: that is precisely the role bypass
account-specific permissions exist to remove, and it would show the screen to admins the server
refuses.

**The panel asks the server instead.** `GET /admin/account-permissions/registry` is itself gated on
`permissions.manage`, so its response *is* the answer:

| Probe result | Meaning | Effect |
|---|---|---|
| `200` | the capability is held | nav entry shown, screen usable |
| `403` | not held | nav entry hidden, direct visit shows access denied |
| anything else (network, `500`) | unknown | treated as **not held** — fail closed |

`App.loadCaps()` runs the probe after sign-in and after a data load, caches the result in
`App.caps` (a `Set`), and re-renders the nav when it settles. `App.can(key)` reads the cache.
Logout clears it, so the next sign-in re-probes rather than inheriting the previous account's menu.

### What this is and is not

**Hiding the nav entry is convenience, not a control.** Three independent statements matter:

1. The cache is a *display hint*. It can go stale — another manager may revoke mid-session — and
   that is safe: a stale `true` shows a menu entry whose every request the server still refuses, and
   the screen renders the refusal honestly rather than a working editor.
2. A direct visit to `#/account-permissions` re-checks (and probes first if the answer is not yet
   known), rendering an access-denied card rather than the screen.
3. **The API is the authority.** Every read and every write is authorised server-side by
   `requirePermission('permissions.manage')` regardless of anything the browser believes.

There is no development bypass, no environment flag, no hard-coded account id and no hard-coded
email anywhere in this interface.

---

## 3. Route and navigation

- **Route:** `#/account-permissions`, and `#/account-permissions/<userId>` with an account selected.
- **Navigation:** a top-level sidebar entry, **Account Permissions**, placed immediately above
  *Audit log*. Both are cross-cutting governance surfaces, which is why it sits there rather than
  inside a functional group.

`NAV` entries gained an optional `requires` field naming a **capability**. `renderNav()` filters on
it, and a group whose every item is filtered out is itself hidden. `account-permissions` is the only
gated entry; every pre-existing entry is unrestricted and renders exactly as before.

---

## 4. API calls

Three narrowly scoped methods added to `DB` in `js/data.js`. Each builds a **fixed** path — no
caller supplies a URL — and each shapes the response through an explicit allowlist rather than
spreading it.

| Method | Endpoint |
|---|---|
| `DB.permissionRegistry()` | `GET /api/admin/account-permissions/registry` |
| `DB.accountPermissions(userId)` | `GET /api/admin/account-permissions/users/:userId` |
| `DB.saveAccountPermissions(userId, keys, token)` | `PUT /api/admin/account-permissions/users/:userId` |

- They reuse the existing authenticated client (`credentials: 'same-origin'`), which already maps
  `401`/`403` and preserves `err.status` for everything else — so `401`, `403`, `404`, `409`, `422`
  and server failure all remain distinguishable to the caller.
- The `PUT` body is exactly `{ permissions, concurrencyToken }`. **The frontend cannot send an
  actor** — no `granted_by`, no `revoked_by`, no user id in the body. The server takes attribution
  from the authenticated session and would ignore it anyway; not sending it means the UI cannot even
  appear to influence attribution.
- **Nothing is retried automatically.** A mutation that may already have been applied is never
  replayed without an administrator deciding to.
- User ids are `encodeURIComponent`-escaped into the path.

---

## 5. Account selection

The left pane reuses **`DB.d.users`** — the account list the panel has already loaded and already
renders on the Users screen. No second user directory was created and no search endpoint was
invented; filtering, searching and paging happen client-side over that existing list, exactly as the
Users screen does.

Shown per account: display name, `@username`, role badge, and a status badge when the account is
not active. Deliberately **not** shown: email, phone, address, tax id, balance, pricing or anything
about credentials. (Email remains searchable, because disambiguating two similarly named accounts
matters when granting authority, but it is not rendered on this screen.)

Selection lives in the URL, so it survives navigating away and back — the same pattern as
`#/suitcases/<id>`.

---

## 6. Permission editor

Renders the **server's registry**. The four keys come from `GET /registry`; the screen never invents
one, and a key the server does not return is not rendered.

Grouping (presentation only):

**Public content**
- View public content administration — `public_content.view`
- Edit public content — `public_content.edit`
- Publish and unpublish public content — `public_content.publish`

**Permission administration**
- Manage account permissions — `permissions.manage`

Each row shows the registry label, the registry description, the current state as a checkbox, and a
history line: *Granted <date> by <name>*, *Revoked <date> by <name>*, or *Never granted*. A revoked
capability renders unticked with its revocation visible — it is never shown as held.

The screen states in plain words that **editing and publishing are independent**: granting Edit does
not allow publishing, and granting Publish does not allow editing.

### Input safety

- Checkboxes are the only permission input. There is **no free-text field**, no wildcard entry, and
  no way to type a key.
- Duplicates are impossible: the draft is a `Set`, and the payload is built by filtering the
  registry, so the request is de-duplicated and in registry order by construction.

### Saving

- **A toggle changes nothing.** It edits a local draft and repaints the Save/Reset affordances.
  No API call is made until Save is pressed.
- Save sends the **complete intended active set**; anything omitted is revoked server-side.
- **Save is disabled** when the draft equals the last server-confirmed state, and while a save is in
  flight. A live status region reads "Unsaved changes" / "No unsaved changes".
- **Reset** restores the last server-confirmed set.
- Switching accounts with unsaved edits raises a confirmation naming the account; navigation is held
  until it is confirmed.

---

## 7. Concurrency

The token from the `GET` is held with the loaded state and returned unchanged on `PUT`.

- Local state is replaced **only after a successful response**, and from the server's response —
  never from what was sent.
- The returned token replaces the old one, so a second save carries the refreshed token and the
  spent one is dead.
- **A token is never reused across accounts.** It is stored with the loaded account and discarded
  when the selection changes; the server additionally binds the token to the account id.

On `409`:

- The save is **not** retried, silently or otherwise.
- The screen says another administrator changed the permissions and that **the change was not
  saved**.
- A **Reload current permissions** action re-reads the stored state.
- Local edits are preserved and still flagged as unsaved, so nothing is lost before the operator
  chooses; reloading is the explicit act that discards them.

---

## 8. Error handling

Every branch produces a sentence written for an administrator. The raw response is never rendered.

| Status | Message |
|---|---|
| `401` | Session expired — sign in again. Nothing was changed. |
| `403` | This account lacks permission to manage account permissions. Nothing was changed. |
| `404` | That account no longer exists; it may have been deleted by another administrator. |
| `409` | Another administrator changed these permissions. Your changes were **not** saved — reload and reapply. |
| `422` | This would remove the last account able to manage permissions. Grant it to another active account first. Nothing was changed. |
| other | The permissions could not be saved. Nothing was changed — check your connection and try again. |

A failed save never reports success, never mutates the saved state, and leaves the attempted edit in
place so the operator can retry deliberately. API error strings, stack traces, SQL, hostnames and
ports are never shown — tested directly by feeding the screen an error containing all of them.

---

## 9. Final-manager protection

The `422` case is the browser-side half of B2.4P's last-manager guard. The server evaluates the
count inside the transaction; the interface explains the outcome in terms of consequence
("would lock everyone out of permission administration") and the remedy ("grant it to another active
account first"), and is explicit that nothing was changed.

The interface never tries to predict this locally — a client-side count would be racy and could
disagree with the server. It asks and reports.

---

## 10. Initial bootstrap state

**Right now this screen is unreachable by everyone**, because `account_permissions` ships empty and
no account holds `permissions.manage`. Every probe returns `403`, so the nav entry is hidden for all
accounts and a direct visit shows access denied. That is the intended fail-closed state, not a
defect.

It becomes reachable only after the controlled bootstrap in
[19_ACCOUNT_PERMISSION_SYSTEM.md](19_ACCOUNT_PERMISSION_SYSTEM.md) §8 grants `permissions.manage` to
one reviewed account. That first manager should then use **this screen** to grant
`permissions.manage` to a second trusted active account — the last-manager guard prevents lockout by
revocation, but cannot help if a single manager's account is lost or disabled.

**The interface contains no bootstrap bypass and never executes SQL.** The access-denied card offers
no self-grant, no request-access flow and no escape hatch; it explains that the capability is granted
per account, is not implied by the administrator role, and must come from someone who already holds
it. This fail-closed behaviour was not weakened for development convenience.

---

## 11. Accessibility

- Account rows are real `<button>` elements, so the picker is keyboard operable rather than a
  click-handled `<div>`; visible `:focus-visible` outlines are defined for them and for the
  checkboxes.
- Every capability checkbox has an `id` and an explicit `<label for=…>` carrying the registry label.
- The unsaved-changes indicator is `role="status" aria-live="polite"`, so a change of state is
  announced.
- Save and Reset are disabled when there is nothing to save and while saving; a disabled control
  does nothing when activated.
- Notices carry meaning in **wording as well as colour**.
- The two-pane layout collapses to a single column at 900px, and the existing iOS focus-zoom guard
  covers the new search input.
- The existing admin visual system is reused throughout — no new component library, and no visual
  change to any other screen.

---

## 12. Tests

The admin panel had **no test framework, no package.json and no build step** before this batch, and
adding one was out of scope (and forbidden by the batch's low-storage rules). Rather than install a
runner, a DOM library or a headless browser, the tests use Node's built-in `node:test` — the
repository's existing convention in `platform/server/api/test` — with a hand-built DOM double, the
same approach as those tests' hand-built `fakeClient()`/`makeDb()` doubles.

`test/helpers/dom.js` provides a small DOM (parse `innerHTML`, query with the selectors the panel
actually uses, read control state, fire handlers) and loads the **real shipped `js/*.js` files** into
a `vm` context. It deliberately throws on a selector it does not support, so an unsupported query
fails loudly instead of silently matching nothing.

| File | Tests | Covers |
|---|---|---|
| `test/permissions-client.test.js` | 14 | request paths, response allowlisting, save payload, no client actor, no auto-retry, status distinction, nav visibility, no role bypass, fail-closed probe, logout, no bootstrap path |
| `test/permissions-page.test.js` | 30 | access denied, four capabilities rendered, no free-text/wildcard control, account-list reuse, active vs revoked, edit/publish independence, toggle-does-not-mutate, save enable/disable, payload contents, token send/replace/never-reused, 401/403/404/409/422/generic handling, reload after 409, unsaved-change guard, reset, labels, keyboard operability, live region |
| `test/admin-shell.test.js` | 9 | all scripts parse and evaluate together, all pre-existing routes still register, script order, unrestricted nav entries unaffected, only one gated entry, protected paths untouched, changes confined to the permitted area, tests excluded from the deploy payload, no hard-coded identity/secret/host |

**Total: 53 passing, 0 failing.**

Run them with:

```
node --test "test/*.test.js"
```

Tests live in `test/`, which `deploy.sh` does not ship — asserted by a test, because moving them
under `js/` would silently start deploying them.

---

## 13. Production prerequisites

1. **Perform the controlled bootstrap** (`19_ACCOUNT_PERMISSION_SYSTEM.md` §8). Until then this
   screen is unreachable and the public-content API is unusable by everyone.
2. **Grant `permissions.manage` to at least two active accounts**, the second through this screen.
3. Deploy the admin panel (`deploy.sh` ships `index.html css js assets`). The three API endpoints
   this screen calls already exist from B2.4P — no API deployment is required for the interface
   itself.

---

## 14. Known limitations

- **No audit-history screen.** Each capability row shows its latest grant/revoke attribution, which
  is what `account_permissions` stores; there is no per-account timeline view, because the table
  keeps one row per (account, capability) rather than an event log.
- **Capability caching is per session.** A revocation by another manager is not pushed to an open
  tab; the entry stays visible until the next sign-in, and every request is refused meanwhile. Safe,
  but momentarily confusing.
- **The account list is bounded by whatever `DB.d.users` holds.** It is the same list the Users
  screen shows, so it inherits any server-side cap on that snapshot; there is no dedicated
  account-search endpoint and this batch was not permitted to add one.
- **No bulk assignment.** Capabilities are managed one account at a time, deliberately — granting
  authority in bulk is how over-granting happens.
- **The screen cannot create the first manager.** By design; see §10.
- **`permissions.manage` is not self-serviceable.** A manager can revoke their own capability
  (subject to the last-manager guard) and would then lose access to the screen — the same fail-closed
  behaviour as any other account.

---

## 15. B2.4B2A update — 2026-08-06

**The capabilities granted here now do something.** Before B2.4B2A, `public_content.view`, `.edit`
and `.publish` could be granted on this screen but had no interface behind them. B2.4B2A added the
**Public Content** section that `view` and `edit` unlock —
[21_PUBLIC_CONTENT_EDITOR.md](21_PUBLIC_CONTENT_EDITOR.md). `public_content.publish` still has no
interface; its controls are B2.4B2B.

### The access model generalised

§2 described probing a gated endpoint and reading `200` vs `403`. That works for
`permissions.manage`, whose registry endpoint is gated on exactly that capability, but it cannot
scale: a `200` on a *read* endpoint proves only `view`, and telling a viewer from an editor would
mean attempting a write.

B2.4B2A therefore added `GET /admin/public-content/capabilities`, which reports the caller's own
three public-content capabilities as booleans, is authenticated but ungated, and answers an account
holding none. `App.loadCaps()` now resolves all four capabilities: the registry probe for
`permissions.manage` plus that endpoint for the other three.

Two hardening changes came with it, both applying to this screen as well:

- **`loadCaps()` clears the cached set before probing**, so a failed re-probe can no longer leave a
  previous session's capabilities in place. §2's note that the cache "can go stale" still holds for a
  revocation mid-session; it no longer holds across a re-probe.
- **A malformed capability response fails closed.** The client returns strict booleans, so a partial
  or unexpected body reads as *no capability* rather than as truthy.

§12's test count is superseded: the frontend suite is now **99 passing** (53 from B2.4B1, 46 from
B2.4B2A). One B2.4B1 test changed — it pinned `loadCaps()` to a single request and now asserts both
requests by name, which is a stronger statement of the same property.

The **bootstrap prerequisite in §10 and §13 is unchanged**, and now blocks more: with no grants,
neither this screen nor the Public Content section is reachable by any account.

---

## 16. B2.4B2B update — 2026-08-06

`public_content.publish` — grantable here since B2.4P, and noted in §15 as having no interface — now
has one. Granting it on this screen gives an account the publish and unpublish decisions described in
[22_PUBLICATION_WORKFLOW_INTERFACE.md](22_PUBLICATION_WORKFLOW_INTERFACE.md).

**All four capabilities are now consequential, so grant them deliberately:**

| Capability | What granting it actually allows |
|---|---|
| `permissions.manage` | Grant and revoke capabilities on any account, including this one. |
| `public_content.view` | Read public-content records, and run the publication readiness check. |
| `public_content.edit` | Change public copy on records — including records already live. |
| `public_content.publish` | Put a record on the public website, and withdraw it. **Does not require, and is not implied by, `edit`.** |

§6's statement that editing and publishing are independent is now observable rather than
theoretical: an account with `edit` alone sees no publication control, and an account with `publish`
alone gets the decisions with every form control disabled. Both are enforced by the API regardless of
what this screen shows.

The access model, concurrency handling, last-manager protection and bootstrap prerequisite in §2,
§7, §9 and §10 are unchanged.

---

## 17. Fast-Track WS2 Phase 2 update — 2026-08-06

Two capabilities were added to the registry (`enquiries.view`, `enquiries.manage`), so this screen
now renders **six** checkboxes rather than four.

**No change was required to this screen's code.** It renders whatever the server's registry endpoint
returns, and `PERM_GROUPS` in `js/pages_permissions.js` groups the keys it knows about; a key in no
group still renders under its own registry ordering. That is the design in §6 working as intended —
a capability added to the API becomes grantable without an interface change.

### What a manager is now deciding

| Capability | What granting it actually allows |
|---|---|
| `enquiries.view` | Read every submission from the public enquiry forms — the sender's name, email address, phone number and message. |
| `enquiries.manage` | Record how an enquiry is being handled. **Cannot delete a submission and cannot edit what was sent.** |

This is the first capability on this screen that discloses **personal data belonging to members of
the public** rather than editorial content, and it should be granted on that basis rather than by
analogy with the content capabilities. `view` does not imply `manage`, and neither is implied by any
`public_content` capability or by the administrator role.

The access model, concurrency handling, last-manager protection and bootstrap prerequisite in §2,
§7, §9 and §10 are unchanged. Detail: [27_ENQUIRY_OPERATIONS.md](27_ENQUIRY_OPERATIONS.md).
