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
      ${App.can('finance.record')
        ? `<button class="btn btn-dark" id="pay-new" style="margin-bottom:14px">${I.plus} Record Payment</button>`
        : `<div class="small muted" style="margin-bottom:14px">Recording a payment needs the
             <b>Record offline payments</b> capability, which is granted per account.</div>`}
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Date</th><th>Customer</th><th class="num">Amount</th><th>Currency</th><th>Method</th><th>Reference</th><th></th></tr></thead>
        <tbody>${p.slice.length?p.slice.map(pm=>{
          const voided=!!pm.voidedAt;
          return `<tr${voided?' style="opacity:.6"':''}>
          <td>${fmtDateShort(pm.date||pm.paidOn)}</td>
          <td class="cell-main">${esc(DB.userName(pm.customerId))}</td>
          <td class="num ${voided?'':'money-green'}">${money(pm.amount)}</td>
          <td>${esc(pm.currency||'USD')}</td>
          <td><span class="badge outline">${esc(methodLabel(pm.method))}</span>
              ${voided?'<span class="badge outline">Voided</span>':''}</td>
          <td class="muted">${esc(pm.reference||'—')}</td>
          ${/* A Stripe payment cannot be voided — the money really was taken —
               so no control is offered for one. Refunding is the correct act
               and lives on the invoice, behind its own capability. */''}
          <td>${(!voided&&pm.method!=='stripe'&&App.can('finance.record'))
            ?`<button class="btn btn-sm" data-void="${esc(pm.id)}">Void</button>`:''}</td>
        </tr>`;}).join(''):`<tr><td colspan="7" class="empty-cell">No payments found</td></tr>`}
        </tbody></table></div>
      ${d.payments.length>10?pagerHTML(p):''}`;
    }else{
      inner=`
      ${App.can('finance.credit')
        ? `<button class="btn btn-dark" id="cn-new" style="margin-bottom:14px">${I.plus} New Credit Note</button>`
        : `<div class="small muted" style="margin-bottom:14px">Issuing a credit note needs the
             <b>Issue credit notes</b> capability. It is deliberately separate from recording a
             payment: reducing a debt and receiving money are different decisions.</div>`}
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Date</th><th>Customer</th><th class="num">Amount</th><th>Reason</th></tr></thead>
        <tbody>${d.creditNotes.length?d.creditNotes.map(cn=>`<tr>
          <td>${fmtDateShort(cn.date||cn.issuedOn)}</td>
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
    if(pn)pn.onclick=recordPaymentForm;
    const cn=el.querySelector('#cn-new');
    if(cn)cn.onclick=creditNoteForm;
    el.querySelectorAll('[data-void]').forEach(b=>b.onclick=()=>voidForm(b.dataset.void));
  }

  /* ---------- governed finance operations (Final Handover Phase 4) ----------

     These used to write DB.d.payments / DB.d.creditNotes and set `user.balance`
     in the browser, then rely on the generic row-diff sync to persist it. The
     API now refuses that path for these collections, and rightly: a browser
     setting a balance is not an edit, it is an assertion that the ledger is
     wrong, and it left no record of what it replaced, who did it, or why.

     Every one of these now posts to a narrow, capability-gated, idempotent,
     audited endpoint and re-reads the result from the server. */

  const methodsFor=()=> (App._financeContract&&App._financeContract.offlineMethods&&App._financeContract.offlineMethods.length)
    ? App._financeContract.offlineMethods
    /* The server's list is authoritative. This fallback exists only so the
       form renders before the capability probe settles — and it deliberately
       uses the SERVER's spelling (`credit_card`, not "credit card", which the
       database CHECK constraint would refuse). */
    : ['transfer','check','credit_card','cash'];

  const METHOD_LABELS={transfer:'Bank transfer',check:'Cheque',credit_card:'Card (taken offline)',cash:'Cash'};
  const methodLabel=m=>METHOD_LABELS[m]||m;

  function financeError(e){
    const s=e&&e.status, d=e&&e.data;
    if(s===403)return 'Your account does not hold the capability that needs. Nothing was changed.';
    if(s===409&&d&&d.code==='ALREADY_RECORDED')
      return 'An identical entry has already been recorded. Change the reference if this is a genuinely separate one.';
    if(s===400&&d&&Array.isArray(d.errors))return d.errors.map(x=>x.message).join(' ');
    if(d&&d.error)return d.error;
    return 'That could not be saved. Nothing was changed.';
  }

  function customerOptions(){
    return DB.d.users.filter(u=>['customer','special customer'].includes(u.role))
      .map(c=>`<option value="${esc(c.id)}">${esc(c.business||c.email||c.id)}${c.balance?' — balance '+money(c.balance):''}</option>`).join('');
  }

  /** Shared modal plumbing: one in-flight guard, one error banner, one place
   *  that re-reads from the server rather than patching browser state. */
  function financeModal({title, body, okLabel, submit, done}){
    Modal.open({title, size:'wide', body,
      foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-ok>${esc(okLabel)}</button>`,
      setup(ov,close){
        ov.querySelector('[data-x]').onclick=close;
        const ok=ov.querySelector('[data-ok]');
        let busy=false;
        ok.onclick=async()=>{
          /* Guarded by a flag, not only by `disabled`: a direct handler call
             would bypass the attribute, and this one moves money. */
          if(busy)return;
          busy=true;ok.disabled=true;
          const original=ok.textContent;ok.textContent='Saving…';
          try{
            const result=await submit(ov);
            close();
            /* Re-read from the server. The browser no longer holds the
               authoritative balance, so patching local state would show a
               figure nothing verified. */
            await DB.refreshLive().catch(()=>{});
            render();
            done(result);
          }catch(e){
            busy=false;ok.disabled=false;ok.textContent=original;
            let banner=ov.querySelector('#fin-error');
            if(!banner){
              banner=document.createElement('div');
              banner.id='fin-error';banner.className='perm-notice err';
              banner.style.marginTop='10px';
              ov.querySelector('.modal-body').appendChild(banner);
            }
            banner.innerHTML=`<div class="small">${esc(financeError(e))}</div>`;
          }
        };
      }});
  }

  function recordPaymentForm(){
    financeModal({
      title:'Record payment received',
      okLabel:'Record payment',
      body:`
      <div class="info-banner">${I.eye}<div>This records money that ALREADY arrived by transfer, cheque,
        cash or a card taken outside Stripe. A Stripe payment is recorded by the payment provider
        itself and cannot be entered here.</div></div>
      <div class="field"><label for="rp-cust">Customer</label>
        <select class="select" id="rp-cust">${customerOptions()}</select></div>
      <div class="two-col">
        <div class="field"><label for="rp-amount">Amount</label>
          <input class="input" id="rp-amount" inputmode="decimal" placeholder="0.00"></div>
        <div class="field"><label for="rp-currency">Currency</label>
          <select class="select" id="rp-currency"><option>USD</option><option>CAD</option><option>EUR</option></select></div>
        <div class="field"><label for="rp-date">Date received</label>
          <input type="date" class="input" id="rp-date" value="${todayISO()}"></div>
        <div class="field"><label for="rp-method">Method</label>
          <select class="select" id="rp-method">
            ${methodsFor().map(m=>`<option value="${esc(m)}">${esc(methodLabel(m))}</option>`).join('')}
          </select></div>
      </div>
      <div class="field"><label for="rp-ref">Reference (required)</label>
        <input class="input" id="rp-ref" placeholder="Bank reference, cheque number or receipt">
        <div class="small muted">Required so this payment can be matched against a bank statement.
          A credit nobody can match is how a receivables ledger stops being trustworthy.</div></div>
      <div class="field"><label for="rp-notes">Note (optional)</label>
        <textarea class="input" id="rp-notes" rows="2" maxlength="2000"></textarea></div>
      <div class="dashed-banner">A payment larger than the balance leaves a <b>credit balance</b>
        (negative) that is used against future orders.</div>`,
      submit:(ov)=>DB.recordOfflinePayment({
        customerId: ov.querySelector('#rp-cust').value,
        amount: ov.querySelector('#rp-amount').value.trim(),
        currency: ov.querySelector('#rp-currency').value,
        method: ov.querySelector('#rp-method').value,
        paidOn: ov.querySelector('#rp-date').value,
        reference: ov.querySelector('#rp-ref').value,
        notes: ov.querySelector('#rp-notes').value,
      }),
      done:(p)=>{
        DB.audit('payment.record',p.customerId||'',p.amount+' '+p.currency+' via '+p.method,'web');
        toast('Payment recorded');
      },
    });
  }

  function creditNoteForm(){
    financeModal({
      title:'Issue credit note',
      okLabel:'Issue credit note',
      body:`
      <div class="info-banner">${I.eye}<div>A credit note reduces what a customer owes
        <b>without money arriving</b>. It is not a payment, and it needs a reason that will still
        make sense to somebody reading it in six months.</div></div>
      <div class="field"><label for="cn-cust">Customer</label>
        <select class="select" id="cn-cust">${customerOptions()}</select></div>
      <div class="two-col">
        <div class="field"><label for="cn-amount">Amount</label>
          <input class="input" id="cn-amount" inputmode="decimal" placeholder="0.00"></div>
        <div class="field"><label for="cn-currency">Currency</label>
          <select class="select" id="cn-currency"><option>USD</option><option>CAD</option><option>EUR</option></select></div>
      </div>
      <div class="field"><label for="cn-reason">Reason (required)</label>
        <textarea class="input" id="cn-reason" rows="3" maxlength="500"
          placeholder="e.g. two frames damaged in transit on SO1188, replacement not requested"></textarea></div>
      <div class="field"><label for="cn-ref">Reference (optional)</label>
        <input class="input" id="cn-ref" placeholder="Return number, claim reference"></div>`,
      submit:(ov)=>DB.issueCreditNote({
        customerId: ov.querySelector('#cn-cust').value,
        amount: ov.querySelector('#cn-amount').value.trim(),
        currency: ov.querySelector('#cn-currency').value,
        reason: ov.querySelector('#cn-reason').value,
        reference: ov.querySelector('#cn-ref').value,
      }),
      done:(n)=>{
        DB.audit('credit-note.create',n.customerId||'',n.amount+' '+n.currency,'web');
        toast('Credit note issued');
      },
    });
  }

  function voidForm(paymentId){
    financeModal({
      title:'Void payment',
      okLabel:'Void payment',
      body:`
      <div class="info-banner">${I.eye}<div>Voiding puts the debt back on the customer's account.
        The payment record is <b>kept</b>, stamped with who voided it and why — nothing is deleted,
        because a balance movement nobody can explain is worse than a visible mistake.</div></div>
      <div class="field"><label for="vd-reason">Reason (required)</label>
        <textarea class="input" id="vd-reason" rows="3" maxlength="500"
          placeholder="e.g. keyed twice — same BACS reference as the entry above"></textarea></div>`,
      submit:(ov)=>DB.voidPayment(paymentId, ov.querySelector('#vd-reason').value),
      done:()=>{ DB.audit('payment.void',paymentId,'payment voided','web'); toast('Payment voided'); },
    });
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
    ${(() => {
      /* The receivable as a whole, above the flagged-customer list: that list
         answers "who", these answer "how much" and "how late". */
      const ar = receivablesSummary(d.invoices, d.users, todayISO());
      const m = c => money0(c / 100);
      return `
      <div class="section-label">ACCOUNTS RECEIVABLE</div>
      <div class="grid g5" style="margin-bottom:14px">
        ${statCard({ label: 'REVENUE INVOICED', icon: I.money, value: m(ar.revenue),
          note: 'billed, not collected', to: 'invoices' })}
        ${statCard({ label: 'OPEN AR', icon: I.invoice, value: m(ar.openAr),
          note: 'unsettled invoices', to: 'invoices' })}
        ${statCard({ label: 'PAST DUE', icon: I.clock, value: m(ar.pastDue),
          note: ar.openAr ? Math.round(ar.pastDue / ar.openAr * 100) + '% of open AR' : 'nothing open' })}
        ${statCard({ label: 'FUTURE DUE', icon: I.calendar, value: m(ar.futureDue),
          note: 'issued, not yet due' })}
        ${statCard({ label: 'TOTAL AR (LEDGER)', icon: I.collection, value: m(ar.totalAr),
          note: 'customer balances', to: 'payments' })}
      </div>
      ${ar.unreconciled !== 0 ? `<div class="dashed-banner" style="margin-bottom:14px">
        The ledger and the open invoices differ by <b>${m(Math.abs(ar.unreconciled))}</b>.
        ${ar.unreconciled > 0
          ? 'The balances say more is owed than the open invoices account for — usually a manual balance adjustment.'
          : 'The open invoices exceed the balances — usually a payment or credit note that has not been matched to an invoice.'}
      </div>` : ''}
      <div class="card card-pad" style="margin-bottom:16px">
        <div class="card-title">Ageing</div>
        <div class="ar-ageing">
          ${ar.buckets.map(b => {
            const v = ar.ageing[b.key];
            const pct = ar.openAr ? Math.max(v ? 2 : 0, v / ar.openAr * 100) : 0;
            return `<div class="ar-age-row">
              <div class="ar-age-k">${esc(b.label)}</div>
              <div class="ar-age-track"><div class="ar-age-fill ${b.key}" style="width:${pct}%"></div></div>
              <div class="ar-age-v">${m(v)}</div></div>`;
          }).join('')}
        </div>
        ${ar.assumedTerms || ar.undatable ? `<div class="small muted" style="margin-top:10px">
          ${ar.assumedTerms ? `${ar.assumedTerms} invoice${ar.assumedTerms === 1 ? '' : 's'} aged on default 30-day terms, because none are recorded for that customer.` : ''}
          ${ar.undatable ? ` ${ar.undatable} invoice${ar.undatable === 1 ? ' has' : 's have'} no usable date and could not be aged; ${ar.undatable === 1 ? 'it is' : 'they are'} counted in Open AR but shown as not yet due.` : ''}
        </div>` : ''}
      </div>`;
    })()}
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
              <button class="btn btn-sm" data-credit="${f.customerId}"
                data-business="${esc(u.business||'')}">Credit</button>
              ${f.status==='flagged'?`<button class="btn btn-sm btn-dark" data-resolve="${f.id}">Resolve</button>`:''}
            </div></td>
          </tr>`;}).join(''):`<tr><td colspan="9" class="empty-cell">No collection items found</td></tr>`}
        </tbody></table></div>
    </div>
    <div class="dashed-banner" style="margin-top:14px">A daily background process automatically flags customers whose debt is about to become due, or is past due (based on their credit days).</div>`;

    el.querySelector('#cl-status').onchange=e=>{state.status=e.target.value;render();};
    el.querySelector('#cl-agent').onchange=e=>{state.agent=e.target.value;render();};

    /* One account's authoritative credit position, and the only control that
       changes its limit. The figures come from the server, not from the
       snapshot this page is otherwise drawn from — a balance in local page
       state is not the exposure a credit decision is made on. */
    el.querySelectorAll('[data-credit]').forEach(b=>b.onclick=()=>
      customerCreditModal(b.dataset.credit,b.dataset.business));

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
    /* A real generated document (Final Handover Phase 5). This used to be a
       toast saying no file existed.

       Opened in a new tab rather than fetched: the endpoint returns
       `application/pdf` with a stable filename and `Cache-Control:
       private, no-store`, so the browser's own viewer is the right consumer.
       Fetching it into a blob would strip the filename and add nothing. */
    el.querySelectorAll('[data-dl]').forEach(b=>b.onclick=()=>{
      if(!App.can('payments.view')){
        toast('Downloading an invoice needs the View payment state capability.',true);
        return;
      }
      window.open('/api/admin/invoices/'+encodeURIComponent(b.dataset.dl)+'/pdf','_blank','noopener');
    });
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

/* ---------- statement presentation (Final Handover Phase 6) ---------- */
const STMT_KIND_LABELS={invoice:'Invoice',payment:'Payment',credit_note:'Credit note',refund:'Refund'};
const STMT_DELIVERY_LABELS={pending:'Queued',processing:'Sending',retry_scheduled:'Retrying',delivered:'Delivered',failed:'Failed',cancelled:'Cancelled'};
/* Minor units to a display string. The SERVER's figure is authoritative; this
   only formats it. */
function stmtMoney(minor){const n=Number(minor)||0;const s=n<0?'-':'';const a=Math.abs(n);return s+Math.floor(a/100)+'.'+String(a%100).padStart(2,'0');}

/* ============================================================ STATEMENTS

   Rewritten for the Final Handover, Phase 6.

   WHAT THIS REPLACES

   The old screen computed the whole statement IN THE BROWSER from the local
   dataset, and its "Send to Customer" button did this:

       DB.audit('statement.send', u.business, 'Emailed to ' + u.email);
       toast('Statement emailed to ' + u.email);

   Nothing was generated, nothing was attached, nothing was sent — and the
   audit log recorded a delivery that never happened. A false record is worse
   than no button, because it is consulted later and believed.

   It also had a subtler arithmetic fault: it took the customer's CURRENT
   balance as the closing figure and subtracted the period's activity to derive
   an opening one, so a statement for any past period silently reported today's
   balance as that period's closing balance.

   Every figure now comes from the server, and "sent" is a word only the
   notification outbox may use.                                              */
App.register('statements',function(el){
  const state=App._stmt||(App._stmt={cust:'',from:'',to:todayISO(),currency:'',
    preview:null,recipient:null,currencies:[],history:[],override:'',notice:null});
  if(!state.from){
    /* Default to the calendar month just gone — the period a statement is
       almost always for. */
    const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-1);
    state.from=d.toISOString().slice(0,10);
  }

  let busy=false;

  const canView=()=>App.can('payments.view');
  const canSend=()=>App.can('statements.send');

  function describe(e){
    const s=e&&e.status,d=e&&e.data;
    if(s===403)return {kind:'err',text:'Your account does not hold the capability that needs. Nothing was sent.'};
    if(s===409&&d&&d.code==='ALREADY_SENT_TODAY')
      return {kind:'warn',text:'This statement has already been sent today. Change the period, or send again tomorrow.'};
    if(s===422&&d&&d.code==='NO_RECIPIENT')
      return {kind:'warn',text:d.error};
    if(d&&d.error)return {kind:'err',text:d.error};
    return {kind:'err',text:'That could not be completed. Nothing was sent.'};
  }

  /* ---------- data ---------- */

  async function loadCustomer(){
    state.preview=null;state.recipient=null;state.currencies=[];state.history=[];
    state.notice=null;
    if(!state.cust){render();return;}
    render();
    try{
      const [currencies,recipient,history]=await Promise.all([
        DB.statementCurrencies(state.cust),
        DB.statementRecipient(state.cust,state.override),
        DB.statementHistory(state.cust),
      ]);
      state.currencies=currencies;
      state.recipient=recipient;
      state.history=history;
      if(!state.currency&&currencies.length)state.currency=currencies[0].currency;
    }catch(e){ state.notice=describe(e); }
    render();
  }

  async function preview(){
    if(busy||!state.cust)return;
    busy=true;state.notice=null;render();
    try{
      state.preview=await DB.statementPreview(state.cust,state.from,state.to,state.currency);
      DB.audit('statement.preview',state.cust,state.from+' → '+state.to,'web');
    }catch(e){ state.preview=null;state.notice=describe(e); }
    finally{ busy=false;render(); }
  }

  async function refreshRecipient(){
    if(!state.cust)return;
    try{ state.recipient=await DB.statementRecipient(state.cust,state.override); }
    catch(e){ state.recipient={ok:false,error:describe(e).text}; }
    render();
  }

  /* ---------- render ---------- */

  function recipientHTML(){
    const r=state.recipient;
    if(!r)return '';
    if(!r.ok){
      return `<div class="dashed-banner" style="margin-top:12px">
        <b>No recipient.</b> ${esc(r.error||'')}</div>`;
    }
    return `<div class="dashed-banner" style="margin-top:12px">
      This statement will go to <b>${esc(r.address)}</b>${r.name?' ('+esc(r.name)+')':''} —
      the ${esc(r.reasonLabel||'')}.
      ${r.reason!=='explicit_override'?'Enter an address below to send it somewhere else.':''}</div>`;
  }

  function previewHTML(){
    const p=state.preview;
    if(!p)return `<div class="task-empty" style="padding:60px 20px">
      <b>Choose a period and press Preview</b>
      <div class="small muted" style="margin-top:6px">Nothing is sent until you press Send.</div></div>`;
    return `
    <div class="divider"></div>
    <div class="grid g3">
      <div class="stat-card"><div class="stat-label">OPENING BALANCE</div>
        <div class="stat-value">${esc(p.opening)} ${esc(p.currency)}</div></div>
      <div class="stat-card"><div class="stat-label">MOVEMENTS</div>
        <div class="stat-value">${esc(String(p.lines.length))}</div></div>
      <div class="stat-card"><div class="stat-label">CLOSING BALANCE</div>
        <div class="stat-value">${esc(p.closing)} ${esc(p.currency)}</div></div>
    </div>
    <div class="table-wrap" style="margin-top:14px"><table class="tbl">
      <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Detail</th>
        <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th></tr></thead>
      <tbody>
        <tr><td>${esc(p.period.from)}</td><td class="muted" colspan="3">Opening balance</td>
          <td class="num"></td><td class="num"></td><td class="num"><b>${esc(p.opening)}</b></td></tr>
        ${p.lines.length?p.lines.map(l=>`<tr>
          <td>${esc(l.date)}</td>
          <td><span class="badge outline">${esc(STMT_KIND_LABELS[l.kind]||l.kind)}</span></td>
          <td class="muted">${esc(l.reference||'—')}</td>
          <td>${esc(l.description)}</td>
          <td class="num">${esc(l.debit)}</td>
          <td class="num" style="color:var(--green)">${esc(l.credit)}</td>
          <td class="num">${esc(l.balance)}</td>
        </tr>`).join(''):`<tr><td colspan="7" class="empty-cell">No activity in this period</td></tr>`}
        <tr><td>${esc(p.period.to)}</td><td colspan="3"><b>Closing balance</b></td>
          <td class="num">${esc(p.totals.debit)}</td><td class="num">${esc(p.totals.credit)}</td>
          <td class="num"><b>${esc(p.closing)}</b></td></tr>
      </tbody></table></div>
    <div class="small muted" style="margin-top:8px">
      Every figure here is calculated by the server from the invoice, payment, credit-note and
      refund records. The closing balance is the opening balance plus these movements — it is not
      read from the customer's current balance.
    </div>`;
  }

  function historyHTML(){
    if(!state.history.length)return '';
    return `
    <div class="card card-pad" style="margin-top:14px">
      <div class="section-label">STATEMENTS SENT</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Period</th><th>Currency</th><th class="num">Closing</th>
          <th>Sent to</th><th>Delivery</th></tr></thead>
        <tbody>${state.history.map(s=>{
          const d=s.delivery;
          const label=d?(STMT_DELIVERY_LABELS[d.status]||d.status):'not queued';
          return `<tr>
            <td>${esc(s.periodFrom)} → ${esc(s.periodTo)}</td>
            <td>${esc(s.currency)}</td>
            <td class="num">${esc(stmtMoney(s.closingMinor))}</td>
            <td><div class="cell-main">${esc(s.recipientAddress)}</div>
                <div class="cell-sub">${esc(s.recipientReasonLabel||'')}</div></td>
            <td><span class="badge outline">${esc(label)}</span>
              ${d&&d.attemptCount?`<span class="small muted"> ${esc(String(d.attemptCount))} attempt${d.attemptCount===1?'':'s'}</span>`:''}
              ${d&&d.lastError&&d.status!=='delivered'?`<div class="small">${esc(d.lastError)}</div>`:''}</td>
          </tr>`;}).join('')}
        </tbody></table></div>
      <div class="small muted" style="margin-top:8px">
        A statement is marked delivered only when the email provider confirms it. Nothing here
        reports a send that did not happen.
      </div>
    </div>`;
  }

  function render(){
    if(!canView()){
      el.innerHTML=`<div class="card card-pad" style="border-left:4px solid var(--red,#c8402e)">
        <div class="card-title" style="margin-bottom:6px">Access denied</div>
        <div class="small">Account statements show a customer's full financial history, so this
          screen needs the <b>View payment state</b> capability.</div></div>`;
      return;
    }

    const customers=DB.d.users.filter(u=>['customer','special customer'].includes(u.role));
    el.innerHTML=`
    <div class="page-head"><div class="page-title">Account Statements</div></div>
    ${state.notice?`<div class="card card-pad perm-notice ${state.notice.kind}" style="margin-bottom:12px">
      <div class="small">${esc(state.notice.text)}</div></div>`:''}
    <div class="card card-pad">
      <div class="flex">
        <select class="select" id="st-cust" style="min-width:260px">
          <option value="">Select customer</option>
          ${customers.map(c=>`<option value="${esc(c.id)}"${state.cust===c.id?' selected':''}>${esc(c.business||c.email||c.id)}</option>`).join('')}
        </select>
        <div class="fieldset-outline"><label>From</label><input type="date" id="st-from" value="${esc(state.from)}"></div>
        <div class="fieldset-outline"><label>To</label><input type="date" id="st-to" value="${esc(state.to)}"></div>
        ${state.currencies.length>1?`<select class="select" id="st-cur">
          ${state.currencies.map(c=>`<option value="${esc(c.currency)}"${state.currency===c.currency?' selected':''}>${esc(c.currency)} (${esc(String(c.movements))})</option>`).join('')}
        </select>`:''}
        <button class="btn btn-dark" id="st-preview" ${!state.cust||busy?'disabled':''}>${busy?'Working…':'Preview'}</button>
        ${state.preview?`<button class="btn" id="st-pdf">${I.download} Download PDF</button>`:''}
        ${state.preview&&canSend()?`<button class="btn" id="st-send" ${busy?'disabled':''}>${I.send} Send to customer</button>`:''}
      </div>

      ${state.currencies.length>1?`<div class="dashed-banner" style="margin-top:12px">
        This customer has activity in ${esc(String(state.currencies.length))} currencies. A statement
        covers <b>one</b> currency — a running balance that mixes them is arithmetic nobody can
        defend — so send one per currency.</div>`:''}

      ${state.cust?recipientHTML():''}
      ${state.cust&&canSend()?`<div class="field" style="margin-top:10px;max-width:420px">
        <label for="st-override">Send somewhere else (optional)</label>
        <input class="input" id="st-override" value="${esc(state.override)}" placeholder="name@example.com">
      </div>`:''}

      ${state.cust?previewHTML():`<div class="task-empty" style="padding:70px 20px">
        <b>Select a customer to generate their account statement</b></div>`}
    </div>
    ${state.cust?historyHTML():''}`;

    el.querySelector('#st-cust').onchange=e=>{
      state.cust=e.target.value;state.currency='';state.preview=null;loadCustomer();
    };
    el.querySelector('#st-from').onchange=e=>{state.from=e.target.value;state.preview=null;render();};
    el.querySelector('#st-to').onchange=e=>{state.to=e.target.value;state.preview=null;render();};
    const cur=el.querySelector('#st-cur');
    if(cur)cur.onchange=e=>{state.currency=e.target.value;state.preview=null;render();};

    const ov=el.querySelector('#st-override');
    if(ov)ov.oninput=debounce(()=>{
      state.override=ov.value;refreshRecipient();
      const n=el.querySelector('#st-override');
      if(n){n.focus();n.setSelectionRange(n.value.length,n.value.length);}
    });

    el.querySelector('#st-preview').onclick=preview;

    const pdf=el.querySelector('#st-pdf');
    /* A real server-generated document, opened in the browser's own viewer —
       the endpoint returns application/pdf with a stable filename. The old
       button wrote an HTML page into a popup and called print(). */
    if(pdf)pdf.onclick=()=>{
      const qs='from='+encodeURIComponent(state.from)+'&to='+encodeURIComponent(state.to)
        +(state.currency?'&currency='+encodeURIComponent(state.currency):'');
      window.open('/api/admin/statements/'+encodeURIComponent(state.cust)+'/pdf?'+qs,'_blank','noopener');
    };

    const snd=el.querySelector('#st-send');
    if(snd)snd.onclick=sendForm;
  }

  /** Sending is confirmed, because it is outward-facing and reaches a customer. */
  function sendForm(){
    const r=state.recipient;
    if(!r||!r.ok){
      state.notice={kind:'warn',text:(r&&r.error)||'There is no recipient for this statement.'};
      render();return;
    }
    Modal.confirm('Send account statement',
      `Email this statement to <b>${esc(r.address)}</b> (the ${esc(r.reasonLabel||'chosen address')})
       as a PDF attachment?<br><br>
       Period <b>${esc(state.from)} → ${esc(state.to)}</b>, closing balance
       <b>${esc(state.preview.closing)} ${esc(state.preview.currency)}</b>.<br><br>
       It is queued for delivery and shown as delivered only once the email provider confirms it.`,
      async()=>{
        if(busy)return;
        busy=true;state.notice=null;render();
        try{
          const sent=await DB.sendStatement(state.cust,{
            from:state.from,to:state.to,currency:state.currency,recipientOverride:state.override,
          });
          state.notice={kind:'ok',text:'Statement queued for delivery to '+sent.recipientAddress
            +'. It will show as delivered once the provider confirms it.'};
          DB.audit('statement.queued',state.cust,state.from+' → '+state.to,'web');
          toast('Statement queued');
          state.history=await DB.statementHistory(state.cust).catch(()=>state.history);
        }catch(e){ state.notice=describe(e); }
        finally{ busy=false;render(); }
      },'Send statement');
  }

  if(state.cust)loadCustomer(); else render();
});

