/* Product catalog: grid, filters, product detail, replenishment. */
'use strict';

const Catalog = { filters: { search: '', brands: [], categories: [], inStockOnly: false, sort: 'newest', page: 1 } };

function catalogUser() {
  return Store.session?.user || { hidePrices: true, role: 'guest', guest: true };
}

Routes['#/products'] = {
  title: 'Products', optional: true,
  async render(el) {
    const F = Catalog.filters;
    const guest = !Store.session;
    if (guest) {
      el.innerHTML = `<div class="guest-head">${homeHeader()}</div>
        <div class="guest-bar">Browsing as a guest — <a href="#/login">sign in</a> to see wholesale prices and order, or <a href="#/activate">activate your account</a>.</div>
        <main class="page" style="background:var(--bg);color:var(--ink);border-radius:0"><div id="guestPage"></div></main>
        ${whatsappFloat()}`;
      document.body.classList.remove('hm-dark');
      el = el.querySelector('#guestPage');
    }
    el.innerHTML = `
      <div class="catbar">
        <div class="search"><input placeholder="Search by name, SKU, brand…" value="${esc(F.search)}"/></div>
        <select class="chip" id="sortSel">
          <option value="newest">Newest</option>
          <option value="name">Name A–Z</option>
          <option value="sku">SKU</option>
          <option value="price_asc">Price ↑</option>
          <option value="price_desc">Price ↓</option>
        </select>
        <span class="chip ${F.inStockOnly ? 'on' : ''}" id="stockChip">In stock</span>
      </div>
      <div class="chips" id="brandChips" style="margin-bottom:14px"></div>
      <div id="grid" class="pgrid"></div>
      <div class="pager" id="pager"></div>`;
    el.querySelector('#sortSel').value = F.sort;

    const grid = el.querySelector('#grid');
    const pager = el.querySelector('#pager');

    async function load() {
      grid.innerHTML = Array(8).fill('<div class="skeleton" style="height:230px"></div>').join('');
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
      });
    }

    // brand chips
    API.get('/user/product-filter-data').then(fd => {
      const box = el.querySelector('#brandChips');
      box.innerHTML = fd.brands.map(b =>
        `<span class="chip ${F.brands.includes(b) ? 'on' : ''}" data-b="${esc(b)}">${esc(b)}</span>`).join('');
      box.querySelectorAll('.chip').forEach(c => c.onclick = () => {
        const b = c.dataset.b;
        F.brands = F.brands.includes(b) ? F.brands.filter(x => x !== b) : [...F.brands, b];
        F.page = 1; c.classList.toggle('on'); load();
      });
    }).catch(() => {});

    el.querySelector('.search input').oninput = debounce(e => {
      F.search = e.target.value; F.page = 1; load();
    }, 350);
    el.querySelector('#sortSel').onchange = e => { F.sort = e.target.value; F.page = 1; load(); };
    el.querySelector('#stockChip').onclick = e => {
      F.inStockOnly = !F.inStockOnly; F.page = 1;
      e.target.classList.toggle('on'); load();
    };
    await load();
  },
};

function productCard(p) {
  const u = catalogUser();
  const hide = u.hidePrices;
  const isNew = (Date.now() - new Date(p.createdAt).getTime()) < 30 * 864e5;
  const card = h(`<div class="pcard">
    ${isNew ? '<span class="tagnew">NEW</span>' : ''}
    ${u.guest ? '' : `<button class="fav ${p.isFavourite ? 'on' : ''}" title="Favourite">${p.isFavourite ? '♥' : '♡'}</button>`}
    <div class="imgbox">${imgOr(p.images?.[0])}</div>
    <div class="body">
      <div class="sku">${esc(p.sku)} · ${esc(p.brand || '')}</div>
      <div class="nm">${esc(p.name)}</div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="price">${hide ? '' : money(p.price)}</span>
        ${p.qty > 0 ? `<span class="sub">${p.qty} pcs</span>` : `<span class="oos">out of stock</span>`}
      </div>
    </div>
  </div>`);
  const favBtn = card.querySelector('.fav');
  if (favBtn) favBtn.onclick = async (e) => {
    e.stopPropagation();
    const r = await API.post(`/user/favourites/${p.id}/toggle`);
    e.target.classList.toggle('on', r.favourite);
    e.target.textContent = r.favourite ? '♥' : '♡';
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
