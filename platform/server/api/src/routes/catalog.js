import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, optionalAuth } from '../authmw.js';
import { priceForCustomer } from '../pricing.js';

const r = Router();
// catalog browsing is public (guest = prices hidden), like the old site
r.use(['/get-products', '/product-filter-data'], optionalAuth());
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

export default r;
