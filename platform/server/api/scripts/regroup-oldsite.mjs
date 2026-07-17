/* One-off repair: group colorways under one product the way the old
   veyora.com does. Brands whose SKUs have no dot (Essedue "VEDETTE-2002",
   Kyme "CAMERON-1", ...) were imported as one product per colorway, so
   cards showed a single color circle (Sam's report, 2026-07-17).

   Truth source: the old site's public catalog (fetch of
   user/get-products), saved to /import/old-products.json. For every old
   product we move its variation SKUs under one parent here, repoint
   favourites, and delete the emptied single-colorway products.
   Idempotent — re-running moves nothing. */
import fs from 'fs';
import pg from 'pg';

const FILE = process.argv[2] || `${process.env.IMPORT_DIR || '/import'}/old-products.json`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const old = JSON.parse(fs.readFileSync(FILE)).data.products;
console.log(`old catalog: ${old.length} products`);

const client = await pool.connect();
try {
  await client.query('begin');
  const { rows: prods } = await client.query(`select id, sku from products`);
  const { rows: vars } = await client.query(`select id, sku, product_id from variations`);
  const prodBySku = new Map(prods.map(p => [String(p.sku), p]));
  const varBySku = new Map(vars.map(v => [String(v.sku), v]));
  const ownerOf = new Map(vars.map(v => [v.id, v.product_id]));

  let moved = 0, deleted = 0, groupsTouched = 0;
  for (const P of old) {
    const vlist = (P.variations || []).map(v => String(v.sku)).filter(Boolean);
    if (vlist.length < 2) continue;
    const target = prodBySku.get(String(P.sku))
      || (varBySku.get(String(P.sku)) && prods.find(p => p.id === varBySku.get(String(P.sku)).product_id));
    if (!target) { console.log(`SKIP (no local product): ${P.sku} ${P.name}`); continue; }

    const emptiedCandidates = new Set();
    let movedHere = 0;
    for (const sku of vlist) {
      const v = varBySku.get(sku);
      if (!v || v.product_id === target.id) continue;
      await client.query(`update variations set product_id=$1 where id=$2`, [target.id, v.id]);
      emptiedCandidates.add(v.product_id);
      v.product_id = target.id;
      moved++; movedHere++;
    }
    if (movedHere) groupsTouched++;

    for (const pid of emptiedCandidates) {
      const { rows: left } = await client.query(
        `select 1 from variations where product_id=$1 limit 1`, [pid]);
      if (left.length) continue;
      await client.query(`
        update favourites f set product_id=$1 where product_id=$2
          and not exists (select 1 from favourites f2
                          where f2.user_id=f.user_id and f2.product_id=$1)`, [target.id, pid]);
      await client.query(`delete from favourites where product_id=$1`, [pid]);
      await client.query(`delete from products where id=$1`, [pid]);
      deleted++;
    }
  }

  const { rows: after } = await client.query(`
    select count(*) as products, (select count(*) from variations) as variations from products`);
  console.log(`moved ${moved} variations across ${groupsTouched} models; deleted ${deleted} empty colorway products`);
  console.log('db now has:', after[0]);
  await client.query('commit');
} catch (e) {
  await client.query('rollback');
  throw e;
} finally {
  client.release();
  await pool.end();
}
