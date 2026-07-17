import { Router } from 'express';
import crypto from 'crypto';
import { q } from '../db.js';
import { requireAuth, optionalAuth, AGENT_ROLES } from '../authmw.js';
import { priceForCustomer } from '../pricing.js';

const r = Router();
// catalog browsing + viewing a shared list are public (guest = prices hidden),
// like the old site. Everything else on this router requires a session.
r.use(['/get-products', '/product-filter-data', '/shared-lists'], optionalAuth());
r.use(requireAuth());

/** Load products with variations + stock qty, shaped for the storefront. */
export async function loadProducts(user, { ids = null, skus = null, activeOnly = true } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push(`p.is_active`);
  if (ids) { params.push(ids); where.push(`p.id = any($${params.length})`); }
  if (skus) { params.push(skus); where.push(`p.sku = any($${params.length})`); }
  const { rows } = await q(`
    select p.*,
      coalesce((
        select json_agg(json_build_object(
          'sku', v.sku, 'color', v.color, 'image', v.image,
          'price', v.price, 'salePrice', v.sale_price,
          'stockStatus', v.stock_status, 'isActive', v.is_active,
          'qty', coalesce((select sum(s.qty) from stock s where s.variation_id = v.id), 0)
        ) order by v.sku)
        from variations v where v.product_id = p.id
      ), '[]') as vars
    from products p
    ${where.length ? 'where ' + where.join(' and ') : ''}
  `, params);

  const hide = user.hide_prices;
  return rows.map(p => {
    const variations = (p.vars || [])
      .filter(v => v.isActive !== false)
      .map(v => ({
        sku: v.sku, color: v.color, image: v.image,
        qty: Number(v.qty) || 0,
        stockStatus: (Number(v.qty) > 0) ? v.stockStatus : (v.stockStatus === 'in production' ? 'in production' : 'out of stock'),
        price: hide ? null : priceForCustomer(user, p, { sku: v.sku, price: v.price, sale_price: v.salePrice }),
      }));
    return {
      id: p.id, sku: p.sku, name: p.name, brand: p.brand, size: p.size,
      description: p.description, categories: p.categories, tags: p.tags,
      images: p.images, attributes: p.attributes,
      productionStatus: p.production_status, estimatedArrival: p.estimated_arrival,
      price: hide ? null : priceForCustomer(user, p, null),
      basePrice: hide ? null : (p.sale_price ?? p.price),
      onSale: p.sale_price != null,
      qty: variations.reduce((s, v) => s + v.qty, 0),
      variations,
      createdAt: p.created_at,
    };
  });
}

async function favouriteIds(userId) {
  if (!userId) return new Set();
  const { rows } = await q(`select product_id from favourites where user_id=$1`, [userId]);
  return new Set(rows.map(x => x.product_id));
}

