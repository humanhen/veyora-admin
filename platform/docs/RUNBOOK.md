# Veyora Platform — Operator Runbook

The production platform runs on the IONOS VPS at **209.46.125.226**
(Ubuntu 24.04, Docker Compose in `/opt/veyora`).

## What runs where

| Piece | URL | Notes |
|---|---|---|
| Storefront (customer portal) | `/` | rebuilt veyora.com portal |
| Admin panel | `/admin/` | same panel as veyora.design, wired to the real DB |
| API | `/api/…` | Node.js, cookie sessions |
| Product images | `/s3/…` | Docker volume `veyora_uploads` |
| Database | internal only | Postgres 16, volume `veyora_pgdata` |

Once DNS is pointed, everything is also served at **https://veyora.design**
(Caddy issues the HTTPS certificate automatically — no action needed).

## DNS cutover (one step, in the veyora.design registrar)

Set the apex **A record of veyora.design → 209.46.125.226** (remove the
GitHub Pages A/CNAME records). HTTPS activates itself a minute or two later.

## Logins

- Staff/admin accounts are `users` rows with role `admin` or `warehouse`.
- Customers activate their own accounts: **storefront → "Activate account"**
  → they get a 6-digit email code → set their own password.
- Create/reset a staff login from the server:
  ```
  ssh veyora-vps "cd /opt/veyora && docker compose exec -T api \
    node scripts/seed-admin.mjs someone@veyora.com 'TheirPassword123' admin 'Their Name'"
  ```

## Email (needed before customer activation emails flow)

The API sends mail only when SMTP is configured; until then it logs the
would-be email (visible in `docker compose logs api`). To enable, add to
`/opt/veyora/.env`:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=info@veyora.com
SMTP_PASS=<google app password>
SMTP_FROM=Veyora <info@veyora.com>
```
then `cd /opt/veyora && docker compose up -d api`.
(For Google Workspace, create an **App password** — regular passwords won't work.)

## Everyday operations

- **Deploy code changes** (from this repo on the office PC):
  `sh platform/server/deploy.sh`
- **Restart everything:** `ssh veyora-vps "cd /opt/veyora && docker compose restart"`
- **Logs:** `ssh veyora-vps "cd /opt/veyora && docker compose logs -f api"`
- **Re-import a fresh Zoho item export (manual fallback):** copy the CSV to
  `/opt/veyora/data/import/Item.csv`, then
  `docker compose exec -T api node scripts/import-zoho.mjs`
  (idempotent — updates by SKU; run any time to resync stock from Zoho).
- **Add product photos in bulk:** put folders named by model SKU in
  `/opt/veyora/data/import/photos/`, then
  `docker compose exec -T api node scripts/import-photos.mjs`
  (files named `<variation sku>.jpg` also become that color's image).

## Live Zoho Inventory sync (API)

The API syncs stock/prices/active status straight from Zoho Inventory every
30 minutes (`api/src/zoho.js`) — no more CSV exports — as soon as it has
credentials. Zoho stays authoritative for the same fields as the CSV import
(price, purchase price, stock on hand, active status). Locally curated
categories/colors/images/attributes are never touched. New Zoho SKUs are
created automatically (with item details pulled per new model).

**One-time setup (~5 minutes, needs the info@veyora.com Zoho login):**
1. Open https://api-console.zoho.com → **Add Client** → **Self Client**.
   Copy the *Client ID* and *Client Secret*.
2. In the Self Client's **Generate Code** tab enter scope
   `ZohoInventory.FullAccess.all` (or the minimum:
   `ZohoInventory.items.READ,ZohoInventory.settings.READ`), duration
   10 minutes, any description → **Create** → copy the code.
3. Within those 10 minutes, exchange the code for a refresh token (Git Bash):
   ```
   curl -s -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d grant_type=authorization_code \
     -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
     -d code=PASTE_CODE_HERE
   ```
   Copy `refresh_token` from the response (it does not expire).
4. Add to `/opt/veyora/.env`:
   ```
   ZOHO_CLIENT_ID=...
   ZOHO_CLIENT_SECRET=...
   ZOHO_REFRESH_TOKEN=...
   ```
   Optional overrides: `ZOHO_ORG_ID` (default 875980504), `ZOHO_DC`
   (default `com`), `ZOHO_SYNC_MINUTES` (default 30).
5. `ssh veyora-vps "cd /opt/veyora && docker compose up -d api"` — the api
   log should show `[zoho] live sync enabled`.

**Endpoints (admin session):**
- `GET  /api/admin/zoho/status` — configured? + last sync summary.
- `POST /api/admin/zoho/sync?dryRun=1` — report what would change, write nothing.
- `POST /api/admin/zoho/sync` — sync now.
The last sync summary is stored in settings (`data.zohoSync`) and every run
lands in the audit log. Order push (platform → Zoho sales orders) is NOT
built — decide whether it's needed before Zoho decommission.

## Running WITHOUT Zoho (cutover — ready whenever the business decides)

Everything Zoho does is now covered in the platform: stock lives per
warehouse (editable on each product's detail page + Stock/Inventory CSV
imports), and supplier purchasing lives in **Admin → Catalog →
Purchasing** (create POs, receive against them — receiving adds stock and
the storefront updates immediately).

While the Zoho sync is ACTIVE, Zoho still overwrites stock/prices every
15 min — so admin stock edits and PO receiving only become authoritative
after cutover. The cutover itself is ONE reversible switch:

```
# pause (platform becomes the source of truth):
curl -X POST https://veyora.design/api/admin/zoho/pause \
  -H "Cookie: veyora_access=<admin session>" \
  -H "Content-Type: application/json" -d '{"paused":true}'
# resume (Zoho takes back over on the next sync):  {"paused":false}
```
State shows in GET /api/admin/zoho/status (`paused`), is stored in
settings (survives restarts/deploys), and every flip lands in the audit
log. Manual syncs refuse while paused.

Cutover checklist (do in this order, any day):
1. Make sure Zoho is fully up to date, wait for/trigger one last sync.
2. Flip the pause switch (above). From this moment the admin panel's
   numbers are the truth.
3. Warehouse team starts receiving via Admin → Purchasing and adjusting
   stock on product pages instead of in Zoho.
4. Keep Zoho read-only for reference for a few weeks, then archive it.
Rollback at any point = flip the switch back (Zoho re-imposes its
numbers on the next sync).

## Backups

- Nightly at 03:20 server time: `pg_dump` gzip into `/opt/veyora/backups/`,
  last 14 kept. Manual backup: `ssh veyora-vps /opt/veyora/backup.sh`
- Restore:
  ```
  gunzip -c backups/veyora-<date>.sql.gz | docker compose exec -T db psql -U veyora veyora
  ```
- Recommended: periodically copy a backup off the server
  (`scp veyora-vps:/opt/veyora/backups/<file> .`).

## The "units sold" guarantee

`order_items.collected` records what actually shipped. The SQL views
`units_sold_by_model` and `supplier_reconciliation` count **fulfilled units
only** — backorders are excluded from supplier-payment numbers by design:
```
docker compose exec -T db psql -U veyora -d veyora -c "select * from supplier_reconciliation limit 20"
```

## Security notes

- SSH is key-based (`~/.ssh/veyora_ionos` on the office PC, alias `veyora-vps`).
  **Rotate the root password** in the IONOS panel (it was shared in chat once).
- Firewall allows only 22/80/443.
- Secrets live in `/opt/veyora/.env` (DB password, JWT secret — generated,
  never committed to git).
