/* ================= Pages: Operations — Shipping, Free Shipping, Agent Revenue + Audit Log ================= */
'use strict';

/* ============================================================ SHIPPING SETTINGS */
App.register('shipping',function(el){
  function ruleForm(existing){
    const r=existing||{country:'US',threshold:300,cost:15,active:true};
    Modal.open({title:existing?'Edit Rule':'Add Shipping Rule',
      body:`
      <div class="two-col">
        <div class="field"><label>Country</label><select class="select" id="sr-country">
          <option ${r.country==='US'?'selected':''}>US</option><option ${r.country==='CA'?'selected':''}>CA</option></select></div>
        <div class="field"><label>Free Shipping Threshold ($)</label><input class="input" type="number" id="sr-thr" value="${r.threshold}"></div>
        <div class="field"><label>Shipping Cost below threshold ($)</label><input class="input" type="number" id="sr-cost" value="${r.cost}"></div>
        <div class="field" style="justify-content:flex-end"><label class="checkbox-row"><input type="checkbox" id="sr-active" ${r.active?'checked':''}> Active — the rule will apply at checkout</label></div>
      </div>
      <div class="dashed-banner">At checkout: if the order total &ge; the threshold &rarr; free shipping; otherwise the cost is added. With no active rule — no shipping charge applies.</div>`,
      foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Save Rule</button>`,
      setup(ov,close){
        ov.querySelector('[data-x]').onclick=close;
        ov.querySelector('[data-ok]').onclick=()=>{
          const vals={country:ov.querySelector('#sr-country').value,
            threshold:parseFloat(ov.querySelector('#sr-thr').value)||0,
            cost:parseFloat(ov.querySelector('#sr-cost').value)||0,
            active:ov.querySelector('#sr-active').checked};
          if(existing)Object.assign(existing,vals);
          else DB.d.shippingRules.push(Object.assign({id:uid('sr')},vals));
          DB.save();DB.audit('shipping.rule',vals.country,'Threshold '+money(vals.threshold)+' / cost '+money(vals.cost)+(vals.active?' (active)':' (inactive)'));
          close();render();toast('Shipping rule saved');
        };
      }});
  }

  function render(){
    const d=DB.d;
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Shipping Settings</div>
      <button class="btn btn-dark" id="sr-add">${I.plus} Add Rule</button>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Country</th><th>Free Shipping Threshold</th><th>Shipping Cost</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>${d.shippingRules.length?d.shippingRules.map(r=>`<tr>
          <td class="cell-main">${esc(r.country)}</td>
          <td>${money(r.threshold)}</td>
          <td>${money(r.cost)}</td>
          <td>${r.active?'<span class="badge green">Active</span>':'<span class="badge gray">Inactive</span>'}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-edit="${r.id}">${I.pencil}</button>
            <button class="icon-btn danger" data-del="${r.id}">${I.trash}</button>
          </div></td>
        </tr>`).join(''):`<tr><td colspan="5" class="empty-cell">No shipping rules configured. Click "Add Rule" to create one.</td></tr>`}
        </tbody></table></div>
    </div>`;
    el.querySelector('#sr-add').onclick=()=>ruleForm(null);
    el.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>ruleForm(DB.d.shippingRules.find(x=>x.id===b.dataset.edit)));
    el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      Modal.confirm('Delete rule','Delete this shipping rule?',()=>{
        DB.d.shippingRules=DB.d.shippingRules.filter(x=>x.id!==b.dataset.del);
        DB.save();render();
      },'Delete');
    });
  }
  render();
});

