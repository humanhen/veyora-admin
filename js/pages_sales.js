/* ================= Pages: Sales — Orders, Collection, Quick Scan, Backorders, Returns, Promotions, Reports ================= */
'use strict';

/* ---------- controls this release does not support (Batch 1H) ----------
   Orders and backorders are read from PostgreSQL and written ONLY through
   dedicated authenticated endpoints. Actions that would move stock or re-point
   an order at another account have no such endpoint yet: doing them from
   browser page state is exactly the unsafe path Batch 1C removed for backorder
   conversion — it invents allocations nobody checked and writes them back over
   real rows. Those controls are therefore disabled and say so, rather than
   showing a success toast for a change that never leaves the browser. */
const NOT_IN_RELEASE='Not available in this release';
const NOT_IN_RELEASE_WHY='This action changes stock allocation and has no server '
  +'endpoint yet. It would only change this browser, so it is disabled rather than '
  +'appearing to succeed.';

function offBtn(label,icon){
  return `<button class="btn btn-sm" disabled data-off="${esc(label)}"
    title="${esc(NOT_IN_RELEASE+' — '+NOT_IN_RELEASE_WHY)}">${icon||''} ${esc(label)}</button>`;
}
/* Money is admin-only. The API enforces this with a 403 on both the discount
   patch and invoice generation (FINANCIAL_ROLES in api/src/admin-data.js); this
   mirrors it so a warehouse login is not shown a control it cannot use. The
   browser check is the courtesy, the server check is the control. */
function canChangeMoney(){
  const s=Auth.current();
  return !!s&&s.role==='admin';
}

/** Reports an awaited server write that failed, without pretending it worked. */
function writeFailed(err,fallback){
  toast((err&&err.message)||fallback||'The change was not saved',true);
}

/* ---------- stock helper (returns only) ----------
   Products ARE still part of the browser row-diff sync, so a product-stock
   change made here does reach PostgreSQL through /admin/sync, which records an
   inventory movement for the exact delta. The order-side callers that used to
   share this helper are gone: they moved stock as a side effect of editing an
   order line, which is allocation work and belongs on the server. */
function releaseStock(sku,qty){
  const hit=DB.variationBySku(sku);if(!hit)return;
  const wh=Object.keys(hit.v.stock)[0];
  if(!wh)return;
  hit.v.stock[wh].qty+=qty;
}

/* ============================================================ ORDERS LIST */
App.register('orders',function(el){
  const state=App._orders||(App._orders={status:'All',source:'All Sources',country:'',from:'',to:'',sort:'Newest first',q:'',page:1});

  function render(){
    /* Live data or an honest error — never a local dataset. */
    if(!requireLiveData(el,render,'Orders could not be loaded'))return;
    const d=DB.d;
    let list=d.orders.slice();
    const counts={All:list.length};
    ['pending','processing','completed','cancelled'].forEach(s=>counts[s]=list.filter(o=>o.status===s).length);
    if(state.status!=='All')list=list.filter(o=>o.status===state.status.toLowerCase());
    if(state.source==='From Customers')list=list.filter(o=>o.source==='customer');
    if(state.source==='From Agents')list=list.filter(o=>o.source==='agent');
    if(state.country)list=list.filter(o=>{
      const c=DB.user(o.customerId);
      return (o.customerCountry||(c&&c.country))===state.country;});
    if(state.from)list=list.filter(o=>o.date>=state.from);
    if(state.to)list=list.filter(o=>o.date<=state.to);
    if(state.q){
      const q=state.q.toLowerCase();
      list=list.filter(o=>{
        const c=DB.user(o.customerId)||{};
        const name=DB.orderCustomerName(o),email=o.customerEmail||c.email||'';
        return o.number.toLowerCase().includes(q)||name.toLowerCase().includes(q)
          ||(c.business||'').toLowerCase().includes(q)||email.toLowerCase().includes(q);
      });
    }
    /* Order NUMBERS are not chronological — legacy "VEYORA000629" (2025)
       string-sorts above "SO11889" (2026), which put ancient orders at the top
       of "Newest first". compareOrdersByTime uses createdAt, then date, and
       only falls back to the number to keep equal timestamps stable. */
    list.sort((a,b)=>compareOrdersByTime(a,b,state.sort==='Newest first'));
    const p=paginate(list,state.page);

    el.innerHTML=`
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="flex" style="justify-content:space-between">
        <div class="flex-col" style="gap:8px">
          <div class="chip-row">
            <button class="chip ${state.status==='All'?'active':''}" data-st="All">All (${counts.All})</button>
            <button class="chip ${state.status==='Pending'?'active':''}" data-st="Pending">Pending</button>
            <button class="chip ${state.status==='Processing'?'active':''}" data-st="Processing">Processing</button>
            <button class="chip ${state.status==='Completed'?'active':''}" data-st="Completed">Completed</button>
            <button class="chip ${state.status==='Cancelled'?'active':''}" data-st="Cancelled">Cancelled</button>
          </div>
          <div class="chip-row">
            ${['All Sources','From Customers','From Agents'].map(s=>`<button class="chip accent-outline ${state.source===s?'active':''}" data-src="${s}">${s}</button>`).join('')}
          </div>
        </div>
        <div class="flex-col" style="gap:8px;align-items:flex-end">
          <div class="flex">
            <select class="select" id="f-country"><option value="">Country</option><option ${state.country==='US'?'selected':''}>US</option><option ${state.country==='CA'?'selected':''}>CA</option></select>
            <div class="search-wrap">${I.search}<input class="input" id="f-q" placeholder="Search order number, customer or email…" value="${esc(state.q)}"></div>
          </div>
          <div class="flex">
            <div class="fieldset-outline"><label>From</label><input type="date" id="f-from" value="${state.from}"></div>
            <div class="fieldset-outline"><label>To</label><input type="date" id="f-to" value="${state.to}"></div>
            <div class="fieldset-outline"><label>Sort</label><select id="f-sort"><option ${state.sort==='Newest first'?'selected':''}>Newest first</option><option ${state.sort==='Oldest first'?'selected':''}>Oldest first</option></select></div>
          </div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Order</th><th>Customer</th><th>Agent</th><th>Date</th><th>Status</th><th>Total</th><th>Source</th><th>Action</th></tr></thead>
        <tbody>
        ${p.slice.length?p.slice.map(o=>{
          return `<tr>
            <td class="cell-main">${esc(o.number)}</td>
            <td>${esc(DB.orderCustomerName(o))}</td>
            <td>${o.agentId?esc(DB.orderAgentName(o)):'—'}</td>
            <td>${fmtDate(o.date)}</td>
            <td>${statusBadge(o.status)}</td>
            <td>${orderMoney(o.total,o)}</td>
            <td><span class="badge outline">${o.source==='agent'?'Agent':'Customer'}</span></td>
            <td><button class="icon-btn" data-view="${o.id}" title="Open order">${I.eye}</button></td>
          </tr>`;}).join(''):`<tr><td colspan="8" class="empty-cell">No orders found</td></tr>`}
        </tbody></table></div>
      ${liveCountNote(DB.liveMeta&&DB.liveMeta.orders)}
      ${pagerHTML(p)}
    </div>`;

    el.querySelectorAll('[data-st]').forEach(b=>b.onclick=()=>{state.status=b.dataset.st;state.page=1;render();});
    el.querySelectorAll('[data-src]').forEach(b=>b.onclick=()=>{state.source=b.dataset.src;state.page=1;render();});
    el.querySelector('#f-country').onchange=e=>{state.country=e.target.value;state.page=1;render();};
    el.querySelector('#f-from').onchange=e=>{state.from=e.target.value;state.page=1;render();};
    el.querySelector('#f-to').onchange=e=>{state.to=e.target.value;state.page=1;render();};
    el.querySelector('#f-sort').onchange=e=>{state.sort=e.target.value;render();};
    const q=el.querySelector('#f-q');
    q.oninput=debounce(()=>{state.q=q.value;state.page=1;render();const nq=el.querySelector('#f-q');nq.focus();nq.setSelectionRange(nq.value.length,nq.value.length);});
    el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{location.hash='#/order/'+b.dataset.view;});
    bindPager(el,pg=>{state.page=pg;render();});
  }
  render();
});

