/* Product catalog — replica of the old veyora.com products page:
   beige search, grouped filters, big cards with colorway thumbnails and
   seller badges. Works for guests (no prices) and customers. */
'use strict';

const CATALOG_FILTER_DEFAULTS = { search: '', brands: [], types: [], genders: [], sizes: [],
  materials: [], sale: false, isNew: false, inStockOnly: false, sort: 'popular', page: 1 };
const Catalog = {
  // Filters survive navigation (module singleton) AND a full page reload
  // (sessionStorage) — they stay in place until the user clears them.
  filters: (() => {
    try { const s = sessionStorage.getItem('veyora_filters');
      if (s) return { ...CATALOG_FILTER_DEFAULTS, ...JSON.parse(s) }; } catch (e) {}
    return { ...CATALOG_FILTER_DEFAULTS };
  })(),
};
/** Is anything actually filtered right now? (page number doesn't count) */
function filtersActive(F) {
  return Boolean(F.search) || F.brands.length || F.types.length || F.genders.length
    || F.sizes.length || F.materials.length || F.sale || F.isNew || F.inStockOnly
    || F.sort !== CATALOG_FILTER_DEFAULTS.sort;
}
/* Persist only a real selection. Once the user clears everything the key goes
   away, so a fresh visit starts clean instead of restoring an empty filter set. */
function saveCatalogFilters() {
  try {
    if (filtersActive(Catalog.filters)) {
      sessionStorage.setItem('veyora_filters', JSON.stringify(Catalog.filters));
    } else {
      sessionStorage.removeItem('veyora_filters');
    }
  } catch (e) {}
}

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
        <button class="btn sm" type="button" onclick="location.hash='#/cart'">🛒 Cart<span
          class="badge" id="cartBadgeT" style="${Store.cartCount ? '' : 'display:none'}">${Store.cartCount}</span></button>
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
        <div class="frow fclear-row">
          <button type="button" class="fclear" id="clearFilters" style="display:none">✕ Clear filters</button>
        </div>
      </div>
      <div class="fsheet-back">
        <div class="fsheet">
          <div class="fsheet-head"><b>Filters</b><button type="button" id="fsDone">Done</button></div>
          <div class="fsheet-body"></div>
        </div>
      </div>
      <div id="grid" class="pgrid2"></div>
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
    const clearBtn = el.querySelector('#clearFilters');

    /* Clear filters — the explicit "until intentionally cleared" half of the
       persistence rule. Resets every group, the search box and the sort, drops
       the saved sessionStorage state and reloads. Lives inside .fbar, so the
       same button is present on desktop and inside the mobile filter sheet. */
    clearBtn.onclick = () => {
      // JSON round-trip rather than structuredClone — same result, and it works
      // on the older mobile Safari versions this storefront still supports.
      Object.assign(F, JSON.parse(JSON.stringify(CATALOG_FILTER_DEFAULTS)));
      try { sessionStorage.removeItem('veyora_filters'); } catch (e) {}
      el.querySelectorAll('.fchip.on').forEach(c => c.classList.remove('on'));
      const search = el.querySelector('.bigsearch input');
      if (search) search.value = '';
      load();
    };

    let loadSeq = 0;
    async function load() {
      const my = ++loadSeq;
      saveCatalogFilters();   // remember the current filters across reloads
      clearBtn.style.display = filtersActive(F) ? '' : 'none';
      grid.innerHTML = Array(8).fill('<div class="skeleton" style="height:430px"></div>').join('');
      const res = await API.post('/user/get-products',
        { ...F, perPage: 24, customerId: actingFor()?.id || undefined });
      if (my !== loadSeq) return;   // a newer search/filter/pager click superseded this
      grid.innerHTML = '';
      if (!res.products.length) {
        grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">🕶️</div>No products match your filters</div>`;
      }
      for (const p of res.products) grid.appendChild(productCard(p));
      // Guests don't get a total — keep a fixed-width sliding window of page
      // numbers (never grow 1…N as they browse). Customers get classic
      // first/last + ellipsis pagination.
      const knowTotal = res.total != null;
      const pages = knowTotal ? Math.max(1, Math.ceil(res.total / res.perPage)) : null;
      const hasPrev = F.page > 1;
      const hasNext = knowTotal ? F.page < pages : !!res.hasMore;
      const nums = pagerNumbers(F.page, pages, hasNext);
      pager.innerHTML = (hasPrev || hasNext || (pages && pages > 1) || nums.length > 1) ? `
        <button type="button" ${hasPrev ? '' : 'disabled'} data-d="-1" aria-label="Previous page">‹ Prev</button>
        ${nums.map(n => n === '…'
          ? `<span class="pager-gap" aria-hidden="true">…</span>`
          : `<button type="button" class="pg ${n === F.page ? 'on' : ''}" data-p="${n}" aria-label="Page ${n}" ${n === F.page ? 'aria-current="page"' : ''}>${n}</button>`).join('')}
        <button type="button" ${hasNext ? '' : 'disabled'} data-d="1" aria-label="Next page">Next ›</button>
        ${knowTotal ? `<span class="sub pager-meta">${res.total} products</span>` : ''}` : '';
      pager.querySelectorAll('button[data-d]').forEach(b => b.onclick = () => {
        F.page += parseInt(b.dataset.d, 10); load();
        window.scrollTo({ top: 0 });
      });
      pager.querySelectorAll('button[data-p]').forEach(b => b.onclick = () => {
        F.page = parseInt(b.dataset.p, 10); load();
        window.scrollTo({ top: 0 });
      });
    }

    // brand chips from live data, limited to the old site's public brand list
    API.get(withOrderingContext('/user/product-filter-data')).then(fd => {
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
    if (!guest) API.get(withOrderingContext('/user/get-cart'))
      .then(c => { if (ctAmt) ctAmt.textContent = money(c.total || 0); setCartBadge(c.totalQty || 0); })
      .catch(() => { if (ctAmt) ctAmt.textContent = money(0); });

    await load();
  },
};

