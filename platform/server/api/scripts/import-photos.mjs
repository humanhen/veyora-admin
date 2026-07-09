/* Copies product photos into the uploads volume and links them in the DB.
   Expects a directory layout of <photos-dir>/<model-sku>/*.jpg
   Files named exactly like a variation sku (e.g. "20894.1.JPG") also become
   that variation's image. Idempotent.
   Usage: node scripts/import-photos.mjs [photos-dir] */
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const SRC = process.argv[2] || `${process.env.IMPORT_DIR || '/import'}/photos`;
const DEST = path.join(process.env.UPLOADS_DIR || '/uploads', 'products');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

fs.mkdirSync(DEST, { recursive: true });
const modelDirs = fs.readdirSync(SRC, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name);
console.log(`found ${modelDirs.length} model folders in ${SRC}`);

let linkedProducts = 0, linkedVariations = 0, copied = 0;
for (const model of modelDirs) {
  const files = fs.readdirSync(path.join(SRC, model))
    .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) continue;

  const images = [];
  for (const f of files) {
    // normalize: keep original base name, lowercase extension
    const safe = f.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const destName = `${model}_${safe}`.replace(/\.(JPE?G|PNG|WEBP)$/i, m => m.toLowerCase());
    fs.copyFileSync(path.join(SRC, model, f), path.join(DEST, destName));
    copied++;
    const webPath = `/s3/products/${destName}`;
    images.push(webPath);

    // file named exactly "<variation sku>.<ext>" → variation image
    const base = f.replace(/\.(jpe?g|png|webp)$/i, '');
    if (/^[\w.]+$/.test(base)) {
      const { rowCount } = await pool.query(
        `update variations set image=$2 where sku=$1`, [base, webPath]);
      if (rowCount) linkedVariations++;
    }
  }

  // put sku-matching images first so the primary shot is deterministic
  images.sort((a, b) => {
    const am = a.includes(`/${model}_${model}.`) ? -1 : 0;
    const bm = b.includes(`/${model}_${model}.`) ? -1 : 0;
    return am - bm;
  });
  const { rowCount } = await pool.query(
    `update products set images=$2 where sku=$1`, [model, images]);
  if (rowCount) linkedProducts++;
  else console.warn(`  ! no product with sku ${model} — photos copied but not linked`);
}

console.log(`copied ${copied} photos; linked ${linkedProducts} products, ${linkedVariations} variation images`);
await pool.end();