/* ============ Credit operations (Finance) ============

   Two surfaces that belong together, reached from Collection & Debt where the
   receivable already lives:

     - CREDIT REVIEWS: orders the server flagged as taking an account over its
       configured limit, awaiting an authorised decision;
     - ACCOUNT CREDIT: one customer's authoritative position, and the only
       control that changes their limit.

   THE BROWSER COMPUTES NO MONEY. Every figure here arrives from the server,
   which derives it from the ledger plus committed uninvoiced orders. A second
   formula in this file would let the screen and the order-time credit decision
   disagree about the same customer.

   Both are capability-gated SERVER-SIDE. A 403 is rendered honestly rather than
   as an empty list, because the panel cannot know what an account holds — the
   session carries a role and no capabilities. */

/** Minor units -> display. No arithmetic on money beyond splitting the units. */
function creditMoney(minor){
  const n=Number(minor||0),sign=n<0?'-':'',a=Math.abs(n);
  return sign+'$'+Math.floor(a/100).toLocaleString('en-US')+'.'+String(a%100).padStart(2,'0');
}

/** A capability failure, said plainly rather than shown as "nothing here". */
function creditDenied(el,e,what){
  const forbidden=e&&(e.status===403||/forbidden|permission/i.test(e.message||''));
  el.innerHTML='<div class="card card-pad"><div class="card-title">'+esc(what)+'</div>'
    +'<p class="muted">'+esc(forbidden
      ?'This account does not hold the capability required for this screen. Nothing is '
       +'hidden from you by mistake — ask an administrator to grant it.'
      :(e&&e.message)||'That could not be loaded.')+'</p></div>';
}