/** Compact page list. With a known total: 1 … 4 5 6 … 39.
    Guests (no total): a fixed 5-wide sliding window — never grows as you browse. */
function pagerNumbers(current, totalPages, hasMore) {
  const WINDOW = 5;
  if (totalPages != null) {
    if (totalPages <= 1) return [1];
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const set = new Set([1, totalPages, current]);
    for (let i = current - 1; i <= current + 1; i++) {
      if (i >= 1 && i <= totalPages) set.add(i);
    }
    // Prefer a denser window near the ends
    if (current <= 3) [2, 3, 4].forEach(n => { if (n < totalPages) set.add(n); });
    if (current >= totalPages - 2) {
      [totalPages - 1, totalPages - 2, totalPages - 3].forEach(n => { if (n > 1) set.add(n); });
    }
    const sorted = [...set].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('…');
      out.push(sorted[i]);
    }
    return out;
  }
  // Guest / unknown total — sliding window only (max ~5 nums + optional 1 …)
  let start = Math.max(1, current - Math.floor(WINDOW / 2));
  let end = start + WINDOW - 1;
  if (current <= Math.ceil(WINDOW / 2)) { start = 1; end = WINDOW; }
  if (!hasMore) end = Math.max(current, Math.min(end, current));
  const mid = [];
  for (let i = start; i <= end; i++) mid.push(i);
  if (!mid.length) return [1];
  if (start <= 1) return mid;
  if (start === 2) return [1, ...mid];
  return [1, '…', ...mid];
}

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
  const lt = String(p.attributes?.lens_type || '').trim();
  if (!lt) return '';
  const short = /polycarb/i.test(lt) ? 'P.C' : lt.toUpperCase();
  return `<span class="lens-chip">${esc(short)}</span>`;
}

function attrLine(p) {
  const a = p.attributes || {};
  // Industry frame size: eye (lens width) – bridge – temple, e.g. 53-18-140
  if (a.lens_w == null || a.bridge == null || a.temple == null) return '';
  const w = String(a.lens_w).trim();
  const b = String(a.bridge).trim();
  const t = String(a.temple).trim();
  if (!w || !b || !t) return '';
  return `${w}-${b}-${t}`;
}

/** Modal frame size — classic optical sizing, visually quiet. */
function frameDimsBlock(p) {
  const line = attrLine(p);
  if (!line) return '';
  const a = p.attributes || {};
  const h = a.lens_h != null && String(a.lens_h).trim() !== '' ? String(a.lens_h).trim() : '';
  return `<div class="pdetail-dims" title="Lens width – Bridge – Temple">${esc(line)}${
    h ? `<span class="pdetail-dims-h"> · H ${esc(h)}</span>` : ''
  }</div>`;
}

