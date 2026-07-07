/* ================= Veyora Admin — utilities ================= */
'use strict';

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function money(n){if(n==null||isNaN(n))return '$—';return '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function money0(n){return '$'+Number(n||0).toLocaleString('en-US',{maximumFractionDigits:0});}
function fmtDate(d){if(!d)return '—';const dt=(d instanceof Date)?d:new Date(d);if(isNaN(dt))return '—';return dt.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});}
function fmtDateShort(d){if(!d)return '—';const dt=new Date(d);return dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}
function fmtDateTime(d){if(!d)return '—';const dt=new Date(d);return dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})+' '+dt.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});}
function isoDay(d){const dt=(d instanceof Date)?d:new Date(d);return dt.toISOString().slice(0,10);}
function todayISO(){return isoDay(new Date());}
function uid(p){return (p||'id')+'_'+Math.random().toString(36).slice(2,9);}
function clamp(n,a,b){return Math.max(a,Math.min(b,n));}
function debounce(fn,ms){let t;return function(...a){clearTimeout(t);t=setTimeout(()=>fn.apply(this,a),ms||220);};}

/* ---------- icons (inline SVG, lucide-style) ---------- */
const I = (function(){
  const w=(inner,vb)=>`<svg width="16" height="16" viewBox="${vb||'0 0 24 24'}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return {
    dashboard:w('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
    tasks:w('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12l2 2 4-4"/>'),
    cart:w('<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>'),
    users:w('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    box:w('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05"/><path d="M12 22.08V12"/>'),
    finance:w('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>'),
    ops:w('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    audit:w('<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'),
    logout:w('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'),
    orders:w('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 4v5M16 4v5"/>'),
    scan:w('<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M11 8v8M15 8v5M17 8v8"/>'),
    clock:w('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
    returns:w('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a4 4 0 0 1 0 8h-1"/>'),
    tag:w('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/>'),
    chart:w('<path d="M3 3v18h18"/><path d="M7 13l3-3 4 4 5-6"/>'),
    user:w('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
    lead:w('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>'),
    chain:w('<path d="M6 3v12a3 3 0 1 0 3 3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
    suitcase:w('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
    mailTpl:w('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>'),
    production:w('<path d="M3 21V9l6 4V9l6 4V5h6v16z"/>'),
    inventory:w('<path d="M3 9l9-6 9 6v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M8 21V13h8v8"/>'),
    warehouse:w('<path d="M3 21V9l9-6 9 6v12"/><path d="M7 21v-6h10v6M7 12h10"/>'),
    fileCsv:w('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>'),
    importData:w('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
    payments:w('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M2 10h20"/>'),
    collection:w('<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    invoice:w('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>'),
    statement:w('<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h4"/>'),
    truck:w('<rect x="1" y="5" width="14" height="12" rx="1"/><path d="M15 9h4l3 3v5h-7z"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/>'),
    gift:w('<rect x="3" y="8" width="18" height="4"/><path d="M12 8v13M5 12v9h14v-9"/><path d="M12 8c-2 0-4.5-.5-4.5-3A2.3 2.3 0 0 1 12 4.5 2.3 2.3 0 0 1 16.5 5c0 2.5-2.5 3-4.5 3z"/>'),
    revenue:w('<path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    eye:w('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    pencil:w('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>'),
    trash:w('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
    envelope:w('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>'),
    lock:w('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    plus:w('<path d="M12 5v14M5 12h14"/>'),
    search:w('<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>'),
    download:w('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>'),
    upload:w('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>'),
    refresh:w('<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    transfer:w('<path d="M17 3l4 4-4 4M21 7H9M7 21l-4-4 4-4M3 17h12"/>'),
    camera:w('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>'),
    printer:w('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
    merge:w('<path d="M8 7l4-4 4 4"/><path d="M12 3v8a4 4 0 0 1-4 4H4"/><path d="M12 11a4 4 0 0 0 4 4h4"/>'),
    swap:w('<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    comment:w('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    send:w('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>'),
    check:w('<path d="M20 6L9 17l-5-5"/>'),
    x:w('<path d="M18 6L6 18M6 6l12 12"/>'),
    caret:w('<path d="M9 18l6-6-6-6"/>'),
    caretDown:w('<path d="M6 9l6 6 6-6"/>'),
    flag:w('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>'),
    star:'<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>',
    starO:w('<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>','0 0 24 24').replace('width="16" height="16"','width="14" height="14"'),
    barcode:w('<path d="M4 6v12M8 6v12M11 6v12M14 6v8M17 6v12M20 6v12"/>'),
    calendar:w('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 4v5M16 4v5"/>'),
    money:w('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>'),
    undo:w('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>'),
    pdf:w('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15h1.5a1.5 1.5 0 0 0 0-3H9v6M15 12v6M13 12h4"/>'),
    image:w('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>'),
    external:w('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>'),
  };
})();

/* ---------- product image placeholder (SVG glasses) ---------- */
function glassesSVG(color){
  const c = color || '#57503f';
  return `<svg viewBox="0 0 60 26" width="44" height="22" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="${esc(c)}" stroke-width="2"><rect x="4" y="6" width="20" height="14" rx="6"/><rect x="36" y="6" width="20" height="14" rx="6"/><path d="M24 11 q6 -4 12 0"/><path d="M4 10 L1 8 M56 10 L59 8"/></g></svg>`;
}
const COLOR_HEX = {black:'#26221c',havana:'#6b4a26',crystal:'#b9c0c4',tortoise:'#8a5a2a',gold:'#b98f2f',silver:'#9aa0a6',rose:'#c67f8e',green:'#4f6f52',blue:'#3f5e8c',red:'#a33f34',brown:'#6e4f33',grey:'#7d7f82',champagne:'#cbb287',navy:'#2d3a5c',olive:'#6c6f45'};

/* ---------- status badge ---------- */
function statusBadge(s){
  const map={pending:'yellow',processing:'blue',approved:'gray',completed:'green',cancelled:'red',collected:'blue',collecting:'blue',shipped:'blue',open:'yellow',converted:'green',eligible:'green',active:'green',inactive:'gray',resolved:'green',flagged:'red',done:'green',credit:'green',exchange:'blue',draft:'gray','n/a':'gray',paid:'green'};
  const cls=map[String(s||'').toLowerCase()]||'gray';
  const label=String(s||'N/A');
  return `<span class="badge ${cls}">${esc(label.charAt(0).toUpperCase()+label.slice(1))}</span>`;
}

/* ---------- modal ---------- */
const Modal={
  open(opts){
    const root=document.getElementById('modal-root');
    const ov=document.createElement('div');ov.className='modal-overlay';
    ov.innerHTML=`<div class="modal ${opts.size||''}">
      <div class="modal-head"><div class="modal-title">${esc(opts.title||'')}</div><button class="modal-x">&times;</button></div>
      <div class="modal-body">${opts.body||''}</div>
      ${opts.foot!==false?`<div class="modal-foot">${opts.foot||''}</div>`:''}
    </div>`;
    root.appendChild(ov);
    const close=()=>{ov.remove();if(opts.onClose)opts.onClose();};
    ov.querySelector('.modal-x').onclick=close;
    ov.addEventListener('mousedown',e=>{if(e.target===ov)close();});
    if(opts.setup)opts.setup(ov,close);
    return {el:ov,close};
  },
  confirm(title,message,onYes,yesLabel){
    return Modal.open({title,body:`<div style="font-size:13px;color:var(--ink-2)">${message}</div>`,
      foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-yes>${esc(yesLabel||'Confirm')}</button>`,
      setup(ov,close){ov.querySelector('[data-x]').onclick=close;ov.querySelector('[data-yes]').onclick=()=>{close();onYes&&onYes();};}});
  }
};