/** Awaiting decision / approved / declined, with why review was triggered. */
function creditStateBadge(r){
  if(r.state==='approved')return '<span class="badge green">Approved</span>';
  if(r.state==='declined')return '<span class="badge red">Declined / held</span>';
  return '<span class="badge yellow">Awaiting decision</span>'
    +(r.decision==='exposure_unsupported'
      ?' <span class="badge gray">exposure unavailable</span>':'');
}

App.register('credit-reviews',function(el){
  const state=App._creditRev||(App._creditRev={filter:'pending'});

  async function render(){
    el.innerHTML='<div class="page-head"><div><div class="page-title">Credit Reviews</div>'
      +'<div class="page-sub">Orders held above their account credit limit</div></div></div>'
      +'<div id="cr-body" class="muted">Loading…</div>';
    const body=el.querySelector('#cr-body');

    let reviews;
    try{reviews=await DB.creditReviews(state.filter);}
    catch(e){return creditDenied(body,e,'Credit Reviews');}

    body.innerHTML=`
      <div class="flex" style="margin-bottom:14px">
        ${['pending','approved','declined','all'].map(f=>
          `<button class="chip ${state.filter===f?'active':''}" data-f="${f}">${
            f==='pending'?'Awaiting decision':f.charAt(0).toUpperCase()+f.slice(1)}</button>`).join('')}
      </div>
      <div class="card"><div class="table-wrap"><table class="tbl">
        <thead><tr>
          <th>Order</th><th>Customer</th><th class="num">Order total</th>
          <th class="num">Exposure at submission</th><th class="num">Credit limit</th>
          <th class="num">Over by</th><th>Terms</th><th>Submitted</th>
          <th>State</th><th class="col-actions">Actions</th>
        </tr></thead>
        <tbody>${reviews.length?reviews.map(rowHtml).join('')
          :'<tr><td colspan="10" class="empty-cell">No credit reviews in this state</td></tr>'}
        </tbody></table></div></div>
      <div class="dashed-banner" style="margin-top:14px">Approving an exception lets
        <b>that order</b> proceed. It does not raise the customer&rsquo;s credit limit —
        that is a separate action, with a separate capability, on the account&rsquo;s
        credit screen.</div>`;

    body.querySelectorAll('[data-f]').forEach(b=>b.onclick=()=>{state.filter=b.dataset.f;render();});
    body.querySelectorAll('[data-decide]').forEach(b=>b.onclick=()=>
      decide(b.dataset.decide,b.dataset.resolution,b.dataset.number,render));
    body.querySelectorAll('[data-cust]').forEach(b=>b.onclick=()=>
      customerCreditModal(b.dataset.cust,b.dataset.business));
  }

  function rowHtml(r){
    /* The figures the decision was made on, AS RECORDED AT SUBMISSION — not
       recomputed now, because the question is what the system worked out then. */
    const limit=r.creditLimitMinor==null
      ?'<span class="muted">not configured</span>':creditMoney(r.creditLimitMinor);
    return `<tr>
      <td class="cell-main">${esc(r.orderNumber)}<div class="cell-sub">${esc(r.orderStatus)}</div></td>
      <td><button class="linklike" data-cust="${esc(r.customerId)}"
        data-business="${esc(r.customerBusiness)}">${esc(r.customerBusiness||'—')}</button></td>
      <td class="num">${creditMoney(r.orderTotalMinor)}</td>
      <td class="num">${creditMoney(r.projectedExposureMinor)}</td>
      <td class="num">${limit}</td>
      <td class="num">${r.overLimitByMinor?'<b>'+creditMoney(r.overLimitByMinor)+'</b>':'—'}</td>
      <td>${esc(r.paymentTerms||'—')}</td>
      <td>${r.submittedAt?fmtDateShort(r.submittedAt):'—'}</td>
      <td>${creditStateBadge(r)}</td>
      <td class="col-actions"><div class="row-actions">
        ${r.state==='pending'?`
          <button class="btn btn-sm btn-dark" data-decide="${esc(r.orderId)}"
            data-resolution="approved" data-number="${esc(r.orderNumber)}">Approve exception</button>
          <button class="btn btn-sm" data-decide="${esc(r.orderId)}"
            data-resolution="declined" data-number="${esc(r.orderNumber)}">Decline / hold</button>`
          :`<span class="cell-sub">${esc(r.resolvedByName||'—')}${
            r.resolvedAt?' · '+fmtDateShort(r.resolvedAt):''}</span>`}
      </div></td></tr>
      ${r.resolutionReason?`<tr><td colspan="10" class="cell-sub" style="padding-top:0">
        Reason: ${esc(r.resolutionReason)}</td></tr>`:''}`;
  }

  render();
});

