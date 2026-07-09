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
