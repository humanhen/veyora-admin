/* ================= Pages: Public Enquiries (Fast-Track WS2 Phase 2) =========

   The operations surface for submissions from the public website's enquiry
   forms, over the governed /admin/enquiries API.

   Four things about this screen are load-bearing and deliberately not
   conveniences:

   1. VIEW AND MANAGE ARE TWO SEPARATE CAPABILITIES. `enquiries.view` renders
      the screens read-only; `enquiries.manage` unlocks the handling decisions.
      Neither implies the other, and neither is implied by any role or by any
      public_content capability. The API enforces both independently — a
      disabled control here is a courtesy, not a control.

   2. NOTHING ON THIS SCREEN CAN DELETE A SUBMISSION. There is no delete
      button because there is no delete endpoint. An enquiry is closed or
      marked spam; removal is a retention matter with its own deliberate
      process, and putting it on a screen is how it happens by accident.

   3. NOTHING IS EDITABLE. What the enquirer wrote is rendered read-only,
      always. The only thing this screen writes is a handling status and an
      internal note.

   4. A LIST DOES NOT SHOW EVERYONE'S MESSAGE. The API's list serializer omits
      the free text deliberately, and this screen does not go looking for it —
      the detail view is one click away and is where the content belongs.

   5. "RECEIVED" AND "SOMEBODY WAS TOLD" ARE SHOWN AS DIFFERENT FACTS. The
      staff-alert panel reports delivery state per attempt, including the
      not-configured case where no alert was ever queued. It is the one part of
      this screen that is allowed to say something went wrong even though the
      enquiry itself was stored perfectly (Final Handover Phase 1).

   Every displayed value passes through esc(). An enquiry is free text a
   member of the public typed; rendering it unescaped would make the enquiry
   form an injection vector into the admin panel.                             */
'use strict';

/* Presentation for each handling status. The KEYS come from the server's
   contract and are never invented here — a status the server does not return
   is not rendered, and there is no free-text status entry anywhere. */
const ENQ_STATUS_LABELS={
  'new':'New',
  'in_review':'In review',
  'responded':'Responded',
  'closed':'Closed',
  'spam':'Spam',
};

const ENQ_FORM_LABELS={
  'contact':'Contact',
  'request-b2b-account':'B2B account request',
  'private-label-enquiry':'Private label enquiry',
};

/* Field order for the detail view. Presentation only — the API decides what
   `fields` contains, and a key it does not send is simply not rendered. */
const ENQ_FIELD_ORDER=['name','email','company','businessType','country','projectType','phone','message'];
const ENQ_FIELD_LABELS={
  name:'Name',email:'Email',company:'Company',businessType:'Business type',
  country:'Country',projectType:'Project type',phone:'Phone',message:'Message',
};

const ENQ_PAGE_SIZE=25;

/* Staff-alert delivery (Final Handover Phase 1, findings ENQ-006 / NOT-006).

   Plain English for each outbox status, because the words an operator needs
   are "was anybody told?" and not the state name a worker uses. `processing`
   deliberately reads as "Sending" rather than exposing that a claim is held.

   `retryable` marks the two states the API will actually re-queue. It is a
   courtesy that keeps a button off a delivered message; the server refuses
   anything else with 409 regardless of what this screen renders. */
const ENQ_DELIVERY_STATES={
  'pending':          {label:'Queued',    tone:'muted', retryable:false},
  'processing':       {label:'Sending',   tone:'muted', retryable:false},
  'retry_scheduled':  {label:'Retrying',  tone:'warn',  retryable:true},
  'delivered':        {label:'Delivered', tone:'ok',    retryable:false},
  'failed':           {label:'Failed',    tone:'err',   retryable:true},
  'cancelled':        {label:'Cancelled', tone:'muted', retryable:true},
};
const enqDeliveryState=k=>ENQ_DELIVERY_STATES[k]||{label:k||'Unknown',tone:'muted',retryable:false};