/* ============================================================ FREE SHIPPING FOR SELECTED CUSTOMERS */
App.register('free-shipping',function(el){
  const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function nextShip(day){
    const target=DAYS.indexOf(day);
    const now=new Date();
    let delta=(target-now.getDay()+7)%7;if(delta===0)delta=7;
    return isoDay(new Date(now.getTime()+delta*864e5));
  }
  function render(){
    const d=DB.d;
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Preferred Customers - Free Shipping</div>
      <button class="btn btn-dark" id="fs-add">${I.plus} Add Customer</button>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Customer</th><th>Business</th><th>Day of Week</th><th>Next Ship Date</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>${d.freeShipping.length?d.freeShipping.map(f=>{
          const u=DB.user(f.customerId)||{};
          return `<tr>
            <td class="cell-main">${esc((u.firstName||'')+' '+(u.lastName||''))}</td>
            <td>${esc(u.business||'—')}</td>
            <td><span class="badge outline">${esc(f.day)}</span></td>
            <td>${fmtDateShort(nextShip(f.day))}</td>
            <td>${f.active?'<span class="badge green">Active</span>':'<span class="badge gray">Inactive</span>'}</td>
            <td><div class="row-actions"><button class="icon-btn danger" data-del="${f.id}">${I.trash}</button></div></td>
          </tr>`;}).join(''):`<tr><td colspan="6" class="empty-cell">No preferred customers configured. Click "Add Customer" to set up free shipping schedules.</td></tr>`}
        </tbody></table></div>
    </div>
    <div class="small muted" style="margin-top:10px">Preferred customers get free shipping on set days of the week (e.g. a chain that always orders on Mondays), regardless of order amount.</div>`;

    el.querySelector('#fs-add').onclick=()=>{
      const customers=d.users.filter(u=>['customer','special customer'].includes(u.role));
      Modal.open({title:'Add Free-Shipping Customer',
        body:`
        <div class="field"><label>Customer</label>
          <select class="select" id="fs-cust">${customers.map(c=>`<option value="${c.id}">${esc(c.business)}</option>`).join('')}</select></div>
        <div class="field"><label>Day of Week</label>
          <select class="select" id="fs-day">${DAYS.map(dd=>`<option>${dd}</option>`).join('')}</select></div>
        <label class="checkbox-row"><input type="checkbox" id="fs-active" checked> Active — orders from that customer on that day will ship for free</label>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Save</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            d.freeShipping.push({id:uid('fs'),customerId:ov.querySelector('#fs-cust').value,
              day:ov.querySelector('#fs-day').value,active:ov.querySelector('#fs-active').checked});
            DB.save();DB.audit('free-shipping.add',DB.userName(d.freeShipping[d.freeShipping.length-1].customerId),d.freeShipping[d.freeShipping.length-1].day);
            close();render();toast('Free-shipping customer added');
          };
        }});
    };
    el.querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
      Modal.confirm('Remove','Remove this free-shipping schedule?',()=>{
        d.freeShipping=d.freeShipping.filter(x=>x.id!==b.dataset.del);
        DB.save();render();
      },'Remove');
    });
  }
  render();
});