/* ---------- toast ---------- */
function toast(msg,err){
  const t=document.createElement('div');t.className='toast'+(err?' err':'');t.textContent=msg;
  document.getElementById('toast-root').appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),320);},2600);
}

/* ---------- pagination helper ---------- */
function paginate(items,page,per){
  per=per||10;
  const total=items.length,pages=Math.max(1,Math.ceil(total/per));
  page=clamp(page,1,pages);
  return {slice:items.slice((page-1)*per,page*per),page,pages,total,per,
    from:total?((page-1)*per+1):0,to:Math.min(page*per,total)};
}
function pagerHTML(p,label){
  let nums=[];
  const push=n=>{if(!nums.includes(n)&&n>=1&&n<=p.pages)nums.push(n);};
  push(1);push(2);push(3);push(4);push(5);push(p.page-1);push(p.page);push(p.page+1);push(p.pages);
  nums.sort((a,b)=>a-b);
  let btns='',prev=0;
  for(const n of nums){
    if(n-prev>1)btns+=`<span class="pg-btn" style="cursor:default">…</span>`;
    btns+=`<button class="pg-btn ${n===p.page?'current':''}" data-pg="${n}">${n}</button>`;prev=n;
  }
  return `<div class="pager">
    <span>Showing ${p.from} to ${p.to} of ${p.total} ${label||'results'}</span>
    <span class="pager-pages">
      <button class="pg-btn" data-pg="${p.page-1}" ${p.page<=1?'disabled':''}>&lsaquo;</button>
      ${btns}
      <button class="pg-btn" data-pg="${p.page+1}" ${p.page>=p.pages?'disabled':''}>&rsaquo;</button>
    </span></div>`;
}
function bindPager(container,cb){
  container.querySelectorAll('[data-pg]').forEach(b=>b.onclick=()=>cb(parseInt(b.dataset.pg,10)));
}

/* ---------- CSV download ---------- */
function downloadCSV(filename,rows){
  const csv=rows.map(r=>r.map(c=>{c=String(c==null?'':c);return /[",\n]/.test(c)?'"'+c.replace(/"/g,'""')+'"':c;}).join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=filename;a.click();
}
function beep(){
  try{
    const ctx=beep._ctx||(beep._ctx=new (window.AudioContext||window.webkitAudioContext)());
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.type='sine';o.frequency.value=880;g.gain.value=.08;
    o.connect(g);g.connect(ctx.destination);o.start();
    setTimeout(()=>{o.stop();},120);
  }catch(e){}
}
