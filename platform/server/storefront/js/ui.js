/* Small DOM helpers shared by all pages. */
'use strict';

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) {
  if (n == null) return '—';
  return '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function fmtDate(d) {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? String(d).slice(0, 10)
    : x.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function toast(msg, isErr) {
  const el = h(`<div class="toast${isErr ? ' err' : ''}">${esc(msg)}</div>`);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function pill(status) {
  return `<span class="pill ${esc(String(status).replace(/\s+/g, ''))}">${esc(status)}</span>`;
}
function stockPill(v) {
  if (v.qty > 0) return `<span class="stockpill in">${v.qty} in stock</span>`;
  if (v.stockStatus === 'in production') return `<span class="stockpill prod">in production</span>`;
  return `<span class="stockpill out">out of stock</span>`;
}
function imgOr(src, cls) {
  return src
    ? `<img class="${cls || ''}" src="${esc(src)}" loading="lazy" onerror="this.outerHTML='<div class=noimg>∞</div>'"/>`
    : `<div class="noimg">∞</div>`;
}
function qtyBox(value, min, max) {
  return `
    <div class="qtybox">
      <button type="button" data-q="-1">−</button>
      <input type="number" inputmode="numeric" value="${value}" min="${min ?? 0}" ${max != null ? `max="${max}"` : ''}/>
      <button type="button" data-q="1">+</button>
    </div>`;
}
/** wire +/- buttons inside a .qtybox; onChange(newVal, inputEl) */
function bindQtyBox(box, onChange) {
  const input = box.querySelector('input');
  const clamp = v => {
    const min = parseInt(input.min || '0', 10);
    let x = Math.max(min, parseInt(v, 10) || 0);
    if (input.max !== '') x = Math.min(x, parseInt(input.max, 10));
    return x;
  };
  box.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      input.value = clamp((parseInt(input.value, 10) || 0) + parseInt(b.dataset.q, 10));
      onChange(parseInt(input.value, 10), input);
    };
  });
  input.onchange = () => {
    input.value = clamp(input.value);
    onChange(parseInt(input.value, 10), input);
  };
}
function modal(innerHtml) {
  const back = h(`<div class="modal-back"><div class="modal">
    <button class="close" aria-label="Close">×</button>${innerHtml}</div></div>`);
  back.addEventListener('click', e => { if (e.target === back) back.remove(); });
  back.querySelector('.close').onclick = () => back.remove();
  document.body.appendChild(back);
  return back;
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* Fullscreen image gallery (arrows + dots + caption), like the old veyora.com. */
function imageLightbox(images, startIndex, title, colorFor) {
  if (!images || !images.length) return;
  let i = Math.max(0, Math.min(startIndex || 0, images.length - 1));
  const back = h(`<div class="lightbox">
    <button class="lb-close" aria-label="Close">×</button>
    <button class="lb-nav prev" aria-label="Previous">‹</button>
    <div class="lb-stage"><img alt=""/></div>
    <button class="lb-nav next" aria-label="Next">›</button>
    <div class="lb-cap">
      ${title ? `<span class="lb-title">${esc(title)}</span>` : ''}
      <span class="lb-color"></span>
      <div class="lb-dots">${images.map((_, k) => `<span data-k="${k}"></span>`).join('')}</div>
    </div>
  </div>`);
  const img = back.querySelector('img');
  const colorEl = back.querySelector('.lb-color');
  const dots = [...back.querySelectorAll('.lb-dots span')];
  function show(n) {
    i = (n + images.length) % images.length;
    img.src = images[i];
    if (colorFor) colorEl.textContent = colorFor(i) || '';
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
  }
  back.querySelector('.prev').onclick = e => { e.stopPropagation(); show(i - 1); };
  back.querySelector('.next').onclick = e => { e.stopPropagation(); show(i + 1); };
  dots.forEach(d => d.onclick = e => { e.stopPropagation(); show(parseInt(d.dataset.k, 10)); });
  back.querySelector('.lb-close').onclick = () => close();
  back.addEventListener('click', e => { if (e.target === back || e.target.classList.contains('lb-stage')) close(); });
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
  }
  function close() { document.removeEventListener('keydown', onKey); back.remove(); }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  show(i);
}
