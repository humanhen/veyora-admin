/* ================= Pages: Sales — Orders, Collection, Quick Scan, Backorders, Returns, Promotions, Reports ================= */
'use strict';

/* ---------- stock helpers ---------- */
function releaseStock(sku,qty){
  const hit=DB.variationBySku(sku);if(!hit)return;
  const wh=Object.keys(hit.v.stock)[0];
  hit.v.stock[wh].qty+=qty;
}
function reserveStock(sku,qty){
  const hit=DB.variationBySku(sku);if(!hit)return;
  for(const w of Object.keys(hit.v.stock)){
    const take=Math.min(hit.v.stock[w].qty,qty);
    hit.v.stock[w].qty-=take;qty-=take;
    if(qty<=0)break;
  }
}

/* ============================================================ ORDERS LIST */
App.register('orders',function(el){
  const state=App._orders||(App._orders={status:'All',source:'All Sources',country:'',from:'',to:'',sort:'Newest first',q:'',page:1});

  function render(){
    const d=DB.d;
    let list=d.orders.slice();
    const counts={All:list.length};
    ['pending','processing','completed','cancelled'].forEach(s=>counts[s]=list.filter(o=>o.status===s).length);
    if(state.status!=='All')list=list.filter(o=>o.status===state.status.toLowerCase());
    if(state.source==='From Customers')list=list.filter(o=>o.source==='customer');
    if(state.source==='From Agents')list=list.filter(o=>o.source==='agent');
    if(state.country)list=list.filter(o=>{const c=DB.user(o.customerId);return c&&c.country===state.country;});
    if(state.from)list=list.filter(o=>o.date>=state.from);
    if(state.to)list=list.filter(o=>o.date<=state.to);
    if(state.q){
      const q=state.q.toLowerCase();
      list=list.filter(o=>{
        const c=DB.user(o.customerId)||{};
        return o.number.toLowerCase().includes(q)||(c.business||'').toLowerCase().includes(q)||(c.email||'').toLowerCase().includes(q);
      });
    }
    list.sort((a,b)=>state.sort==='Newest first'?(b.number>a.number?1:-1):(a.number>b.number?1:-1));
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
            <div class="search-wrap">${I.search}<input class="input" id="f-q" placeholder="Search here…" value="${esc(state.q)}"></div>
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
          const c=DB.user(o.customerId)||{};
          return `<tr>
            <td class="cell-main">${esc(o.number)}</td>
            <td>${esc(c.business||'—')}</td>
            <td>${o.agentId?esc(DB.userName(o.agentId)):'—'}</td>
            <td>${fmtDate(o.date)}</td>
            <td>${statusBadge(o.status)}</td>
            <td>${money(o.total)}</td>
            <td><span class="badge outline">${o.source==='agent'?'Agent':'Customer'}</span></td>
            <td><button class="icon-btn" data-view="${o.id}" title="Open order">${I.eye}</button></td>
          </tr>`;}).join(''):`<tr><td colspan="8" class="empty-cell">No orders found</td></tr>`}
        </tbody></table></div>
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
  const o=DB.order(args[0]);
  if(!o){el.innerHTML='<div class="card card-pad">Order not found. <a class="link" href="#/orders">Back to orders</a></div>';return;}
  const local=App._order||(App._order={});
  if(local.id!==o.id){local.id=o.id;local.scanning=false;}

  function itemsCollectedAll(){return o.items.every(i=>i.collected>=i.qty);}
  function saveAudit(action,changes){DB.save();DB.audit(action,o.number,changes);}

  function render(){
    const cust=DB.user(o.customerId)||{};
    const agent=o.agentId?DB.user(o.agentId):null;
    const canEdit=!['shipped'].includes(o.status);
    const inv=o.invoiceId?DB.d.invoices.find(i=>i.id===o.invoiceId):null;
    const shipped=o.status==='shipped';

    el.innerHTML=`
    <div class="flex" style="margin-bottom:16px">
      <a class="back-btn" href="#/orders" title="Back">&larr;</a>
      <div class="page-title" style="font-size:16px">Order Collection</div>
      <button class="btn btn-sm" id="btn-pdf">${I.pdf} PDF</button>
      <div class="right flex">
        ${canEdit?`
        <button class="btn btn-sm" id="btn-merge">${I.merge} Merge orders</button>
        <button class="btn btn-sm" id="btn-chg-cust">${I.user} Change customer</button>
        <button class="btn btn-sm" id="btn-labels">${I.printer} Print labels</button>`:''}
      </div>
    </div>

    <div class="order-cards">
      <div class="card card-pad"><div class="stat-label">ORDER NUMBER</div><div style="font-weight:600;margin-top:6px">${esc(o.number)}</div></div>
      <div class="card card-pad"><div class="stat-label">ORDER DATE</div><div style="font-weight:600;margin-top:6px">${fmtDateShort(o.date)}</div></div>
      <div class="card card-pad"><div class="stat-label">STATUS</div><div style="margin-top:6px">${statusBadge(o.status)}</div></div>
      <div class="card card-pad"><div class="stat-label">TOTAL AMOUNT</div><div class="money-green" style="font-size:16px;margin-top:6px">${money(DB.orderTotal(o))}</div></div>
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <div class="spread">
        <div class="flex">${I.invoice}<b style="font-size:13px">Invoice</b>
          ${inv?`<span class="badge green">Invoice #${inv.number}</span>`:''}</div>
        ${inv?`<button class="btn btn-sm" id="btn-inv-dl">${I.download} Download Invoice</button>`
             :`<button class="btn btn-dark btn-sm" id="btn-gen-inv">${I.invoice} Generate Invoice</button>`}
      </div>
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <div class="card-title">Customer Information</div>
      <div class="grid g2">
        <div><div class="stat-label">CUSTOMER</div><div style="margin-top:5px;font-weight:500">${esc(cust.business||'—')}</div></div>
        <div><div class="stat-label">EMAIL</div><div style="margin-top:5px">${esc(cust.email||'—')}</div></div>
        ${agent?`<div><div class="stat-label">AGENT</div><div style="margin-top:5px">${esc(DB.userName(agent.id))}</div></div>
        <div><div class="stat-label">AGENT EMAIL</div><div style="margin-top:5px">${esc(agent.email)}</div></div>`:''}
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
            const done=it.collected>=it.qty;
            return `<tr>
              <td><button class="count-circle" data-count="${ix}" title="Count manually (+1)">${done?'✓':'+'}</button></td>
              <td><div class="cell-main">${esc(it.name)} &times; ${it.qty}</div><div class="cell-sub">Color: ${esc(it.color||'N/A')} | SKU: ${esc(it.sku)}</div></td>
              <td>${esc(it.sku)}</td>
              <td><div class="progress ${done?'full':''}"><span style="width:${Math.min(100,it.collected/it.qty*100)}%"></span></div></td>
              <td><b>${it.collected} / ${it.qty}</b> ${done?'<span class="badge green">Done</span>':''}</td>
            </tr>`;}).join('')}
          </tbody></table></div>`}
    </div>

    <div class="card card-pad" style="margin-top:14px">
      <div class="spread"><div class="card-title" style="margin:0">Order Items Summary</div>
        ${canEdit?`<div class="flex">
          <button class="btn btn-sm" id="btn-add-item">${I.plus} Add item</button>
          <button class="btn btn-sm" id="btn-discount">${I.tag} Admin discount</button>
        </div>`:''}</div>
      <div class="table-wrap" style="margin-top:12px"><table class="tbl">
        <thead><tr><th>Product</th><th class="num">Total</th><th style="width:90px"></th></tr></thead>
        <tbody>
          ${o.items.map((it,ix)=>`<tr>
            <td><div class="cell-main">${esc(it.name)} &times; ${it.qty}</div><div class="cell-sub">Color: ${esc(it.color||'N/A')} | SKU: ${esc(it.sku)}</div></td>
            <td class="num">${money(it.qty*it.price)}</td>
            <td><div class="row-actions">
              ${canEdit?`<button class="icon-btn" data-edit-item="${ix}" title="Edit / swap SKU">${I.pencil}</button>
              <button class="icon-btn danger" data-del-item="${ix}" title="Delete line">${I.trash}</button>`:''}
            </div></td>
          </tr>`).join('')}
          ${o.discount||o.discountPct?`<tr><td class="cell-sub">Admin discount ${o.discountPct?o.discountPct+'%':''}</td><td class="num" style="color:var(--red)">−${money(o.discountPct?(o.items.reduce((s,i)=>s+i.qty*i.price,0)*o.discountPct/100):o.discount)}</td><td></td></tr>`:''}
          <tr><td style="font-weight:600">Total</td><td class="num" style="font-weight:600">${money(DB.orderTotal(o))}</td><td></td></tr>
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
    el.querySelector('#btn-pdf').onclick=()=>{
      const w=window.open('','_blank');
      const rows=o.items.map(it=>`<tr><td>${esc(it.name)}</td><td>${esc(it.sku)}</td><td>${it.qty}</td><td>$${(it.qty*it.price).toFixed(2)}</td></tr>`).join('');
      w.document.write(`<html><head><title>${o.number}</title><style>body{font-family:sans-serif;padding:40px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:8px;text-align:left}h1{letter-spacing:4px}.bc{font-family:monospace;font-size:30px;letter-spacing:2px;border:2px solid #000;display:inline-block;padding:8px 18px;margin:10px 0}</style></head>
      <body><h1>VEYORA</h1><h2>Order ${o.number}</h2><div class="bc">*${o.number}*</div>
      <p><b>Customer:</b> ${esc(cust.business||'')} &lt;${esc(cust.email||'')}&gt;<br><b>Date:</b> ${fmtDate(o.date)} &middot; <b>Status:</b> ${o.status}</p>
      <table><tr><th>Product</th><th>SKU</th><th>Qty</th><th>Total</th></tr>${rows}
      <tr><td colspan="3"><b>Total</b></td><td><b>$${DB.orderTotal(o).toFixed(2)}</b></td></tr></table>
      <script>print()<\/script></body></html>`);
      w.document.close();
    };

    const gen=el.querySelector('#btn-gen-inv');
    if(gen)gen.onclick=()=>{
      const num=DB.d.nextInvoiceNumber++;
      const invc={id:uid('inv'),number:num,orderId:o.id,orderNumber:o.number,customerId:o.customerId,
        amount:DB.orderTotal(o),provider:'Green Invoice',date:todayISO(),status:'paid'};
      DB.d.invoices.unshift(invc);o.invoiceId=invc.id;
      const u=DB.user(o.customerId);if(u)u.balance=(u.balance||0)+invc.amount;
      saveAudit('invoice.generate','#'+num,'Invoice for '+o.number+' — '+money(invc.amount));
      toast('Invoice #'+num+' generated');render();
    };
    const invdl=el.querySelector('#btn-inv-dl');
    if(invdl)invdl.onclick=()=>toast('Invoice PDF downloaded');

    const mrg=el.querySelector('#btn-merge');
    if(mrg)mrg.onclick=()=>{
      const others=DB.d.orders.filter(x=>x.customerId===o.customerId&&x.id!==o.id&&['pending','approved','processing'].includes(x.status));
      if(!others.length)return toast('No other open orders from this customer',true);
      Modal.open({title:'Merge orders',
        body:`<div class="small muted">Combine open orders from ${esc(cust.business)} into ${esc(o.number)}. Promotions are recalculated.</div>
        ${others.map(x=>`<label class="checkbox-row"><input type="checkbox" value="${x.id}"> ${esc(x.number)} — ${money(x.total)} — ${statusBadge(x.status)}</label>`).join('')}`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-merge>Merge</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-merge]').onclick=()=>{
            const ids=[...ov.querySelectorAll('input:checked')].map(c=>c.value);
            if(!ids.length)return toast('Select at least one order',true);
            for(const id of ids){
              const src=DB.order(id);
              for(const it of src.items){
                const ex=o.items.find(x=>x.sku===it.sku&&x.price===it.price);
                if(ex)ex.qty+=it.qty;else o.items.push(Object.assign({},it));
              }
              DB.d.orders=DB.d.orders.filter(x=>x.id!==id);
            }
            o.total=DB.orderTotal(o);
            saveAudit('order.merge',o.number,'Merged '+ids.length+' order(s) into '+o.number);
            close();render();toast('Orders merged');
          };
        }});
    };

    const chg=el.querySelector('#btn-chg-cust');
    if(chg)chg.onclick=()=>{
      if(o.status!=='pending')return toast('Only pending orders can be reassigned',true);
      const customers=DB.d.users.filter(u=>['customer','special customer'].includes(u.role));
      Modal.open({title:'Change customer',
        body:`<div class="field"><label>Reassign ${esc(o.number)} to</label>
          <select class="select" id="cc-sel">${customers.map(c=>`<option value="${c.id}" ${c.id===o.customerId?'selected':''}>${esc(c.business)}</option>`).join('')}</select></div>
          <div class="small muted">Both customers receive an email.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Reassign</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const nid=ov.querySelector('#cc-sel').value;
            const oldN=DB.userName(o.customerId);
            o.customerId=nid;
            saveAudit('order.reassign',o.number,oldN+' → '+DB.userName(nid)+' (both notified by email)');
            close();render();toast('Order reassigned — both customers emailed');
          };
        }});
    };

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

    /* ------- scanning ------- */
    const st=el.querySelector('#btn-start-scan');
    if(st)st.onclick=()=>{
      if(o.status!=='pending')return;
      local.scanning=true;o.status='collecting';saveAudit('order.collect.start',o.number,'Scanning started');render();
      setTimeout(()=>{const si=el.querySelector('#scan-input');if(si)si.focus();},50);
    };
    const cs=el.querySelector('#btn-cancel-scan');
    if(cs)cs.onclick=()=>{local.scanning=false;o.status='pending';saveAudit('order.collect.cancel',o.number,'Scanning cancelled');render();};

    const si=el.querySelector('#scan-input');
    if(si)si.addEventListener('keydown',e=>{
      if(e.key!=='Enter')return;
      const code=si.value.trim();si.value='';
      if(!code)return;
      const it=o.items.find(x=>x.sku.toLowerCase()===code.toLowerCase());
      if(!it){toast('SKU '+code+' is not on this order',true);return;}
      if(it.collected>=it.qty){toast(it.sku+' already fully collected',true);return;}
      it.collected++;beep();DB.save();render();
      setTimeout(()=>{const s2=el.querySelector('#scan-input');if(s2)s2.focus();},30);
    });
    const cam=el.querySelector('#btn-camera');
    if(cam)cam.onclick=()=>toast('Camera scanning: point your device camera at the barcode');
    el.querySelectorAll('[data-count]').forEach(b=>b.onclick=()=>{
      const it=o.items[parseInt(b.dataset.count,10)];
      if(it.collected<it.qty){it.collected++;DB.save();render();}
    });

    const comp=el.querySelector('#btn-complete');
    if(comp)comp.onclick=()=>{
      const missing=o.items.filter(i=>i.collected<i.qty);
      if(!missing.length){finishCollection(false);return;}
      Modal.open({title:'Missing items',size:'wide',
        body:`<div class="small">Some items weren't scanned (out of stock / not found):</div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Product</th><th>SKU</th><th>Ordered</th><th>Collected</th><th>Missing</th></tr></thead>
        <tbody>${missing.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.sku)}</td><td>${i.qty}</td><td>${i.collected}</td><td style="color:var(--red);font-weight:600">${i.qty-i.collected}</td></tr>`).join('')}</tbody></table></div>`,
        foot:`<button class="btn" data-x>Cancel</button>
              <button class="btn" data-anyway>Complete Anyway</button>
              <button class="btn btn-dark" data-backorder>Complete + send missing to Backorders</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-anyway]').onclick=()=>{close();finishCollection(false);toast('Order completed — customer emailed about missing items');};
          ov.querySelector('[data-backorder]').onclick=()=>{close();finishCollection(true);};
        }});
    };

    function finishCollection(makeBackorder){
      const missing=o.items.filter(i=>i.collected<i.qty);
      if(makeBackorder&&missing.length){
        const num='BO'+(DB.d.nextBackorderNumber++);
        DB.d.backorders.unshift({id:uid('bo'),number:num,orderId:o.id,orderNumber:o.number,
          customerId:o.customerId,status:'open',reason:'out_of_stock',eligible:false,
          items:missing.map(i=>({sku:i.sku,name:i.name,color:i.color,qty:i.qty-i.collected,price:i.price})),
          createdAt:todayISO(),convertedOrderId:null});
        /* keep only collected qty on the original order */
        o.items.forEach(i=>{i.qty=Math.max(i.collected,0)||i.collected;});
        o.items=o.items.filter(i=>i.qty>0);
        DB.audit('backorder.create',num,'From '+o.number+' — '+missing.length+' item(s)');
        toast('Backorder '+num+' created for missing items');
      }
      o.status='collected';o.total=DB.orderTotal(o);local.scanning=false;
      saveAudit('order.collect.complete',o.number,'Collection completed');
      render();
    }

    /* ------- item editing ------- */
    el.querySelectorAll('[data-edit-item]').forEach(b=>b.onclick=()=>{
      const ix=parseInt(b.dataset.editItem,10),it=o.items[ix];
      Modal.open({title:'Edit item — '+it.sku,
        body:`
        <div class="two-col">
          <div class="field"><label>Quantity</label><input class="input" id="ei-qty" type="number" min="1" value="${it.qty}"></div>
          <div class="field"><label>Swap to SKU</label><input class="input" id="ei-swap" placeholder="Type a different SKU"></div>
        </div>
        <div class="small muted">Swapping releases the old stock and reserves the new one automatically.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Save</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const qty=parseInt(ov.querySelector('#ei-qty').value,10)||it.qty;
            const swap=ov.querySelector('#ei-swap').value.trim();
            if(swap){
              const hit=DB.variationBySku(swap);
              if(!hit)return toast('SKU '+swap+' not found',true);
              releaseStock(it.sku,it.qty);reserveStock(hit.v.sku,qty);
              const cust=DB.user(o.customerId);
              it.sku=hit.v.sku;it.name=hit.p.name;it.color=hit.v.color;
              it.price=DB.priceForCustomer(cust,hit.p,hit.v);
              DB.audit('order.item.swap',o.number,'Swapped to '+hit.v.sku);
            }
            it.qty=qty;it.collected=Math.min(it.collected,qty);
            o.total=DB.orderTotal(o);saveAudit('order.item.edit',o.number,it.sku+' qty → '+qty);
            close();render();
          };
        }});
    });
    el.querySelectorAll('[data-del-item]').forEach(b=>b.onclick=()=>{
      const ix=parseInt(b.dataset.delItem,10),it=o.items[ix];
      Modal.confirm('Delete item','Remove <b>'+esc(it.name)+'</b> ('+esc(it.sku)+') from the order? The total is recalculated and the stock is released.',()=>{
        releaseStock(it.sku,it.qty);
        o.items.splice(ix,1);o.total=DB.orderTotal(o);
        saveAudit('order.item.delete',o.number,'Removed '+it.sku);
        render();toast('Item removed — stock released');
      },'Delete');
    });
    const add=el.querySelector('#btn-add-item');
    if(add)add.onclick=()=>{
      Modal.open({title:'Add item',
        body:`<div class="two-col">
          <div class="field"><label>SKU</label><input class="input" id="ai-sku" placeholder="Type a SKU"></div>
          <div class="field"><label>Quantity</label><input class="input" id="ai-qty" type="number" min="1" value="1"></div>
        </div>
        <div class="small muted">The price is set according to the customer's pricing tier.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Add</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const sku=ov.querySelector('#ai-sku').value.trim(),qty=parseInt(ov.querySelector('#ai-qty').value,10)||1;
            const hit=DB.variationBySku(sku);
            if(!hit)return toast('SKU not found',true);
            const cust=DB.user(o.customerId);
            const price=DB.priceForCustomer(cust,hit.p,hit.v);
            const ex=o.items.find(x=>x.sku===hit.v.sku);
            if(ex)ex.qty+=qty;else o.items.push({sku:hit.v.sku,name:hit.p.name,color:hit.v.color,qty,price,collected:0});
            reserveStock(hit.v.sku,qty);
            o.total=DB.orderTotal(o);saveAudit('order.item.add',o.number,hit.v.sku+' × '+qty);
            close();render();toast('Item added at '+money(price));
          };
        }});
    };
    const disc=el.querySelector('#btn-discount');
    if(disc)disc.onclick=()=>{
      const sess=Auth.current();
      if(!['admin','super-agent'].includes(sess.role))return toast('Admin / super-agent only',true);
      Modal.open({title:'Admin discount',
        body:`<div class="two-col">
          <div class="field"><label>Type</label><select class="select" id="ad-type"><option value="pct">Percentage (%)</option><option value="fix">Fixed amount ($)</option></select></div>
          <div class="field"><label>Value</label><input class="input" id="ad-val" type="number" min="0" value="${o.discountPct||o.discount||0}"></div>
        </div>
        <div class="small muted">Applied on top of any existing promotion. Admin / super-agent only.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Apply</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const v=parseFloat(ov.querySelector('#ad-val').value)||0;
            if(ov.querySelector('#ad-type').value==='pct'){o.discountPct=v;o.discount=0;}
            else{o.discount=v;o.discountPct=0;}
            o.total=DB.orderTotal(o);
            saveAudit('order.discount',o.number,'Admin discount applied');
            close();render();toast('Discount applied');
          };
        }});
    };

    /* ------- status & shipping ------- */
    el.querySelector('#btn-set-status').onclick=()=>{
      const ns=el.querySelector('#sel-status').value;
      const old=o.status;o.status=ns;
      if(ns==='pending')o.items.forEach(i=>i.collected=0);
      saveAudit('order.status',o.number,old+' → '+ns);
      render();toast('Status updated to '+ns);
    };
    el.querySelector('#btn-ship').onclick=()=>{
      const num=el.querySelector('#ship-track').value.trim();
      if(!num)return toast('Enter a tracking number',true);
      o.tracking={company:el.querySelector('#ship-co').value,number:num};
      o.status='shipped';
      saveAudit('order.ship',o.number,o.tracking.company+' '+num+' — customer notified');
      render();toast('Order marked as shipped — customer notified');
    };

    /* ------- comments ------- */
    el.querySelector('#btn-comment').onclick=()=>{
      const inp=el.querySelector('#comment-input');
      const txt=inp.value.trim();if(!txt)return;
      o.comments.push({by:Auth.current().name,text:txt,at:new Date().toISOString()});
      saveAudit('order.comment',o.number,'Comment posted — all admins emailed');
      render();toast('Comment posted — all admins emailed');
    };
  }
  render();
});

/* ============================================================ QUICK SCAN EDIT */
App.register('quick-scan',function(el){
  const state=App._qs||(App._qs={order:null,qty:1,scans:[]});

  function render(){
    const o=state.order?DB.order(state.order):null;
    el.innerHTML=`
    <div class="flex" style="margin-bottom:14px">${I.scan}<div class="page-title" style="font-size:16px">Quick Order Scanner</div></div>
    <div class="info-banner">${I.eye}<div>Scan SKUs (or EANs) to add, increment, or decrement product lines on an existing <b>pending</b>, <b>approved</b> or <b>collecting</b> order. Promotions re-evaluate automatically after every scan.</div></div>
    <div class="card card-pad" style="margin-top:14px">
      <div class="flex">
        <input class="input" id="qs-order" placeholder="Order number" style="flex:1" value="${o?esc(o.number):''}">
        <button class="btn btn-dark" id="qs-load">Load Order</button>
      </div>
    </div>
    ${o?`
    <div class="card card-pad" style="margin-top:14px">
      <div class="flex" style="justify-content:space-between">
        <div><b>${esc(o.number)}</b> &middot; ${esc(DB.userName(o.customerId))}</div>
        ${statusBadge(o.status)}
        <div class="money-green">${money(DB.orderTotal(o))}</div>
      </div>
      ${['pending','approved','collecting'].includes(o.status)?`
      <div class="divider"></div>
      <div class="flex">
        <div class="fieldset-outline" style="width:130px"><label>Quantity</label><input type="number" id="qs-qty" value="${state.qty}"></div>
        <input class="input" id="qs-sku" placeholder="Scan a SKU or barcode (EAN) and press Enter" style="flex:1;font-size:15px" autofocus>
      </div>
      <div class="small muted" style="margin-top:8px">A negative quantity removes items.</div>`:
      `<div class="note-banner" style="margin-top:12px">This order is <b>${o.status}</b> — quick scan works on pending / approved / collecting orders only.</div>`}
    </div>
    <div class="card card-pad" style="margin-top:14px">
      <div class="card-title">Recent scans</div>
      ${state.scans.length?state.scans.map(s=>`
        <div class="flex" style="padding:7px 0;border-bottom:1px solid var(--line-2)">
          <span class="dot" style="background:${s.qty>0?'var(--green)':'var(--red)'}"></span>
          <b>${esc(s.sku)}</b><span class="muted">${esc(s.name)}</span>
          <span>${s.qty>0?'+':''}${s.qty}</span>
          <span class="right">Total: <b>${money(s.total)}</b></span>
        </div>`).join(''):'<div class="muted small">No scans yet.</div>'}
    </div>`:''}`;

    el.querySelector('#qs-load').onclick=()=>{
      const n=el.querySelector('#qs-order').value.trim();
      const ord=DB.order(n)||DB.order('SO'+n);
      if(!ord)return toast('Order not found',true);
      state.order=ord.id;state.scans=[];render();
    };
    el.querySelector('#qs-order').addEventListener('keydown',e=>{if(e.key==='Enter')el.querySelector('#qs-load').click();});
    const qty=el.querySelector('#qs-qty');
    if(qty)qty.onchange=()=>{state.qty=parseInt(qty.value,10)||1;};
    const sku=el.querySelector('#qs-sku');
    if(sku)sku.addEventListener('keydown',e=>{
      if(e.key!=='Enter')return;
      const code=sku.value.trim();sku.value='';if(!code)return;
      const hit=DB.variationBySku(code);
      if(!hit)return toast('SKU / EAN not found',true);
      const o=DB.order(state.order);
      const q=state.qty;
      let it=o.items.find(x=>x.sku===hit.v.sku);
      if(q>0){
        if(it)it.qty+=q;
        else{const cust=DB.user(o.customerId);o.items.push({sku:hit.v.sku,name:hit.p.name,color:hit.v.color,qty:q,price:DB.priceForCustomer(cust,hit.p,hit.v),collected:0});}
        reserveStock(hit.v.sku,q);
      }else if(it){
        it.qty=Math.max(0,it.qty+q);
        releaseStock(hit.v.sku,-q);
        if(it.qty===0)o.items=o.items.filter(x=>x!==it);
      }else return toast(hit.v.sku+' is not on the order',true);
      o.total=DB.orderTotal(o);
      DB.save();DB.audit('order.quickscan',o.number,hit.v.sku+' '+(q>0?'+':'')+q);
      beep();
      state.scans.unshift({sku:hit.v.sku,name:hit.p.name,qty:q,total:o.total});
      state.scans=state.scans.slice(0,12);
      render();
      setTimeout(()=>{const s2=el.querySelector('#qs-sku');if(s2)s2.focus();},30);
    });
  }
  render();
});

/* ============================================================ BACKORDERS */
App.register('backorders',function(el){
  const state=App._bo||(App._bo={status:'',page:1});

  function render(){
    let list=DB.d.backorders.slice();
    if(state.status)list=list.filter(b=>b.status===state.status);
    const p=paginate(list,state.page);
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Backorders</div>
      <select class="select" id="bo-status">
        <option value="">Status</option>
        ${['open','converted','cancelled'].map(s=>`<option ${state.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Backorder #</th><th>Original Order</th><th>Customer</th><th>Status</th><th>Reason</th><th>Eligible</th><th>Items</th><th>Created</th><th>Actions</th></tr></thead>
        <tbody>
        ${p.slice.length?p.slice.map(b=>`<tr>
          <td class="cell-main">${esc(b.number)}</td>
          <td>${esc(b.orderNumber)}</td>
          <td>${esc(DB.userName(b.customerId))}</td>
          <td>${statusBadge(b.status)}</td>
          <td><span class="badge ${b.reason==='out_of_stock'?'yellow':'gray'}">${esc(b.reason)}</span></td>
          <td>${b.eligible?'<span class="badge green">Eligible</span>':'<span class="badge gray">Not yet</span>'}</td>
          <td>${b.items.reduce((s,i)=>s+i.qty,0)}</td>
          <td>${fmtDateShort(b.createdAt)}</td>
          <td><div class="row-actions">
            ${b.status==='open'&&!b.eligible?`<button class="btn btn-sm" data-el="${b.id}">Mark eligible</button>`:''}
            ${b.status==='open'&&b.eligible?`<button class="btn btn-sm btn-dark" data-cv="${b.id}">Convert</button>`:''}
            <button class="icon-btn" data-view="${b.id}" title="Details">${I.eye}</button>
          </div></td>
        </tr>`).join(''):`<tr><td colspan="9" class="empty-cell">No backorders found</td></tr>`}
        </tbody></table></div>
      ${pagerHTML(p)}
    </div>`;

    el.querySelector('#bo-status').onchange=e=>{state.status=e.target.value;state.page=1;render();};
    bindPager(el,pg=>{state.page=pg;render();});
    el.querySelectorAll('[data-el]').forEach(b=>b.onclick=()=>{
      const bo=DB.d.backorders.find(x=>x.id===b.dataset.el);
      bo.eligible=true;DB.save();DB.audit('backorder.eligible',bo.number,'Marked eligible');
      render();toast(bo.number+' marked eligible');
    });
    el.querySelectorAll('[data-cv]').forEach(b=>b.onclick=()=>{
      const bo=DB.d.backorders.find(x=>x.id===b.dataset.cv);
      Modal.confirm('Convert Backorder','Convert <b>'+esc(bo.number)+'</b> into a new fulfillment order for '+esc(DB.userName(bo.customerId))+'? Free shipping, prices locked from the backorder; stock is reserved.',()=>{
        const num='SO'+(DB.d.nextOrderNumber++);
        const order={id:uid('o'),number:num,customerId:bo.customerId,agentId:null,
          date:todayISO(),status:'pending',source:'customer',freeShipping:true,
          items:bo.items.map(i=>({sku:i.sku,name:i.name,color:i.color,qty:i.qty,price:i.price,collected:0})),
          discount:0,tracking:null,comments:[],invoiceId:null,total:0};
        order.total=DB.orderTotal(order);
        order.items.forEach(i=>reserveStock(i.sku,i.qty));
        DB.d.orders.push(order);
        bo.status='converted';bo.convertedOrderId=order.id;bo.convertedOrderNumber=num;
        DB.save();DB.audit('backorder.convert',bo.number,'→ '+num+' for '+DB.userName(bo.customerId)+' — '+money(order.total));
        toast('Converted to '+num);
        location.hash='#/order/'+order.id;
      },'Convert');
    });
    el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
      const bo=DB.d.backorders.find(x=>x.id===b.dataset.view);
      Modal.open({title:'Backorder '+bo.number,size:'wide',
        body:`
        <div class="kv">
          <dt>Customer</dt><dd>${esc(DB.userName(bo.customerId))}</dd>
          <dt>Source order</dt><dd>${esc(bo.orderNumber)}</dd>
          <dt>New order</dt><dd>${bo.convertedOrderNumber?esc(bo.convertedOrderNumber):'—'}</dd>
          <dt>Status / reason</dt><dd>${statusBadge(bo.status)} <span class="badge gray">${esc(bo.reason)}</span></dd>
        </div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>Price</th><th>Current stock</th></tr></thead>
          <tbody>${bo.items.map(i=>{
            const hit=DB.variationBySku(i.sku);
            const stock=hit?DB.variationQty(hit.v):0;
            return `<tr><td>${esc(i.name)}</td><td>${esc(i.sku)}</td><td>${i.qty}</td><td>${money(i.price)}</td>
              <td>${stock>0?'<span class="badge green">'+stock+'</span>':'<span class="badge red">0</span>'}</td></tr>`;}).join('')}
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
            orderSel.innerHTML='<option value="">—</option>'+list.map(o=>`<option value="${o.number}">${o.number} — ${money(o.total)}</option>`).join('');
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
      case 'By Customer':return ['Customer','Orders','Amount','Frames'];
      case 'By Item':return ['Product / SKU','Units sold','Revenue'];
      case 'By Agent':return ['Agent','Orders','Customers','Revenue','Avg order value'];
      default:return ['City','Orders','Revenue'];
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
              .map(o=>`<div class="flex small" style="padding:3px 0"><a class="link" href="#/order/${o.id}">${o.number}</a><span>${fmtDateShort(o.date)}</span>${statusBadge(o.status)}<span class="right">${money(o.total)}</span></div>`).join('')}
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