async function getProducts(req, res) {
  const b = { ...req.query, ...req.body };
  const search = (b.search || '').trim().toLowerCase();
  const brands = [].concat(b.brands || b.brand || []).filter(Boolean);
  const categories = [].concat(b.categories || b.category || []).filter(Boolean);
  // grouped filters (AND across groups, OR within a group) like the old site
  const catGroups = ['types', 'genders', 'materials']
    .map(k => [].concat(b[k] || []).filter(Boolean)).filter(g => g.length);
  // Accept both the mapped size names the UI sends (Medium/Large/Small) and the
  // raw chip labels (M/L/Kids) for robustness against alt clients.
  const SIZE_ALIAS = { m: 'Medium', l: 'Large', s: 'Small', kids: 'Small',
    medium: 'Medium', large: 'Large', small: 'Small' };
  const sizes = [].concat(b.sizes || []).filter(Boolean)
    .map(x => SIZE_ALIAS[String(x).toLowerCase()] || x);
  const saleOnly = b.sale === true || b.sale === 'true';
  const newOnly = b.isNew === true || b.isNew === 'true';
  const inStockOnly = b.inStockOnly === true || b.inStockOnly === 'true';
  const sort = b.sort || 'newest';
  const page = Math.max(1, parseInt(b.page, 10) || 1);
  const perPage = Math.min(96, Math.max(1, parseInt(b.perPage, 10) || 24));

  let items = await loadProducts(req.user);
  const favs = await favouriteIds(req.user.id);

  if (search) {
    items = items.filter(p =>
      p.name.toLowerCase().includes(search) ||
      p.sku.toLowerCase().includes(search) ||
      (p.brand || '').toLowerCase().includes(search) ||
      p.variations.some(v => v.sku.toLowerCase().includes(search)));
  }
  // Brand chips mirror the old site's brand *category*: Zoho splits some
  // brands (e.g. "Charlett" vs "Charlett Sunglass") but the old site groups
  // them under one name, which is present in `categories`. Fall back to the
  // brand column for Zoho-only products not in the old-site export.
  if (brands.length) items = items.filter(p =>
    brands.some(b => p.categories.includes(b) || p.brand === b));
  if (categories.length) items = items.filter(p => categories.some(c => p.categories.includes(c)));
  for (const group of catGroups) {
    items = items.filter(p => group.some(c => p.categories.includes(c)));
  }
  if (sizes.length) items = items.filter(p => sizes.includes(p.size));
  if (saleOnly) items = items.filter(p => p.onSale);
  if (newOnly) items = items.filter(p => p.categories.includes('New'));   // old site tags "New" as a category
  if (inStockOnly) items = items.filter(p => p.qty > 0);

  const popScore = p => (p.tags?.includes('best-seller') ? 4 : 0)
    + (p.tags?.includes('good-seller') ? 2 : 0)
    + (p.images?.length ? 1 : 0);
  // A card shows a photo if the product OR any variation has an image; products
  // with none render a placeholder, so keep them off the front of the browse
  // view (default popular/newest sorts only — explicit price/name sorts stay pure).
  const noPhoto = p => (p.images?.length || p.variations?.some(v => v.image)) ? 0 : 1;
  const sorters = {
    popular: (a, b2) => (noPhoto(a) - noPhoto(b2))
      || (popScore(b2) - popScore(a))
      || (new Date(b2.createdAt) - new Date(a.createdAt)),
    newest: (a, b2) => (noPhoto(a) - noPhoto(b2))
      || (new Date(b2.createdAt) - new Date(a.createdAt)),
    price_asc: (a, b2) => (a.price ?? 0) - (b2.price ?? 0),
    price_desc: (a, b2) => (b2.price ?? 0) - (a.price ?? 0),
    name: (a, b2) => a.name.localeCompare(b2.name),
    sku: (a, b2) => a.sku.localeCompare(b2.sku, undefined, { numeric: true }),
  };
  items.sort(sorters[sort] || sorters.newest);

  const total = items.length;
  const pageItems = items.slice((page - 1) * perPage, page * perPage)
    .map(p => ({ ...p, isFavourite: favs.has(p.id) }));
  res.json({ products: pageItems, total, page, perPage });
}

r.get('/get-products', getProducts);
r.post('/get-products', getProducts);

r.get('/product-filter-data', async (req, res) => {
  const { rows: brandRows } = await q(
    `select distinct brand from products where is_active and brand <> '' order by brand`);
  const { rows: catRows } = await q(
    `select distinct unnest(categories) as c from products where is_active order by c`);
  const { rows: priceRows } = await q(
    `select min(coalesce(sale_price, price)) as min, max(coalesce(sale_price, price)) as max
       from products where is_active`);
  res.json({
    brands: brandRows.map(x => x.brand),
    categories: catRows.map(x => x.c),
    priceRange: priceRows[0],
  });
});

r.get('/products/top-sellers', async (req, res) => {
  const { rows } = await q(`
    select split_part(oi.sku, '.', 1) as model, sum(oi.collected) as sold
      from order_items oi
      join orders o on o.id = oi.order_id
     where o.status <> 'cancelled' and o.order_date > current_date - 90
     group by 1 order by 2 desc limit 12`);
  const skus = rows.map(x => x.model);
  if (!skus.length) return res.json({ products: [] });
  const items = await loadProducts(req.user, { skus });
  const order = new Map(skus.map((s, i) => [s, i]));
  items.sort((a, b) => order.get(a.sku) - order.get(b.sku));
  res.json({ products: items });
});

r.get('/new-since-last-login', async (req, res) => {
  const since = req.user.prev_login_at;
  if (!since) return res.json({ products: [] });
  const { rows } = await q(
    `select id from products where is_active and created_at > $1 order by created_at desc limit 48`, [since]);
  if (!rows.length) return res.json({ products: [] });
  const items = await loadProducts(req.user, { ids: rows.map(x => x.id) });
  res.json({ products: items });
});

/* ============================ shared frame lists ============================
   A curated set of frames behind one link (veyora.design/#/list/<slug>).
   Staff paste SKUs (model like "2057" or model.color like "2057.81"); we match
   either against a product's own SKU or any of its variations, case-insensitive,
   and keep the products in the order the SKUs were pasted. */

