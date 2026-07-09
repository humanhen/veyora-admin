/* One-time migration: Zoho Inventory "Item.csv" export → products/variations/stock.
   Usage: node scripts/import-zoho.mjs [path/to/Item.csv]
   Idempotent: re-running upserts by SKU (zoho_item_id preserved). */
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import pg from 'pg';

const FILE = process.argv[2] || `${process.env.IMPORT_DIR || '/import'}/Item.csv`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const money = s => {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const titleCase = s => String(s || '').toLowerCase()
  .replace(/\b\w/g, c => c.toUpperCase()).trim();

/** Categories inferred from the item name (Zoho has no category data).
    The admin panel can refine these later. */
function inferCategories(name, brand) {
  const cats = new Set();
  if (brand) cats.add(brand);
  const n = name.toLowerCase();
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

const rows = parse(fs.readFileSync(FILE), { columns: true, skip_empty_lines: true, bom: true });
console.log(`parsed ${rows.length} Zoho items from ${FILE}`);

// group variations by model
const models = new Map();
let skipped = 0;
for (const r of rows) {
  const sku = String(r.SKU || '').trim();
  if (!sku) { skipped++; continue; }
  const { model } = splitSku(sku);
  if (!models.has(model)) models.set(model, []);
  models.get(model).push(r);
}
console.log(`grouped into ${models.size} product models (${skipped} rows without SKU skipped)`);

const client = await pool.connect();
try {
  await client.query('begin');

  // single Zoho warehouse ("VEYORA INC") → wh_main
  let nProducts = 0, nVars = 0, nActive = 0;
  for (const [model, items] of models) {
    items.sort((a, b) => String(a.SKU).localeCompare(String(b.SKU), undefined, { numeric: true }));
    const first = items[0];
    const name = String(first['Item Name'] || first['Product Name'] || model).replace(/\s+/g, ' ').trim();
    const brand = titleCase(first.Brand);
    const price = money(first['Selling Price']);
    // pseudo-items (shipping fees etc.) come in deactivated so they never
    // show in the storefront but old order references still resolve
    const pseudo = /shiping|shipping/i.test(String(first.Brand || ''));
    const anyActive = !pseudo && items.some(i => i.Status === 'Active');
    if (anyActive) nActive++;

    // preserve the real creation date from Zoho (earliest item of the model)
    const createdAt = items.map(i => i['Created Time']).filter(Boolean).sort()[0] || null;
    const { rows: pRows } = await client.query(`
      insert into products (sku, name, brand, categories, price, is_active, zoho_item_id, created_at)
      values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now()))
      on conflict (sku) do update set
        name=excluded.name, brand=excluded.brand, price=excluded.price,
        is_active=excluded.is_active, zoho_item_id=excluded.zoho_item_id,
        created_at=excluded.created_at
      returning id`,
      [model, name, brand, inferCategories(name, brand), price, anyActive,
       String(first['Item ID'] || ''), createdAt]);
    const productId = pRows[0].id;
    nProducts++;

    for (const it of items) {
      const vSku = String(it.SKU).trim();
      const qty = Math.max(0, Math.round(parseFloat(it['Stock On Hand']) || 0));
      const isActive = it.Status === 'Active';
      const { rows: vRows } = await client.query(`
        insert into variations (product_id, sku, price, purchase_price, ean,
                                stock_status, is_active, zoho_item_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (sku) do update set
          product_id=excluded.product_id, price=excluded.price,
          purchase_price=excluded.purchase_price, ean=excluded.ean,
          stock_status=excluded.stock_status, is_active=excluded.is_active,
          zoho_item_id=excluded.zoho_item_id
        returning id`,
        [productId, vSku, money(it['Selling Price']), money(it['Purchase Price']),
         String(it.EAN || it.UPC || '').trim(),
         qty > 0 ? 'in stock' : 'out of stock', isActive,
         String(it['Item ID'] || '')]);
      await client.query(`
        insert into stock (variation_id, warehouse_id, qty)
        values ($1, 'wh_main', $2)
        on conflict (variation_id, warehouse_id) do update set qty=excluded.qty`,
        [vRows[0].id, qty]);
      nVars++;
    }
  }

  await client.query('commit');
  console.log(`imported ${nProducts} products (${nActive} active), ${nVars} variations + stock`);

  const { rows: sums } = await client.query(`
    select count(*) as products,
           (select count(*) from variations) as variations,
           (select coalesce(sum(qty),0) from stock) as units_on_hand
      from products`);
  console.log('db now has:', sums[0]);
} catch (e) {
  await client.query('rollback');
  throw e;
} finally {
  client.release();
  await pool.end();
}
