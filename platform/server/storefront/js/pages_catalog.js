/* Product catalog — replica of the old veyora.com products page:
   beige search, grouped filters, density toggle, big cards with colorway
   thumbnails and seller badges. Works for guests (no prices) and customers. */
'use strict';

const Catalog = {
  filters: { search: '', brands: [], types: [], genders: [], sizes: [], materials: [],
             sale: false, isNew: false, inStockOnly: false, sort: 'popular', page: 1 },
  density: 4,
};

function catalogUser() {
  return Store.session?.user || { hidePrices: true, role: 'guest', guest: true };
}

const FILTER_GROUPS = [
  { key: 'types',     label: 'Lens type', options: ['Sunglasses', 'Eyeglasses'] },
  { key: 'genders',   label: 'Gender',    options: ['Men', 'Women', 'Kids'] },
  { key: 'sizes',     label: 'Size',      options: [['M', 'Medium'], ['L', 'Large'], ['S', 'Small']] },
  { key: 'materials', label: 'Material',  options: ['Metal', 'Plastic', 'Acetate'] },
];

Routes['#/products'] = {
  title: 'Products', optional: true,
  async render(el) {
    const F = Catalog.filters;
    const guest = !Store.session;
    if (guest) {
      el.innerHTML = `<div class="guest-head">${homeHeader()}</div>
        <div class="guest-bar">Browsing as a guest — <a href="#/login">sign in</a> to see wholesale prices and order, or <a href="#/activate">activate your account</a>.</div>
        <main class="page" style="background:var(--bg);color:var(--ink);border-radius:0;max-width:1440px"><div id="guestPage"></div></main>
        ${whatsappFloat()}`;
      document.body.classList.remove('hm-dark');
      el = el.querySelector('#guestPage');
    }

    const chip = (group, value, label, extra) => `
      <span class="fchip ${extra || ''} ${Array.isArray(F[group]) ? (F[group].includes(value) ? 'on' : '') : (F[group] ? 'on' : '')}"
            data-g="${group}" data-v="${esc(value)}">${esc(label)}</span>`;

    el.innerHTML = `
      <div class="prod-head">
        <h1>Products</h1>
        <div class="density">
          <button data-d="3" class="${Catalog.density === 3 ? 'on' : ''}" title="Larger cards">•••</button>
          <button data-d="4" class="${Catalog.density === 4 ? 'on' : ''}" title="Smaller cards">••••</button>
        </div>
      </div>
      <div class="bigsearch"><input placeholder="Search products..." value="${esc(F.search)}"/></div>
      <div class="fbar">
        <div class="frow">
          ${FILTER_GROUPS.map(g => `
            <span class="flabel">${g.label}</span>
            ${g.options.map(o => Array.isArray(o)
              ? chip(g.key, o[1], o[0])
              : chip(g.key, o, o)).join('')}`).join('')}
          ${chip('sale', 'sale', 'Sale', 'sale')}
          ${chip('isNew', 'new', 'New')}
          ${chip('inStockOnly', 'stock', 'In stock')}
        </div>
        <div class="frow" id="brandRow"><span class="flabel">Brand</span></div>
      </div>
      <div id="grid" class="pgrid2 ${Catalog.density === 3 ? 'cols3' : ''}"></div>
      <div class="pager" id="pager"></div>`;

    const grid = el.querySelector('#grid');
    const pager = el.querySelector('#pager');

    async function load() {
      grid.innerHTML = Array(8).fill('<div class="skeleton" style="height:430px"></div>').join('');
      const res = await API.post('/user/get-products', { ...F, perPage: 24 });
      grid.innerHTML = '';
      if (!res.products.length) {
        grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">🕶️</div>No products match your filters</div>`;
      }
      for (const p of res.products) grid.appendChild(productCard(p));
      const pages = Math.max(1, Math.ceil(res.total / res.perPage));
      pager.innerHTML = pages > 1 ? `
        <button ${F.page <= 1 ? 'disabled' : ''} data-d="-1">‹ Prev</button>
        <span class="sub">Page ${F.page} of ${pages} · ${res.total} products</span>
        <button ${F.page >= pages ? 'disabled' : ''} data-d="1">Next ›</button>` : '';
      pager.querySelectorAll('button').forEach(b => b.onclick = () => {
        F.page += parseInt(b.dataset.d, 10); load();
        window.scrollTo({ top: 0 });
      });
    }

    // brand chips from live data
    API.get('/user/product-filter-data').then(fd => {
      const row = el.querySelector('#brandRow');
      row.insertAdjacentHTML('beforeend', fd.brands.map(b =>
        `<span class="fchip ${F.brands.includes(b) ? 'on' : ''}" data-g="brands" data-v="${esc(b)}">${esc(b)}</span>`).join(''));
      bindChips();
    }).catch(() => {});

    function bindChips() {
      el.querySelectorAll('.fchip').forEach(c => c.onclick = () => {
        const g = c.dataset.g, v = c.dataset.v;
        if (Array.isArray(F[g])) {
          F[g] = F[g].includes(v) ? F[g].filter(x => x !== v) : [...F[g], v];
        } else {
          F[g] = !F[g];
        }
        F.page = 1;
        c.classList.toggle('on');
        load();
      });
    }
    bindChips();

    el.querySelector('.bigsearch input').oninput = debounce(e => {
      F.search = e.target.value; F.page = 1; load();
    }, 350);
    el.querySelectorAll('.density button').forEach(b => b.onclick = () => {
      Catalog.density = parseInt(b.dataset.d, 10);
      el.querySelectorAll('.density button').forEach(x => x.classList.toggle('on', x === b));
      grid.classList.toggle('cols3', Catalog.density === 3);
    });

    await load();
  },
};