function normSkus(input) {
  let list = input;
  if (typeof list === 'string') list = list.split(/[\s,;]+/);
  const seen = new Set(), out = [];
  for (const s of list || []) {
    const t = String(s).trim();
    if (t && !seen.has(t.toUpperCase())) { seen.add(t.toUpperCase()); out.push(t); }
  }
  return out;
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Products whose own SKU or a variation SKU is in `skus`, ordered by paste order. */
async function productsForSkus(user, skus) {
  const wanted = normSkus(skus);
  if (!wanted.length) return [];
  const upper = wanted.map(s => s.toUpperCase());
  const { rows } = await q(`
    select p.id, upper(p.sku) as psku,
      array(select upper(v.sku) from variations v where v.product_id = p.id) as vskus
    from products p
    where p.is_active and (
      upper(p.sku) = any($1)
      or exists (select 1 from variations v where v.product_id = p.id and upper(v.sku) = any($1)))`,
    [upper]);
  if (!rows.length) return [];
  const items = await loadProducts(user, { ids: rows.map(x => x.id) });
  const rank = new Map();
  for (const row of rows) {
    let r0 = upper.length;
    for (let i = 0; i < upper.length; i++) {
      if (upper[i] === row.psku || row.vskus.includes(upper[i])) { r0 = i; break; }
    }
    rank.set(row.id, r0);
  }
  return items.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
}

/** Split requested SKUs into those that match a live product/variation and those that don't. */
async function resolveSkuMatches(skus) {
  const wanted = normSkus(skus);
  if (!wanted.length) return { matched: [], unmatched: [] };
  const { rows } = await q(`
    select x.sku from unnest($1::text[]) as x(sku)
    where exists (select 1 from products p where p.is_active and upper(p.sku) = upper(x.sku))
       or exists (select 1 from variations v join products p on p.id = v.product_id
                   where p.is_active and upper(v.sku) = upper(x.sku))`, [wanted]);
  const ok = new Set(rows.map(x => x.sku.toUpperCase()));
  return {
    matched: wanted.filter(s => ok.has(s.toUpperCase())),
    unmatched: wanted.filter(s => !ok.has(s.toUpperCase())),
  };
}

function listUrl(slug) {
  const base = (process.env.PUBLIC_URL || 'https://veyora.design').replace(/\/+$/, '');
  return `${base}/#/list/${slug}`;
}

// Public: view a shared list (guest sees frames only, customer sees prices).
r.get('/shared-lists/:slug', async (req, res, next) => {
  try {
    const { rows } = await q(`select slug, name, skus from shared_lists where slug = $1`,
      [String(req.params.slug || '').toLowerCase()]);
    if (!rows[0]) return res.status(404).json({ error: 'list not found' });
    const products = await productsForSkus(req.user, rows[0].skus);
    res.json({ list: { slug: rows[0].slug, name: rows[0].name, count: products.length }, products });
  } catch (e) { next(e); }
});

// Staff: list every shared list (newest first).
r.get('/shared-lists', requireAuth(...AGENT_ROLES), async (req, res, next) => {
  try {
    const { rows } = await q(`
      select s.slug, s.name, s.skus, s.created_at, u.email as created_by
        from shared_lists s left join users u on u.id = s.created_by
       order by s.created_at desc limit 200`);
    res.json({ lists: rows.map(x => ({
      slug: x.slug, name: x.name, count: (x.skus || []).length,
      createdAt: x.created_at, createdBy: x.created_by, url: listUrl(x.slug),
    })) });
  } catch (e) { next(e); }
});

// Staff: create a shared list. Body: { name, code?, skus: string|string[] }.
r.post('/shared-lists', requireAuth(...AGENT_ROLES), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 120);
    const skus = normSkus(req.body?.skus);
    if (!skus.length) return res.status(400).json({ error: 'Add at least one SKU.' });

    let slug = slugify(req.body?.code);
    if (slug) {
      const { rows } = await q(`select 1 from shared_lists where slug = $1`, [slug]);
      if (rows[0]) return res.status(409).json({ error: `The link code "${slug}" is already used — pick another.` });
    } else {
      for (let i = 0; i < 6 && !slug; i++) {
        const cand = crypto.randomBytes(4).toString('hex');
        const { rows } = await q(`select 1 from shared_lists where slug = $1`, [cand]);
        if (!rows[0]) slug = cand;
      }
      if (!slug) slug = crypto.randomBytes(8).toString('hex');
    }

    await q(`insert into shared_lists (slug, name, skus, created_by) values ($1,$2,$3,$4)`,
      [slug, name, skus, req.user.id]);
    const { matched, unmatched } = await resolveSkuMatches(skus);
    res.json({ slug, url: listUrl(slug), name, total: skus.length,
      matched: matched.length, unmatched });
  } catch (e) { next(e); }
});

// Staff: delete a shared list (the link stops working).
r.delete('/shared-lists/:slug', requireAuth(...AGENT_ROLES), async (req, res, next) => {
  try {
    await q(`delete from shared_lists where slug = $1`, [String(req.params.slug || '').toLowerCase()]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default r;
