/* ================= Pages: Finance — Payments, Collection, Invoices, Statements ================= */
'use strict';

/* ============================================================ PAYMENTS */
App.register('payments',function(el){
  const state=App._pay||(App._pay={tab:'Payments',page:1});

  function render(){
    const d=DB.d;
    const customers=d.users.filter(u=>['customer','special customer'].includes(u.role));
    let inner='';
    if(state.tab==='Payments'){
      const p=paginate(d.payments,state.page);
      inner=`
      <button class="btn btn-dark" id="pay-new" style="margin-bottom:14px">${I.plus} Record Payment</button>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Date</th><th>Customer</th><th class="num">Amount</th><th>Currency</th><th>Method</th><th>Reference</th></tr></thead>
        <tbody>${p.slice.length?p.slice.map(pm=>`<tr>
          <td>${fmtDateShort(pm.date)}</td>
          <td class="cell-main">${esc(DB.userName(pm.customerId))}</td>
          <td class="num money-green">${money(pm.amount)}</td>
          <td>USD</td>
          <td><span class="badge outline">${esc(pm.method)}</span></td>
          <td class="muted">${esc(pm.reference||'—')}</td>
        </tr>`).join(''):`<tr><td colspan="6" class="empty-cell">No payments found</td></tr>`}
        </tbody></table></div>
      ${d.payments.length>10?pagerHTML(p):''}`;
    }else{
      inner=`
      <button class="btn btn-dark" id="cn-new" style="margin-bottom:14px">${I.plus} New Credit Note</button>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Date</th><th>Customer</th><th class="num">Amount</th><th>Reason</th></tr></thead>
        <tbody>${d.creditNotes.length?d.creditNotes.map(cn=>`<tr>
          <td>${fmtDateShort(cn.date)}</td>
          <td class="cell-main">${esc(DB.userName(cn.customerId))}</td>
          <td class="num money-green">${money(cn.amount)}</td>
          <td>${esc(cn.reason)}</td>
        </tr>`).join(''):`<tr><td colspan="4" class="empty-cell">No credit notes found</td></tr>`}
        </tbody></table></div>`;
    }

    el.innerHTML=`
    <div class="page-head"><div class="page-title">Payments</div></div>
    <div class="card card-pad">
      <div class="tabs">${['Payments','Credit Notes'].map(t=>`<button class="tab ${state.tab===t?'active':''}" data-tab="${t}">${t}</button>`).join('')}</div>
      ${inner}
    </div>`;

    el.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render();});
    bindPager(el,pg=>{state.page=pg;render();});

    const pn=el.querySelector('#pay-new');
    if(pn)pn.onclick=()=>{
      Modal.open({title:'Record Payment',
        body:`
        <div class="field"><label>Customer</label>
          <select class="select" id="rp-cust">${customers.map(c=>`<option value="${c.id}">${esc(c.business)} ${c.balance?'— balance '+money(c.balance):''}</option>`).join('')}</select></div>
        <div class="two-col">
          <div class="field"><label>Amount ($)</label><input class="input" type="number" step="0.01" id="rp-amount"></div>
          <div class="field"><label>Date</label><input type="date" class="input" id="rp-date" value="${todayISO()}"></div>
          <div class="field"><label>Payment method</label><select class="select" id="rp-method">
            <option>transfer</option><option>check</option><option>credit card</option><option>cash</option></select></div>
          <div class="field"><label>Reference</label><input class="input" id="rp-ref" placeholder="Check # / confirmation"></div>
        </div>
        <div class="dashed-banner">A payment larger than the balance creates a <b>credit balance</b> (negative) that will be used on future orders.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Save Payment</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const amount=parseFloat(ov.querySelector('#rp-amount').value);
            if(!amount||amount<=0)return toast('Enter a valid amount',true);
            const cid=ov.querySelector('#rp-cust').value;
            const pm={id:uid('pm'),customerId:cid,amount,date:ov.querySelector('#rp-date').value,
              method:ov.querySelector('#rp-method').value,reference:ov.querySelector('#rp-ref').value.trim()};
            DB.d.payments.unshift(pm);
            const u=DB.user(cid);u.balance=Math.round(((u.balance||0)-amount)*100)/100;
            /* settle collection flag if debt cleared */
            if(u.balance<=0){
              const fl=DB.d.collectionFlags.find(f=>f.customerId===cid&&f.status==='flagged');
              if(fl)fl.status='resolved';
            }
            DB.save();DB.audit('payment.record',DB.userName(cid),money(amount)+' via '+pm.method);
            close();render();
            toast('Payment recorded — balance is now '+money(u.balance)+(u.balance<0?' (credit)':''));
          };
        }});
    };
    const cn=el.querySelector('#cn-new');
    if(cn)cn.onclick=()=>{
      Modal.open({title:'New Credit Note',
        body:`
        <div class="field"><label>Customer</label>
          <select class="select" id="cn-cust">${customers.map(c=>`<option value="${c.id}">${esc(c.business)}</option>`).join('')}</select></div>
        <div class="two-col">
          <div class="field"><label>Amount ($)</label><input class="input" type="number" step="0.01" id="cn-amount"></div>
          <div class="field"><label>Reason</label><select class="select" id="cn-reason">
            <option>Return</option><option>Price adjustment</option><option>Goodwill gesture</option><option>Other</option></select></div>
        </div>
        <div class="small muted">A credit note is a formal acknowledgment of credit owed to the customer — the balance is reduced accordingly.</div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>Create Credit Note</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const amount=parseFloat(ov.querySelector('#cn-amount').value);
            if(!amount||amount<=0)return toast('Enter a valid amount',true);
            const cid=ov.querySelector('#cn-cust').value;
            DB.d.creditNotes.unshift({id:uid('cn'),customerId:cid,amount,
              reason:ov.querySelector('#cn-reason').value,date:todayISO()});
            const u=DB.user(cid);u.balance=Math.round(((u.balance||0)-amount)*100)/100;
            DB.save();DB.audit('credit-note.create',DB.userName(cid),money(amount));
            close();render();toast('Credit note created');
          };
        }});
    };
  }
  render();
});

