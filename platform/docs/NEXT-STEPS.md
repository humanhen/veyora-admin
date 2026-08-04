# Veyora — where things stand (2026-08-04)

Working doc for the current push: the iOS app, the customer password import,
and what's blocking each. Everything here is committed on
`claude/veyora-testflight-setup-82zsdj`.

Read the numbered list in order — each step depends on the one above it.

---

## 0. Server access (IONOS VPS)

| | |
|---|---|
| Host | `209.46.125.226` |
| User | `root` |
| Port | 22 (firewall allows only 22/80/443) |
| OS | Ubuntu 24.04, Docker Compose in `/opt/veyora` |
| Key | `~/.ssh/veyora_ionos` on the office PC (Windows: `C:\Users\sunda\.ssh\veyora_ionos`), SSH alias `veyora-vps` |

**Connecting from Termius:** import the private key (`veyora_ionos`, the file
*without* `.pub`) into Termius → Keychain, then add a host at
`209.46.125.226` / `root` using that key. Move the key via a password manager's
secure note — not email or chat.

If key auth isn't an option, the IONOS panel can reset the root password, but
that only helps if `PasswordAuthentication` is still enabled in `sshd_config`.
The IONOS **browser console (KVM)** always works and is the way back in if SSH
locks you out.

> Two credentials are still marked for rotation: the VPS root password and the
> platform admin password, both of which have been pasted into chat at some
> point. Rotate once the current work is done.

---

## 1. Admin login

Creates or updates the staff account — `seed-admin.mjs` upserts on email and
forces `status='active'`, so it works whether or not the account exists.

Already on the server (Termius):

```bash
cd /opt/veyora && docker compose exec -T api \
  node scripts/seed-admin.mjs info@veyora.com '<password>' admin 'Veyora'
```

From the office PC:

```bash
ssh veyora-vps "cd /opt/veyora && docker compose exec -T api \
  node scripts/seed-admin.mjs info@veyora.com '<password>' admin 'Veyora'"
```

Then sign in at <https://veyora.design/admin/>. Change the password from
My Account afterwards.

---

## 2. Deploy — nothing below this line works until it runs

```bash
sh platform/server/deploy.sh    # from the office PC, in the repo
```

Four things are committed but not live:

- `/auth/mobile/{login,refresh,logout}` — token auth for the app
- `/app/config` — the app's version gate
- `GET /user/product/:id` — the app's product detail screen
- `/admin/import-passwords` + the **Password Import** admin page

---

## 3. Import the customer passwords

**Admin → Customers → Password Import.**

The July migration brought 157 customers across without passwords (the old
admin API never exposed them), so every one of them is `pending` and cannot
sign in — on the web or in the app. The spreadsheet fixes that.

1. Save the sheet as **CSV UTF-8** (Excel: File → Save As → CSV UTF-8).
   Needs `email` and `password` columns; `external_id` optional; anything else
   is ignored.
2. **Check first** — a dry run that reports exactly what would happen and
   writes nothing. Review the "not matched" list.
3. **Import Passwords.**
4. **Delete your copy of the file.** Not email, not a shared drive, not
   Downloads.

What it does: bcrypts each password, sets it on the matched account, and flips
`pending` → `active`. Matching is on lower(email), falling back to
`external_id` → customer number for rows whose email is a synthetic
`@import.veyora.local` address.

Accounts that **already** have a password are skipped, so anyone who activated
via OTP and chose their own is never reset. There's an overwrite checkbox for
deliberate re-runs.

The file never touches disk — processed in memory, buffer zeroed after
hashing, and the audit log records counts only.

> The passwords in the sheet are uniformly 10 characters of mixed-case
> alphanumeric, which means the old system generated them rather than
> customers choosing them. Plan a forced password change once everyone is
> settled in. Not a blocker.

---

## 4. Apple — this is what actually gates TestFlight

Start with enrolment; everything else is quick by comparison.

- [ ] **Apple Developer Program**, $99/year.
      Organization enrolment needs a **D-U-N-S number** for Veyora — if the
      company doesn't have one, this can add several days. An individual
      enrolment is much faster and can be migrated to an org later; the bundle
      id doesn't change either way.