/* The card's call to action. A frame with no stock is still orderable when
   backorders are enabled — it just says so, instead of being a dead button. */
function orderButton(p, hide) {
  const priceBit = (hide || p.price == null) ? '' : ' · ' + money(p.price);
  if (p.qty > 0) return `<button class="orderbtn">Order${priceBit}</button>`;
  if (backordersAllowed()) return `<button class="orderbtn bo">Backorder${priceBit}</button>`;
  return `<button class="orderbtn" disabled>Out of stock</button>`;
}

function productCard(p) {
  const u = catalogUser();
  const hide = u.hidePrices;
  const mainImg = p.images?.[0] || p.variations.find(v => v.image)?.image || null;
  const thumbs = p.variations.filter(v => v.image).slice(0, 7);
  // Second angle (usually the exterior/side shot) revealed on hover — the
  // product's 2nd photo, else the first variation image that differs from main.
  const hoverImg = p.images?.[1]
    || p.variations.map(v => v.image).filter(Boolean).find(img => img && img !== mainImg)
    || null;
  const { gallery, colorAt } = productGallery(p);
  // Which photo is currently shown (thumb pick or default). Lightbox opens here.
  let selectedSrc = mainImg || thumbs[0]?.image || gallery[0] || null;

  const card = h(`<div class="pcard2">
    ${sellerBadge(p)}
    ${u.guest ? '' : `<button class="fav ${p.isFavourite ? 'on' : ''}" title="Favorite">${p.isFavourite ? '♥' : '♡'}</button>`}
    <div class="photo-wrap">
      <div class="imgbox2">${imgOr(mainImg)}</div>
      ${hoverImg ? `<img class="hover-img" src="${esc(hoverImg)}" alt="" loading="lazy"/>` : ''}
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
    ${u.guest ? `<button class="orderbtn">Log in to order</button>` : orderButton(p, hide)}
  </div>`);

  const imgBox = card.querySelector('.imgbox2');
  const setMainPhoto = (src) => {
    selectedSrc = src;
    imgBox.innerHTML = imgOr(src);
    // If the cursor is still over the card, the hover overlay would hide this
    // swap. Suppress it only until the pointer leaves — then normal hover
    // resumes (including after picking another colour and going back).
    card.classList.add('thumb-swapping');
  };
  card.addEventListener('mouseleave', () => card.classList.remove('thumb-swapping'));

  card.querySelectorAll('.vthumbs img').forEach(t => t.onclick = (e) => {
    e.stopPropagation();
    setMainPhoto(t.dataset.src);
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
    productModal(p, selectedSrc);
  };
  // Main photo → fullscreen of the currently selected thumb/image.
  card.querySelector('.photo-wrap').onclick = (e) => {
    e.stopPropagation();
    if (!gallery.length) return;
    const start = Math.max(0, gallery.indexOf(selectedSrc));
    imageLightbox(gallery, start < 0 ? 0 : start, p.name, colorAt);
  };
  // Name / empty areas: guests still get the viewer; customers get the order modal
  // opened on the colour they already picked on the card.
  card.onclick = () => {
    if (catalogUser().guest) {
      const start = Math.max(0, gallery.indexOf(selectedSrc));
      imageLightbox(gallery, start < 0 ? 0 : start, p.name, colorAt);
    } else productModal(p, selectedSrc);
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

/* Per-colour ordering controls.
   With backorders ON  — every active colourway takes a quantity, and the box is
                         uncapped so a customer may deliberately order more than
                         is on the shelf. Out-of-stock rows keep "Notify me" too,
                         for customers who would rather wait than commit.
   With backorders OFF — only stocked colourways take a quantity, capped at what
                         is available; the rest offer "Notify me" as before. */
function variationNotifyButton(v) {
  // Only when the colour cannot be ordered at all — if backorders are on,
  // the qty box already covers demand and "Notify me" is noise.
  if (v.qty > 0 || backordersAllowed()) return '';
  return `<button class="btn ghost sm notify" data-sku="${esc(v.sku)}"
    title="Email me when this colour is back in stock">Notify me</button>`;
}
function variationQtyControls(v) {
  const bo = backordersAllowed();
  if (v.qty === 0 && !bo) return '';
  const max = bo ? null : v.qty;
  return qtyBox(0, 0, max);
}
function variationOrderControls(v) {
  const notify = variationNotifyButton(v);
  const qty = variationQtyControls(v);
  if (!notify && !qty) return '';
  return `<span class="vactions">${qty}${notify}</span>`;
}

function productModal(p, startSrc = null) {
  const u = catalogUser();
  const hide = u.hidePrices;
  const guest = !!u.guest;
  // gallery = product images + any per-variation images (deduped)
  const { gallery, colorAt } = productGallery(p);
  // Honour the colour the customer already picked on the product card.
  const startIdx = Math.max(0, startSrc ? gallery.indexOf(startSrc) : 0);
  const pricesVary = (p.variations || []).some(v =>
    v.price != null && p.price != null && Number(v.price) !== Number(p.price));
  const m = modal(`
    <div class="pdetail">
      <div class="pdetail-img">
        <div class="imgbox big" id="mainImg" title="Click to enlarge">
          ${imgOr(gallery[startIdx] || gallery[0])}
          <span class="zoom-hint">⤢</span>
        </div>
        ${gallery.length > 1 ? `<div class="thumbstrip">
          ${gallery.map((src, i) => `<img src="${esc(src)}" data-i="${i}" class="${i === startIdx ? 'sel' : ''}"/>`).join('')}
        </div>` : ''}
      </div>
      <div class="pdetail-info">
        <div class="sub">${esc(p.sku)} · ${esc(p.brand || '')}</div>
        <h2 class="pdetail-title">${esc(p.name)}</h2>
        ${!hide ? `<div class="price pdetail-price">${money(p.price)}</div>`
          : guest ? '' : `<div class="reveal-row">
              <span class="price pr-hidden pdetail-price">${money(p.price)}</span>
              <button class="reveal-btn" id="revealP" type="button">${eyeIcon(false)} Show price</button>
            </div>`}
        ${p.description ? `<p class="sub pdetail-desc">${esc(p.description)}</p>` : ''}
        ${frameDimsBlock(p)}
        <h3 class="pdetail-colors-h">Colors</h3>
        <div id="vrows" class="vrows">
          ${p.variations.map(v => `
            <div class="vrow" data-sku="${esc(v.sku)}" data-avail="${v.qty || 0}">
              ${imgOr(v.image || p.images?.[0])}
              <span class="vcol">${esc(v.color || v.sku)}</span>
              ${stockPill(v, { short: true })}
              <div class="vctrl">
                ${!hide && pricesVary ? `<b class="vprice">${money(v.price)}</b>`
                  : guest || !hide ? ''
                  : pricesVary ? `<b class="vprice pr-hidden">${money(v.price)}</b>` : ''}
                ${guest ? '' : variationQtyControls(v)}
                ${guest ? '' : variationNotifyButton(v)}
              </div>
              <span class="vbo"></span>
            </div>`).join('')}
        </div>
        <div class="pdetail-actions">
          ${guest
            ? `<button class="btn" onclick="location.hash='#/login'">Sign in to see prices & order</button>`
            : `<button class="btn" id="addBtn">Add to cart</button>
               ${/* Salesperson demonstration action — staff only. A customer
                     viewing their own account has no "customer" to show it to. */
                 canPresentToCustomer()
                 ? `<button class="btn ghost" id="custViewBtn" type="button" title="Show this frame to a customer, without the price">${eyeIcon(false)} Show to customer</button>`
                 : ''}
               <span class="sub" id="addSummary"></span>`}
        </div>
      </div>
    </div>`);

  // Phone: float close on the gallery image. Desktop/tablet: keep it on the
  // modal's top-right corner (previous behaviour).
  const galleryCol = m.querySelector('.pdetail-img');
  const modalEl = m.querySelector('.modal');
  const closeBtn = m.querySelector('.close');
  if (galleryCol && modalEl && closeBtn) {
    const phone = window.matchMedia('(max-width:760px)');
    const placeClose = () => {
      if (phone.matches) {
        if (closeBtn.parentElement !== galleryCol) galleryCol.prepend(closeBtn);
      } else if (closeBtn.parentElement !== modalEl) {
        modalEl.prepend(closeBtn);
      }
    };
    placeClose();
    phone.addEventListener('change', placeClose);
  }

  const mainBox = m.querySelector('#mainImg');
  let curIdx = startIdx;
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

  // "Show to customer": open a clean, price-free fullscreen card of THIS frame,
  // so the rep can turn the screen to the shopper. One frame, on demand — does
  // not touch the site-wide presentation toggle.
  const custBtn = m.querySelector('#custViewBtn');
  if (custBtn) custBtn.onclick = () => customerFrameView(p);
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
  const boTotals = new Map();
  m.querySelectorAll('.vrow .qtybox').forEach(box => {
    const row = box.closest('.vrow');
    const sku = row.dataset.sku;
    const avail = parseInt(row.dataset.avail, 10) || 0;
    const note = row.querySelector('.vbo');
    bindQtyBox(box, v => {
      if (v > 0) chosen.set(sku, v); else chosen.delete(sku);
      // Say per row exactly what ships now and what is being backordered, so
      // nobody discovers the split only after checkout.
      const backordered = Math.max(0, v - avail);
      boTotals.set(sku, backordered);
      if (note) {
        note.textContent = backordered > 0
          ? (avail > 0 ? `${avail} now · ${backordered} on backorder` : `${backordered} on backorder`)
          : '';
        note.classList.toggle('on', backordered > 0);
      }
      const total = [...chosen.values()].reduce((s, x) => s + x, 0);
      const boTotal = [...chosen.keys()].reduce((s, k) => s + (boTotals.get(k) || 0), 0);
      m.querySelector('#addSummary').textContent = total
        ? `${total} pcs selected${boTotal ? ` · ${boTotal} on backorder` : ''}` : '';
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
    try {
      for (const [sku, qty] of chosen) {
        cart = await API.post('/user/add-to-cart', { sku, qty });
      }
    } catch (ex) {
      // With backorders disabled the server refuses over-ordering; say why.
      toast(ex.message, true);
      if (cart) setCartBadge(cart.totalQty);
      return;
    }
    setCartBadge(cart.totalQty);
    const boTotal = [...chosen.keys()].reduce((s, k) => s + (boTotals.get(k) || 0), 0);
    toast(boTotal ? `Added to cart · ${boTotal} on backorder` : 'Added to cart');
    m.remove();
  };
}

/* Customer view — a clean, fullscreen card of ONE frame with NO price and none
   of the rep's controls, so the rep can turn the screen to the shopper. It shows
   only the photo, brand + model name, and the available colours. Transient and
   per-frame: it never changes the site-wide presentation/hide-prices state. */
function customerFrameView(p) {
  const { gallery } = productGallery(p);
  const colors = (p.variations || []).filter(v => v.color);
  const back = h(`<div class="custview">
    <button class="cv-close" aria-label="Close">×</button>
    <div class="cv-card">
      <div class="cv-stage" title="">${imgOr(gallery[0])}</div>
      <div class="cv-meta">
        ${p.brand ? `<div class="cv-brand">${esc(p.brand)}</div>` : ''}
        <h2 class="cv-name">${esc(p.name || p.sku || '')}</h2>
        ${colors.length > 1 ? `<div class="cv-colors">${colors.map((v, i) => `
          <button class="cv-swatch${i === 0 ? ' sel' : ''}" data-i="${i}">
            ${imgOr(v.image || p.images?.[0])}
            <span>${esc(v.color)}</span>
          </button>`).join('')}</div>` : ''}
      </div>
    </div>
  </div>`);

  const stage = back.querySelector('.cv-stage');
  let gi = 0;
  const setImg = src => { stage.innerHTML = imgOr(src); };
  // tapping a colour shows that colourway's photo (never a price)
  back.querySelectorAll('.cv-swatch').forEach(btn => btn.onclick = () => {
    const v = colors[+btn.dataset.i];
    setImg(v.image || p.images?.[0] || gallery[0]);
    back.querySelectorAll('.cv-swatch').forEach(b => b.classList.toggle('sel', b === btn));
  });
  // swipe/drag through all photos on the main image
  if (gallery.length > 1) bindSwipe(stage, d => {
    gi = (gi + d + gallery.length) % gallery.length;
    setImg(gallery[gi]);
  });

  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  function onKey(e) { if (e.key === 'Escape') close(); }
  back.querySelector('.cv-close').onclick = close;
  back.addEventListener('click', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  return back;
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
    try { r = await API.post(withOrderingContext('/user/scan-tray'), fd); }
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
          ${qtyBox(x.available > 0 ? x.qty : 0, 0, backordersAllowed() ? null : x.available)}
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
    const res = await API.get(withOrderingContext('/user/replenishment'));
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
        ${i.available > 0 ? qtyBox(0, 0, backordersAllowed() ? null : i.available)
          : (backordersAllowed() ? qtyBox(0, 0, null) : '')}
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
