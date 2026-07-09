# Veyora — New System Build Plan

Plain-English roadmap for turning the demo into the real system.

## Architecture (decided)

- **Frontend** — the admin panel (already built) + a customer storefront (to build).
  Stays hosted on **veyora.design** (GitHub Pages). No servers to run.
- **Backend** — **Supabase**: one shared Postgres database, real logins, file
  storage for product photos, and secure hooks for Stripe + Zoho.
- **Payments** — Stripe, called through a Supabase Edge Function (so the secret
  key never touches the browser).
- **Data sync** — Zoho export → import into Supabase (one-time migration), plus
  optional ongoing sync.

## Build order

1. **Database** — schema written (`supabase/migrations/`). ← DONE
2. **Supabase project** — create it (YOUR one setup step, below), run the schema.
3. **Wire the admin** to Supabase (replace the demo's browser-storage with real
   database reads/writes). All screens already exist; this is plumbing.
4. **Migrate data** — load real products/customers/stock from the Zoho export.
5. **Storefront** — customer-facing shop (catalog, cart, checkout) matching the
   old veyora.com, pointed at the same database.
6. **Stripe** — real checkout payments.
7. **Integrations** — activation/order emails, Zoho stock sync, invoices.

## The "units sold" question, solved in the schema

`order_items.collected_qty` records what actually shipped. The reporting views
(`units_sold_by_model`, `supplier_reconciliation`) count **only fulfilled units**,
so backorders are excluded from supplier-payment numbers by design — and the
`supplier_reconciliation` view shows the exact gap if anyone ever pays on
"ordered" instead of "sold."

## YOUR ONE SETUP STEP (5 minutes)

To give me a real database to build against:

1. Go to **https://supabase.com** and click **Start your project**.
2. Sign in with GitHub (the same account we used for veyora.design) or email.
3. Click **New project**:
   - Name: `veyora`
   - Database password: pick a strong one and **save it in your password manager**
   - Region: **East US** (closest to NY)
4. Wait ~2 minutes for it to provision.
5. Tell me it's ready. I'll give you the schema to paste into Supabase's SQL
   editor (one copy-paste), and from there I wire everything up.

> I can't create the account for you (it's your business's data and login), but
> that's the only thing that needs your hands. Everything after is me building.