/* ============================================================ COLLECTION */
App.register('collection',function(el){
  const state=App._coll||(App._coll={status:'',agent:''});

  function render(){
    const d=DB.d;
    let list=d.collectionFlags.slice();
    if(state.status)list=list.filter(f=>f.status===state.status);
    if(state.agent)list=list.filter(f=>{const u=DB.user(f.customerId);return u&&u.agentId===state.agent;});
    const agents=d.users.filter(u=>['agent','super-agent'].includes(u.role));

    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Collection &amp; Debt</div>
      <button class="btn btn-dark" id="cl-flag">${I.flag} Flag Customer</button>
    </div>
    <div class="flex" style="margin-bottom:14px">
      <select class="select" id="cl-status"><option value="">Status</option>
        <option value="flagged" ${state.status==='flagged'?'selected':''}>Flagged</option>
        <option value="resolved" ${state.status==='resolved'?'selected':''}>Resolved</option></select>
      <select class="select" id="cl-agent"><option value="">Filter by Agent</option>
        ${agents.map(a=>`<option value="${a.id}" ${state.agent===a.id?'selected':''}>${esc(a.firstName+' '+a.lastName)}</option>`).join('')}</select>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Customer Name</th><th>Business</th><th>Agent</th><th class="num">Balance</th><th>Days Overdue</th><th>Last Payment</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
        <tbody>${list.length?list.map(f=>{
          const u=DB.user(f.customerId)||{};
          return `<tr>
            <td class="cell-main">${esc((u.firstName||'')+' '+(u.lastName||''))}</td>
            <td>${esc(u.business||'—')}</td>
            <td>${u.agentId?esc(DB.userName(u.agentId)):'—'}</td>
            <td class="num"><b>${money(u.balance||0)}</b></td>
            <td>${f.daysOverdue>0?`<span class="badge red">${f.daysOverdue} days</span>`:'—'}</td>
            <td>${f.lastPayment?fmtDateShort(f.lastPayment):'—'}</td>
            <td>${statusBadge(f.status)}${f.auto?' <span class="badge gray small">auto</span>':''}</td>
            <td class="small" style="max-width:180px">${esc(f.notes||'')}
              ${f.log&&f.log.length?`<div class="cell-sub">${f.log.length} activit${f.log.length===1?'y':'ies'} logged</div>`:''}</td>
            <td><div class="row-actions">
              <button class="btn btn-sm" data-log="${f.id}">Log</button>
              ${f.status==='flagged'?`<button class="btn btn-sm btn-dark" data-resolve="${f.id}">Resolve</button>`:''}
            </div></td>
          </tr>`;}).join(''):`<tr><td colspan="9" class="empty-cell">No collection items found</td></tr>`}
        </tbody></table></div>
    </div>
    <div class="dashed-banner" style="margin-top:14px">A daily background process automatically flags customers whose debt is about to become due, or is past due (based on their credit days).</div>`;

    el.querySelector('#cl-status').onchange=e=>{state.status=e.target.value;render();};
    el.querySelector('#cl-agent').onchange=e=>{state.agent=e.target.value;render();};

    el.querySelector('#cl-flag').onclick=()=>{
      const withBalance=d.users.filter(u=>['customer','special customer'].includes(u.role)&&(u.balance||0)>0);
      Modal.open({title:'Flag Customer',
        body:`
        <div class="field"><label>Customer</label>
          <select class="select" id="fc-cust">${withBalance.map(c=>`<option value="${c.id}">${esc(c.business)} — ${money(c.balance)}</option>`).join('')}</select></div>
        <div class="field"><label>Notes</label><input class="input" id="fc-notes" placeholder='e.g. "promised payment by Friday"'></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>${I.flag} Flag</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-ok]').onclick=()=>{
            const cid=ov.querySelector('#fc-cust').value;
            if(!cid)return toast('No customers with a balance',true);
            d.collectionFlags.unshift({id:uid('cf'),customerId:cid,status:'flagged',auto:false,
              notes:ov.querySelector('#fc-notes').value.trim(),log:[],createdAt:todayISO(),
              daysOverdue:0,lastPayment:null});
            DB.save();DB.audit('collection.flag',DB.userName(cid),'Manually flagged');
            close();render();toast('Customer flagged for follow-up');
          };
        }});
    };
    el.querySelectorAll('[data-log]').forEach(b=>b.onclick=()=>{
      const f=d.collectionFlags.find(x=>x.id===b.dataset.log);
      Modal.open({title:'Collection activity — '+DB.userName(f.customerId),size:'wide',
        body:`
        <div class="flex">
          <select class="select" id="la-type"><option>call</option><option>email</option><option>reminder</option></select>
          <select class="select" id="la-outcome"><option>reached</option><option>no answer</option><option>promised payment</option><option>dispute</option></select>
          <input class="input" id="la-notes" placeholder="Notes" style="flex:1">
          <button class="btn btn-dark" id="la-add">${I.plus} Log</button>
        </div>
        <div class="timeline" style="margin-top:14px" id="la-list">
          ${f.log.length?f.log.map(l=>`<div class="tl-item"><b>${esc(l.type)}</b> — ${esc(l.outcome)} <span class="muted small">${fmtDateTime(l.at)}</span><div class="small">${esc(l.notes)}</div></div>`).join(''):'<div class="muted small">No activity yet — building a full timeline for the customer.</div>'}
        </div>`,
        foot:`<button class="btn" data-x>Close</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('#la-add').onclick=()=>{
            f.log.unshift({type:ov.querySelector('#la-type').value,outcome:ov.querySelector('#la-outcome').value,
              notes:ov.querySelector('#la-notes').value.trim(),at:new Date().toISOString()});
            DB.save();DB.audit('collection.log',DB.userName(f.customerId),f.log[0].type+' — '+f.log[0].outcome);
            ov.querySelector('#la-list').innerHTML=f.log.map(l=>`<div class="tl-item"><b>${esc(l.type)}</b> — ${esc(l.outcome)} <span class="muted small">${fmtDateTime(l.at)}</span><div class="small">${esc(l.notes)}</div></div>`).join('');
            ov.querySelector('#la-notes').value='';
            render();
          };
        }});
    });
    el.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=()=>{
      const f=d.collectionFlags.find(x=>x.id===b.dataset.resolve);
      Modal.confirm('Resolve flag','Close the collection flag for <b>'+esc(DB.userName(f.customerId))+'</b>? Use this once the debt has been settled.',()=>{
        f.status='resolved';DB.save();DB.audit('collection.resolve',DB.userName(f.customerId),'Flag closed');
        render();toast('Flag resolved');
      },'Resolve');
    });
  }
  render();
});

/* ============================================================ INVOICES */
/* ---------- invoice payment presentation (Final Handover Phase 3) ----------

   Plain English for each settlement state. `on_terms` deliberately reads as
   "On terms" rather than "Unpaid": an invoice outstanding on agreed account
   terms is not a delinquent one, and every existing invoice is in that state.

   `processing` is its own word because it is genuinely different from both
   paid and unpaid — a hosted session completed and Veyora is waiting for the
   signed webhook that is the only evidence money moved. */
const PAY_STATE_LABELS={
  'on_terms':'On terms',
  'processing':'Confirming…',
  'paid':'Paid',
  'refunded':'Refunded',
  'void':'Void',
};
const payStateLabel=k=>PAY_STATE_LABELS[k]||k||'—';

/* Minor units to a display string. Mirrors fromMinorUnits() on the server; the
   SERVER's figure is authoritative and this only formats it. */
function payMoney(minor,currency){
  const n=Number(minor)||0;
  const sign=n<0?'-':'';
  const abs=Math.abs(n);
  return sign+Math.floor(abs/100)+'.'+String(abs%100).padStart(2,'0')+' '+String(currency||'');
}

App.register('invoices',function(el){
  const state=App._inv2||(App._inv2={cust:'',from:'',to:'',provider:'',page:1});

  function render(){
    /* Each row is priced in ITS OWN order's stamped currency, so the order must
       have loaded. Without it the amounts would silently fall back to USD. */
    if(!requireLiveData(el,render,'Invoices could not be loaded'))return;
    const d=DB.d;
    let list=d.invoices.slice();
    if(state.cust){const q=state.cust.toLowerCase();list=list.filter(i=>DB.userName(i.customerId).toLowerCase().includes(q));}
    if(state.from)list=list.filter(i=>i.date>=state.from);
    if(state.to)list=list.filter(i=>i.date<=state.to);
    if(state.provider)list=list.filter(i=>i.provider===state.provider);
    const p=paginate(list,state.page);

    el.innerHTML=`
    <div class="page-head">
      <div class="page-title">Invoices</div>
      <span class="muted small">${d.invoices.length} invoice${d.invoices.length!==1?'s':''}</span>
    </div>
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="flex">
        <input class="input" id="iv-cust" placeholder="Customer" value="${esc(state.cust)}">
        <div class="fieldset-outline"><label>Start Date</label><input type="date" id="iv-from" value="${state.from}"></div>
        <div class="fieldset-outline"><label>End Date</label><input type="date" id="iv-to" value="${state.to}"></div>
        <select class="select" id="iv-provider"><option value="">Provider</option>
          <option ${state.provider==='Green Invoice'?'selected':''}>Green Invoice</option>
          <option ${state.provider==='QuickBooks'?'selected':''}>QuickBooks</option></select>
        <button class="btn" id="iv-refresh">${I.refresh} Refresh</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Invoice #</th><th>Order #</th><th>Customer</th><th class="num">Amount</th><th>Provider</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${p.slice.length?p.slice.map(iv=>`<tr>
          <td class="cell-main">${iv.number}</td>
          <td><a class="link" href="#/order/${iv.orderId}">${esc(iv.orderNumber)}</a></td>
          <td>${esc(DB.userName(iv.customerId))}</td>
          ${/* An invoice record stores the order total in base USD; show it
               in the ORDER's own currency at its stamped rate. */''}
          <td class="num">${orderMoney(iv.amount,DB.order(iv.orderId)||DB.order(iv.orderNumber))}</td>
          <td><span class="badge outline">${esc(iv.provider)}</span></td>
          <td>${fmtDateShort(iv.date)}</td>
          <td>${statusBadge(iv.status)}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-dl="${iv.id}" title="Download PDF">${I.download}</button>
            <button class="icon-btn" data-ext="${iv.id}" title="Open at provider">${I.external}</button>
            ${App.can('payments.view')?`<button class="icon-btn" data-pay="${iv.id}" title="Payment">${I.payments}</button>`:''}
          </div></td>
        </tr>`).join(''):`<tr><td colspan="8" class="empty-cell">No invoices found</td></tr>`}
        </tbody></table></div>
      ${list.length>10?pagerHTML(p):''}
    </div>
    ${paymentBannerHTML()}
    <div class="small muted" style="margin-top:10px">An invoice is generated from an order via the <b>Generate Invoice</b> button on the order screen.</div>`;

    const cq=el.querySelector('#iv-cust');
    cq.oninput=debounce(()=>{state.cust=cq.value;state.page=1;render();const nq=el.querySelector('#iv-cust');nq.focus();nq.setSelectionRange(nq.value.length,nq.value.length);});
    el.querySelector('#iv-from').onchange=e=>{state.from=e.target.value;render();};
    el.querySelector('#iv-to').onchange=e=>{state.to=e.target.value;render();};
    el.querySelector('#iv-provider').onchange=e=>{state.provider=e.target.value;render();};
    el.querySelector('#iv-refresh').onclick=()=>{render();toast('Refreshed');};
    bindPager(el,pg=>{state.page=pg;render();});
    /* Truthful: invoices are records in this system; no file is produced. */
    el.querySelectorAll('[data-dl]').forEach(b=>b.onclick=()=>toast('No invoice document is generated yet — open the order and use Print order.'));
    el.querySelectorAll('[data-ext]').forEach(b=>b.onclick=()=>toast('Opening invoice at the provider…'));
    el.querySelectorAll('[data-pay]').forEach(b=>b.onclick=()=>paymentModal(b.dataset.pay));
    const rec=el.querySelector('#pay-reconcile');
    if(rec)rec.onclick=reconciliationModal;
  }

  /* ---------- payment (Final Handover Phase 3) ---------- */

  /** A standing note about the payment provider's state.
   *
   *  Test mode is announced LOUDLY and permanently rather than discovered when
   *  a customer's payment never arrives. Stripe being off is stated as a fact
   *  about configuration, not as a failure. */
  function paymentBannerHTML(){
    if(!App.can('payments.view'))return '';
    const s=App._stripe||{};
    const reconcile=App.can('payments.reconcile')
      ? '<button class="btn btn-sm" id="pay-reconcile" style="margin-left:auto">Reconciliation</button>' : '';
    if(!s.enabled){
      return `<div class="dashed-banner" style="margin-top:12px;display:flex;align-items:center;gap:10px">
        <span>Online card payment is switched off${s.disabledReason?' — '+esc(s.disabledReason):''}.
        Invoices remain payable on account terms exactly as before.</span>${reconcile}</div>`;
    }
    if(s.testMode){
      return `<div class="dashed-banner" style="margin-top:12px;display:flex;align-items:center;gap:10px">
        <span><b>Stripe is in TEST mode.</b> Payment links here take test cards only and move no real money.</span>${reconcile}</div>`;
    }
    return `<div class="dashed-banner" style="margin-top:12px;display:flex;align-items:center;gap:10px">
      <span>Stripe is live. Payment links here take real money.</span>${reconcile}</div>`;
  }

  function paymentModal(invoiceId){
    let payment=null, busy=false, notice=null;

    function body(){
      if(notice&&!payment)return `<div class="perm-notice ${notice.kind}"><div class="small">${esc(notice.text)}</div></div>`;
      if(!payment)return '<div class="muted small">Loading payment state…</div>';
      const st=payment.settlementState;
      const s=payment.session;
      const stripe=App._stripe||{};
      return `
      ${notice?`<div class="perm-notice ${notice.kind}" style="margin-bottom:10px"><div class="small">${esc(notice.text)}</div></div>`:''}
      <div class="summary-row"><span>Invoice</span><b>${esc(payment.invoiceNumber)}</b></div>
      <div class="summary-row"><span>Amount</span><b>${esc(payment.amount)} ${esc(payment.currency)}</b></div>
      <div class="summary-row"><span>State</span><span class="badge outline">${esc(payStateLabel(st))}</span></div>
      ${st==='paid'||st==='refunded'?`
        <div class="summary-row"><span>Settled</span><b>${esc(payMoney(payment.amountSettledMinor,payment.currency))}</b></div>
        ${payment.amountRefundedMinor?`<div class="summary-row"><span>Refunded</span><b>${esc(payMoney(payment.amountRefundedMinor,payment.currency))}</b></div>`:''}
        <div class="summary-row"><span>Provider reference</span><span class="small">${esc(payment.settlementReference||'—')}</span></div>
        ${payment.settledAt?`<div class="summary-row"><span>Settled at</span><span class="small">${esc(fmtDateShort(payment.settledAt))}</span></div>`:''}`:''}
      ${s?`<div class="section-label" style="margin-top:12px">LAST PAYMENT LINK</div>
        <div class="summary-row"><span>Status</span><span class="badge outline">${esc(s.status)}</span></div>
        ${s.expiresAt?`<div class="summary-row"><span>Expires</span><span class="small">${esc(fmtDateShort(s.expiresAt))}</span></div>`:''}
        ${s.lastError?`<div class="summary-row"><span>Last error</span><span class="small">${esc(s.lastError)}</span></div>`:''}
        ${s.hostedUrl?`<div class="field" style="margin-top:8px">
          <label>Secure payment link</label>
          <input class="input" id="pay-link" readonly value="${esc(s.hostedUrl)}">
          <div class="small muted">Anyone holding this link can pay this invoice. Send it to the customer directly.</div>
        </div>`:''}`
        :'<div class="small muted" style="margin-top:12px">No payment link has been created for this invoice.</div>'}
      ${!stripe.enabled?'<div class="small muted" style="margin-top:10px">Online payment is switched off, so no link can be created.</div>':''}
      <div class="small muted" style="margin-top:12px">
        An invoice is only ever marked paid by a signed confirmation from the payment provider.
        Nothing on this screen can assert a payment.
      </div>`;
    }

    function foot(){
      const st=payment&&payment.settlementState;
      const canCollect=App.can('payments.collect')&&(App._stripe||{}).enabled&&st==='on_terms';
      const canRefund=App.can('payments.refund')&&(st==='paid'||st==='refunded')
        &&Number(payment.amountRefundedMinor)<Number(payment.amountSettledMinor);
      return `<button class="btn" data-x>Close</button>
        ${canRefund?`<button class="btn" data-refund ${busy?'disabled':''}>Refund…</button>`:''}
        ${canCollect?`<button class="btn btn-dark" data-collect ${busy?'disabled':''}>${busy?'Working…':(payment.session&&payment.session.hostedUrl?'Get link':'Create payment link')}</button>`:''}`;
    }

    const modal=Modal.open({title:'Invoice payment',size:'wide',body:body(),foot:foot(),
      setup(ov,close){ wire(ov,close); }});

    function repaint(){
      const ov=modal.el;
      ov.querySelector('.modal-body').innerHTML=body();
      ov.querySelector('.modal-foot').innerHTML=foot();
      wire(ov,modal.close);
    }

    function wire(ov,close){
      ov.querySelector('[data-x]').onclick=close;
      const link=ov.querySelector('#pay-link');
      if(link)link.onclick=()=>{link.select();};
      const collect=ov.querySelector('[data-collect]');
      /* `busy` is checked in the handler, not only reflected in `disabled`: a
         direct handler call would bypass the attribute, and creating a second
         session is exactly what must not happen. */
      if(collect)collect.onclick=async()=>{
        if(busy)return;
        busy=true;notice=null;repaint();
        try{
          const out=await DB.collectInvoicePayment(invoiceId);
          payment=out.payment;
          notice={kind:'ok',text:out.reused
            ? 'This invoice already had an open payment link — the same one is shown below.'
            : 'A secure payment link has been created. Send it to the customer.'};
          DB.audit('payment.collect',payment.invoiceNumber,'payment link created','web');
        }catch(e){ notice=describePay(e); }
        finally{ busy=false;repaint(); }
      };
      const refund=ov.querySelector('[data-refund]');
      if(refund)refund.onclick=()=>{ if(!busy)refundModal(); };
    }

    /** A refund is confirmed by TYPING, not by clicking. The reason is
     *  mandatory because a refund nobody can explain six months later is the
     *  problem this field exists to prevent. */
    function refundModal(){
      const remaining=Number(payment.amountSettledMinor)-Number(payment.amountRefundedMinor);
      Modal.open({title:'Refund payment',size:'wide',
        body:`<div class="info-banner">${I.eye}<div>This sends money back to the customer through Stripe.
          Up to <b>${esc(payMoney(remaining,payment.currency))}</b> remains refundable on invoice
          <b>${esc(payment.invoiceNumber)}</b>.</div></div>
          <div class="field"><label for="rf-amount">Amount (blank refunds everything remaining)</label>
            <input class="input" id="rf-amount" placeholder="${esc(payMoney(remaining,payment.currency).split(' ')[0])}"></div>
          <div class="field"><label for="rf-reason">Reason (required, recorded in the audit log)</label>
            <textarea class="input" id="rf-reason" rows="2" maxlength="500"></textarea></div>
          <div class="field"><label for="rf-confirm">Type REFUND to confirm</label>
            <input class="input" id="rf-confirm" autocomplete="off"></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok disabled>Send refund</button>`,
        setup(ov,close){
          const ok=ov.querySelector('[data-ok]');
          const confirm=ov.querySelector('#rf-confirm');
          const reason=ov.querySelector('#rf-reason');
          const check=()=>{ ok.disabled=!(confirm.value.trim()==='REFUND'&&reason.value.trim().length>=3); };
          confirm.oninput=check; reason.oninput=check;
          ov.querySelector('[data-x]').onclick=close;
          let sending=false;
          ok.onclick=async()=>{
            if(sending||confirm.value.trim()!=='REFUND')return;
            sending=true;ok.disabled=true;
            try{
              const out=await DB.refundInvoicePayment(invoiceId,reason.value,ov.querySelector('#rf-amount').value.trim());
              close();
              notice={kind:'ok',text:`${payMoney(out.amountMinor,out.currency)} refunded.`};
              DB.audit('payment.refund',payment.invoiceNumber,'refund sent','web');
              toast('Refund sent');
              await load();
            }catch(e){
              sending=false;ok.disabled=false;
              const n=describePay(e);
              ov.querySelector('.modal-body').insertAdjacentHTML('beforeend',
                `<div class="perm-notice err" style="margin-top:10px"><div class="small">${esc(n.text)}</div></div>`);
            }
          };
        }});
    }

    async function load(){
      try{ payment=await DB.invoicePayment(invoiceId); }
      catch(e){ notice=describePay(e); }
      repaint();
    }
    load();
  }

  function reconciliationModal(){
    Modal.open({title:'Payment reconciliation',size:'wide',
      body:'<div class="muted small">Loading…</div>',
      foot:'<button class="btn" data-x>Close</button>',
      setup(ov,close){
        ov.querySelector('[data-x]').onclick=close;
        DB.paymentReconciliation().then(list=>{
          ov.querySelector('.modal-body').innerHTML=list.length?`
            <div class="small muted" style="margin-bottom:8px">
              Payment events the platform could not apply. Each is recorded with the reason;
              none of them changed an invoice.
            </div>
            <div class="table-wrap"><table class="tbl">
              <thead><tr><th>Received</th><th>Event</th><th>Reason</th><th class="num">Amount</th></tr></thead>
              <tbody>${list.map(e=>`<tr>
                <td class="small">${esc(fmtDateShort(e.receivedAt))}</td>
                <td class="small">${esc(e.eventType)}</td>
                <td class="small">${esc(e.lastError||e.status)}</td>
                <td class="num small">${e.amountMinor==null?'—':esc(payMoney(e.amountMinor,e.currency))}</td>
              </tr>`).join('')}</tbody></table></div>`
            :'<div class="small">Nothing to reconcile — every payment event was applied.</div>';
        }).catch(e=>{
          ov.querySelector('.modal-body').innerHTML=
            `<div class="perm-notice err"><div class="small">${esc(describePay(e).text)}</div></div>`;
        });
      }});
  }

  /* Every branch is a sentence for an operator. A raw API error never renders. */
  function describePay(e){
    const s=e&&e.status, code=e&&e.data&&e.data.code;
    if(s===401)return {kind:'err',text:'Your session has expired. Sign in again — nothing was changed.'};
    if(s===403)return {kind:'err',text:'Your account does not hold the payment capability that needs. Nothing was changed.'};
    if(s===404)return {kind:'err',text:'That invoice could not be found.'};
    if(s===409&&code==='ALREADY_PAID')return {kind:'warn',text:'This invoice has already been paid.'};
    if(s===409&&code==='PAYMENT_PENDING')return {kind:'warn',text:'A payment for this invoice is being confirmed. Nothing was changed.'};
    if(s===409&&code==='EXCEEDS_REMAINING')return {kind:'err',text:(e.data&&e.data.error)||'That is more than remains refundable.'};
    if(s===409)return {kind:'warn',text:(e.data&&e.data.error)||'That change was refused. Nothing was changed.'};
    if(s===502)return {kind:'err',text:(e.data&&e.data.error)||'The payment provider could not be reached. Nothing was charged.'};
    if(s===400)return {kind:'err',text:(e.data&&e.data.error)||'That request was rejected. Nothing was changed.'};
    return {kind:'err',text:'That could not be completed. Nothing was changed — check your connection and try again.'};
  }

  render();
});

/* ============================================================ STATEMENTS */
App.register('statements',function(el){
  const state=App._stmt||(App._stmt={cust:'',from:'2026-01-01',to:todayISO(),result:null});

  function generate(){
    const d=DB.d;
    const cid=state.cust;
    const u=DB.user(cid);
    const tx=[];
    for(const iv of d.invoices)if(iv.customerId===cid&&iv.date>=state.from&&iv.date<=state.to)
      tx.push({date:iv.date,desc:'Invoice #'+iv.number+' ('+iv.orderNumber+')',debit:iv.amount,credit:0});
    for(const pm of d.payments)if(pm.customerId===cid&&pm.date>=state.from&&pm.date<=state.to)
      tx.push({date:pm.date,desc:'Payment — '+pm.method+(pm.reference?' ('+pm.reference+')':''),debit:0,credit:pm.amount});
    for(const cn of d.creditNotes)if(cn.customerId===cid&&cn.date>=state.from&&cn.date<=state.to)
      tx.push({date:cn.date,desc:'Credit note — '+cn.reason,debit:0,credit:cn.amount});
    tx.sort((a,b)=>a.date.localeCompare(b.date));
    const activity=tx.reduce((s,t)=>s+t.debit-t.credit,0);
    const closing=u?(u.balance||0):0;
    const opening=Math.round((closing-activity)*100)/100;
    let run=opening;
    tx.forEach(t=>{run=Math.round((run+t.debit-t.credit)*100)/100;t.balance=run;});
    state.result={opening,closing:run,tx};
  }

  function render(){
    const customers=DB.d.users.filter(u=>['customer','special customer'].includes(u.role));
    const r=state.result;
    el.innerHTML=`
    <div class="page-head"><div class="page-title">Account Statements</div></div>
    <div class="card card-pad">
      <div class="flex">
        <select class="select" id="st-cust" style="min-width:280px">
          <option value="">Select Customer</option>
          ${customers.map(c=>`<option value="${c.id}" ${state.cust===c.id?'selected':''}>${esc(c.business)}</option>`).join('')}
        </select>
        <div class="fieldset-outline"><label>From</label><input type="date" id="st-from" value="${state.from}"></div>
        <div class="fieldset-outline"><label>To</label><input type="date" id="st-to" value="${state.to}"></div>
        <button class="btn btn-dark" id="st-gen" ${!state.cust?'disabled':''}>Generate</button>
        ${r?`<button class="btn" id="st-pdf" title="Opens the browser print view">${I.printer} Print statement</button>
        <button class="btn" id="st-send">${I.send} Send to Customer</button>`:''}
      </div>
      ${!state.cust?`<div class="task-empty" style="padding:70px 20px"><b>Select a customer to generate their account statement</b></div>`:''}
      ${r?`
      <div class="divider"></div>
      <div class="grid g3">
        <div class="stat-card"><div class="stat-label">OPENING BALANCE</div><div class="stat-value">${money(r.opening)}</div></div>
        <div class="stat-card"><div class="stat-label">TRANSACTIONS</div><div class="stat-value">${r.tx.length}</div></div>
        <div class="stat-card"><div class="stat-label">CLOSING BALANCE</div><div class="stat-value">${money(r.closing)}</div></div>
      </div>
      <div class="table-wrap" style="margin-top:14px"><table class="tbl">
        <thead><tr><th>Date</th><th>Description</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Running Balance</th></tr></thead>
        <tbody>
          <tr><td>${fmtDateShort(state.from)}</td><td class="muted">Opening balance</td><td class="num"></td><td class="num"></td><td class="num"><b>${money(r.opening)}</b></td></tr>
          ${r.tx.map(t=>`<tr>
            <td>${fmtDateShort(t.date)}</td><td>${esc(t.desc)}</td>
            <td class="num">${t.debit?money(t.debit):''}</td>
            <td class="num" style="color:var(--green)">${t.credit?money(t.credit):''}</td>
            <td class="num">${money(t.balance)}</td>
          </tr>`).join('')||'<tr><td colspan="5" class="empty-cell">No transactions in this range</td></tr>'}
          <tr><td>${fmtDateShort(state.to)}</td><td><b>Closing balance</b></td><td></td><td></td><td class="num"><b>${money(r.closing)}</b></td></tr>
        </tbody></table></div>`:''}
    </div>`;

    el.querySelector('#st-cust').onchange=e=>{state.cust=e.target.value;state.result=null;render();};
    el.querySelector('#st-from').onchange=e=>{state.from=e.target.value;};
    el.querySelector('#st-to').onchange=e=>{state.to=e.target.value;};
    el.querySelector('#st-gen').onclick=()=>{generate();DB.audit('statement.generate',DB.userName(state.cust),state.from+' → '+state.to);render();};
    const pdf=el.querySelector('#st-pdf');
    if(pdf)pdf.onclick=()=>{
      const u=DB.user(state.cust);
      const w=window.open('','_blank');
      w.document.write(`<html><head><title>Statement — ${esc(u.business)}</title>
      <style>body{font-family:sans-serif;padding:40px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:7px;text-align:left}h1{letter-spacing:4px}</style></head>
      <body><h1>VEYORA</h1><h2>Account Statement — ${esc(u.business)}</h2>
      <p>${state.from} → ${state.to}</p>
      <table><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr>
      <tr><td>${state.from}</td><td>Opening balance</td><td></td><td></td><td>$${state.result.opening.toFixed(2)}</td></tr>
      ${state.result.tx.map(t=>`<tr><td>${t.date}</td><td>${esc(t.desc)}</td><td>${t.debit?'$'+t.debit.toFixed(2):''}</td><td>${t.credit?'$'+t.credit.toFixed(2):''}</td><td>$${t.balance.toFixed(2)}</td></tr>`).join('')}
      <tr><td>${state.to}</td><td><b>Closing balance</b></td><td></td><td></td><td><b>$${state.result.closing.toFixed(2)}</b></td></tr>
      </table><script>print()<\/script></body></html>`);
      w.document.close();
    };
    const snd=el.querySelector('#st-send');
    if(snd)snd.onclick=()=>{
      const u=DB.user(state.cust);
      DB.audit('statement.send',u.business,'Emailed to '+u.email);
      toast('Statement emailed to '+u.email);
    };
  }
  render();
});