function sellerBadge(p) {
  if ((p.tags || []).includes('best-seller')) {
    return `<span class="seller best">🔥 Best Seller</span>`;
  }
  if ((p.tags || []).includes('good-seller')) {
    return `<span class="seller good">★ Good Seller</span>`;
  }
  return '';
}

function lensChip(p) {
  const lt = String(p.attributes?.lensType || '').trim();
  if (!lt) return '';
  const short = /polycarb/i.test(lt) ? 'P.C' : lt.toUpperCase();
  return `<span class="lens-chip">${esc(short)}</span>`;
}

function attrLine(p) {
  const a = p.attributes || {};
  if (!a.lens_w) return '';
  const parts = [a.lens_w, a.bridge, a.temple].filter(Boolean).join(' · ');
  return `${parts}${a.lens_h ? ` — H ${a.lens_h}` : ''}`;
}

function productCard(p) {
  const u = catalogUser();
  const hide = u.hidePrices;
  const mainImg = p.images?.[0] || p.variations.find(v => v.image)?.image || null;
  const thumbs = p.variations.filter(v => v.image).slice(0, 7);

  const card = h(`<div class="pcard2">
    ${sellerBadge(p)}
    ${u.guest ? '' : `<button class="fav ${p.isFavourite ? 'on' : ''}" title="Favourite">${p.isFavourite ? '♥' : '♡'}</button>`}
    <div class="imgbox2">${imgOr(mainImg)}</div>
    <div class="attrline">${attrLine(p) || '&nbsp;'} ${lensChip(p)}</div>
    <div class="rowname">
      <span class="pname">${esc(p.name)}</span>
      <button class="share" title="Copy link">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>
      </button>
    </div>
    ${thumbs.length ? `<div class="vthumbs">${thumbs.map((v, i) => `
      <img src="${esc(v.image)}" data-src="${esc(v.image)}" class="${i === 0 ? 'sel' : ''}"
           title="${esc(v.sku)}${v.color ? ' · ' + esc(v.color) : ''}" loading="lazy"/>`).join('')}
      ${p.variations.length > 7 ? `<span class="more">+${p.variations.length - 7}</span>` : ''}
    </div>` : `<div class="vthumbs empty-thumbs"></div>`}
    ${u.guest
      ? `<button class="orderbtn">Log in to order</button>`
      : `<button class="orderbtn" ${p.qty > 0 ? '' : 'disabled'}>${p.qty > 0
          ? `Order${hide || p.price == null ? '' : ' · ' + money(p.price)}`
          : 'Out of stock'}</button>`}
  </div>`);

  card.querySelectorAll('.vthumbs img').forEach(t => t.onclick = (e) => {
    e.stopPropagation();
    card.querySelector('.imgbox2').innerHTML = imgOr(t.dataset.src);
    card.querySelectorAll('.vthumbs img').forEach(x => x.classList.toggle('sel', x === t));
  });
  card.querySelector('.share').onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(`${location.origin}/#/products?sku=${encodeURIComponent(p.sku)}`)
      .then(() => toast('Link copied'));
  };
  const favBtn = card.querySelector('.fav');
  if (favBtn) favBtn.onclick = async (e) => {
    e.stopPropagation();
    const r = await API.post(`/user/favourites/${p.id}/toggle`);
    e.target.classList.toggle('on', r.favourite);
    e.target.textContent = r.favourite ? '♥' : '♡';
  };
  card.querySelector('.orderbtn').onclick = (e) => {
    e.stopPropagation();
    if (catalogUser().guest) { location.hash = '#/login'; return; }
    productModal(p);
  };
  card.onclick = () => productModal(p);
  return card;
}

