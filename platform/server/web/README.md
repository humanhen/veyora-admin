# platform/server/web

The Veyora public website. **Status: foundation only (batch B1.1).** There is
no page content, no navigation, no catalogue, no forms and no database
connection yet — see
`docs/public-website-rebuild/09_FIRST_BUILD_PACKAGE.md` for what this batch
covers and what comes next.

This is a **new, standalone application**. It shares no code with
`platform/server/storefront` or `platform/server/api` and imports nothing
from either — see
`docs/public-website-rebuild/04_TARGET_ARCHITECTURE.md` for the public/
private boundary this preserves.

## Stack

- Astro 5, `output: 'server'`
- `@astrojs/node`, standalone mode
- TypeScript
- No React, no UI framework, no CSS framework, no component library

## Environment

| Variable | Required in production | Development fallback |
|---|---|---|
| `PUBLIC_SITE_ORIGIN` | yes — throws at startup if missing or malformed | `http://localhost:4321` |
| `PORTAL_ORIGIN` | yes — throws at startup if missing or malformed | `http://localhost:4322` |
| `PUBLIC_API_ORIGIN` | yes — throws at startup if missing or malformed | `http://localhost:3000` |
| `NODE_ENV` | — | `development` |

`PUBLIC_API_ORIGIN` is **server-side only**: the internal origin this server
calls to reach the read-only `/public/*` API (`http://api:3000` inside the
deployed Docker stack). It is never sent to a browser, never rendered into a
page, and never read through `import.meta.env` — only `src/lib/public-api.ts`,
itself server-only, ever uses it.

All three origins must be absolute `http`/`https` URLs with no path, query or
fragment; trailing slashes normalise to the same value either way. See
`src/env.ts` for the full contract and `.env.example` for a template. No
real Veyora domain is hard-coded anywhere in this application — the
canonical domain and portal destination are undecided
(`docs/public-website-rebuild/08_RISKS_AND_OPEN_DECISIONS.md`,
DECISION-01 / DECISION-02).

## Commands

```bash
npm install --no-audit --no-fund
npm run dev       # astro dev
npm test          # node --test against test/*.test.ts
npm run build     # astro build -> dist/
npm run preview   # astro preview, serves the built output
npm start         # node ./dist/server/entry.mjs — what the Docker image runs
```

## Health check

`GET /healthz` returns `200`, `Content-Type: application/json`,
`X-Robots-Tag: noindex, nofollow`, and a body including `"ok": true`. No
database or API dependency, no environment detail in the response.

## Design tokens

`src/styles/tokens.css` and `src/styles/base.css` port the approved
editorial system from `platform/server/storefront/css/store.css`
(`body.hm-dark`), catalogued in
`docs/public-website-rebuild/02_VISUAL_SYSTEM_INVENTORY.md`. Square corners,
no card shadows, no new colours, no new type sizes — see that document §8
before adding anything to either file.

## Out of scope for this batch

Layouts, header/footer/navigation, route skeletons, metadata framework,
error pages, redirects, catalogue, forms, database access, deployment. See
`docs/public-website-rebuild/07_IMPLEMENTATION_PLAN.md` batches B1 (rest),
B2–B11.
