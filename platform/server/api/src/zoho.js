/* Live Zoho Inventory sync — replaces the manual Item.csv export/re-import.
   Zoho stays authoritative for exactly what the CSV path was authoritative
   for (see scripts/import-zoho.mjs): price, purchase price, stock on hand,
   active status, zoho_item_id. Locally-curated data (categories, colors,
   images, attributes from the old site) is never touched.

   Config (all required to enable): ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET,
   ZOHO_REFRESH_TOKEN. Optional: ZOHO_ORG_ID (default 875980504 — the
   VEYORA INC org), ZOHO_DC (accounts datacenter TLD, default "com"),
   ZOHO_SYNC_MINUTES (default 30, min 5). Setup steps: docs/RUNBOOK.md. */
import { q, tx, audit } from './db.js';

const DC = process.env.ZOHO_DC || 'com';
const ORG = process.env.ZOHO_ORG_ID || '875980504';
const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

export function zohoConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
}

let tokenCache = { token: null, exp: 0 };
async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const res = await fetch(`https://accounts.zoho.${DC}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET, grant_type: 'refresh_token',
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(j).slice(0, 200)}`);
  }
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function zGet(path, params = {}) {
  const token = await accessToken();
  const url = new URL(`https://www.zohoapis.${DC}/inventory/v1${path}`);
  url.searchParams.set('organization_id', ORG);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(`Zoho GET ${path}: ${j.message || `HTTP ${res.status}`}`);
  return j;
}

async function fetchAllItems() {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const j = await zGet('/items', { page, per_page: 200 });
    items.push(...(j.items || []));
    if (!j.page_context?.has_more_page) break;
  }
  return items;
}

/* ------- helpers shared with the CSV importer's semantics ------- */

const titleCase = s => String(s || '').toLowerCase()
  .replace(/\b\w/g, c => c.toUpperCase()).trim();

function inferCategories(name, brand) {
  const cats = new Set();
  if (brand) cats.add(brand);
  const n = String(name).toLowerCase();
  if (n.includes('sun')) cats.add('Sunglasses'); else cats.add('Eyeglasses');
  if (n.includes('metal')) cats.add('Metal');
  if (n.includes('plastic') || n.includes('acetate')) cats.add('Plastic');
  if (n.includes('kids') || n.includes('kid ')) cats.add('Kids');
  if (n.includes('clip')) cats.add('Clip-On');
  return [...cats];
}

function splitSku(sku) {
  const i = sku.lastIndexOf('.');
  if (i <= 0) return { model: sku, suffix: null };
  return { model: sku.slice(0, i), suffix: sku.slice(i + 1) };
}

const money = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/* ----------------------------- sync ----------------------------- */

let running = false;

/** Pull all Zoho items and update the catalog. Returns a summary object.
    dryRun computes the same summary without writing anything. */