/* ============================================================ PURCHASING (supplier POs + receiving into stock) */
App.register('purchasing',function(el){
  const d=DB.d;d.purchaseOrders=d.purchaseOrders||[];d.nextPoNumber=d.nextPoNumber||1;
  const sumQ=po=>po.items.reduce((s,i)=>s+(i.qty||0),0);
  const sumR=po=>po.items.reduce((s,i)=>s+(i.received||0),0);
  function render(){
    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Purchasing</div>
      <button class="btn btn-dark" id="po-add">${I.plus} New Purchase Order</button>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>PO</th><th>Supplier</th><th>Expected</th><th>Items</th><th>Received</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${d.purchaseOrders.length?d.purchaseOrders.map(po=>`<tr>
          <td class="cell-main">${esc(po.number)}</td>
          <td>${esc(po.supplier)}</td>
          <td>${po.expectedOn?fmtDateShort(po.expectedOn):'—'}</td>
          <td>${po.items.length} lines · ${sumQ(po)} pcs</td>
          <td>${sumR(po)} / ${sumQ(po)}</td>
          <td>${statusBadge(po.status)}</td>
          <td><div class="row-actions">
            ${['ordered','partially received'].includes(po.status)?`<button class="btn btn-sm" data-recv="${po.id}">Receive</button>`:''}
            <button class="btn btn-sm" data-view="${po.id}">View</button>
            ${['draft','ordered'].includes(po.status)?`<button class="icon-btn danger" title="Cancel" data-cancel="${po.id}">${I.trash}</button>`:''}
          </div></td>
        </tr>`).join(''):`<tr><td colspan="7" class="empty-cell">No purchase orders yet. "New Purchase Order" records what you buy from suppliers; receiving it adds the stock.</td></tr>`}
        </tbody></table></div>
    </div>
    <div class="small muted" style="margin-top:10px">Receiving a PO adds the quantities to warehouse stock and shows on the storefront immediately. (While the Zoho sync is active, Zoho still overrides stock — purchasing becomes authoritative after cutover.)</div>`;

    el.querySelector('#po-add').onclick=()=>{
      const items=[];
      Modal.open({title:'New Purchase Order',
        body:`
        <div class="grid-2">
          <div class="field"><label>Supplier</label><input class="input" id="po-sup" placeholder="e.g. Kyme SRL"></div>
          <div class="field"><label>Expected arrival</label><input class="input" type="date" id="po-exp"></div>
        </div>
        <div class="field"><label>Add line — variation SKU</label><div class="flex">
          <input class="input" id="po-sku" placeholder="e.g. 3507.61" style="flex:2">
          <input class="input" id="po-qty" type="number" min="1" value="10" style="width:80px">
          <input class="input" id="po-cost" type="number" min="0" step="0.01" placeholder="unit cost" style="width:110px">
          <button class="btn" id="po-line-add">Add</button>
        </div></div>
        <div id="po-lines"></div>
        <div class="field" style="margin-top:8px"><label>Notes</label><input class="input" id="po-notes"></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Create PO</button>`,
        setup(ov,close){
          function paint(){
            ov.querySelector('#po-lines').innerHTML=items.map((it,ix)=>`
              <div class="flex" style="border:1px solid var(--line);border-radius:9px;padding:7px 12px;margin-bottom:6px">
                <b>${esc(it.sku)}</b><span class="muted">${esc(it.name)}</span>
                <span>× ${it.qty}</span>${it.cost?`<span class="muted">@ ${money(it.cost)}</span>`:''}
                <button class="icon-btn danger right" data-rm="${ix}">${I.trash}</button>
              </div>`).join('');
            ov.querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{items.splice(parseInt(b.dataset.rm,10),1);paint();});
          }
          ov.querySelector('#po-line-add').onclick=()=>{
            const sku=ov.querySelector('#po-sku').value.trim();
            const hit=DB.variationBySku(sku);
            if(!hit)return toast('SKU not found',true);
            items.push({sku:hit.v.sku,name:hit.p.name,qty:parseInt(ov.querySelector('#po-qty').value,10)||1,
              received:0,cost:parseFloat(ov.querySelector('#po-cost').value)||null});
            ov.querySelector('#po-sku').value='';paint();
          };
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            if(!items.length)return toast('Add at least one line',true);
            const num='PO'+(d.nextPoNumber++);
            d.purchaseOrders.unshift({id:uid('po'),number:num,supplier:ov.querySelector('#po-sup').value.trim(),
              status:'ordered',notes:ov.querySelector('#po-notes').value,expectedOn:ov.querySelector('#po-exp').value||null,
              items,createdAt:new Date().toISOString()});
            DB.save();DB.audit('po.create',num,items.length+' line(s), '+items.reduce((s,i)=>s+i.qty,0)+' pcs');
            close();render();toast('Purchase order '+num+' created');
          };
        }});
    };

    el.querySelectorAll('[data-recv]').forEach(b=>b.onclick=()=>{
      const po=d.purchaseOrders.find(x=>x.id===b.dataset.recv);
      Modal.open({title:'Receive '+po.number,
        body:`
        <div class="field"><label>Into warehouse</label>
          <select class="select" id="rc-wh">${d.warehouses.map(w=>`<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>SKU</th><th>Product</th><th>Ordered</th><th>Received</th><th style="width:110px">Receive now</th></tr></thead>
          <tbody>${po.items.map((it,ix)=>`<tr>
            <td class="cell-main">${esc(it.sku)}</td><td>${esc(it.name)}</td>
            <td>${it.qty}</td><td>${it.received||0}</td>
            <td><input class="input" type="number" min="0" style="width:90px;padding:5px 8px" data-rc="${ix}"
              value="${Math.max(0,it.qty-(it.received||0))}" onwheel="this.blur()"></td>
          </tr>`).join('')}</tbody></table></div>
        <div class="dashed-banner">Received quantities are added to the selected warehouse's stock and appear on the storefront right away.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Receive</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const wh=ov.querySelector('#rc-wh').value;let total=0;
            po.items.forEach((it,ix)=>{
              const n=Math.max(0,parseInt(ov.querySelector(`[data-rc="${ix}"]`).value,10)||0);
              if(!n)return;
              const hit=DB.variationBySku(it.sku);
              if(!hit)return toast(it.sku+' no longer exists — skipped',true);
              hit.v.stock=hit.v.stock||{};hit.v.stock[wh]=hit.v.stock[wh]||{qty:0,shelf:''};
              hit.v.stock[wh].qty+=n;it.received=(it.received||0)+n;total+=n;
            });
            if(!total)return toast('Nothing to receive',true);
            po.status=po.items.every(it=>(it.received||0)>=it.qty)?'received':'partially received';
            DB.save();DB.audit('po.receive',po.number,total+' pcs into '+ (DB.d.warehouses.find(w=>w.id===wh)?.name||wh));
            close();render();toast(total+' pcs received into stock');
          };
        }});
    });

    el.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
      const po=d.purchaseOrders.find(x=>x.id===b.dataset.view);
      Modal.open({title:po.number+' — '+(po.supplier||'supplier'),
        body:`<div class="kv"><dt>Status</dt><dd>${statusBadge(po.status)}</dd>
          <dt>Expected</dt><dd>${po.expectedOn?fmtDateShort(po.expectedOn):'—'}</dd>
          ${po.notes?`<dt>Notes</dt><dd>${esc(po.notes)}</dd>`:''}</div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>SKU</th><th>Product</th><th>Ordered</th><th>Received</th><th>Unit cost</th></tr></thead>
        <tbody>${po.items.map(it=>`<tr><td>${esc(it.sku)}</td><td>${esc(it.name)}</td><td>${it.qty}</td><td>${it.received||0}</td><td>${it.cost?money(it.cost):'—'}</td></tr>`).join('')}</tbody></table></div>`,
        foot:`<button class="btn" data-x>Close</button>`,
        setup(ov,close){ov.querySelector('[data-x]').onclick=close;}});
    });

    el.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>{
      const po=d.purchaseOrders.find(x=>x.id===b.dataset.cancel);
      Modal.confirm('Cancel PO','Cancel <b>'+esc(po.number)+'</b>? Nothing already received is removed from stock.',()=>{
        po.status='cancelled';DB.save();DB.audit('po.cancel',po.number,'');render();
      },'Cancel PO');
    });
  }
  render();
});

/* ============================================================ AGENT REVENUE */
App.register('agent-revenue',function(el){
  const state=App._ar||(App._ar={from:todayISO(),to:todayISO(),direct:15,referral:5,country:'',placedBy:'',rows:null,drill:null});

  function shortcut(days){
    const now=new Date();
    if(days==='YTD')state.from=now.getFullYear()+'-01-01';
    else if(days==='All time')state.from='2020-01-01';
    else state.from=isoDay(new Date(now-(+days)*864e5));
    state.to=todayISO();
  }

  function calc(){
    const d=DB.d;
    let orders=d.orders.filter(o=>o.status!=='cancelled'&&o.date>=state.from&&o.date<=state.to);
    if(state.country)orders=orders.filter(o=>{const c=DB.user(o.customerId);return c&&c.country===state.country;});
    if(state.placedBy==='agent')orders=orders.filter(o=>o.source==='agent');
    if(state.placedBy==='customer')orders=orders.filter(o=>o.source==='customer');
    const agents=d.users.filter(u=>['agent','super-agent'].includes(u.role));
    /* prior period for growth */
    const spanMs=new Date(state.to)-new Date(state.from)+864e5;
    const prevFrom=isoDay(new Date(new Date(state.from)-spanMs)),prevTo=isoDay(new Date(new Date(state.from)-864e5));
    const prevOrders=d.orders.filter(o=>o.status!=='cancelled'&&o.date>=prevFrom&&o.date<=prevTo);
    state.rows=agents.map(a=>{
      const direct=orders.filter(o=>o.agentId===a.id);
      const refCust=d.users.filter(u=>u.agentId===a.id).map(u=>u.id);
      const referral=orders.filter(o=>!o.agentId&&refCust.includes(o.customerId));
      const dRev=direct.reduce((s,o)=>s+o.total,0);
      const rRev=referral.reduce((s,o)=>s+o.total,0);
      const commission=dRev*state.direct/100+rRev*state.referral/100;
      const prevRev=prevOrders.filter(o=>o.agentId===a.id||(!o.agentId&&refCust.includes(o.customerId))).reduce((s,o)=>s+o.total,0);
      const curRev=dRev+rRev;
      const growth=prevRev>0?((curRev-prevRev)/prevRev*100):(curRev>0?100:0);
      return {agent:a,direct:direct.length,dRev,referral:referral.length,rRev,commission,growth,refCust};
    }).sort((a,b)=>(b.dRev+b.rRev)-(a.dRev+a.rRev));
  }

  function render(){
    el.innerHTML=`
    <div class="page-head"><div class="page-title">Revenue</div></div>
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="flex">
        <div class="fieldset-outline"><label>Start Date</label><input type="date" id="ar-from" value="${state.from}"></div>
        <div class="fieldset-outline"><label>End Date</label><input type="date" id="ar-to" value="${state.to}"></div>
        <div class="fieldset-outline" style="width:120px"><label>Direct Rate %</label><input type="number" id="ar-direct" value="${state.direct}"></div>
        <div class="fieldset-outline" style="width:120px"><label>Referral Rate %</label><input type="number" id="ar-ref" value="${state.referral}"></div>
        <button class="btn btn-dark" id="ar-calc">Calculate</button>
      </div>
      <div class="flex" style="margin-top:10px">
        <select class="select" id="ar-country"><option value="">Country (filter revenue)</option>
          <option ${state.country==='US'?'selected':''}>US</option><option ${state.country==='CA'?'selected':''}>CA</option></select>
        <select class="select" id="ar-placed"><option value="">Placed by</option>
          <option value="agent" ${state.placedBy==='agent'?'selected':''}>Agent</option>
          <option value="customer" ${state.placedBy==='customer'?'selected':''}>Customer</option></select>
      </div>
      <div class="chip-row" style="margin-top:10px">
        ${['14d','30d','60d','90d','YTD','All time','Custom'].map(s=>`<button class="chip" data-sc="${s}">${s}</button>`).join('')}
      </div>
    </div>
    ${state.rows?`
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Agent</th><th>Direct Orders</th><th class="num">Direct Revenue</th><th>Referral Orders</th><th class="num">Referral Revenue</th><th class="num">Total Commission</th><th>Growth vs prior</th></tr></thead>
        <tbody>${state.rows.map((r,ix)=>`
          <tr class="clickable" data-drill="${ix}">
            <td class="cell-main">${esc(r.agent.firstName+' '+r.agent.lastName)} <span class="badge outline">${esc(r.agent.role)}</span></td>
            <td>${r.direct}</td><td class="num">${money(r.dRev)}</td>
            <td>${r.referral}</td><td class="num">${money(r.rRev)}</td>
            <td class="num money-green">${money(r.commission)}</td>
            <td>${r.growth>=0?`<span class="badge green">+${r.growth.toFixed(1)}%</span>`:`<span class="badge red">${r.growth.toFixed(1)}%</span>`}</td>
          </tr>
          ${state.drill===ix?`<tr><td colspan="7" style="background:#fbf8f1">
            <b class="small">Referral customers of ${esc(r.agent.firstName)}</b>
            <div class="flex" style="flex-wrap:wrap;margin-top:6px">
              ${r.refCust.slice(0,20).map(id=>`<span class="tag-pill">${esc(DB.userName(id))}</span>`).join('')||'<span class="muted small">None</span>'}
            </div></td></tr>`:''}`).join('')}
        </tbody></table></div>
    </div>`:''}`;

    el.querySelector('#ar-from').onchange=e=>state.from=e.target.value;
    el.querySelector('#ar-to').onchange=e=>state.to=e.target.value;
    el.querySelector('#ar-direct').onchange=e=>state.direct=+e.target.value;
    el.querySelector('#ar-ref').onchange=e=>state.referral=+e.target.value;
    el.querySelector('#ar-country').onchange=e=>state.country=e.target.value;
    el.querySelector('#ar-placed').onchange=e=>state.placedBy=e.target.value;
    el.querySelector('#ar-calc').onclick=()=>{calc();state.drill=null;render();};
    el.querySelectorAll('[data-sc]').forEach(b=>b.onclick=()=>{
      if(b.dataset.sc!=='Custom')shortcut(b.dataset.sc.replace('d',''));
      calc();state.drill=null;render();
    });
    el.querySelectorAll('[data-drill]').forEach(tr=>tr.onclick=()=>{
      const ix=+tr.dataset.drill;
      state.drill=state.drill===ix?null:ix;render();
    });
  }
  render();
});

/* ============================================================ AUDIT LOG */
App.register('audit',function(el){
  const state=App._audit||(App._audit={from:'',to:'',action:'',source:'',actor:'',page:1});

  function render(){
    const d=DB.d;
    let list=d.audit.slice();
    if(state.from)list=list.filter(e=>e.when>=state.from);
    if(state.to)list=list.filter(e=>e.when<=state.to+'T23:59');
    if(state.action)list=list.filter(e=>e.action.startsWith(state.action));
    if(state.source)list=list.filter(e=>e.source===state.source);
    if(state.actor)list=list.filter(e=>(e.actorId||'').includes(state.actor)||(e.actorName||'').toLowerCase().includes(state.actor.toLowerCase()));
    const p=paginate(list,state.page,12);
    const actions=[...new Set(d.audit.map(e=>e.action.split('.')[0]))].sort();

    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Audit log</div>
      <span class="muted small">${list.length} events</span>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="flex">
        <div class="fieldset-outline"><label>From</label><input type="datetime-local" id="au-from" value="${state.from}"></div>
        <div class="fieldset-outline"><label>To</label><input type="datetime-local" id="au-to" value="${state.to}"></div>
        <select class="select" id="au-action"><option value="">Action</option>
          ${actions.map(a=>`<option ${state.action===a?'selected':''}>${a}</option>`).join('')}</select>
        <select class="select" id="au-source"><option value="">Source</option>
          ${['web','csv','cron','api'].map(s=>`<option ${state.source===s?'selected':''}>${s}</option>`).join('')}</select>
        <input class="input" id="au-actor" placeholder="Actor ID" value="${esc(state.actor)}" style="width:130px">
        <button class="btn" id="au-reset">Reset</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Source</th><th>Changes</th><th>Undo</th></tr></thead>
        <tbody>${p.slice.length?p.slice.map((e,ix)=>`<tr class="clickable" data-row="${e.id}">
          <td class="small">${fmtDateTime(e.when)}</td>
          <td><div class="cell-main">${esc(e.actorName)}</div><div class="cell-sub">${esc(e.actorRole)}</div></td>
          <td><span class="badge outline">${esc(e.action)}</span></td>
          <td>${esc(e.target)}</td>
          <td><span class="badge gray">${esc(e.source)}</span></td>
          <td class="small" style="max-width:240px">${esc(e.changes)}</td>
          <td>${e.undone?'<span class="badge gray">Undone</span>':`<button class="btn btn-sm" data-undo="${e.id}">${I.undo} Undo</button>`}</td>
        </tr>`).join(''):`<tr><td colspan="7" class="empty-cell">No events match the current filters.</td></tr>`}
        </tbody></table></div>
      ${pagerHTML(p,'events')}
    </div>`;

    el.querySelector('#au-from').onchange=e=>{state.from=e.target.value;state.page=1;render();};
    el.querySelector('#au-to').onchange=e=>{state.to=e.target.value;state.page=1;render();};
    el.querySelector('#au-action').onchange=e=>{state.action=e.target.value;state.page=1;render();};
    el.querySelector('#au-source').onchange=e=>{state.source=e.target.value;state.page=1;render();};
    const aq=el.querySelector('#au-actor');
    aq.oninput=debounce(()=>{state.actor=aq.value;state.page=1;render();const nq=el.querySelector('#au-actor');nq.focus();});
    el.querySelector('#au-reset').onclick=()=>{Object.assign(state,{from:'',to:'',action:'',source:'',actor:'',page:1});render();};
    bindPager(el,pg=>{state.page=pg;render();});

    el.querySelectorAll('[data-row]').forEach(tr=>tr.onclick=e=>{
      if(e.target.closest('[data-undo]'))return;
      const ev=d.audit.find(x=>x.id===tr.dataset.row);
      const ov=document.createElement('div');
      ov.innerHTML=`<div class="drawer-overlay"></div>
      <div class="drawer">
        <div class="drawer-head"><b>Event details</b><button class="modal-x">&times;</button></div>
        <div class="drawer-body">
          <dl class="kv">
            <dt>When</dt><dd>${fmtDateTime(ev.when)}</dd>
            <dt>Actor</dt><dd>${esc(ev.actorName)} (${esc(ev.actorRole)})</dd>
            <dt>Action</dt><dd>${esc(ev.action)}</dd>
            <dt>Target</dt><dd>${esc(ev.target)}</dd>
            <dt>Source</dt><dd>${esc(ev.source)}</dd>
          </dl>
          <div class="section-label">FULL PAYLOAD (BEFORE / AFTER)</div>
          <pre class="payload">${esc(JSON.stringify(ev,null,2))}</pre>
        </div>
      </div>`;
      document.getElementById('modal-root').appendChild(ov);
      const close=()=>ov.remove();
      ov.querySelector('.modal-x').onclick=close;
      ov.querySelector('.drawer-overlay').onclick=close;
    });
    el.querySelectorAll('[data-undo]').forEach(b=>b.onclick=()=>{
      const ev=d.audit.find(x=>x.id===b.dataset.undo);
      const sess=Auth.current();
      if(sess.role!=='admin')return toast('Admin only',true);
      Modal.confirm('Undo action','Reverse <b>'+esc(ev.action)+'</b> on '+esc(ev.target)+'? A new record is created pointing back at the original. (Not every action is reversible.)',()=>{
        ev.undone=true;
        d.audit.unshift({id:uid('ev'),when:new Date().toISOString(),actorId:sess.id,actorName:sess.name,
          actorRole:sess.role,action:'undo',target:ev.target,source:'web',
          changes:'Reversed event '+ev.id+' ('+ev.action+')',undone:false,refId:ev.id});
        DB.save();render();toast('Action reversed');
      },'Undo');
    });
  }
  render();
});