const enqStatusLabel=k=>ENQ_STATUS_LABELS[k]||k||'—';
const enqFormLabel=k=>ENQ_FORM_LABELS[k]||k||'—';

App.register('enquiries',function(el,args){
  const state=App._enq||(App._enq={status:'',formType:'',offset:0});
  /* Selection lives in the URL (#/enquiries/<id>) so it survives an ordinary
     navigation away and back, exactly like #/account-permissions/<id>. */
  const wantedId=(args&&args[0])||null;

  /* ---------- state ----------
     `page` is the last list the SERVER returned. `detail` is the last record
     the server confirmed, and is the ONLY source of the concurrency token —
     nothing else may write to it, so a token can never be older than the
     record the operator is looking at. */
  let page=null;          /* {enquiries, total, limit, offset} */
  let detail=null;        /* the full record */
  let contract=App._enqContract||null;
  let busy=false;         /* a transition is in flight */
  let retrying=null;      /* the notification id whose retry is in flight */
  let notice=null;        /* {kind:'err'|'ok'|'warn', text, action?} */
  let noteDraft='';

  const canManage=()=>App.can('enquiries.manage');

  /* ---------- API error → operator-facing message ----------
     Every branch produces a sentence written for an operator. The raw
     response is never rendered: an API error string, a stack or an
     infrastructure detail leaking into the panel is both alarming and useless
     to the person reading it. */
  function describe(e){
    const s=e&&e.status;
    if(s===401)return {kind:'err',text:'Your session has expired. Sign in again to continue — nothing was changed.'};
    if(s===403)return {kind:'err',text:'Your account does not have permission to do that. Nothing was changed.'};
    if(s===404)return {kind:'err',text:'That enquiry could not be found.'};
    if(s===409)return {kind:'warn',text:'Someone else updated this enquiry while you were working on it. Your change was NOT saved. Reload it, then reapply what you need.',action:'reload'};
    if(s===422)return {kind:'err',text:'That is not a move this enquiry can make from its current state. Reload it to see where it actually is. Nothing was changed.',action:'reload'};
    if(s===400)return {kind:'err',text:'That change was rejected. A handling note must be 2000 characters or fewer. Nothing was changed.'};
    return {kind:'err',text:'The enquiry could not be updated. Nothing was changed — check your connection and try again.'};
  }

  /* ---------- data ---------- */

  async function loadPage(){
    try{
      page=await DB.enquiries({status:state.status,formType:state.formType,limit:ENQ_PAGE_SIZE,offset:state.offset});
    }catch(e){
      page=null;
      notice=describe(e);
    }
    render();
  }

  async function selectEnquiry(id){
    detail=null;noteDraft='';notice=null;
    render();
    try{
      detail=await DB.enquiry(id);
      noteDraft=detail.handlingNote;
    }catch(e){
      notice=describe(e);
      detail=null;
    }
    render();
  }

  /** Re-read after a 409 or 422 so the operator sees where the enquiry
      actually is now. */
  async function reloadSelected(){
    const id=(detail&&detail.id)||wantedId;
    if(!id)return;
    await selectEnquiry(id);
    if(!notice)notice={kind:'ok',text:'Reloaded this enquiry.'};
    render();
  }

  async function transition(to){
    if(!detail||busy||!canManage())return;
    busy=true;notice=null;render();
    try{
      /* The token from the matching read. `detail` is replaced only from the
         SERVER's response, so the previous token is dead the moment this
         returns. */
      const res=await DB.setEnquiryStatus(detail.id,to,detail.concurrencyToken,noteDraft);
      detail=res;
      noteDraft=res.handlingNote;
      notice={kind:'ok',text:'Enquiry moved to '+enqStatusLabel(res.handlingStatus)+'.'};
      /* The list carries the status, so it is now stale. */
      DB.audit('enquiry.status',detail.id,'moved to '+res.handlingStatus,'web');
      toast('Enquiry updated');
      await loadPage();
      return;
    }catch(e){
      /* No automatic retry, and `detail` is untouched — the screen must not
         imply a transition the server refused. */
      notice=describe(e);
    }finally{
      busy=false;render();
    }
  }

  /** Re-queues one failed staff alert.

      `retrying` is an id, not a boolean: the guard has to survive the re-render
      that follows, and a `disabled` attribute would not — a second click that
      reaches the handler directly must still be refused. It is cleared only
      after the server has answered, so a double click cannot enqueue twice.

      The refreshed notification comes from the SERVER's response; the local
      row is never optimistically moved to "Queued", because a screen claiming
      an alert is on its way when the API refused is the exact failure this
      whole phase exists to remove. */
  async function retryNotification(notificationId){
    if(!detail||retrying||!canManage()||!notificationId)return;
    retrying=notificationId;notice=null;render();
    try{
      const updated=await DB.retryEnquiryNotification(detail.id,notificationId);
      const list=(detail.delivery&&detail.delivery.notifications)||[];
      detail.delivery.notifications=list.map(n=>n.id===updated.id?updated:n);
      notice={kind:'ok',text:'That alert has been re-queued. It will be sent again shortly; this screen shows the result once it has been attempted.'};
      DB.audit('enquiry.notification.retry',detail.id,'alert re-queued','web');
      toast('Alert re-queued');
    }catch(e){
      notice=e&&e.status===409
        ?{kind:'warn',text:'That alert is not in a state that can be re-sent. Reload this enquiry to see where it actually is.',action:'reload'}
        :describe(e);
    }finally{
      retrying=null;render();
    }
  }

  function go(id){
    location.hash='#/enquiries/'+id;
  }

  /* ---------- render ---------- */

  function filtersHTML(){
    const statuses=(contract&&contract.statuses&&contract.statuses.length)?contract.statuses:Object.keys(ENQ_STATUS_LABELS);
    return `
    <div class="card card-pad" style="margin-bottom:12px">
      <div class="field">
        <label for="enq-status">Handling status</label>
        <select class="select" id="enq-status" style="width:100%">
          <option value="">All statuses</option>
          ${statuses.map(s=>`<option value="${esc(s)}"${state.status===s?' selected':''}>${esc(enqStatusLabel(s))}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin-top:8px">
        <label for="enq-form">Form</label>
        <select class="select" id="enq-form" style="width:100%">
          <option value="">All forms</option>
          ${Object.keys(ENQ_FORM_LABELS).map(f=>`<option value="${esc(f)}"${state.formType===f?' selected':''}>${esc(enqFormLabel(f))}</option>`).join('')}
        </select>
      </div>
    </div>`;
  }

  function listHTML(){
    if(!page)return `<div class="card card-pad"><div class="muted small">Loading enquiries…</div></div>`;
    const rows=page.enquiries;
    const from=page.offset+1,to=page.offset+rows.length;
    return `
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Enquiry</th><th>Status</th></tr></thead>
        <tbody>${rows.length?rows.map(e=>{
          const sel=detail&&detail.id===e.id;
          return `<tr${sel?' class="active"':''}>
            <td><button class="linklike" data-pick="${esc(e.id)}"${sel?' aria-current="true"':''}>
                  <span class="cell-main">${esc(e.name||'(no name given)')}</span>
                  <span class="cell-sub">${esc(enqFormLabel(e.formType))}${e.company?' — '+esc(e.company):''} · ${esc(fmtDateShort(e.createdAt))}</span>
                </button></td>
            <td><span class="badge outline">${esc(enqStatusLabel(e.handlingStatus))}</span></td>
          </tr>`;}).join(''):`<tr><td colspan="2" class="empty-cell">No enquiries match these filters</td></tr>`}
        </tbody></table></div>
      <div class="flex" style="justify-content:space-between;align-items:center;padding:10px 12px">
        <span class="small muted" role="status" aria-live="polite">${rows.length?esc(from+'–'+to+' of '+page.total):'0 of '+esc(String(page.total))}</span>
        <span class="flex" style="gap:6px">
          <button class="btn btn-sm" data-prev ${page.offset>0?'':'disabled'}>Previous</button>
          <button class="btn btn-sm" data-next ${(page.offset+rows.length)<page.total?'':'disabled'}>Next</button>
        </span>
      </div>
    </div>`;
  }

  function fieldsHTML(){
    const fields=detail.fields||{};
    /* Known keys in the intended order, then anything else the API sent, so a
       new form field is still shown rather than silently dropped. */
    const keys=ENQ_FIELD_ORDER.filter(k=>k in fields)
      .concat(Object.keys(fields).filter(k=>ENQ_FIELD_ORDER.indexOf(k)<0));
    if(!keys.length)return `<div class="small muted">This submission recorded no fields.</div>`;
    return keys.map(k=>`
      <div class="field">
        <label>${esc(ENQ_FIELD_LABELS[k]||k)}</label>
        <div class="small" style="white-space:pre-wrap">${esc(fields[k])}</div>
      </div>`).join('');
  }

  function retentionHTML(){
    const r=detail.retention||{};
    if(!r.retainUntil)return '';
    const overdue=r.expired===true;
    return `<div class="small ${overdue?'':'muted'}" style="margin-top:8px">
      Retention: ${esc(String(r.retentionDays))} days from submission — ${overdue?'due for removal since':'held until'}
      ${esc(fmtDateShort(r.retainUntil))}.
      ${overdue?'Removal is a separate, deliberate process; it is not performed from this screen.':''}
    </div>`;
  }

  /* ---------- staff-alert delivery ----------

     Answers one question honestly: was anybody actually told this enquiry
     arrived? Before this existed a submission was stored, the screen said
     "received", and no message was ever sent (ENQ-006 / NOT-006).

     WHAT THIS DELIBERATELY DOES NOT SHOW: the provider, the host, the port,
     the credential, the provider's message id, or any part of the template
     data. `recipientMasked` arrives already masked from the API and is
     rendered as it came — this screen does not have the full address and
     cannot reconstruct one. `lastError` is the provider's own failure reason,
     which is what makes a misconfiguration actionable; it is built by the
     outbox from a code and a provider message and never from a payload. */
  function deliveryHTML(){
    const d=detail.delivery||{configured:false,notifications:[]};
    const list=d.notifications||[];

    if(!d.configured||!list.length){
      /* An empty list is not "sent"; it is "no alert was ever queued". Saying
         so plainly is the point — silence is what the old behaviour looked
         like from here. */
      return `
      <div class="card card-pad" style="margin-top:12px">
        <div class="section-label">STAFF ALERT</div>
        <div class="small" style="margin-top:6px">
          <b>Not configured.</b> No alert was queued for this enquiry, so nobody was emailed about it.
        </div>
        <div class="small muted" style="margin-top:6px">
          The enquiry itself was stored safely and is shown above. Alerts start being queued once a
          recipient address is configured for the platform; ask whoever administers the deployment.
        </div>
      </div>`;
    }

    const rows=list.map(n=>{
      const st=enqDeliveryState(n.status);
      const inFlight=retrying===n.id;
      const canRetry=canManage()&&st.retryable;
      return `
      <div class="field" style="margin-top:10px">
        <div class="flex" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span>
            <span class="badge outline">${esc(st.label)}</span>
            <span class="small muted" style="margin-left:6px">${esc(n.recipientMasked||'recipient hidden')}</span>
          </span>
          ${canRetry?`<button class="btn btn-sm" data-retry="${esc(n.id)}" ${retrying?'disabled':''}>
            ${esc(inFlight?'Re-queueing…':'Send again')}</button>`:''}
        </div>
        <div class="small muted" style="margin-top:4px">
          ${esc(n.attemptCount===1?'1 attempt':String(n.attemptCount)+' attempts')}${
            n.lastAttemptedAt?' · last tried '+esc(fmtDateShort(n.lastAttemptedAt)):' · not yet attempted'}${
            n.status==='delivered'&&n.deliveredAt?' · delivered '+esc(fmtDateShort(n.deliveredAt)):''}${
            n.status==='retry_scheduled'&&n.nextAttemptAt?' · next attempt '+esc(fmtDateShort(n.nextAttemptAt)):''}${
            n.status==='failed'&&n.failedAt?' · gave up '+esc(fmtDateShort(n.failedAt)):''}
        </div>
        ${n.lastError&&n.status!=='delivered'?`<div class="small" style="margin-top:4px">
          Last error: ${esc(n.lastError)}</div>`:''}
      </div>`;
    }).join('');

    const failed=list.filter(n=>n.status==='failed').length;
    return `
    <div class="card card-pad" style="margin-top:12px">
      <div class="section-label">STAFF ALERT</div>
      ${failed?`<div class="small" style="margin-top:6px">
        <b>${esc(String(failed))} alert${failed===1?'':'s'} could not be delivered.</b>
        The enquiry is safe and is shown above, but nobody was emailed about it.
      </div>`:''}
      ${rows}
      ${canManage()?'':`<div class="small muted" style="margin-top:10px">
        You can see whether an alert was delivered but not re-send one. That needs the
        <b>Manage public enquiries</b> capability.
      </div>`}
    </div>`;
  }

  function decisionsHTML(){
    const allowed=detail.allowedTransitions||[];
    if(!canManage()){
      return `<div class="small muted" style="margin-top:12px">
        You can read enquiries but not change how they are handled. That needs the
        <b>Manage public enquiries</b> capability, which is granted per account.
      </div>`;
    }
    return `
    <div class="field" style="margin-top:12px">
      <label for="enq-note">Internal handling note</label>
      <textarea class="input" id="enq-note" rows="3" maxlength="2000"
        ${busy?'disabled':''}>${esc(noteDraft)}</textarea>
      <div class="small muted">Visible only to staff. Saved with the next handling decision.</div>
    </div>
    <div class="flex" style="justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:10px">
      ${allowed.length?allowed.map(s=>`<button class="btn btn-sm${s==='spam'?'':' btn-dark'}" data-to="${esc(s)}" ${busy?'disabled':''}>
          ${esc(busy?'Saving…':'Mark '+enqStatusLabel(s).toLowerCase())}</button>`).join('')
        :'<span class="small muted">No further handling decisions are available from this state.</span>'}
    </div>`;
  }

  function detailHTML(){
    if(notice&&!detail){
      return `<div class="card card-pad perm-notice ${notice.kind}">
        <div class="small">${esc(notice.text)}</div>
        ${notice.action==='reload'?'<button class="btn btn-sm" data-reload style="margin-top:10px">Reload this enquiry</button>':''}
      </div>`;
    }
    if(!detail)return `<div class="card card-pad"><div class="muted small">Select an enquiry on the left to read it.</div></div>`;

    return `
    <div class="card card-pad" style="margin-bottom:12px">
      <div class="card-title" style="margin-bottom:2px">${esc(enqFormLabel(detail.formType))}</div>
      <div class="small muted">
        <span class="badge outline">${esc(enqStatusLabel(detail.handlingStatus))}</span>
        Received ${esc(fmtDateShort(detail.createdAt))}${detail.sourcePath?' from '+esc(detail.sourcePath):''}
      </div>
      ${detail.handledAt?`<div class="small muted" style="margin-top:6px">
        Last handled ${esc(fmtDateShort(detail.handledAt))}${detail.handledBy?' by '+esc(DB.userName(detail.handledBy)):''}.
      </div>`:''}
      ${detail.consentAt?`<div class="small muted" style="margin-top:6px">
        Contact consent given ${esc(fmtDateShort(detail.consentAt))} (${esc(detail.consentVersion||'unversioned')}).
      </div>`:`<div class="small muted" style="margin-top:6px">No contact consent was recorded with this submission.</div>`}
      ${retentionHTML()}
    </div>

    ${notice?`<div class="card card-pad perm-notice ${notice.kind}" style="margin-bottom:12px">
      <div class="small">${esc(notice.text)}</div>
      ${notice.action==='reload'?'<button class="btn btn-sm" data-reload style="margin-top:10px">Reload this enquiry</button>':''}
    </div>`:''}

    <div class="card card-pad">
      <div class="section-label">SUBMITTED</div>
      ${fieldsHTML()}
      ${detail.handlingNote?`<div class="field"><label>Current handling note</label>
        <div class="small" style="white-space:pre-wrap">${esc(detail.handlingNote)}</div></div>`:''}
      ${decisionsHTML()}
    </div>
    ${deliveryHTML()}`;
  }

  function deniedHTML(){
    /* A direct visit without the capability. Says what is true and offers no
       way around it. */
    return `<div class="card card-pad" style="border-left:4px solid var(--red,#c8402e)">
      <div class="card-title" style="margin-bottom:6px">Access denied</div>
      <div class="small" style="margin-bottom:4px">
        Your account does not have the <b>View public enquiries</b> capability, so this screen is unavailable.
      </div>
      <div class="small muted">
        Enquiries contain personal contact details, so this capability is granted per account and is not
        implied by the administrator role or by any public-content capability.
        Ask someone who holds <b>Manage account permissions</b> to grant it to you.
      </div>
    </div>`;
  }

  function render(){
    if(!App.can('enquiries.view')){el.innerHTML=deniedHTML();return;}
    el.innerHTML=`
      <div class="perm-layout">
        <div class="perm-accounts">${filtersHTML()}${listHTML()}</div>
        <div class="perm-editor">${detailHTML()}</div>
      </div>`;

    const status=el.querySelector('#enq-status');
    if(status)status.onchange=e=>{state.status=e.target.value;state.offset=0;loadPage();};
    const form=el.querySelector('#enq-form');
    if(form)form.onchange=e=>{state.formType=e.target.value;state.offset=0;loadPage();};

    const prev=el.querySelector('[data-prev]');
    if(prev)prev.onclick=()=>{state.offset=Math.max(0,state.offset-ENQ_PAGE_SIZE);loadPage();};
    const next=el.querySelector('[data-next]');
    if(next)next.onclick=()=>{state.offset=state.offset+ENQ_PAGE_SIZE;loadPage();};

    el.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>go(b.dataset.pick));
    el.querySelectorAll('[data-reload]').forEach(b=>b.onclick=()=>{b.disabled=true;reloadSelected();});

    /* The note only edits the DRAFT. It is sent with the next decision and
       never on its own — a note is a record of how an enquiry was handled,
       not an independent edit. */
    const note=el.querySelector('#enq-note');
    if(note)note.oninput=()=>{noteDraft=note.value;};

    el.querySelectorAll('[data-to]').forEach(b=>b.onclick=()=>transition(b.dataset.to));
    el.querySelectorAll('[data-retry]').forEach(b=>b.onclick=()=>retryNotification(b.dataset.retry));
  }

  /* ---------- entry ----------
     The capability may not have been probed yet on a direct visit (a page load
     straight to #/enquiries). Probe, then render — a not-yet-answered probe
     must render as denied, never as the screen. */
  function start(){
    contract=App._enqContract||contract;
    render();
    if(!App.can('enquiries.view'))return;
    loadPage();
    if(wantedId)selectEnquiry(wantedId);
  }

  if(App.capsChecked){
    start();
  }else{
    el.innerHTML=`<div class="card card-pad"><div class="muted small">Checking your permissions…</div></div>`;
    App.loadCaps().then(()=>{App.renderNav();start();});
  }
});
