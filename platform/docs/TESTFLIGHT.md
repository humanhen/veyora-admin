# Veyora iOS app — TestFlight & release runbook

The app lives in `platform/mobile/` (Expo SDK 57, React Native, expo-router).
It talks to the same API as veyora.design, so there is no second backend and no
second database — a customer sees the same catalogue, cart and orders in both
places.

---

## The one idea that matters

**Two kinds of change, two ways to ship.**

| | Over-the-air (EAS Update) | New build (TestFlight) |
|---|---|---|
| What it can change | Anything in the JS bundle: screens, copy, layout, pricing display, bug fixes, new API calls | The native layer: new native modules, Expo SDK upgrades, permissions, bundle id, icon, splash |
| How long | ~2 minutes, automatic | ~20-40 minutes + Apple processing, testers must install |
| Costs a build | No | Yes |
| How testers get it | Next time they open the app | They install it from TestFlight |
| Workflow | `Mobile OTA update` | `Mobile build → TestFlight` |

Day to day you will almost only use the first row. That's the point: the build
queue and the install friction stop being part of your iteration loop.

`runtimeVersion` is set to the `fingerprint` policy, which means EAS derives
compatibility from the actual native layer. A JS-only change keeps the same
fingerprint and the update is delivered. A native change produces a new
fingerprint, and older builds simply never see that update — so it is not
possible to push an OTA update to a binary that can't run it.

---

## What only you can do (Apple side)

Everything below needs the Veyora Apple account. None of it can be done from
this repo.

### 1. Apple Developer Program — $99/year

<https://developer.apple.com/programs/enroll/>

Enrol as an **organization**, not an individual, so the App Store listing says
Veyora rather than a person's name. Organization enrolment requires a **D-U-N-S
number** for the company; Apple looks it up, and if Veyora doesn't already have
one this can add several days. Start here first — everything else waits on it.

> If you need something in testers' hands sooner than the org enrolment
> completes, an individual enrolment is approved much faster and can be
> migrated to an org later. The bundle id stays the same either way.

### 2. Create the app record in App Store Connect

<https://appstoreconnect.apple.com> → **Apps** → **+**

- Platform: **iOS**
- Name: **Veyora**
- Primary language: **English (U.S.)**
- Bundle ID: **`com.veyora.app`** — must match `app.json` exactly. If it isn't
  in the dropdown, register it at *Certificates, Identifiers & Profiles →
  Identifiers → +*.
- SKU: anything internal, e.g. `veyora-ios`

Note the **Apple ID** number shown on the app's App Information page — it's a
10-digit number and it goes into `eas.json` as `ascAppId`.

### 3. App Store Connect API key (lets CI upload builds)

App Store Connect → **Users and Access** → **Integrations** → **App Store
Connect API** → **+**

- Access: **App Manager**
- Download the `.p8` file. **Apple lets you download it exactly once.** Put it
  in the company password manager immediately.
- Note the **Key ID** and the **Issuer ID** on that page.
- Note your **Team ID** from *Membership details* — it goes into `eas.json` as
  `appleTeamId`.

### 4. Expo account + token

<https://expo.dev> → create an account/organization for Veyora → **Account
settings → Access tokens → Create token**.

Add it to GitHub: repo → **Settings → Secrets and variables → Actions → New
repository secret** → name `EXPO_TOKEN`.

---

## First build

Once the four steps above are done, from `platform/mobile/`:

```bash
npm install --legacy-peer-deps
npx eas login
npx eas init            # creates the EAS project, writes extra.eas.projectId
npx eas update:configure # writes updates.url for OTA
```

Those two commands write real values into `app.json`. Commit that change —
until then `app.json` has no project id and no update URL, which is why they
aren't checked in with placeholders.

Then fill in the two placeholders in `eas.json` → `submit.production.ios`:

```json
"ascAppId": "1234567890",       // the 10-digit Apple ID from step 2
"appleTeamId": "ABCDE12345"     // from step 3
```

Build and submit:

```bash
npx eas build --platform ios --profile production
npx eas submit --platform ios --profile production --latest
```

The first `eas build` asks for your Apple login and offers to generate the
signing certificate and provisioning profile for you — say yes, EAS manages
them from then on. The first `eas submit` asks for the API key from step 3
(`.p8`, Key ID, Issuer ID) and stores it for later runs.

