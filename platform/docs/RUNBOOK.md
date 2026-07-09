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
- **Re-import a fresh Zoho item export:** copy the CSV to
  `/opt/veyora/data/import/Item.csv`, then
  `docker compose exec -T api node scripts/import-zoho.mjs`
  (idempotent — updates by SKU; run any time to resync stock from Zoho).
- **Add product photos in bulk:** put folders named by model SKU in
  `/opt/veyora/data/import/photos/`, then
  `docker compose exec -T api node scripts/import-photos.mjs`
  (files named `<variation sku>.jpg` also become that color's image).

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