function productModal(p) {
  const u = catalogUser();
  const hide = u.hidePrices;
  const guest = !!u.guest;
  const a = p.attributes || {};
  const attrs = [
    ['Lens width', a.lens_w], ['Lens height', a.lens_h], ['Bridge', a.bridge],
    ['Temple', a.temple], ['Lens type', a.lensType], ['Case', a.caseCode],
    ['Size', p.size], ['EAN', p.ean],
  ].filter(x => x[1]);
  const m = modal(`
    <div style="display:flex;gap:20px;flex-wrap:wrap">
      <div style="flex:1;min-width:240px">
        <div class="imgbox" style="border:1px solid var(--line);border-radius:10px;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;overflow:hidden" id="mainImg">
          ${imgOr(p.images?.[0])}
        </div>
        ${(p.images || []).length > 1 ? `<div style="display:flex;gap:6px;margin-top:8px;overflow-x:auto">
          ${p.images.map(src => `<img src="${esc(src)}" data-src="${esc(src)}" style="width:58px;height:44px;object-fit:contain;border:1px solid var(--line);border-radius:6px;cursor:pointer"/>`).join('')}
        </div>` : ''}
      </div>
      <div style="flex:1.2;min-width:280px">
        <div class="sub">${esc(p.sku)} · ${esc(p.brand || '')}</div>
        <h2 style="margin:2px 0 6px;font-size:19px">${esc(p.name)}</h2>
        ${hide ? '' : `<div class="price" style="font-size:18px;font-weight:800">${money(p.price)}</div>`}
        ${p.description ? `<p class="sub" style="margin-top:8px">${esc(p.description)}</p>` : ''}
        ${attrs.length ? `<div class="attr-grid">${attrs.map(x =>
          `<div class="a">${esc(x[0])}<b>${esc(x[1])}</b></div>`).join('')}</div>` : ''}
        <h3 style="font-size:13.5px;margin:14px 0 2px">Colors</h3>
        <div id="vrows">
          ${p.variations.map(v => `
            <div class="vrow" data-sku="${esc(v.sku)}">
              ${imgOr(v.image || p.images?.[0])}
              <span class="vsku">${esc(v.sku)}</span>
              <span class="vcol">${esc(v.color || '')}</span>
              ${stockPill(v)}
              ${hide ? '' : `<b style="min-width:56px;text-align:right">${money(v.price)}</b>`}
              ${guest ? '' : (v.qty > 0 ? qtyBox(0, 0, v.qty)
                : `<button class="btn ghost sm notify" data-sku="${esc(v.sku)}">Notify me</button>`)}
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:10px;margin-top:16px;align-items:center">
          ${guest
            ? `<button class="btn" onclick="location.hash='#/login'">Sign in to see prices & order</button>`
            : `<button class="btn" id="addBtn">Add to cart</button><span class="sub" id="addSummary"></span>`}
        </div>
      </div>
    </div>`);

  m.querySelectorAll('[data-src]').forEach(t => t.onclick = () => {
    m.querySelector('#mainImg').innerHTML = imgOr(t.dataset.src);
  });

  const chosen = new Map();
  m.querySelectorAll('.vrow .qtybox').forEach(box => {
    const sku = box.closest('.vrow').dataset.sku;
    bindQtyBox(box, v => {
      if (v > 0) chosen.set(sku, v); else chosen.delete(sku);
      const total = [...chosen.values()].reduce((s, x) => s + x, 0);
      m.querySelector('#addSummary').textContent = total ? `${total} pcs selected` : '';
    });
  });
  m.querySelectorAll('.notify').forEach(b => b.onclick = async () => {
    const r = await API.post('/user/restock-notify', { sku: b.dataset.sku });
    toast(r.notify ? 'We\'ll email you when it\'s back' : 'Notification removed');
  });
  const addBtn = m.querySelector('#addBtn');
  if (addBtn) addBtn.onclick = async () => {
    if (!chosen.size) { toast('Choose quantities first', true); return; }
    let cart;
    for (const [sku, qty] of chosen) {
      cart = await API.post('/user/add-to-cart', { sku, qty });
    }
    setCartBadge(cart.totalQty);
    toast('Added to cart');
    m.remove();
  };
}

Routes['#/replenishment'] = {
  title: 'Reorder',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle">Quick reorder</h1>
      <p class="sub" style="margin:-8px 0 14px">Items you've bought before, with live stock.</p>
      <div class="card"><div class="pad" id="box">Loading…</div></div>`;
    const res = await API.get('/user/replenishment');
    const box = el.querySelector('#box');
    if (!res.items.length) {
      box.innerHTML = `<div class="empty"><div class="big">📦</div>No purchase history yet</div>`;
      return;
    }
    box.innerHTML = res.items.map(i => `
      <div class="vrow" data-sku="${esc(i.sku)}">
        ${imgOr(i.image)}
        <span class="vsku">${esc(i.sku)}</span>
        <span class="vcol">${esc(i.name)}${i.color ? ' · ' + esc(i.color) : ''}<br/>
          <span class="sub">bought ${i.bought} · last ${fmtDate(i.lastOrdered)}</span></span>
        ${stockPill({ qty: i.available, stockStatus: 'in stock' })}
        ${i.available > 0 ? qtyBox(0, 0, i.available) : ''}
      </div>`).join('') +
      `<div style="margin-top:14px"><button class="btn" id="addAll">Add selected to cart</button></div>`;
    const chosen = new Map();
    box.querySelectorAll('.qtybox').forEach(qb => {
      const sku = qb.closest('.vrow').dataset.sku;
      bindQtyBox(qb, v => { if (v > 0) chosen.set(sku, v); else chosen.delete(sku); });
    });
    box.querySelector('#addAll').onclick = async () => {
      if (!chosen.size) { toast('Choose quantities first', true); return; }
      let cart;
      for (const [sku, qty] of chosen) cart = await API.post('/user/add-to-cart', { sku, qty });
      setCartBadge(cart.totalQty);
      toast('Added to cart');
      location.hash = '#/cart';
    };
  },
};