/* ============================================================ ORDER COLLECTION (order screen) */
App.register('order',function(el,args){
  if(!requireLiveData(el,()=>App.route(),'This order could not be loaded'))return;
  let o=DB.order(args[0]);
  if(!o){el.innerHTML='<div class="card card-pad">Order not found. <a class="link" href="#/orders">Back to orders</a></div>';return;}
  const local=App._order||(App._order={});
  if(local.id!==o.id){local.id=o.id;local.scanning=false;local.pending={};}
  if(!local.pending)local.pending={};

  /* Scans are buffered in page state and flushed to the server when the
     collection is completed, so the count on screen is "scanned so far", not a
     saved figure. The screen says which it is. */
  function scanned(it){return Math.min(it.qty,(it.collected||0)+(local.pending[it.sku]||0));}
  function hasUnsavedScans(){return Object.values(local.pending).some(n=>n>0);}

  /* Every write on this screen is an AWAITED server call. The panel used to
     mutate the order in browser state and toast success immediately; with
     orders no longer part of the row-diff sync that would change nothing at
     all. `run` performs the call, adopts the order the server returns, and
     only then reports success. */
  /* An in-flight FLAG, not just `disabled` (Final Handover Phase 7).
     `btn.disabled` alone was bypassed by a handler called directly and by a
     re-render replacing the button between two clicks. Most order patches are
     ABSOLUTE writes and so replay harmlessly — but `comment` appends
     (`comments = coalesce(comments,'[]') || $n::jsonb`), so a duplicated
     request added the same comment twice. */
  let runBusy=false;
  async function run(btn,patch,okMsg,failMsg){
    if(runBusy)return false;
    runBusy=true;
    if(btn)btn.disabled=true;
    try{
      const res=await DB.patchOrder(o.id,patch);
      o=(res&&res.order)||DB.order(o.id)||o;
      render();
      if(okMsg)toast(okMsg);
      return true;
    }catch(err){
      if(btn)btn.disabled=false;
      writeFailed(err,failMsg);
      return false;
    }finally{
      runBusy=false;
    }
  }
  /* NO client-side audit on this screen. Every mutation below goes through
     PATCH /admin/orders/:id or POST /admin/orders/:id/invoice, and each of
     those writes an authoritative audit entry after it commits. A second entry
     posted from the browser — through the row-diff sync, which is debounced and
     unordered — would duplicate every action in the log and could arrive even
     when the server write had failed. */

  function render(){
    const cust=DB.user(o.customerId)||{};
    const custName=DB.orderCustomerName(o);
    const custEmail=o.customerEmail||cust.email||'';
    const agent=o.agentId?DB.user(o.agentId):null;
    const canEdit=!['shipped'].includes(o.status);
    const inv=o.invoiceId?DB.d.invoices.find(i=>i.id===o.invoiceId):null;
    const shipped=o.status==='shipped';

    el.innerHTML=`
    <div class="flex" style="margin-bottom:16px">
      <a class="back-btn" href="#/orders" title="Back">&larr;</a>
      <div class="page-title" style="font-size:16px">Order Collection</div>
      <button class="btn btn-sm" id="btn-print" title="Open the browser print view for this order">${I.printer} Print order</button>
      <div class="right flex">
        ${/* Merge and Change customer rewrite order lines and ownership. Both
             move reserved stock between orders and neither has a server
             endpoint yet, so they are disabled rather than faked. */''}
        ${canEdit?`
        ${offBtn('Merge orders',I.merge)}
        ${offBtn('Change customer',I.user)}
        <button class="btn btn-sm" id="btn-labels">${I.printer} Print labels</button>`:''}
      </div>
    </div>

    <div class="order-cards">
      <div class="card card-pad"><div class="stat-label">ORDER NUMBER</div><div style="font-weight:600;margin-top:6px">${esc(o.number)}</div></div>
      <div class="card card-pad"><div class="stat-label">ORDER DATE</div><div style="font-weight:600;margin-top:6px">${fmtDateShort(o.date)}</div></div>
      <div class="card card-pad"><div class="stat-label">STATUS</div><div style="margin-top:6px">${statusBadge(o.status)}</div></div>
      <div class="card card-pad"><div class="stat-label">TOTAL AMOUNT (${esc(orderCurrencyCode(o))})</div><div class="money-green" style="font-size:16px;margin-top:6px">${orderMoney(DB.orderTotal(o),o)}</div></div>
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <div class="spread">
        <div class="flex">${I.invoice}<b style="font-size:13px">Invoice</b>
          ${inv?`<span class="badge green">Invoice #${inv.number}</span>`:''}</div>
        ${inv?`<button class="btn btn-sm" id="btn-inv-dl">${I.download} Download Invoice</button>`
             :canChangeMoney()?`<button class="btn btn-dark btn-sm" id="btn-gen-inv">${I.invoice} Generate Invoice</button>`
             :`<span class="small muted">Invoicing is an admin action.</span>`}
      </div>
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <div class="card-title">Customer Information</div>
      <div class="grid g2">
        <div><div class="stat-label">CUSTOMER</div><div style="margin-top:5px;font-weight:500">${esc(custName)}</div></div>
        <div><div class="stat-label">EMAIL</div><div style="margin-top:5px">${esc(custEmail||'—')}</div></div>
        ${o.agentId?`<div><div class="stat-label">AGENT</div><div style="margin-top:5px">${esc(DB.orderAgentName(o))}</div></div>
        <div><div class="stat-label">AGENT EMAIL</div><div style="margin-top:5px">${esc(o.agentEmail||(agent&&agent.email)||'—')}</div></div>`:''}
      </div>
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <div class="card-title">Warehouse Collection</div>
      ${!local.scanning?`
        <div class="scan-hero">
          ${I.barcode.replace('width="16" height="16"','width="44" height="44"')}
          <div class="scan-title">Ready to Collect Order</div>
          <div class="muted small">Click the button below to start scanning items</div>
          <button class="btn ${o.status==='pending'?'btn-dark':''}" id="btn-start-scan" ${o.status!=='pending'?'disabled':''}>${I.scan} Start Scanning</button>
          ${o.status!=='pending'?'<div class="scan-warn">Order status must be "pending" to start scanning</div>':''}
        </div>`:`
        <div class="scan-input-row">
          <input class="input" id="scan-input" placeholder="Scan barcode or type SKU, then press Enter" autofocus>
          <button class="btn" id="btn-camera" title="Scan with camera">${I.camera}</button>
          <button class="btn btn-dark" id="btn-complete">${I.check} Complete Order Collection</button>
          <button class="btn" id="btn-cancel-scan">Cancel</button>
        </div>
        <div class="table-wrap" style="margin-top:14px"><table class="tbl">
          <thead><tr><th></th><th>Product</th><th>SKU</th><th>Progress</th><th style="width:130px"></th></tr></thead>
          <tbody>
          ${o.items.map((it,ix)=>{
            const n=scanned(it),done=n>=it.qty;
            return `<tr>
              <td><button class="count-circle" data-count="${ix}" title="Count manually (+1)">${done?'✓':'+'}</button></td>
              <td><div class="cell-main">${esc(it.name)} &times; ${it.qty}</div><div class="cell-sub">${
                it.brand?esc(it.brand)+' | ':''}${it.modelSku?'Model: '+esc(it.modelSku)+' | ':''}Color: ${esc(it.color||'N/A')} | SKU: ${esc(it.sku)}</div></td>
              <td>${esc(it.sku)}</td>
              <td><div class="progress ${done?'full':''}"><span style="width:${Math.min(100,n/it.qty*100)}%"></span></div></td>
              <td><b>${n} / ${it.qty}</b> ${done?'<span class="badge green">Done</span>':''}</td>
            </tr>`;}).join('')}
          </tbody></table></div>
        ${/* Scans are not saved until the collection is completed. Saying so
             beats a count that looks persisted and is not. */''}
        ${hasUnsavedScans()?`<div class="small muted" style="margin-top:10px">
          Scanned counts are not saved yet — press <b>Complete Order Collection</b> to
          record them.</div>`:''}`}
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <div class="spread"><div class="card-title" style="margin:0">Order Items Summary</div>
        ${canEdit?`<div class="flex">
          ${/* Adding a line reserves stock; there is no endpoint for that yet. */''}
          ${offBtn('Add item',I.plus)}
          ${canChangeMoney()?`<button class="btn btn-sm" id="btn-discount">${I.tag} Admin discount</button>`:''}
        </div>`:''}</div>
      <div class="table-wrap" style="margin-top:12px"><table class="tbl">
        <thead><tr><th>Product</th><th class="num">Total (${esc(orderCurrencyCode(o))})</th><th style="width:90px"></th></tr></thead>
        <tbody>
          ${o.items.map((it,ix)=>`<tr>
            <td><div class="cell-main">${esc(it.name)} &times; ${it.qty}</div><div class="cell-sub">Color: ${esc(it.color||'N/A')} | SKU: ${esc(it.sku)}</div></td>
            <td class="num">${orderMoney(it.qty*it.price,o)}</td>
            ${/* Editing, swapping or deleting a line releases and reserves
                 stock. No endpoint, so no control — not a control that lies. */''}
            <td><div class="row-actions">
              ${canEdit?`<button class="icon-btn" disabled data-off="Edit item"
                title="${esc(NOT_IN_RELEASE+' — '+NOT_IN_RELEASE_WHY)}">${I.pencil}</button>
              <button class="icon-btn" disabled data-off="Delete item"
                title="${esc(NOT_IN_RELEASE+' — '+NOT_IN_RELEASE_WHY)}">${I.trash}</button>`:''}
            </div></td>
          </tr>`).join('')}
          ${o.discount||o.discountPct?`<tr><td class="cell-sub">Admin discount ${o.discountPct?o.discountPct+'%':''}</td><td class="num" style="color:var(--red)">−${orderMoney(o.discountPct?(o.items.reduce((s,i)=>s+i.qty*i.price,0)*o.discountPct/100):o.discount,o)}</td><td></td></tr>`:''}
          <tr><td style="font-weight:600">Total</td><td class="num" style="font-weight:600">${orderMoney(DB.orderTotal(o),o)}</td><td></td></tr>
        </tbody></table></div>
    </div>

    <div class="two-col" style="margin-top:14px">
      <div class="card card-pad">
        <div class="card-title">Select Status</div>
        <div class="flex">
          <select class="select" id="sel-status" style="flex:1">
            ${['pending','processing','approved','collecting','collected','completed','cancelled'].map(s=>`<option ${o.status===s?'selected':''}>${s}</option>`).join('')}
          </select>
          <button class="btn btn-dark" id="btn-set-status">Update</button>
        </div>
      </div>
      <div class="card card-pad">
        <div class="card-title">Shipment tracking ${shipped&&o.tracking?`<span class="badge green">Shipped &middot; ${esc(o.tracking.company)} ${esc(o.tracking.number)}</span>`:''}</div>
        <div class="flex">
          <select class="select" id="ship-co"><option>UPS</option><option>DHL</option><option>GLS</option></select>
          <input class="input" id="ship-track" placeholder="Tracking number" style="flex:1" value="${o.tracking?esc(o.tracking.number):''}">
          <button class="btn btn-dark" id="btn-ship" ${shipped?'disabled':''}>Save &amp; Mark as Shipped</button>
        </div>
      </div>
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <div class="card-title">Comments <span class="muted small">internal — admins &amp; agents</span></div>
      <div class="flex-col">
        ${o.comments.length?o.comments.map(c=>`<div class="msg" style="max-width:100%">${esc(c.text)}<div class="msg-meta">${esc(c.by)} &middot; ${fmtDateTime(c.at)}</div></div>`).join(''):'<div class="muted small">No comments yet.</div>'}
      </div>
      <div class="flex" style="margin-top:12px">
        <input class="input" id="comment-input" placeholder="Write an internal comment…" style="flex:1">
        <button class="btn btn-dark" id="btn-comment">${I.comment} Post</button>
      </div>
    </div>`;

    /* ------- top actions ------- */
    /* Browser print view of the order — this opens the print dialog; it does
       NOT generate a PDF file (saving as PDF is the browser's own option).
       Every line carries the full frame identity the warehouse and the customer
       need: brand, model number, colour and variation SKU as separate columns.
       modelSku comes from the API (the product's own sku) — never from
       splitting the variation sku, which is wrong for dash colorways. */
    el.querySelector('#btn-print').onclick=()=>{
      const w=window.open('','_blank');
      /* Money on this document is the ORDER's own money: amounts are stored in
         base USD and converted with the rate stamped on the order when it was
         placed. Hardcoding "$" showed a CAD customer an unconverted USD figure
         labelled as their currency. */
      const cur=(o.currency||'USD').toUpperCase();
      const rate=Number(o.fxRate)||1;
      const SYM={USD:'$',CAD:'CA$',EUR:'€'};
      const pm=base=>(SYM[cur]||'$')+((Number(base)||0)*rate).toFixed(2);
      const rows=o.items.map(it=>`<tr>
        <td>${esc(it.brand||'—')}</td>
        <td><b>${esc(it.modelSku||'—')}</b></td>
        <td>${esc(it.name||'')}</td>
        <td>${esc(it.color||'—')}</td>
        <td>${esc(it.sku)}</td>
        <td class="n">${it.qty}</td>
        <td class="n">${pm(it.qty*it.price)}</td></tr>`).join('');
      w.document.write(`<html><head><title>${o.number}</title><style>body{font-family:sans-serif;padding:40px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:7px;text-align:left;font-size:12px}th{background:#f4f2ef}.n{text-align:right}h1{letter-spacing:4px}.bc{font-family:monospace;font-size:30px;letter-spacing:2px;border:2px solid #000;display:inline-block;padding:8px 18px;margin:10px 0}</style></head>
      <body><h1>VEYORA</h1><h2>Order ${o.number}</h2><div class="bc">*${o.number}*</div>
      <p><b>Customer:</b> ${esc(custName)} &lt;${esc(custEmail)}&gt;<br><b>Date:</b> ${fmtDate(o.date)} &middot; <b>Status:</b> ${esc(o.status)} &middot; <b>Currency:</b> ${esc(cur)}${cur!=='USD'?` (rate ${esc(String(rate))} from USD)`:''}</p>
      <table><tr><th>Brand</th><th>Model</th><th>Product</th><th>Colour</th><th>Variation SKU</th><th class="n">Qty</th><th class="n">Total</th></tr>${rows}
      <tr><td colspan="6"><b>Total (${esc(cur)})</b></td><td class="n"><b>${pm(DB.orderTotal(o))}</b></td></tr></table>
      ${o.comments&&o.comments.length?`<p><b>Notes</b><br>${o.comments.map(c=>esc(c.text)).join('<br>')}</p>`:''}
      <script>print()<\/script></body></html>`);
      w.document.close();
    };

    /* Invoicing is a SERVER transaction: it takes the next number from the
       database sequence, writes the invoice row, links it to the order and
       moves the customer balance. The browser used to do all of that in page
       state with its own counter, which produced numbers no database had
       issued. Idempotent — a second press returns the invoice already on file. */
    const gen=el.querySelector('#btn-gen-inv');
    if(gen)gen.onclick=async()=>{
      gen.disabled=true;
      try{
        const res=await DB.generateInvoice(o.id);
        o=DB.order(o.id)||o;
        render();
        toast(res.alreadyInvoiced
          ? 'Invoice '+res.invoice.number+' already exists for this order'
          : 'Invoice '+res.invoice.number+' recorded');
      }catch(err){
        gen.disabled=false;
        writeFailed(err,'Invoice was not generated');
      }
    };
    const invdl=el.querySelector('#btn-inv-dl');
    /* No document generator exists yet: the invoice is a record, not a file.
       Say so rather than claiming a download that never happened. */
    if(invdl)invdl.onclick=()=>toast('Invoice #'+inv.number+' is recorded. No invoice document is generated yet — use Print order for a printable copy.');

    /* Merge orders and Change customer used to rebuild order lines and
       ownership in page state. Both move reserved stock between orders, both
       claimed to email the customer, and neither reached the database. They
       are disabled above; a disabled control needs no handler, and there is
       deliberately none here so the behaviour cannot quietly come back. */

    const lbl=el.querySelector('#btn-labels');
    if(lbl)lbl.onclick=()=>{
      Modal.open({title:'Print labels',
        body:`<div class="small">Print item labels for ${esc(o.number)} (${o.items.reduce((s,i)=>s+i.qty,0)} labels).</div>
        <label class="checkbox-row"><input type="checkbox" id="pl-nii"> Use Bluetooth NiiMbot printer</label>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-print>${I.printer} Print</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-print]').onclick=()=>{
            if(ov.querySelector('#pl-nii').checked){close();toast('Sent to NiiMbot printer');return;}
            const w=window.open('','_blank');
            w.document.write('<html><body style="font-family:monospace">'+o.items.map(it=>`<div style="border:1px dashed #000;padding:10px;margin:6px;display:inline-block">${esc(it.sku)}<br>${esc(it.name)}<br>*${esc(it.sku)}*</div>`).join('')+'<script>print()<\/script></body></html>');
            w.document.close();close();
          };
        }});
    };

    /* ------- scanning -------
       Collection counts move NO stock — they record how much of an already
       reserved line the warehouse has physically picked — so they are safe to
       write, and the server clamps each count to the ordered quantity. */
    const st=el.querySelector('#btn-start-scan');
    if(st)st.onclick=async()=>{
      if(o.status!=='pending')return;
      if(await run(st,{status:'collecting'},null,'Could not start collection')){
        local.scanning=true;
        render();
        setTimeout(()=>{const s=el.querySelector('#scan-input');if(s)s.focus();},50);
      }
    };
    const cs=el.querySelector('#btn-cancel-scan');
    if(cs)cs.onclick=async()=>{
      if(await run(cs,{status:'pending'},null,'Could not cancel collection')){
        local.scanning=false;
        render();
      }
    };

    const pending=local.pending;
    const si=el.querySelector('#scan-input');
    if(si)si.addEventListener('keydown',e=>{
      if(e.key!=='Enter')return;
      const code=si.value.trim();si.value='';
      if(!code)return;
      const it=o.items.find(x=>x.sku.toLowerCase()===code.toLowerCase());
      if(!it){toast('SKU '+code+' is not on this order',true);return;}
      if(scanned(it)>=it.qty){toast(it.sku+' already fully collected',true);return;}
      pending[it.sku]=(pending[it.sku]||0)+1;beep();render();
      setTimeout(()=>{const s2=el.querySelector('#scan-input');if(s2)s2.focus();},30);
    });
    const cam=el.querySelector('#btn-camera');
    if(cam)cam.onclick=()=>toast('Camera scanning: point your device camera at the barcode');
    el.querySelectorAll('[data-count]').forEach(b=>b.onclick=()=>{
      const it=o.items[parseInt(b.dataset.count,10)];
      if(scanned(it)<it.qty){pending[it.sku]=(pending[it.sku]||0)+1;render();}
    });

    const comp=el.querySelector('#btn-complete');
    if(comp)comp.onclick=()=>{
      const missing=o.items.filter(i=>scanned(i)<i.qty);
      if(!missing.length){finishCollection();return;}
      Modal.open({title:'Missing items',size:'wide',
        body:`<div class="small">Some items weren't scanned (out of stock / not found):</div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Product</th><th>SKU</th><th>Ordered</th><th>Collected</th><th>Missing</th></tr></thead>
        <tbody>${missing.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.sku)}</td><td>${i.qty}</td><td>${scanned(i)}</td><td style="color:var(--red);font-weight:600">${i.qty-scanned(i)}</td></tr>`).join('')}</tbody></table></div>
        ${/* The old dialog offered "Complete + send missing to Backorders",
             which built a backorder in page state with its own BO number and
             silently rewrote the order's quantities. Nothing reached the
             database and no stock was released. */''}
        <div class="small muted" style="margin-top:10px">Raising a backorder for the
        missing pieces is <b>${esc(NOT_IN_RELEASE.toLowerCase())}</b> — it changes stock
        allocation and has no server endpoint yet. Complete the order and record the
        shortfall in the comments.</div>`,
        foot:`<button class="btn" data-x>Cancel</button>
              <button class="btn btn-dark" data-anyway>Complete anyway</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-anyway]').onclick=()=>{close();finishCollection();};
        }});
    };

    async function finishCollection(){
      const collected=o.items.map(i=>({sku:i.sku,collected:scanned(i)}));
      if(await run(comp,{status:'collected',collected},'Collection completed',
                   'Collection was not saved')){
        local.pending={};local.scanning=false;
        render();
      }
    }

    /* ------- item editing -------
       Add / edit / swap / delete all released and reserved stock straight in
       page state via the old releaseStock()/reserveStock() helpers, which took
       whatever the browser happened to believe was on the shelf. Those helpers
       and their controls are gone; the buttons above are disabled and explain
       why. Restoring them needs a server allocation endpoint, not a handler. */

    const disc=el.querySelector('#btn-discount');
    if(disc)disc.onclick=()=>{
      if(!canChangeMoney())return toast('Only an admin can change an order discount.',true);
      Modal.open({title:'Admin discount',
        body:`<div class="two-col">
          <div class="field"><label>Type</label><select class="select" id="ad-type"><option value="pct">Percentage (%)</option><option value="fix">Fixed amount (USD)</option></select></div>
          <div class="field"><label>Value</label><input class="input" id="ad-val" type="number" min="0" value="${o.discountPct||o.discount||0}"></div>
        </div>
        <div class="small muted">Applied on top of any existing promotion. Admin only.
        The order total is recalculated on the server.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Apply</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          const ok=ov.querySelector('[data-ok]');
          ok.onclick=async()=>{
            const v=parseFloat(ov.querySelector('#ad-val').value)||0;
            const patch=ov.querySelector('#ad-type').value==='pct'
              ? {discountPct:v} : {discount:v};
            ok.disabled=true;
            try{
              const res=await DB.patchOrder(o.id,patch);
              o=(res&&res.order)||DB.order(o.id)||o;
              close();render();toast('Discount applied');
            }catch(err){ok.disabled=false;writeFailed(err,'Discount was not applied');}
          };
        }});
    };

    /* ------- status & shipping ------- */
    const stBtn=el.querySelector('#btn-set-status');
    stBtn.onclick=async()=>{
      const ns=el.querySelector('#sel-status').value;
      const old=o.status;
      if(ns===old)return toast('Order is already '+ns);
      await run(stBtn,{status:ns},'Status updated to '+ns,'Status was not updated');
    };
    const shipBtn=el.querySelector('#btn-ship');
    shipBtn.onclick=async()=>{
      const num=el.querySelector('#ship-track').value.trim();
      if(!num)return toast('Enter a tracking number',true);
      const company=el.querySelector('#ship-co').value;
      await run(shipBtn,{tracking:{company,number:num},status:'shipped'},
               'Order marked as shipped','Order was not marked as shipped');
    };

    /* ------- comments ------- */
    const cmt=el.querySelector('#btn-comment');
    cmt.onclick=async()=>{
      const inp=el.querySelector('#comment-input');
      const txt=inp.value.trim();if(!txt)return;
      await run(cmt,{comment:txt},'Comment posted','Comment was not posted');
    };

    /* A disabled control that is somehow reached still says what it is. */
    el.querySelectorAll('[data-off]').forEach(b=>{
      b.onclick=()=>toast(b.dataset.off+': '+NOT_IN_RELEASE,true);
    });
  }
  render();
});

/* ============================================================ QUICK SCAN EDIT */
/* Quick Scan EDIT added and removed order lines and moved stock straight in
   browser state — the same unsafe path as the order screen's item controls,
   and with orders no longer syncing from the browser it would now change
   nothing at all. The scanner is therefore READ-ONLY in this release: it looks
   an order up from the database and shows exactly what is on it. */
App.register('quick-scan',function(el){
  const state=App._qs||(App._qs={order:null});

  function render(){
    if(!requireLiveData(el,render,'Orders could not be loaded'))return;
    const o=state.order?DB.order(state.order):null;
    el.innerHTML=`
    <div class="flex" style="margin-bottom:14px">${I.scan}<div class="page-title" style="font-size:16px">Quick Order Lookup</div></div>
    <div class="note-banner">${I.eye}<div>Scan or type an order number to see what is on it.
      Editing order lines by scanner is <b>${esc(NOT_IN_RELEASE.toLowerCase())}</b> — it changes
      stock allocation and has no server endpoint yet.</div></div>
    <div class="card card-pad" style="margin-top:14px">
      <div class="flex">
        <input class="input" id="qs-order" placeholder="Order number" style="flex:1" value="${o?esc(o.number):''}" autofocus>
        <button class="btn btn-dark" id="qs-load">Load order</button>
      </div>
    </div>
    ${o?`
    <div class="card card-pad" style="margin-top:14px">
      <div class="flex" style="justify-content:space-between">
        <div><b>${esc(o.number)}</b> &middot; ${esc(DB.orderCustomerName(o))}</div>
        ${statusBadge(o.status)}
        <div class="money-green">${orderMoney(DB.orderTotal(o),o)}</div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table class="tbl">
        <thead><tr><th>Product</th><th>SKU</th><th class="num">Qty</th><th class="num">Collected</th><th class="num">Line total (${esc(orderCurrencyCode(o))})</th></tr></thead>
        <tbody>${o.items.map(it=>`<tr>
          <td><div class="cell-main">${esc(it.name)}</div><div class="cell-sub">${
            it.brand?esc(it.brand)+' | ':''}Color: ${esc(it.color||'N/A')}</div></td>
          <td>${esc(it.sku)}</td><td class="num">${it.qty}</td>
          <td class="num">${it.collected||0}</td>
          <td class="num">${orderMoney(it.qty*it.price,o)}</td></tr>`).join('')}
        </tbody></table></div>
      <div class="small muted" style="margin-top:10px">To record a collection, open
        <a class="link" href="#/order/${esc(o.id)}">${esc(o.number)}</a> and use Warehouse Collection.</div>
    </div>`:''}`;

    el.querySelector('#qs-load').onclick=()=>{
      const n=el.querySelector('#qs-order').value.trim();
      const ord=DB.order(n)||DB.order('SO'+n);
      if(!ord)return toast('Order not found',true);
      state.order=ord.id;render();
    };
    el.querySelector('#qs-order').addEventListener('keydown',e=>{if(e.key==='Enter')el.querySelector('#qs-load').click();});
  }
  render();
});

/* ============================================================ BACKORDERS */
/* A backorder still awaiting staff action. 'open' is what the storefront and
   the collection screen create; 'approved' only exists on legacy rows written
   by the old customer-approve flow, and must remain processable. */
function OPEN_BO(b){return b.status==='open'||b.status==='approved';}
/* Terminal: nothing further will happen to it, so "stock cleared" is not a
   pending task — it is simply not applicable. Mirrors the server's
   isTerminalBackorderStatus()/canDeleteBackorder() rule. */
function TERMINAL_BO(b){return !!b&&(b.status==='converted'||b.status==='cancelled'||!!b.convertedOrderId);}

App.register('backorders',function(el){
  const state=App._bo||(App._bo={status:'',page:1});

  function render(){
    if(!requireLiveData(el,render,'Backorders could not be loaded'))return;
    let list=DB.d.backorders.slice();
    if(state.status)list=list.filter(b=>b.status===state.status);
    const p=paginate(list,state.page);
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Backorders</div>
      <select class="select" id="bo-status">
        <option value="">Status</option>
        ${/* 'approved' is legacy: the storefront no longer creates it, but any
             row already in that state must stay visible and actionable. */
          ['open','approved','converted','cancelled'].map(s=>`<option ${state.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        ${/* The four longest headings wrap onto a second line and the actions
             column shrinks to fit. Ten nowrap headings plus a one-line action
             row made the table wider than its card, which cut off Convert and
             the details control at 1366px. */''}
        <thead><tr><th class="wrap">Backorder #</th><th class="wrap">Original Order</th><th>Customer</th><th>Status</th><th>Reason</th><th class="wrap">Customer authorised</th><th class="wrap">Stock cleared</th><th>Items</th><th>Created</th><th class="col-actions">Actions</th></tr></thead>
        <tbody>
        ${p.slice.length?p.slice.map(b=>`<tr>
          <td class="cell-main">${esc(b.number)}</td>
          <td>${esc(b.orderNumber||'—')}</td>
          <td>${esc(b.customerName||DB.userName(b.customerId))}</td>
          <td>${statusBadge(b.status)}</td>
          <td><span class="badge ${b.reason==='out_of_stock'?'yellow':'gray'}">${esc(b.reason)}</span></td>
          ${/* Two DIFFERENT facts, deliberately in two columns:
                "Customer" = the customer authorised this by ordering an
                             unavailable quantity;
                "Stock cleared" = staff have acknowledged it for conversion.
                They were previously conflated, which made a backorder look
                convertible the instant it was created. */''}
          <td>${b.customerAuthorised?'<span class="badge green">Authorised</span>':'<span class="badge gray">—</span>'}</td>
          ${/* Presentation only — the stored eligibility value is untouched.
               "Not yet" on a cancelled or converted record reads as work still
               to do; for a terminal record it simply does not apply. */''}
          <td>${TERMINAL_BO(b)?'<span class="muted">—</span>'
            :b.eligible?'<span class="badge green">Cleared</span>':'<span class="badge gray">Not yet</span>'}</td>
          <td>${b.items.reduce((s,i)=>s+i.qty,0)}<br/><span class="cell-sub">${
            moneyIn(b.items.reduce((s,i)=>s+i.qty*i.price,0),b)}</span></td>
          <td>${fmtDateShort(b.createdAt)}</td>
          <td class="col-actions"><div class="row-actions">
            ${/* Convert is always offered on a processable record: the SERVER
                 decides on real, locked stock and refuses with exact shortages
                 if any line is short. 'approved' is accepted alongside 'open'
                 so legacy rows from the old customer-approve flow still work. */''}
            ${OPEN_BO(b)&&!b.eligible?`<button class="btn btn-sm" data-el="${b.id}">Mark stock cleared</button>`:''}
            ${OPEN_BO(b)?`<button class="btn btn-sm btn-dark" data-cv="${b.id}">Convert</button>`:''}
            <button class="icon-btn" data-view="${b.id}" title="Details">${I.eye}</button>
          </div></td>
        </tr>`).join(''):`<tr><td colspan="10" class="empty-cell">No backorders found</td></tr>`}
        </tbody></table></div>
      ${liveCountNote(DB.liveMeta&&DB.liveMeta.backorders)}
      ${pagerHTML(p)}
    </div>`;

    el.querySelector('#bo-status').onchange=e=>{state.status=e.target.value;state.page=1;render();};
    bindPager(el,pg=>{state.page=pg;render();});
    /* Stock eligibility goes through a DEDICATED server endpoint, not the
       generic browser-state row sync. The sync is debounced and carries a whole
       snapshot, so it could otherwise write a stale `open`/`eligible` over a
       backorder the conversion endpoint had just marked converted. */
    el.querySelectorAll('[data-el]').forEach(b=>b.onclick=async()=>{
      const bo=DB.backorder(b.dataset.el);
      b.disabled=true;
      try{
        await DB.setBackorderEligibility(bo.id,true);
        await DB.refreshLive();                // re-pull; the server is the truth
        render();toast(bo.number+' marked stock-cleared');
      }catch(err){
        b.disabled=false;toast(err.message||'Could not update eligibility',true);
      }
    });
    /* Conversion is SERVER-AUTHORITATIVE. The browser no longer builds the
       order or touches stock: it asks the API, which locks the backorder and
       the stock rows, requires full coverage for every line, reserves exactly
       what is needed, rebuilds the order from the backorder's own preserved
       context (customer, agent, source, currency, rate, addresses, promotion,
       notes, locked prices) and records the inventory movements — all in one
       transaction. Insufficient stock returns 409 and changes nothing. */
    el.querySelectorAll('[data-cv]').forEach(b=>b.onclick=()=>{
      const bo=DB.backorder(b.dataset.cv);
      Modal.confirm('Convert Backorder',
        'Convert <b>'+esc(bo.number)+'</b> into a fulfillment order for '+esc(bo.customerName||DB.userName(bo.customerId))+'?'
        +'<div class="small muted" style="margin-top:8px">Prices are locked from the backorder and the original order context is reused. '
        +'Every line must be fully in stock — if any is short, nothing is changed and you will be told what is missing.</div>',
        async ()=>{
          b.disabled=true;
          try{
            const r=await DB.convertBackorder(bo.id);
            if(r.alreadyConverted){
              toast('Already converted to '+(r.orderNumber||'an order'));
            } else {
              toast('Converted to '+r.orderNumber);
            }
            /* Re-pull the snapshot: stock, the new order and the backorder's
               status all changed on the server, and page state must not be
               allowed to drift from it. */
            await DB.refreshLive();
            if(r.orderId) location.hash='#/order/'+r.orderId; else render();
          }catch(err){
            b.disabled=false;
            if(err.status===409&&err.data&&err.data.shortages){
              const rows=err.data.shortages.map(s=>
                '<tr><td>'+esc(s.sku)+'</td><td>'+esc(s.name||'')+'</td><td class="num">'+s.requested
                +'</td><td class="num">'+s.available+'</td><td class="num">'+s.short+'</td></tr>').join('');
              Modal.open({title:'Not enough stock',size:'wide',body:
                '<div class="small muted" style="margin-bottom:10px">Nothing was changed. '
                +esc(bo.number)+' is still open and can be converted once stock arrives.</div>'
                +'<div class="table-wrap"><table class="tbl"><thead><tr><th>SKU</th><th>Product</th>'
                +'<th class="num">Needed</th><th class="num">Available</th><th class="num">Short</th></tr></thead>'
                +'<tbody>'+rows+'</tbody></table></div>'});
            } else {
              toast(err.message||'Conversion failed',true);
            }
          }
        },'Convert');
    });
    el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
      const bo=DB.backorder(b.dataset.view);
      Modal.open({title:'Backorder '+bo.number,size:'wide',
        body:`
        ${/* Operational context staff need to process it. A fully backordered
             request has no order row, so this IS the record: who it is for, who
             placed it, and the currency/rate/addresses/notes it was struck with.
             Deliberately excludes pricing profiles, balances and tax ids. */''}
        <div class="kv">
          <dt>Customer</dt><dd>${esc(bo.customerName||DB.userName(bo.customerId))}</dd>
          <dt>Placed by</dt><dd>${bo.agentId?esc(bo.agentName||DB.userName(bo.agentId)):'Customer'} <span class="badge gray">${esc(bo.source||'customer')}</span></dd>
          <dt>Source order</dt><dd>${bo.orderNumber?esc(bo.orderNumber):'— (fully backordered)'}</dd>
          <dt>New order</dt><dd>${bo.convertedOrderNumber?esc(bo.convertedOrderNumber):'—'}</dd>
          <dt>Status / reason</dt><dd>${statusBadge(bo.status)} <span class="badge gray">${esc(bo.reason)}</span></dd>
          <dt>Customer authorised</dt><dd>${bo.customerAuthorised?'<span class="badge green">Yes</span>':'<span class="badge gray">No</span>'}</dd>
          <dt>Stock cleared</dt><dd>${TERMINAL_BO(bo)?'<span class="muted">Not applicable</span>'
            :bo.eligible?'<span class="badge green">Yes</span>':'<span class="badge gray">Not yet</span>'}</dd>
          <dt>Currency</dt><dd>${esc(bo.currency||'USD')}${bo.currency&&bo.currency!=='USD'?' (rate '+esc(String(bo.fxRate||1))+' from USD)':''}</dd>
          ${bo.shippingAddress?`<dt>Ship to</dt><dd>${esc([bo.shippingAddress.business,bo.shippingAddress.address,bo.shippingAddress.city,bo.shippingAddress.state,bo.shippingAddress.zip,bo.shippingAddress.country].filter(Boolean).join(', '))}</dd>`:''}
          ${bo.promo&&bo.promo.name?`<dt>Promotion</dt><dd>${esc(bo.promo.name)}</dd>`:''}
          ${(bo.comments&&bo.comments.length)?`<dt>Customer note</dt><dd>${bo.comments.map(cm=>esc(cm.text)).join('<br>')}</dd>`:''}
        </div>
        ${/* Money is shown in the BACKORDER's own currency at its stamped rate
             — not the admin viewer's — so a CAD customer's record never reads
             as dollars. Aggregate demand is shown per SKU because conversion
             checks coverage per SKU, not per line. */''}
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>Price (${esc(bo.currency||'USD')})</th><th>Line total</th><th>Current stock</th></tr></thead>
          <tbody>${(()=>{
            const demand={};bo.items.forEach(i=>{demand[i.sku]=(demand[i.sku]||0)+i.qty;});
            return bo.items.map(i=>{
              const hit=DB.variationBySku(i.sku);
              const stock=hit?DB.variationQty(hit.v):0;
              const short=stock<demand[i.sku];
              return `<tr><td>${esc(i.name)}</td><td>${esc(i.sku)}</td><td>${i.qty}</td>
                <td>${moneyIn(i.price,bo)}</td><td>${moneyIn(i.qty*i.price,bo)}</td>
                <td>${short?'<span class="badge red">'+stock+' of '+demand[i.sku]+'</span>'
                           :'<span class="badge green">'+stock+'</span>'}</td></tr>`;}).join('');
          })()}
          <tr><td colspan="4"><b>Total (${esc(bo.currency||'USD')})</b></td>
            <td><b>${moneyIn(bo.items.reduce((s,i)=>s+i.qty*i.price,0)-(Number(bo.discount)||0)+(Number(bo.shipping)||0),bo)}</b></td><td></td></tr>
          </tbody></table></div>`,
        foot:`<button class="btn" data-x>Close</button>`,
        setup(ov,close){ov.querySelector('[data-x]').onclick=close;}});
    });
  }
  render();
});

/* ============================================================ RETURNS */
App.register('returns',function(el){
  const state=App._ret||(App._ret={status:'',page:1});

  function render(){
    let list=DB.d.returns.slice();
    if(state.status)list=list.filter(r=>r.status===state.status);
    const p=paginate(list,state.page);
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Returns</div>
      <div class="flex">
        <select class="select" id="rt-status"><option value="">Status</option>
          ${['open','closed'].map(s=>`<option ${state.status===s?'selected':''}>${s}</option>`).join('')}</select>
        <button class="btn btn-dark" id="rt-new">${I.plus} New Return</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Return #</th><th>Customer</th><th>Order</th><th>Status</th><th>Items</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>${p.slice.length?p.slice.map(r=>`<tr>
          <td class="cell-main">${esc(r.number)}</td>
          <td>${esc(DB.userName(r.customerId))}</td>
          <td>${esc(r.orderNumber||'—')}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${r.items.reduce((s,i)=>s+i.qty,0)}</td>
          <td>${fmtDateShort(r.createdAt)}</td>
          <td><div class="row-actions">
            ${r.status==='open'?`<button class="btn btn-sm btn-dark" data-close="${r.id}">Close return</button>`:''}
            <button class="icon-btn" data-view="${r.id}">${I.eye}</button>
          </div></td>
        </tr>`).join(''):`<tr><td colspan="7" class="empty-cell">No returns found</td></tr>`}
        </tbody></table></div>
      ${pagerHTML(p)}
    </div>`;

    el.querySelector('#rt-status').onchange=e=>{state.status=e.target.value;render();};
    bindPager(el,pg=>{state.page=pg;render();});

    el.querySelector('#rt-new').onclick=()=>{
      const customers=DB.d.users.filter(u=>['customer','special customer'].includes(u.role));
      let items=[];
      const m=Modal.open({title:'Create Return',size:'wide',
        body:`
        <div class="two-col">
          <div class="field"><label>Customer</label>
            <select class="select" id="nr-cust">${customers.map(c=>`<option value="${c.id}">${esc(c.business)}</option>`).join('')}</select></div>
          <div class="field"><label>Order (optional)</label><select class="select" id="nr-order"><option value="">—</option></select></div>
        </div>
        <div class="field"><label>Add item</label>
          <div class="flex">
            <input class="input" id="nr-sku" placeholder="SKU" style="flex:1">
            <input class="input" id="nr-qty" type="number" min="1" value="1" style="width:80px">
            <select class="select" id="nr-res"><option value="credit">credit</option><option value="exchange">exchange</option></select>
            <button class="btn" id="nr-add">${I.plus} Add</button>
          </div></div>
        <div id="nr-items" class="flex-col"></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Create Return</button>`,
        setup(ov,close){
          const orderSel=ov.querySelector('#nr-order'),custSel=ov.querySelector('#nr-cust');
          function loadOrders(){
            const list=DB.d.orders.filter(o=>o.customerId===custSel.value).slice(-25).reverse();
            orderSel.innerHTML='<option value="">—</option>'+list.map(o=>`<option value="${o.number}">${o.number} — ${orderMoney(o.total,o)}</option>`).join('');
          }
          custSel.onchange=loadOrders;loadOrders();
          function paint(){
            ov.querySelector('#nr-items').innerHTML=items.map((it,ix)=>`
              <div class="flex" style="border:1px solid var(--line);border-radius:9px;padding:8px 12px">
                <b>${esc(it.sku)}</b><span class="muted">${esc(it.name)}</span><span>× ${it.qty}</span>
                ${statusBadge(it.resolution)}
                <button class="icon-btn danger right" data-rm="${ix}">${I.trash}</button>
              </div>`).join('');
            ov.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{items.splice(parseInt(b.dataset.rm,10),1);paint();});
          }
          ov.querySelector('#nr-add').onclick=()=>{
            const sku=ov.querySelector('#nr-sku').value.trim();
            const hit=DB.variationBySku(sku);
            if(!hit)return toast('SKU not found',true);
            items.push({sku:hit.v.sku,name:hit.p.name,qty:parseInt(ov.querySelector('#nr-qty').value,10)||1,
              price:hit.p.price,resolution:ov.querySelector('#nr-res').value});
            ov.querySelector('#nr-sku').value='';paint();
          };
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            if(!items.length)return toast('Add at least one item',true);
            const num='RT'+(DB.d.nextReturnNumber++);
            DB.d.returns.unshift({id:uid('rt'),number:num,customerId:custSel.value,
              orderNumber:orderSel.value||null,status:'open',items,createdAt:todayISO()});
            DB.save();DB.audit('return.create',num,items.length+' item(s)');
            close();render();toast('Return '+num+' created');
          };
        }});
    };

    el.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{
      const r=DB.d.returns.find(x=>x.id===b.dataset.close);
      Modal.confirm('Close return','Close <b>'+esc(r.number)+'</b>? Stock and the customer\'s balance are updated accordingly.',()=>{
        r.status='closed';
        let credit=0;
        for(const it of r.items){
          releaseStock(it.sku,it.qty); /* returned items go back to stock */
          if(it.resolution==='credit')credit+=it.qty*it.price;
        }
        if(credit>0){
          const u=DB.user(r.customerId);if(u)u.balance=(u.balance||0)-credit;
          DB.d.creditNotes.unshift({id:uid('cn'),customerId:r.customerId,amount:credit,
            reason:'Return '+r.number,date:todayISO()});
        }
        DB.save();DB.audit('return.close',r.number,'Stock restocked'+(credit?', credit '+money(credit):''));
        render();toast('Return closed'+(credit?' — '+money(credit)+' credited':''));
      },'Close return');
    });
    el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
      const r=DB.d.returns.find(x=>x.id===b.dataset.view);
      Modal.open({title:'Return '+r.number,
        body:`<div class="kv"><dt>Customer</dt><dd>${esc(DB.userName(r.customerId))}</dd>
          <dt>Order</dt><dd>${esc(r.orderNumber||'—')}</dd><dt>Status</dt><dd>${statusBadge(r.status)}</dd></div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>SKU</th><th>Product</th><th>Qty</th><th>Resolution</th></tr></thead>
        <tbody>${r.items.map(i=>`<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td>${i.qty}</td><td>${statusBadge(i.resolution)}${i.exchangeSku?` <span class="muted">→ ${esc(i.exchangeSku)}</span>`:''}</td></tr>`).join('')}</tbody></table></div>`,
        foot:`<button class="btn" data-x>Close</button>`,
        setup(ov,close){ov.querySelector('[data-x]').onclick=close;}});
    });
  }
  render();
});