export async function syncZohoInventory({ dryRun = false } = {}) {
  if (!zohoConfigured()) throw Object.assign(new Error('Zoho is not configured'), { status: 400 });
  if (running) throw Object.assign(new Error('a Zoho sync is already running'), { status: 409 });
  running = true;
  const started = Date.now();
  try {
    const zItems = (await fetchAllItems())
      .filter(it => String(it.sku || '').trim())
      .map(it => ({
        sku: String(it.sku).trim(),
        itemId: String(it.item_id || ''),
        name: String(it.name || '').replace(/\s+/g, ' ').trim(),
        price: money(it.rate),
        purchase: money(it.purchase_rate),
        qty: Math.max(0, Math.round(parseFloat(it.stock_on_hand) || 0)),
        active: String(it.status).toLowerCase() === 'active',
      }));

    const { rows: vars } = await q(`
      select v.id, v.sku, v.price, v.purchase_price, v.is_active, v.product_id,
             coalesce((select sum(s.qty) from stock s where s.variation_id=v.id), 0) as qty
        from variations v`);
    const bySku = new Map(vars.map(v => [v.sku, v]));
    const { rows: prods } = await q(`select id, sku, brand from products`);
    const prodBySku = new Map(prods.map(p => [p.sku, p]));

    const summary = {
      at: new Date().toISOString(), dryRun,
      zohoItems: zItems.length,
      matched: 0, stockChanged: 0, priceChanged: 0, newSkus: [],
      localOnlySkus: vars.length, // decremented per match below
      tookMs: 0, error: null,
    };

    const apply = async (c) => {
      for (const it of zItems) {
        const v = bySku.get(it.sku);
        if (!v) { summary.newSkus.push(it.sku); continue; }
        summary.matched++;
        summary.localOnlySkus--;
        if (Number(v.qty) !== it.qty) summary.stockChanged++;
        if (it.price != null && Number(v.price) !== it.price) summary.priceChanged++;
        if (c) {
          await c.query(`
            update variations set price=coalesce($2, price),
              purchase_price=coalesce($3, purchase_price),
              stock_status=$4, is_active=$5, zoho_item_id=$6
            where id=$1`,
            [v.id, it.price, it.purchase, it.qty > 0 ? 'in stock' : 'out of stock',
             it.active, it.itemId]);
          await c.query(`
            insert into stock (variation_id, warehouse_id, qty) values ($1,'wh_main',$2)
            on conflict (variation_id, warehouse_id) do update set qty=excluded.qty`,
            [v.id, it.qty]);
        }
      }

      // product-level rollup: group items by the product that actually owns
      // their variation (grouping-agnostic — works for dot SKUs like 3507.15
      // AND dash colorways like VEDETTE-2002 that live under one parent).
      // Price = first item's, active if any colorway is active (pseudo
      // products like shipping fees stay inactive — guarded by brand).
      const prodById = new Map(prods.map(p => [p.id, p]));
      const byProduct = new Map();
      for (const it of zItems) {
        const v = bySku.get(it.sku);
        if (!v) continue;
        if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
        byProduct.get(v.product_id).push(it);
      }
      for (const [pid, items] of byProduct) {
        items.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }));
        const p = prodById.get(pid);
        if (!p) continue;
        const pseudo = /shipping|shiping/i.test(String(p.brand || ''));
        if (c) {
          await c.query(`
            update products set price=coalesce($2, price), is_active=$3, zoho_item_id=$4
            where id=$1`,
            [p.id, items[0].price, !pseudo && items.some(i => i.active), items[0].itemId]);
        }
      }

      // brand-new models: create product + variations + stock like the CSV
      // import would (details fetched per item for brand/ean/created date)
      const newModels = new Map();
      for (const sku of summary.newSkus) {
        const { model } = splitSku(sku);
        if (!newModels.has(model)) newModels.set(model, []);
        newModels.get(model).push(zItems.find(i => i.sku === sku));
      }
      if (c) {
        for (const [model, items] of newModels) {
          items.sort((a, b) => a.sku.localeCompare(b.sku, undefined, { numeric: true }));
          let detail = {};
          try {
            detail = (await zGet(`/items/${items[0].itemId}`)).item || {};
          } catch { /* detail is nice-to-have */ }
          const brand = titleCase(detail.brand || '');
          const pseudo = /shipping|shiping/i.test(brand);
          let productId = prodBySku.get(model)?.id;
          if (!productId && /-\d+$/.test(model)) {
            // dash colorway (VEDETTE-2005): attach to the product that owns
            // its siblings (VEDETTE-2001…) instead of creating a duplicate
            const prefix = model.replace(/-\d+$/, '') + '-';
            for (const [sku, v] of bySku) {
              if (sku.startsWith(prefix)) { productId = v.product_id; break; }
            }
          }
          if (!productId) {
            const { rows } = await c.query(`
              insert into products (sku, name, brand, categories, price, is_active,
                                    zoho_item_id, created_at)
              values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()))
              on conflict (sku) do update set zoho_item_id=excluded.zoho_item_id
              returning id`,
              [model, items[0].name || model, brand,
               inferCategories(items[0].name || model, brand),
               items[0].price, !pseudo && items.some(i => i.active),
               items[0].itemId, detail.created_time || null]);
            productId = rows[0].id;
            prodBySku.set(model, { id: productId, sku: model, brand });
          }
          for (const it of items) {
            const { rows: vRows } = await c.query(`
              insert into variations (product_id, sku, price, purchase_price, ean,
                                      stock_status, is_active, zoho_item_id)
              values ($1,$2,$3,$4,$5,$6,$7,$8)
              on conflict (sku) do update set zoho_item_id=excluded.zoho_item_id
              returning id`,
              [productId, it.sku, it.price, it.purchase,
               String(detail.ean || detail.upc || '').trim(),
               it.qty > 0 ? 'in stock' : 'out of stock', it.active, it.itemId]);
            await c.query(`
              insert into stock (variation_id, warehouse_id, qty) values ($1,'wh_main',$2)
              on conflict (variation_id, warehouse_id) do update set qty=excluded.qty`,
              [vRows[0].id, it.qty]);
          }
        }
      }
    };

    if (dryRun) await apply(null);
    else await tx(apply);

    summary.newSkuCount = summary.newSkus.length;
    summary.newSkus = summary.newSkus.slice(0, 50); // keep the record small
    summary.tookMs = Date.now() - started;

    if (!dryRun) {
      await q(`update settings set data = jsonb_set(coalesce(data,'{}'::jsonb),
               '{zohoSync}', $1::jsonb) where id=1`, [JSON.stringify(summary)]);
      await audit({ id: 'system', name: 'Zoho sync', role: 'system' }, 'zoho sync', ORG,
        `${summary.matched} matched, ${summary.stockChanged} stock updates, ` +
        `${summary.newSkuCount} new SKUs`, 'zoho');
    }
    console.log(`[zoho] sync${dryRun ? ' (dry-run)' : ''}: ${summary.zohoItems} items, ` +
      `${summary.matched} matched, ${summary.stockChanged} stock changed, ` +
      `${summary.newSkuCount} new, ${summary.tookMs}ms`);
    return summary;
  } catch (e) {
    if (!dryRun) {
      await q(`update settings set data = jsonb_set(coalesce(data,'{}'::jsonb),
               '{zohoSync}', $1::jsonb) where id=1`,
        [JSON.stringify({ at: new Date().toISOString(), error: e.message })])
        .catch(() => {});
    }
    throw e;
  } finally {
    running = false;
  }
}

export async function zohoStatus() {
  const { rows } = await q(`select data->'zohoSync' as last from settings where id=1`);
  return {
    configured: zohoConfigured(),
    dc: DC, orgId: ORG,
    intervalMinutes: Math.max(5, parseInt(process.env.ZOHO_SYNC_MINUTES || '30', 10)),
    syncRunning: running,
    lastSync: rows[0]?.last || null,
  };
}

/** Called from index.js at boot: periodic sync when configured. */
export function startZohoSchedule() {
  if (!zohoConfigured()) {
    console.log('[zoho] not configured — set ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ' +
      'ZOHO_REFRESH_TOKEN in /opt/veyora/.env to enable live sync (see RUNBOOK)');
    return;
  }
  const mins = Math.max(5, parseInt(process.env.ZOHO_SYNC_MINUTES || '30', 10));
  setTimeout(() => syncZohoInventory().catch(e => console.error('[zoho] initial sync:', e.message)), 20_000);
  setInterval(() => syncZohoInventory().catch(e => console.error('[zoho] sync:', e.message)), mins * 60_000);
  console.log(`[zoho] live sync enabled: org ${ORG}, every ${mins} min`);
}
