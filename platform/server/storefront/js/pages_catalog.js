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
  { key: 'sizes',     label: 'Size',      options: [['M', 'Medium'], ['L', 'Large'], ['Kids', 'Small']] },
  { key: 'materials', label: 'Material',  options: ['Metal', 'Plastic', 'Acetate'] },
];

// The old site's public filter bar lists exactly these brands, in this order.
const FILTER_BRANDS = ['Charlett', 'Essedue', 'Extreme', 'Kyme', 'Laura Ferre',
  'Liv London', 'Puro', 'Spike'];

Routes['#/products'] = {
  title: 'Products', optional: true,
  async render(el) {
    const F = Catalog.filters;
    const guest = !Store.session;
    if (guest) {
      el.innerHTML = `<div class="guest-head">${homeHeader()}</div>
        <main class="page prod-page"><div id="guestPage"></div></main>
        ${whatsappFloat()}`;
      document.body.classList.remove('hm-dark');
      el = el.querySelector('#guestPage');
    } else {
      el.classList.add('prod-page-inner');
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
        ${guest ? '' : `<button class="fbtn scanbtn" type="button" title="Scan your list">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>
        </button>`}
        <button class="fbtn" type="button">${funnelIcon()} Filters</button>
      </div>
      <div class="bigsearch">
        <input placeholder="Search products..." value="${esc(F.search)}"/>
      </div>
      ${guest ? '' : `<div class="cart-total-row">
        ${catalogUser().hidePrices ? '' : `<span>Total: <span class="amt" id="ctAmt">—</span></span>`}
        <button class="btn sm" type="button" onclick="location.hash='#/cart'">🛒 Cart</button>
      </div>`}
      <span id="fbarSlot"></span>
      <div class="fbar">
        <div class="frow groups">
          ${FILTER_GROUPS.map(g => `
            <span class="fgroup">
              <span class="flabel">${g.label}</span>
              ${g.options.map(o => Array.isArray(o)
                ? chip(g.key, o[1], o[0])
                : chip(g.key, o, o)).join('')}
            </span>
            <span class="fdiv"></span>`).join('')}
          ${chip('isNew', 'new', 'New')}
        </div>
        <div class="frow brands" id="brandRow"><span class="flabel">Brand</span></div>
      </div>
      <div class="fsheet-back">
        <div class="fsheet">
          <div class="fsheet-head"><b>Filters</b><button type="button" id="fsDone">Done</button></div>
          <div class="fsheet-body"></div>
        </div>
      </div>
      <div id="grid" class="pgrid2 ${Catalog.density === 3 ? 'cols3' : ''}"></div>
      <div class="pager" id="pager"></div>`;

    // mobile: the same filter bar moves into a bottom sheet (old-site pattern)
    const fbar = el.querySelector('.fbar');
    const sheetBack = el.querySelector('.fsheet-back');
    const openSheet = () => {
      sheetBack.querySelector('.fsheet-body').appendChild(fbar);
      sheetBack.classList.add('open');
      document.body.style.overflow = 'hidden';
    };
    const closeSheet = () => {
      sheetBack.classList.remove('open');
      document.body.style.overflow = '';
      el.querySelector('#fbarSlot').after(fbar);
    };
    el.querySelectorAll('.fbtn:not(.scanbtn)').forEach(b => b.onclick = openSheet);
    const scanBtn = el.querySelector('.scanbtn');
    if (scanBtn) scanBtn.onclick = () => scanListModal(el);
    el.querySelector('#fsDone').onclick = closeSheet;
    sheetBack.addEventListener('click', e => { if (e.target === sheetBack) closeSheet(); });

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

    // brand chips from live data, limited to the old site's public brand list
    API.get('/user/product-filter-data').then(fd => {
      const row = el.querySelector('#brandRow');
      const brands = FILTER_BRANDS.filter(b => fd.brands.includes(b));
      row.insertAdjacentHTML('beforeend', brands.map(b =>
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
    // app-layout cart summary (old-site: "Total: $X" + Cart under the search)
    const ctAmt = el.querySelector('#ctAmt');
    if (ctAmt) API.get('/user/get-cart')
      .then(c => { ctAmt.textContent = money(c.total || 0); })
      .catch(() => { ctAmt.textContent = money(0); });
    el.querySelectorAll('.density button').forEach(b => b.onclick = () => {
      Catalog.density = parseInt(b.dataset.d, 10);
      el.querySelectorAll('.density button').forEach(x => x.classList.toggle('on', x === b));
      grid.classList.toggle('cols3', Catalog.density === 3);
    });

    await load();
  },
};

function funnelIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M3 5h18l-7 8v5l-4 2v-7L3 5z"/></svg>`;
}

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
    ${u.guest ? '' : `<button class="fav ${p.isFavourite ? 'on' : ''}" title="Favorite">${p.isFavourite ? '♥' : '♡'}</button>`}
    <div class="photo-wrap">
      <div class="imgbox2">${imgOr(mainImg)}</div>
      <div class="attrline">${attrLine(p) || '&nbsp;'} ${lensChip(p)}</div>
    </div>
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
  // Old-site behavior: guests clicking the card get the image viewer directly
  // (arrows through the photos); customers get the ordering modal.
  card.onclick = () => {
    if (catalogUser().guest) {
      const { gallery, colorAt } = productGallery(p);
      imageLightbox(gallery, 0, p.name, colorAt);
    } else productModal(p);
  };
  return card;
}

/** Product + variation images, deduped, with a color caption per index. */
function productGallery(p) {
  const gallery = [...new Set([...(p.images || []),
    ...p.variations.map(v => v.image).filter(Boolean)])];
  const colorAt = idx => {
    const src = gallery[idx];
    const v = p.variations.find(x => x.image === src);
    return v ? (v.color || v.sku) : '';
  };
  return { gallery, colorAt };
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
  // gallery = product images + any per-variation images (deduped)
  const { gallery, colorAt } = productGallery(p);
  const m = modal(`
    <div class="pdetail">
      <div class="pdetail-img">
        <div class="imgbox big" id="mainImg" title="Click to enlarge">
          ${imgOr(gallery[0])}
          <span class="zoom-hint">⤢</span>
        </div>
        ${gallery.length > 1 ? `<div class="thumbstrip">
          ${gallery.map((src, i) => `<img src="${esc(src)}" data-i="${i}" class="${i === 0 ? 'sel' : ''}"/>`).join('')}
        </div>` : ''}
      </div>
      <div class="pdetail-info">
        <div class="sub">${esc(p.sku)} · ${esc(p.brand || '')}</div>
        <h2 style="margin:2px 0 6px;font-size:19px">${esc(p.name)}</h2>
        ${!hide ? `<div class="price" style="font-size:18px;font-weight:800">${money(p.price)}</div>`
          : guest ? '' : `<div class="reveal-row">
              <span class="price pr-hidden" style="font-size:18px;font-weight:800">${money(p.price)}</span>
              <button class="reveal-btn" id="revealP" type="button">${eyeIcon(false)} Show price</button>
            </div>`}
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
              ${!hide ? `<b class="vprice">${money(v.price)}</b>`
                : guest ? '' : `<b class="vprice pr-hidden">${money(v.price)}</b>`}
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

  const mainBox = m.querySelector('#mainImg');
  let curIdx = 0;
  function setMain(i) {
    curIdx = i;
    mainBox.innerHTML = imgOr(gallery[i]) + '<span class="zoom-hint">⤢</span>';
    m.querySelectorAll('.thumbstrip img').forEach(t => t.classList.toggle('sel', +t.dataset.i === i));
  }
  m.querySelectorAll('.thumbstrip img').forEach(t =>
    t.onclick = () => setMain(parseInt(t.dataset.i, 10)));
  mainBox.onclick = () => imageLightbox(gallery, curIdx, p.name, colorAt);
  // roll through photos with a finger / mouse drag, no buttons needed
  if (gallery.length > 1) bindSwipe(mainBox, d =>
    setMain((curIdx + d + gallery.length) % gallery.length));

  // presentation / hidden-price mode: price shows per item, on demand only
  const revealBtn = m.querySelector('#revealP');
  if (revealBtn) revealBtn.onclick = () => {
    const on = m.querySelector('.pdetail').classList.toggle('show-prices');
    revealBtn.innerHTML = on ? `${eyeIcon(true)} Hide price` : `${eyeIcon(false)} Show price`;
  };
  // clicking a color row jumps the gallery to that variation's image
  m.querySelectorAll('.vrow').forEach(row => {
    const sku = row.dataset.sku;
    const gi = gallery.findIndex(src => src === p.variations.find(v => v.sku === sku)?.image);
    if (gi >= 0) row.addEventListener('click', e => {
      if (e.target.closest('.qtybox') || e.target.closest('button')) return;
      setMain(gi);
    });
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
  // notify buttons reflect their real state (pressed = "✓ We'll email you")
  const setNotify = (b, on) => {
    b.classList.toggle('on', on);
    b.textContent = on ? '✓ We\'ll email you' : 'Notify me';
  };
  const notifyBtns = [...m.querySelectorAll('.notify')];
  if (notifyBtns.length) {
    API.get('/user/restock-notify').then(r => {
      const mine = new Set(r.skus || []);
      notifyBtns.forEach(b => setNotify(b, mine.has(b.dataset.sku)));
    }).catch(() => {});
  }
  notifyBtns.forEach(b => b.onclick = async () => {
    const r = await API.post('/user/restock-notify', { sku: b.dataset.sku });
    setNotify(b, r.notify);
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

/* "Scan your list" — photo of a handwritten SKU list fills the cart
   (replica of the old site's scan-tray modal, same wording). */
function scanListModal(pageEl) {
  const m = modal(`
    <h2 style="font-size:18px;margin-bottom:4px">Scan your list</h2>
    <p class="sub" style="margin-bottom:14px">Got a notepad list of SKUs? Snap a photo or drop the image
      here and your cart will auto-populate. List each item as model.color — e.g. 2057.81.</p>
    <div class="scan-drop" id="scanDrop">
      <div class="scan-ic">🖼️</div>
      <p style="max-width:420px;margin:0 auto 16px">Snap a photo of your handwritten list, or drag and drop
        the image here. We'll match each line to a SKU and add it to your cart.
        Format: model.color, e.g. 2057.81.</p>
      <button class="btn" id="scanPick">📷 Upload Or Take Photo</button>
      <p class="sub" style="margin-top:12px">…or drop the image anywhere in this box</p>
      <p class="sub">Up to 8 photos per scan. JPG, PNG, WebP, or HEIC.</p>
      <p style="margin-top:14px"><a href="javascript:void 0" id="scanSearch" class="sub" style="font-weight:600">🔍 Search Catalog</a></p>
      <input type="file" id="scanFiles" accept="image/*" multiple style="display:none"/>
    </div>
    <div id="scanResults"></div>`);
  const drop = m.querySelector('#scanDrop');
  const input = m.querySelector('#scanFiles');
  m.querySelector('#scanPick').onclick = () => input.click();
  m.querySelector('#scanSearch').onclick = () => {
    m.remove();
    pageEl.querySelector('.bigsearch input')?.focus();
  };
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); scan(e.dataTransfer.files); });
  input.onchange = () => scan(input.files);

  async function scan(fileList) {
    const files = [...fileList].slice(0, 8);
    if (!files.length) return;
    drop.innerHTML = `<div class="skeleton" style="height:54px;margin:20px 0"></div>
      <p class="sub" style="text-align:center">Reading your list…</p>`;
    const fd = new FormData();
    files.forEach(f => fd.append('photos', f));
    let r;
    try { r = await API.post('/user/scan-tray', fd); }
    catch (ex) {
      drop.innerHTML = `<p class="sub" style="color:var(--bad);text-align:center;padding:20px 0">${esc(ex.message)}</p>
        <p style="text-align:center"><button class="btn ghost sm" onclick="location.hash='#/products'">Close</button></p>`;
      return;
    }
    drop.style.display = 'none';
    const box = m.querySelector('#scanResults');
    if (!r.matched.length) {
      box.innerHTML = `<div class="empty"><div class="big">🤷</div>No SKUs matched.
        ${r.unmatched.length ? `Read but not found: ${r.unmatched.map(esc).join(', ')}` : ''}</div>`;
      return;
    }
    const hide = Store.session.user.hidePrices;
    box.innerHTML = `
      ${r.matched.map((x, i) => `
        <div class="vrow" data-sku="${esc(x.sku)}">
          ${imgOr(x.image)}
          <span class="vsku">${esc(x.sku)}</span>
          <span class="vcol">${esc(x.name)}${x.color ? ' · ' + esc(x.color) : ''}<br/>
            <span class="sub">read as "${esc(x.scanned)}"</span></span>
          ${stockPill({ qty: x.available, stockStatus: 'in stock' })}
          ${hide || x.price == null ? '' : `<b class="vprice">${money(x.price)}</b>`}
          ${qtyBox(x.available > 0 ? x.qty : 0, 0, null)}
        </div>`).join('')}
      ${r.unmatched.length ? `<p class="sub" style="margin-top:10px;color:var(--warn)">
        Couldn't match: ${r.unmatched.map(esc).join(', ')}</p>` : ''}
      <div style="display:flex;gap:10px;margin-top:14px;align-items:center">
        <button class="btn" id="scanAdd">Add all to cart</button><span class="sub" id="scanSum"></span>
      </div>`;
    const qty = new Map(r.matched.map(x => [x.sku, x.available > 0 ? x.qty : 0]));
    const sum = () => {
      const t = [...qty.values()].reduce((s, v) => s + v, 0);
      m.querySelector('#scanSum').textContent = t ? `${t} pcs` : '';
    };
    box.querySelectorAll('.vrow .qtybox').forEach(qb =>
      bindQtyBox(qb, (v) => { qty.set(qb.closest('.vrow').dataset.sku, v); sum(); }));
    sum();
    m.querySelector('#scanAdd').onclick = async () => {
      let cart, added = 0;
      for (const [sku, n] of qty) {
        if (n > 0) { cart = await API.post('/user/add-to-cart', { sku, qty: n }); added += n; }
      }
      if (!added) { toast('Choose quantities first', true); return; }
      setCartBadge(cart.totalQty);
      toast(`${added} pcs added to cart`);
      m.remove();
    };
  }
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