/** Approve or decline one review. Confirmation and a reason, both required. */
function decide(orderId,resolution,number,onDone){
  const approving=resolution==='approved';
  const m=Modal.open({
    title:approving?'Approve credit exception':'Decline / keep on hold',
    body:`<div style="font-size:13px;color:var(--ink-2)">
        <p>${approving
          ?'This lets order <b>'+esc(number)+'</b> proceed even though it takes the account '
           +'over its credit limit. It does <b>not</b> raise the credit limit.'
          :'Order <b>'+esc(number)+'</b> stays on hold and cannot be progressed. It is not '
           +'cancelled and not deleted.'}</p>
        <div class="field" style="margin-top:12px"><label>Reason (required)</label>
          <textarea class="input" id="cr-reason" rows="3"
            placeholder="Why this decision was made"></textarea></div>
      </div>`,
    foot:`<button class="btn" data-x>Cancel</button>
      <button class="btn ${approving?'btn-dark':'btn-danger'}" data-go>${
        approving?'Approve exception':'Decline / hold'}</button>`,
    setup(ov,close){
      ov.querySelector('[data-x]').onclick=close;
      const go=ov.querySelector('[data-go]');
      go.onclick=async()=>{
        const reason=ov.querySelector('#cr-reason').value.trim();
        if(!reason){toast('A reason is required',true);return;}
        go.disabled=true;
        try{
          const res=await DB.decideCreditReview(orderId,resolution,reason);
          close();
          toast('Order '+res.orderNumber+' '+res.state);
          if(onDone)onDone();
        }catch(e){
          go.disabled=false;
          toast(e.message||'That decision could not be recorded',true);
        }
      };
    },
  });
  return m;
}