/* ============================================================ PROMOTIONS */
App.register('promotions',function(el){
  const state=App._promo||(App._promo={tab:'Promotions'});

  function promoForm(existing,onSave){
    const p=existing||{name:'',description:'',active:true,from:'',to:'',countries:[],audience:'all',
      customerIds:'',agentIds:'',minQty:0,maxPerCustomer:0,maxTotal:0,ctxCustomer:true,ctxAgent:true,
      rewardType:'tiered',tiers:[{buy:20,free:2}],pct:10,fixed:10};
    Modal.open({title:existing?'Edit Promotion':'New Promotion',size:'xwide',
      body:`
      <div class="section-label">IDENTITY</div>
      <div class="two-col">
        <div class="field"><label>Name</label><input class="input" id="pm-name" value="${esc(p.name)}"></div>
        <div class="field"><label>Status</label><select class="select" id="pm-active"><option value="1" ${p.active?'selected':''}>Active</option><option value="0" ${!p.active?'selected':''}>Inactive</option></select></div>
      </div>
      <div class="field"><label>Description</label><input class="input" id="pm-desc" value="${esc(p.description)}"></div>
      <div class="two-col">
        <div class="field"><label>From (empty = always)</label><input type="date" class="input" id="pm-from" value="${p.from}"></div>
        <div class="field"><label>To</label><input type="date" class="input" id="pm-to" value="${p.to}"></div>
      </div>
      <div class="section-label">ELIGIBILITY</div>
      <div class="two-col">
        <div class="field"><label>Countries</label>
          <div class="flex"><label class="checkbox-row"><input type="checkbox" id="pm-us" ${!p.countries.length||p.countries.includes('US')?'checked':''}> US</label>
          <label class="checkbox-row"><input type="checkbox" id="pm-ca" ${!p.countries.length||p.countries.includes('CA')?'checked':''}> CA</label></div></div>
        <div class="field"><label>Target audience</label>
          <select class="select" id="pm-aud">
            <option value="all" ${p.audience==='all'?'selected':''}>All customers</option>
            <option value="specific" ${p.audience==='specific'?'selected':''}>Specific customers (list of IDs)</option>
            <option value="agents" ${p.audience==='agents'?'selected':''}>Customers of specific agents</option>
          </select></div>
      </div>
      <div class="two-col">
        <div class="field"><label>Customer IDs (comma-separated)</label><input class="input" id="pm-custids" value="${esc(p.customerIds)}"></div>
        <div class="field"><label>Agent IDs (comma-separated)</label><input class="input" id="pm-agentids" value="${esc(p.agentIds)}"></div>
      </div>
      <div class="grid g3">
        <div class="field"><label>Minimum order quantity</label><input class="input" type="number" id="pm-minqty" value="${p.minQty}"></div>
        <div class="field"><label>Max uses per customer (0 = ∞)</label><input class="input" type="number" id="pm-maxc" value="${p.maxPerCustomer}"></div>
        <div class="field"><label>Max uses total (0 = ∞)</label><input class="input" type="number" id="pm-maxt" value="${p.maxTotal}"></div>
      </div>
      <div class="section-label">CONTEXT <span style="font-weight:400">(at least one must be checked)</span></div>
      <div class="flex">
        <label class="checkbox-row"><input type="checkbox" id="pm-ctxc" ${p.ctxCustomer?'checked':''}> Orders a customer placed</label>
        <label class="checkbox-row"><input type="checkbox" id="pm-ctxa" ${p.ctxAgent?'checked':''}> Orders an agent placed</label>
      </div>
      <div class="section-label">REWARD TYPE</div>
      <div class="field"><select class="select" id="pm-reward">
        <option value="tiered" ${p.rewardType==='tiered'?'selected':''}>Tiered free items ("buy 20 get 2")</option>
        <option value="pct" ${p.rewardType==='pct'?'selected':''}>Percent discount</option>
        <option value="fixed" ${p.rewardType==='fixed'?'selected':''}>Fixed-amount discount</option>
        <option value="freeship" ${p.rewardType==='freeship'?'selected':''}>Free shipping</option>
      </select></div>
      <div id="pm-reward-cfg"></div>`,
      foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Save Promotion</button>`,
      setup(ov,close){
        const cfg=ov.querySelector('#pm-reward-cfg');
        let tiers=p.tiers.slice();
        function paintCfg(){
          const t=ov.querySelector('#pm-reward').value;
          if(t==='tiered'){
            cfg.innerHTML=`<div class="flex-col">${tiers.map((tr,ix)=>`
              <div class="flex"><span class="muted small">Buy</span><input class="input" style="width:90px" type="number" data-buy="${ix}" value="${tr.buy}">
              <span class="muted small">get free</span><input class="input" style="width:90px" type="number" data-free="${ix}" value="${tr.free}">
              <button class="icon-btn danger" data-deltier="${ix}">${I.trash}</button></div>`).join('')}
              <button class="btn btn-sm" id="pm-addtier">${I.plus} Add tier</button></div>`;
            cfg.querySelector('#pm-addtier').onclick=()=>{tiers.push({buy:0,free:0});paintCfg();};
            cfg.querySelectorAll('[data-buy]').forEach(i=>i.onchange=()=>tiers[+i.dataset.buy].buy=+i.value);
            cfg.querySelectorAll('[data-free]').forEach(i=>i.onchange=()=>tiers[+i.dataset.free].free=+i.value);
            cfg.querySelectorAll('[data-deltier]').forEach(b=>b.onclick=()=>{tiers.splice(+b.dataset.deltier,1);paintCfg();});
          }else if(t==='pct'){
            cfg.innerHTML=`<div class="field" style="max-width:200px"><label>Percent discount (%)</label><input class="input" type="number" id="pm-pct" value="${p.pct}"></div>`;
          }else if(t==='fixed'){
            cfg.innerHTML=`<div class="field" style="max-width:200px"><label>Fixed discount ($)</label><input class="input" type="number" id="pm-fixed" value="${p.fixed}"></div>`;
          }else cfg.innerHTML='<div class="small muted">Shipping is free when the promotion applies.</div>';
        }
        ov.querySelector('#pm-reward').onchange=paintCfg;paintCfg();
        ov.querySelector('[data-x]').onclick=close;
        ov.querySelector('[data-ok]').onclick=()=>{
          const name=ov.querySelector('#pm-name').value.trim();
          if(!name)return toast('Name is required',true);
          const ctxC=ov.querySelector('#pm-ctxc').checked,ctxA=ov.querySelector('#pm-ctxa').checked;
          if(!ctxC&&!ctxA)return toast('At least one context must be checked',true);
          const countries=[];if(ov.querySelector('#pm-us').checked)countries.push('US');if(ov.querySelector('#pm-ca').checked)countries.push('CA');
          const obj={id:p.id||uid('pr'),name,description:ov.querySelector('#pm-desc').value,
            active:ov.querySelector('#pm-active').value==='1',
            from:ov.querySelector('#pm-from').value,to:ov.querySelector('#pm-to').value,
            countries,audience:ov.querySelector('#pm-aud').value,
            customerIds:ov.querySelector('#pm-custids').value,agentIds:ov.querySelector('#pm-agentids').value,
            minQty:+ov.querySelector('#pm-minqty').value,maxPerCustomer:+ov.querySelector('#pm-maxc').value,maxTotal:+ov.querySelector('#pm-maxt').value,
            ctxCustomer:ctxC,ctxAgent:ctxA,
            rewardType:ov.querySelector('#pm-reward').value,tiers,
            pct:ov.querySelector('#pm-pct')?+ov.querySelector('#pm-pct').value:p.pct,
            fixed:ov.querySelector('#pm-fixed')?+ov.querySelector('#pm-fixed').value:p.fixed,
            used:p.used||0};
          onSave(obj);close();
        };
      }});
  }

  function rewardLabel(p){
    if(p.rewardType==='tiered')return p.tiers.map(t=>'buy '+t.buy+' get '+t.free).join(', ');
    if(p.rewardType==='pct')return p.pct+'% off';
    if(p.rewardType==='fixed')return money(p.fixed)+' off';
    return 'Free shipping';
  }

  function render(){
    const d=DB.d;
    let inner='';
    if(state.tab==='Promotions'){
      inner=`
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Active</th><th>Name</th><th>Reward</th><th>Eligibility</th><th>Used</th><th>Actions</th></tr></thead>
        <tbody>${d.promotions.length?d.promotions.map(p=>`<tr>
          <td>${p.active?'<span class="badge green">Active</span>':'<span class="badge gray">Inactive</span>'}</td>
          <td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(p.description)}</div></td>
          <td>${esc(rewardLabel(p))}</td>
          <td class="small">${p.audience==='all'?'All customers':p.audience==='specific'?'Specific customers':'Customers of agents'} &middot; ${p.countries.join(', ')||'US, CA'}</td>
          <td>${p.used||0}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-edit="${p.id}">${I.pencil}</button>
            <button class="icon-btn danger" data-del="${p.id}">${I.trash}</button>
          </div></td>
        </tr>`).join(''):`<tr><td colspan="6" class="empty-cell">No promotions yet. Click "New promotion" to create one.</td></tr>`}
        </tbody></table></div>`;
    }else if(state.tab==='Campaigns'){
      inner=`
      <div class="flex" style="margin-bottom:12px"><button class="btn btn-dark btn-sm" id="cp-new">${I.plus} New Campaign</button></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Name</th><th>Audience</th><th>Template</th><th>Send date</th><th>Status</th><th>Opens</th><th>Clicks</th></tr></thead>
        <tbody>${d.campaigns.length?d.campaigns.map(c=>`<tr>
          <td class="cell-main">${esc(c.name)}</td><td>${esc(c.audience)}</td><td>${esc(c.template)}</td>
          <td>${fmtDateShort(c.sendDate)}</td><td>${statusBadge(c.status)}</td>
          <td>${c.opens||0}</td><td>${c.clicks||0}</td>
        </tr>`).join(''):`<tr><td colspan="7" class="empty-cell">No campaigns yet.</td></tr>`}
        </tbody></table></div>`;
    }else{
      const cr=d.settings.cartRecovery;
      inner=`
      <div class="card card-pad" style="max-width:560px">
        <label class="checkbox-row" style="margin-bottom:14px"><input type="checkbox" id="cr-on" ${cr.enabled?'checked':''}> <b>Enable automatic cart-recovery emails</b></label>
        <div class="two-col">
          <div class="field"><label>Delay (hours after abandonment)</label><input class="input" type="number" id="cr-delay" value="${cr.delayHours}"></div>
          <div class="field"><label>Minimum cart value ($)</label><input class="input" type="number" id="cr-min" value="${cr.minValue}"></div>
        </div>
        <button class="btn btn-dark" id="cr-save" style="margin-top:14px">Save settings</button>
      </div>`;
    }

    el.innerHTML=`
    <div class="page-head">
      <div><div class="page-title">Promotions</div>
      <div class="page-sub">Auto-applied discounts, free-item rules, and email campaigns</div></div>
      ${state.tab==='Promotions'?`<button class="btn btn-dark" id="pm-new">${I.plus} New Promotion</button>`:''}
    </div>
    <div class="card card-pad">
      <div class="tabs">
        ${['Promotions','Campaigns','Cart Recovery'].map(t=>`<button class="tab ${state.tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}
      </div>
      ${inner}
    </div>`;

    el.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});
    const nw=el.querySelector('#pm-new');
    if(nw)nw.onclick=()=>promoForm(null,obj=>{
      DB.d.promotions.unshift(obj);DB.save();DB.audit('promotion.create',obj.name,rewardLabel(obj));
      render();toast('Promotion created');
    });
    el.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
      const p=DB.d.promotions.find(x=>x.id===b.dataset.edit);
      promoForm(p,obj=>{Object.assign(p,obj);DB.save();DB.audit('promotion.edit',p.name,'');render();toast('Promotion updated');});
    });
    el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      const p=DB.d.promotions.find(x=>x.id===b.dataset.del);
      Modal.confirm('Delete promotion','Delete <b>'+esc(p.name)+'</b>?',()=>{
        DB.d.promotions=DB.d.promotions.filter(x=>x.id!==p.id);DB.save();
        DB.audit('promotion.delete',p.name,'');render();toast('Promotion deleted');
      },'Delete');
    });
    const cpn=el.querySelector('#cp-new');
    if(cpn)cpn.onclick=()=>{
      Modal.open({title:'New Campaign',
        body:`
        <div class="field"><label>Name</label><input class="input" id="cp-name"></div>
        <div class="field"><label>Audience</label><select class="select" id="cp-aud"><option>All customers</option><option>US customers</option><option>CA customers</option><option>Customers of specific agents</option></select></div>
        <div class="field"><label>Email template</label><select class="select" id="cp-tpl">${DB.d.emailTemplates.map(t=>`<option>${esc(t.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Send date</label><input type="date" class="input" id="cp-date" value="${todayISO()}"></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Schedule</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const name=ov.querySelector('#cp-name').value.trim();
            if(!name)return toast('Name is required',true);
            DB.d.campaigns.unshift({id:uid('cp'),name,audience:ov.querySelector('#cp-aud').value,
              template:ov.querySelector('#cp-tpl').value,sendDate:ov.querySelector('#cp-date').value,
              status:'draft',opens:0,clicks:0});
            DB.save();DB.audit('campaign.create',name,'');close();render();toast('Campaign scheduled');
          };
        }});
    };
    const crs=el.querySelector('#cr-save');
    if(crs)crs.onclick=()=>{
      const cr=DB.d.settings.cartRecovery;
      cr.enabled=el.querySelector('#cr-on').checked;
      cr.delayHours=+el.querySelector('#cr-delay').value;
      cr.minValue=+el.querySelector('#cr-min').value;
      DB.save();DB.audit('cart-recovery.save','settings',(cr.enabled?'on':'off')+' · '+cr.delayHours+'h');
      toast('Cart recovery settings saved');
    };
  }
  render();
});