- [ ] **App Store Connect app record** — bundle id **`com.veyora.app`**, must
      match `app.json` exactly. Note the 10-digit Apple ID it generates.
- [ ] **App Store Connect API key** — Users and Access → Integrations, role
      **App Manager**. The `.p8` downloads **exactly once** → password manager.
      Note the Key ID and Issuer ID.
- [ ] **Team ID** from Membership details.
- [ ] **`EXPO_TOKEN`** — expo.dev → Account settings → Access tokens → add as
      a GitHub repo secret.

Full detail, including TestFlight tester setup, is in
[`TESTFLIGHT.md`](./TESTFLIGHT.md).

---

## 5. One-time EAS wiring

From `platform/mobile/`:

```bash
npm install --legacy-peer-deps
npx eas login
npx eas init              # writes extra.eas.projectId into app.json
npx eas update:configure  # writes updates.url into app.json
```

Commit the `app.json` change. Then fill the two placeholders in `eas.json` →
`submit.production.ios`: `ascAppId` (the 10-digit Apple ID) and `appleTeamId`.

---

## 6. First build

```bash
npx eas build  --platform ios --profile production
npx eas submit --platform ios --profile production --latest
```

The first build offers to generate signing certs — say yes, EAS manages them
from then on. The first submit asks for the `.p8` key and remembers it.

After that both are one click in GitHub Actions.

---

## Day-to-day once it's live

**This is the part that matters for iteration speed.**

| Change | How it ships | Time |
|---|---|---|
| Screens, copy, layout, pricing display, bug fixes, new API calls | **Mobile OTA update** workflow — automatic on any push to `main` touching `platform/mobile/` | ~2 min, no build |
| New native module, Expo SDK bump, permissions, bundle id, icon, splash | **Mobile build → TestFlight** workflow — manual | ~30 min + Apple processing + tester install |

You will almost only use the first row. `runtimeVersion` uses the
`fingerprint` policy, so an OTA update can never reach a build whose native
layer doesn't match it — the fast path is safe by construction.

### The version gate

`GET /api/app/config` — public, checked on launch and on every foreground.

- **`minBuild`** — hard block. Below this, the app shows a full-screen "Update
  required" and can't be used.
- **`latestBuild`** — soft nudge only.

```bash
curl -X POST https://veyora.design/api/app/config \
  -H "Cookie: veyora_access=<admin session>" \
  -H "Content-Type: application/json" \
  -d '{"ios":{"minBuild":4,"latestBuild":6,
       "installUrl":"https://testflight.apple.com/join/XXXXXXXX",
       "message":"Please install the latest build from TestFlight."}}'
```

Both live in `settings`, so no deploy is needed to change them.

> Never raise `minBuild` to a build testers haven't installed yet — it locks
> them out of a working app.

---

## Open questions I couldn't answer from here

**SMTP status is contradictory.** `SESSION-HANDOFF.md` open item #1 says it
isn't configured; the 2026-07-10 evening entry says welcome and order emails
were verified live over Gmail SMTP. `mail.js` falls back to logging silently
when SMTP is missing, so a broken config never announces itself.

```bash
ssh veyora-vps "cd /opt/veyora && grep -c SMTP_HOST .env"
```

If the password import goes well you won't need activation emails for the
migrated 157 — but order confirmations still depend on it.

**How many customers are still locked out**, and how many have no real email
(those can't self-activate and won't match on email in the import):

```bash
ssh veyora-vps "cd /opt/veyora && docker compose exec -T db psql -U veyora -d veyora -c \
  \"select status, count(*),
       count(*) filter (where email like '%@import.veyora.local') as no_email
     from users where role in ('customer','special customer') group by status\""
```

---

## Still open from before this push

Unchanged from `SESSION-HANDOFF.md`, listed so nothing gets lost:

- Sam's "cleaner, more international" design pass on the storefront
- `ANTHROPIC_API_KEY` in `/opt/veyora/.env` — "Scan your list" is built and
  deployed but dormant without it
- Sam's stock-rules decision (sold-out safety buffer + low-stock label) —
  waiting on his two numbers
- Stripe — schema and payments table are ready; checkout is on-terms for now
- Zoho decommission — the pause switch is built and tested, nothing flipped