/* ---------------------------------------------------------------------------
   One account's credit position, and the only control that changes the limit
   --------------------------------------------------------------------------- */

function customerCreditModal(customerId,businessName){
  const m=Modal.open({
    title:'Account credit — '+(businessName||customerId),
    body:'<div id="cc-body" class="muted">Loading…</div>',
    foot:'<button class="btn" data-x>Close</button>',
    setup(ov,close){ov.querySelector('[data-x]').onclick=close;},
  });
  const body=m.el.querySelector('#cc-body');

  async function render(){
    let p;
    try{p=await DB.creditPosition(customerId);}
    catch(e){return creditDenied(body,e,'Account credit');}

    /* NULL is NOT CONFIGURED. Never "unlimited", never blank, never zero. */
    const limitLine=p.creditLimitConfigured
      ?'<b>'+esc(p.creditLimit)+'</b>'
      :'<span class="muted">Credit limit not configured</span>';
    const headroom=!p.creditLimitConfigured
      ?'<span class="muted">—</span>'
      :p.exposureUnsupported
        ?'<span class="muted">Unavailable</span>'
        :p.overLimit
          ?'<span class="badge red">Over by '+esc(p.overLimitBy)+'</span>'
          :'<b>'+esc(p.availableCredit)+'</b>';

    body.innerHTML=`
      ${p.exposureUnsupported?`<div class="dashed-banner" style="margin-bottom:12px">${
        esc(p.unsupportedReason)}</div>`:''}
      <table class="tbl"><tbody>
        <tr><td>Receivable balance</td><td class="num">${esc(p.ledger)}</td></tr>
        <tr><td>Committed, not yet invoiced${p.uninvoicedOrders
          ?' <span class="cell-sub">('+p.uninvoicedOrders+' order'
            +(p.uninvoicedOrders===1?'':'s')+')</span>':''}</td>
          <td class="num">${esc(p.uninvoiced)}</td></tr>
        <tr><td><b>Total qualifying exposure</b></td>
          <td class="num"><b>${esc(p.exposure)}</b></td></tr>
        <tr><td>Credit limit</td><td class="num">${limitLine}</td></tr>
        <tr><td>Available credit</td><td class="num">${headroom}</td></tr>
      </tbody></table>
      <div class="flex" style="margin-top:14px">
        <button class="btn btn-dark" id="cc-edit">Edit credit limit</button>
      </div>`;
    body.querySelector('#cc-edit').onclick=()=>editLimit(p);
  }

  function editLimit(p){
    const em=Modal.open({
      title:'Edit credit limit',
      body:`<div style="font-size:13px;color:var(--ink-2)">
          <p class="muted">Leave the amount empty to clear the limit back to
            <b>not configured</b>. That is not the same as zero: zero means the account
            may order nothing, and not configured means no limit has been decided.</p>
          <div class="field" style="margin-top:12px"><label>Credit limit</label>
            <input class="input" id="cc-limit" inputmode="decimal"
              value="${p.creditLimit==null?'':esc(p.creditLimit)}" placeholder="e.g. 25000.00"></div>
          <div class="field"><label>Reason (required)</label>
            <textarea class="input" id="cc-reason" rows="3"
              placeholder="Why this limit is being set or changed"></textarea></div>
        </div>`,
      foot:'<button class="btn" data-x>Cancel</button>'
        +'<button class="btn btn-dark" data-save>Save credit limit</button>',
      setup(ov,close){
        ov.querySelector('[data-x]').onclick=close;
        const save=ov.querySelector('[data-save]');
        save.onclick=async()=>{
          const reason=ov.querySelector('#cc-reason').value.trim();
          if(!reason){toast('A reason is required',true);return;}
          save.disabled=true;
          try{
            /* The value read when this screen loaded, so a change somebody else
               made while it was open is refused rather than overwritten. */
            await DB.setCreditLimit(customerId,ov.querySelector('#cc-limit').value.trim(),
              reason,p.creditLimit);
            close();
            toast('Credit limit updated');
            render();
          }catch(e){
            save.disabled=false;
            toast(e.message||'That credit limit could not be saved',true);
          }
        };
      },
    });
    return em;
  }

  render();
  return m;
}