/* ============================================================ REPORTS */
App.register('reports',function(el){
  const state=App._rep||(App._rep={tab:'By Customer',from:'2026-01-01',to:todayISO(),src:'All',rows:null,drill:null});

  function computeRows(){
    const d=DB.d;
    let orders=d.orders.filter(o=>o.status!=='cancelled'&&o.date>=state.from&&o.date<=state.to);
    if(state.src==='Website')orders=orders.filter(o=>o.source==='customer');
    if(state.src==='Agent')orders=orders.filter(o=>o.source==='agent');
    const agg={};
    if(state.tab==='By Customer'){
      for(const o of orders){
        const k=o.customerId,a=agg[k]=agg[k]||{key:k,name:DB.userName(k),orders:0,amount:0,frames:0};
        a.orders++;a.amount+=o.total;a.frames+=o.items.reduce((s,i)=>s+i.qty,0);
      }
      return Object.values(agg).sort((a,b)=>b.amount-a.amount);
    }
    if(state.tab==='By Item'){
      for(const o of orders)for(const it of o.items){
        const a=agg[it.sku]=agg[it.sku]||{key:it.sku,name:it.name+' ('+it.sku+')',units:0,revenue:0};
        a.units+=it.qty;a.revenue+=it.qty*it.price;
      }
      return Object.values(agg).sort((a,b)=>b.units-a.units);
    }
    if(state.tab==='By Agent'){
      for(const o of orders){
        if(!o.agentId)continue;
        const a=agg[o.agentId]=agg[o.agentId]||{key:o.agentId,name:DB.userName(o.agentId),orders:0,customers:new Set(),revenue:0};
        a.orders++;a.customers.add(o.customerId);a.revenue+=o.total;
      }
      return Object.values(agg).map(a=>({key:a.key,name:a.name,orders:a.orders,customers:a.customers.size,revenue:a.revenue,aov:a.orders?a.revenue/a.orders:0})).sort((a,b)=>b.revenue-a.revenue);
    }
    for(const o of orders){
      const c=DB.user(o.customerId);const city=(c&&c.city)||'Unknown';
      const a=agg[city]=agg[city]||{key:city,name:city,orders:0,revenue:0};
      a.orders++;a.revenue+=o.total;
    }
    return Object.values(agg).sort((a,b)=>b.revenue-a.revenue);
  }

  function headers(){
    switch(state.tab){
      case 'By Customer':return ['Customer','Orders','Amount (USD)','Frames'];
      case 'By Item':return ['Product / SKU','Units sold','Revenue (USD)'];
      case 'By Agent':return ['Agent','Orders','Customers','Revenue (USD)','Average order value (USD)'];
      default:return ['City','Orders','Revenue (USD)'];
    }
  }
  function rowCells(r){
    switch(state.tab){
      case 'By Customer':return [esc(r.name),r.orders,money(r.amount),r.frames];
      case 'By Item':return [esc(r.name),r.units,money(r.revenue)];
      case 'By Agent':return [esc(r.name),r.orders,r.customers,money(r.revenue),money(r.aov)];
      default:return [esc(r.name),r.orders,money(r.revenue)];
    }
  }

  function render(){
    /* Order-based aggregates. No live orders means no report — not a report of
       zero, which would read as a real trading figure. */
    if(!requireLiveData(el,render,'Reports could not be generated'))return;
    el.innerHTML=`
    <div class="page-head"><div class="page-title">Reports</div></div>
    <div class="card card-pad">
      <div class="tabs">
        ${['By Customer','By Item','By Agent','By City'].map(t=>`<button class="tab ${state.tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}
      </div>
      <div class="flex">
        <div class="fieldset-outline"><label>From</label><input type="date" id="rp-from" value="${state.from}"></div>
        <div class="fieldset-outline"><label>To</label><input type="date" id="rp-to" value="${state.to}"></div>
        <span class="chip-row" style="background:#f1ede3;border-radius:9px;padding:3px">
          ${['All','Website','Agent'].map(s=>`<button class="chip ${state.src===s?'active':''}" data-src="${s}" style="border:none">${s}</button>`).join('')}
        </span>
        <button class="btn btn-dark" id="rp-gen">${I.chart} Generate</button>
        <button class="btn" id="rp-csv" ${!state.rows?'disabled':''}>${I.fileCsv} Export CSV</button>
      </div>
      ${state.rows?`
      <div class="table-wrap" style="margin-top:16px"><table class="tbl">
        <thead><tr>${headers().map(h=>`<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${state.rows.length?state.rows.slice(0,100).map((r,ix)=>`
          <tr class="${state.tab==='By Customer'?'clickable':''}" data-drill="${ix}">${rowCells(r).map(c=>`<td>${c}</td>`).join('')}</tr>
          ${state.drill===ix&&state.tab==='By Customer'?`<tr><td colspan="4" style="background:#fbf8f1">
            ${DB.d.orders.filter(o=>o.customerId===r.key&&o.status!=='cancelled'&&o.date>=state.from&&o.date<=state.to)
              .map(o=>`<div class="flex small" style="padding:3px 0"><a class="link" href="#/order/${o.id}">${o.number}</a><span>${fmtDateShort(o.date)}</span>${statusBadge(o.status)}<span class="right">${orderMoney(o.total,o)}</span></div>`).join('')}
          </td></tr>`:''}`).join(''):`<tr><td colspan="${headers().length}" class="empty-cell">No data for this range</td></tr>`}
        </tbody></table></div>
      ${state.rows.length>100?'<div class="small muted" style="margin-top:8px">Showing top 100 rows — export CSV for the full list.</div>':''}`:
      '<div class="task-empty">'+I.chart+'<div>Choose a range and click Generate</div></div>'}
    </div>`;

    el.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;state.rows=null;state.drill=null;render();});
    el.querySelectorAll('[data-src]').forEach(b=>b.onclick=()=>{state.src=b.dataset.src;render();});
    el.querySelector('#rp-from').onchange=e=>state.from=e.target.value;
    el.querySelector('#rp-to').onchange=e=>state.to=e.target.value;
    el.querySelector('#rp-gen').onclick=()=>{state.rows=computeRows();state.drill=null;render();};
    el.querySelector('#rp-csv').onclick=()=>{
      if(!state.rows)return;
      downloadCSV('veyora-report-'+state.tab.toLowerCase().replace(/ /g,'-')+'.csv',
        [headers()].concat(state.rows.map(r=>rowCells(r).map(c=>String(c).replace(/<[^>]*>/g,'')))));
    };
    el.querySelectorAll('[data-drill]').forEach(tr=>tr.onclick=()=>{
      if(state.tab!=='By Customer')return;
      const ix=parseInt(tr.dataset.drill,10);
      state.drill=state.drill===ix?null:ix;render();
    });
  }
  render();
});

