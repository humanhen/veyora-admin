/* Enriches the Zoho-imported catalog with data from the old veyora.com site:
   display names, descriptions, sizes, attributes, categories, variation colors,
   shelf codes, and ALL product/variation photos (downloaded from the old S3).
   Zoho stays authoritative for prices, stock quantities and active status.

   Input: /import/oldsite-products.json (harvested from the old public API).
   Idempotent — re-running refreshes fields and skips already-downloaded photos. */
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import pg from 'pg';

const FILE = process.argv[2] || `${process.env.IMPORT_DIR || '/import'}/oldsite-products.json`;
const DEST = path.join(process.env.UPLOADS_DIR || '/uploads', 'products');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
fs.mkdirSync(DEST, { recursive: true });

const CATS = { 1: 'Men', 2: 'Women', 3: 'Sunglasses', 6: 'Spike', 7: 'Charlett',
  8: 'Laura Ferre', 9: 'Eyeglasses', 12: 'Liv London', 13: 'Puro', 18: 'Extreme',
  19: 'Essedue', 20: 'Kyme', 21: 'Kids', 22: 'Metal', 23: 'Plastic', 24: 'Acetate' };
const TAG_CATS = { 10: 'new', 11: 'sale' };

const olds = JSON.parse(fs.readFileSync(FILE));
console.log(`old-site products: ${olds.length}`);

/* ---------- download queue (8 parallel) ---------- */
let dlOk = 0, dlSkip = 0, dlFail = 0;
const queue = [];
async function download(url, destName, attempt = 1) {
  const dest = path.join(DEST, destName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { dlSkip++; return true; }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty body');
    fs.writeFileSync(dest, buf);
    dlOk++;
    return true;
  } catch (e) {
    fs.rmSync(dest, { force: true });
    if (attempt < 3 && !/HTTP 4/.test(e.message)) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return download(url, destName, attempt + 1);
    }
    dlFail++;
    if (dlFail < 20) console.warn(`  ! download failed: ${destName} (${e.message})`);
    return false;
  }
}
function enqueue(url, destName) { queue.push({ url, destName }); }
async function drainQueue() {
  let i = 0;
  async function worker() {
    while (i < queue.length) {
      const job = queue[i++];
      await download(job.url, job.destName);
      if ((dlOk + dlSkip + dlFail) % 500 === 0) {
        console.log(`  photos: ${dlOk} downloaded, ${dlSkip} cached, ${dlFail} failed`);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
}

/** old image entry -> stable local filename (keeps the unique S3 basename) */
const localName = entry => path.basename(String(entry.value || entry.url).split('?')[0]);

/* ---------- pass 1: metadata + queue downloads ---------- */
let matched = 0, missing = 0, varsUpdated = 0;
for (const op of olds) {
  const sku = String(op.sku).trim();
  const { rows } = await pool.query(`select id from products where sku=$1`, [sku]);
  if (!rows.length) { missing++; continue; }
  matched++;
  const productId = rows[0].id;

  const catIds = Array.isArray(op.category_id) ? op.category_id
    : String(op.category_id || '').split(',').map(x => parseInt(x, 10)).filter(Boolean);
  const categories = catIds.map(id => CATS[id]).filter(Boolean);
  const tags = catIds.map(id => TAG_CATS[id]).filter(Boolean);
  if (op.label && op.label !== '0') tags.push('label:' + op.label);

  const images = (op.image || []).map(im => {
    enqueue(im.url, localName(im));
    return `/s3/products/${localName(im)}`;
  });

  await pool.query(`
    update products set
      name = coalesce(nullif($2, ''), name),
      size = coalesce(nullif($3, ''), size),
      description = coalesce(nullif($4, ''), description),
      attributes = coalesce($5::jsonb, attributes),
      categories = case when array_length($6::text[], 1) > 0 then $6::text[] else categories end,
      tags = $7::text[],
      images = case when array_length($8::text[], 1) > 0 then $8::text[] else images end,
      production_status = coalesce(nullif($9, ''), production_status),
      estimated_arrival = coalesce($10::date, estimated_arrival)
    where id = $1`,
    [productId, op.name || '', op.size || '', op.description || '',
     op.attributes ? JSON.stringify(op.attributes) : null,
     categories, tags, images, op.production_status || '',
     op.estimated_arrival || null]);

  for (const ov of (op.variations || [])) {
    const vSku = String(ov.sku).trim();
    const vImages = (ov.variation_image || []).map(im => {
      enqueue(im.url, localName(im));
      return `/s3/products/${localName(im)}`;
    });
    const { rowCount } = await pool.query(`
      update variations set
        color = coalesce(nullif($2, ''), color),
        image = coalesce($3, image)
      where sku = $1`,
      [vSku, ov.color || '', vImages[0] || null]);
    if (rowCount) {
      varsUpdated++;
      if (ov.warehouse_name) {
        await pool.query(`
          update stock set shelf=$2
            from variations v where stock.variation_id = v.id and v.sku = $1`,
          [vSku, String(ov.warehouse_name)]);
      }
    }
  }
}
console.log(`metadata: ${matched} products enriched, ${missing} old products not in Zoho import, ${varsUpdated} variations updated`);

/* ---------- pass 2: download all photos ---------- */
console.log(`downloading ${queue.length} photos (8 parallel)…`);
await drainQueue();
console.log(`photos done: ${dlOk} downloaded, ${dlSkip} already cached, ${dlFail} failed`);

/* ---------- pass 3: drop image references that failed to download ---------- */
const { rows: allP } = await pool.query(`select id, images from products where array_length(images,1) > 0`);
let cleaned = 0;
for (const p of allP) {
  const ok = p.images.filter(im => {
    if (!im.startsWith('/s3/products/')) return true;
    return fs.existsSync(path.join(DEST, path.basename(im)));
  });
  if (ok.length !== p.images.length) {
    await pool.query(`update products set images=$2 where id=$1`, [p.id, ok]);
    cleaned++;
  }
}
console.log(`cleaned ${cleaned} products with missing image files`);
await pool.end();
