/* One-off repair: rebuild each product's `categories` from the old site's
   authoritative `category_id[].name` list, matched by SKU. The original
   enrichment (import-oldsite.mjs) looked up CATS[obj] instead of CATS[obj.id]
   / obj.name, so gender (Men/Women) and Acetate never made it into categories
   — breaking those filters. Source names already match the filter chips
   exactly (Men, Women, Kids, Sunglasses, Eyeglasses, Metal, Plastic, Acetate,
   New, plus brand names which are harmless for filtering). Idempotent. */
import fs from 'fs';
import pg from 'pg';

const DIR = process.env.IMPORT_DIR || '/import';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const raw = JSON.parse(fs.readFileSync(`${DIR}/oldsite-products.json`));
const prods = Array.isArray(raw) ? raw : (raw.products || raw.data || []);

let updated = 0, unmatched = 0, empty = 0;
for (const op of prods) {
  const sku = String(op.sku || '').trim();
  if (!sku) continue;
  const cats = [...new Set(
    (Array.isArray(op.category_id) ? op.category_id : [])
      .map(c => (c && c.name || '').trim())
      .filter(Boolean))];
  if (!cats.length) { empty++; continue; }
  const { rowCount } = await pool.query(
    `update products set categories = $2::text[] where sku = $1`, [sku, cats]);
  if (rowCount) updated += rowCount; else unmatched++;
}
console.log(JSON.stringify({ sourceProducts: prods.length, updated, unmatched, emptyCats: empty }));

const { rows } = await pool.query(`
  select
    count(*) filter (where 'Men'=any(categories))     as men,
    count(*) filter (where 'Women'=any(categories))   as women,
    count(*) filter (where 'Kids'=any(categories))    as kids,
    count(*) filter (where 'Acetate'=any(categories)) as acetate,
    count(*) filter (where 'New'=any(categories))     as new,
    count(*) filter (where 'Men'=any(categories) and brand='Charlett') as men_charlett
  from products`);
console.log('counts after fix:', rows[0]);
await pool.end();