After that both are one click in GitHub Actions.

### Getting testers on it

App Store Connect → your app → **TestFlight**.

- **Internal testers** — up to 100 people who are members of your App Store
  Connect team. No review, available as soon as Apple finishes processing
  (5-15 minutes). This is where Sam, Yehuda, Avichai and Moshe should go.
- **External testers** — up to 10,000, invited by email or public link. The
  *first* build you send to external testers goes through **Beta App Review**
  (usually a day or two). Later builds normally don't.

Export compliance is already answered: `ITSAppUsesNonExemptEncryption` is set
to `false` in `app.json`, so TestFlight won't ask on every upload. That is the
correct answer here — the app only uses HTTPS, which is exempt.

---

## Day-to-day

**Shipping a normal change:** merge to `main`. The `Mobile OTA update` workflow
runs on any change under `platform/mobile/`, typechecks, proves the bundle
builds, and publishes to the `preview` channel. To push to everyone on the
production channel, run the workflow manually and pick `production`.

**Shipping a native change:** run `Mobile build → TestFlight` from the Actions
tab. Then raise the floor (below) once testers are on the new build.

### The version gate

`GET /api/app/config?platform=ios&build=N` is what the app checks on launch and
every time it's foregrounded. It's public, so it works before login.

Two levers, both stored in `settings` — no deploy needed to change them:

- **`minBuild`** — hard block. A build below this shows a full-screen "Update
  required" and can't be used. Use it when a build is actively broken or is
  hitting the API in a way you need to stop.
- **`latestBuild`** — soft nudge. Shows "A new build is available" on the
  account screen with a link, but the app keeps working.

```bash
curl -X POST https://veyora.design/api/app/config \
  -H "Cookie: veyora_access=<admin session>" \
  -H "Content-Type: application/json" \
  -d '{"ios":{"minBuild":4,"latestBuild":6,
       "installUrl":"https://testflight.apple.com/join/XXXXXXXX",
       "message":"Please install the latest build from TestFlight."}}'
```

Set `installUrl` to the TestFlight public link while in beta, and to the App
Store listing after launch.

> Don't raise `minBuild` to a build testers haven't installed yet — it locks
> them out of a working app until they go to TestFlight. Raise it *after* the
> new build is live and adopted.

---

## Notes and gotchas

- **Build numbers are managed by EAS.** `eas.json` sets
  `appVersionSource: "remote"` with `autoIncrement` on the production profile,
  so EAS owns the build number and bumps it every build. The `buildNumber` in
  `app.json` is only a starting point and is not what ships. This is what stops
  the "build number already used" rejection from App Store Connect.
- **`npm install --legacy-peer-deps`** is needed (and is what CI uses). The
  dependency tree has a conflict between the React version Expo pins and the
  one `react-dom` asks for. It's inert — nothing in the app renders to the DOM
  — but plain `npm ci` refuses to resolve it.
- **The app cannot be built on Linux or Windows.** iOS binaries need macOS.
  EAS's macOS workers handle that, which is why neither you nor CI needs a Mac.
- **OTA updates don't apply mid-session.** The app downloads in the background
  and shows a "Restart" strip; the update lands on next launch otherwise. This
  is deliberate — swapping the bundle under someone mid-order would lose their
  cart state.
- **Auth is separate from the web.** The app uses
  `/auth/mobile/{login,refresh,logout}` with bearer tokens in the iOS keychain,
  not cookies. Refresh tokens rotate on every use, so a device that hasn't been
  opened in over 30 days will need a fresh sign-in.
- Signing out on the device revokes only that device's refresh token; other
  sessions keep working.

---

## Files

| Path | What it is |
|---|---|
| `platform/mobile/app/` | Screens (expo-router file-based routes) |
| `platform/mobile/src/api.ts` | API client, token refresh, response types |
| `platform/mobile/src/updates.tsx` | OTA + version-gate logic |
| `platform/mobile/app/settings/updates.tsx` | The version screen testers see |
| `platform/mobile/eas.json` | Build/submit profiles |
| `platform/server/api/src/routes/app.js` | The version-gate endpoint |
| `.github/workflows/mobile-ota.yml` | Ship a JS change |
| `.github/workflows/mobile-build.yml` | Ship a binary |