/* Spare-part requests submitted by customers from the storefront.
   Previously there was no admin view at all, so requests went unseen.
   Customers create them; staff move status forward and can see the photo. */
App.register('spare-parts',function(el){
  const STATUSES=['open','in_review','shipped','closed'];
  const state=App._sp||(App._sp={status:'',q:'',page:1});

  function render(){
    let list=(DB.d.spareParts||[]).slice();
    if(state.status)list=list.filter(r=>r.status===state.status);
    if(state.q){
      const term=state.q.toLowerCase();
      list=list.filter(r=>(DB.userName(r.userId)+' '+r.model+' '+r.part+' '+(r.notes||'')).toLowerCase().includes(term));
    }
    list.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    const openCount=(DB.d.spareParts||[]).filter(r=>r.status==='open').length;
    const p=paginate(list,state.page);
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Spare Parts ${openCount?`<span class="badge">${openCount} open</span>`:''}</div>
      <div class="flex">
        <input class="input" id="sp-q" placeholder="Search customer, model, part…" value="${esc(state.q)}" style="width:240px">
        <select class="select" id="sp-status"><option value="">All statuses</option>
          ${STATUSES.map(s=>`<option value="${s}" ${state.status===s?'selected':''}>${s.replace('_',' ')}</option>`).join('')}</select>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th></th><th>Customer</th><th>Model</th><th>Part needed</th><th>Status</th><th>Requested</th><th>Actions</th></tr></thead>
        <tbody>${p.slice.length?p.slice.map(r=>`<tr>
          <td><div class="thumb-box" style="width:44px;height:28px;overflow:hidden;background:#fff">${photoThumb(r.image)}</div></td>
          <td class="cell-main">${esc(DB.userName(r.userId))}</td>
          <td>${esc(r.model||'—')}</td>
          <td>${esc(r.part||'—')}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${fmtDateShort(r.createdAt)}</td>
          <td><div class="row-actions">
            <select class="select" data-setstatus="${r.id}" style="padding:4px 8px;font-size:12px;width:auto">
              ${STATUSES.map(s=>`<option value="${s}" ${r.status===s?'selected':''}>${s.replace('_',' ')}</option>`).join('')}</select>
            <button class="icon-btn" data-view="${r.id}">${I.eye}</button>
          </div></td>
        </tr>`).join(''):`<tr><td colspan="7" class="empty-cell">No spare-part requests</td></tr>`}
        </tbody></table></div>
      ${pagerHTML(p)}
    </div>`;

    el.querySelector('#sp-status').onchange=e=>{state.status=e.target.value;state.page=1;render();};
    const qi=el.querySelector('#sp-q');
    qi.oninput=e=>{state.q=e.target.value;state.page=1;render();
      const n=el.querySelector('#sp-q');n.focus();n.setSelectionRange(n.value.length,n.value.length);};
    bindPager(el,pg=>{state.page=pg;render();});

    el.querySelectorAll('[data-setstatus]').forEach(sel=>sel.onchange=()=>{
      const r=(DB.d.spareParts||[]).find(x=>x.id===sel.dataset.setstatus);
      if(!r)return;
      const from=r.status;r.status=sel.value;
      DB.save();DB.audit('sparepart.status',r.model||r.id,from+' → '+r.status);
      render();toast('Marked '+r.status.replace('_',' '));
    });

    el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
      const r=(DB.d.spareParts||[]).find(x=>x.id===b.dataset.view);
      if(!r)return;
      Modal.open({title:'Spare-part request',
        body:`<div class="kv">
          <dt>Customer</dt><dd>${esc(DB.userName(r.userId))}</dd>
          <dt>Model</dt><dd>${esc(r.model||'—')}</dd>
          <dt>Part needed</dt><dd>${esc(r.part||'—')}</dd>
          <dt>Status</dt><dd>${statusBadge(r.status)}</dd>
          <dt>Requested</dt><dd>${fmtDate(r.createdAt)}</dd>
        </div>
        ${r.notes?`<div class="field"><label>Notes</label><div class="note-banner">${esc(r.notes)}</div></div>`:''}
        ${r.image?`<div class="field"><label>Photo</label><a href="${esc(r.image)}" target="_blank" rel="noopener"><img src="${esc(r.image)}" alt="" style="max-width:100%;border-radius:9px;border:1px solid var(--line)"></a></div>`:'<div class="muted">No photo attached.</div>'}`,
        foot:`<button class="btn" data-x>Close</button>`,
        setup(ov,close){ov.querySelector('[data-x]').onclick=close;}});
    });
  }
  render();
});
