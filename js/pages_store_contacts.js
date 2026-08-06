/* ================= Pages: Store Contacts (Final Handover Phase 2) ===========

   The people who work AT a customer, over the governed
   /admin/customer-contacts API.

   THE DISTINCTION THIS SCREEN EXISTS TO MAKE VISIBLE

     Veyora sales rep — an internal Veyora agent, shown read-only at the top
       so whoever is looking at a store's contacts can see who at Veyora owns
       it. This screen never changes it.
     Store contact — a person who works for the customer. Everything below.
       No login, no capability, no authority.
     Portal user — an account that may authenticate. Shown as a link on a
       contact, and only as a link: this screen cannot create, disable or
       alter an account.

   Six things are load-bearing and deliberately not conveniences:

   1. VIEW AND MANAGE ARE TWO SEPARATE CAPABILITIES, and neither is implied by
      any role or by `users.manage`. A disabled control here is a courtesy; the
      API enforces both independently.

   2. NOTHING ON THIS SCREEN CAN DELETE A CONTACT. There is no delete button
      because there is no delete endpoint. A contact is archived, and an
      archived contact is still shown — greyed, with a Reactivate control.

   3. NOTHING IS SENT FROM HERE. The call, email and WhatsApp controls are
      ordinary links a human clicks. There is no "send" anywhere on this
      screen, no template, and no queue.

   4. NO RESPONSIBILITY IS EVER PRE-TICKED. A responsibility is a statement
      about what somebody actually does; defaulting one would be the system
      inventing it.

   5. THE PRIMARY IS REPLACED, NOT VACATED. Archiving the primary is refused by
      the API, and this screen says why rather than hiding the control — a
      hidden button teaches nothing, and the operator needs to know the rule.

   6. A STORE WITH NO CONTACTS IS A NORMAL STATE. Every legacy customer starts
      that way. It is shown as a plain sentence, not as an error.

   Every displayed value passes through esc(). A contact's name, job title and
   notes are free text somebody typed.                                        */
'use strict';

const SC_RESPONSIBILITY_LABELS={
  'owner':'Owner',
  'store_manager':'Store manager',
  'buyer':'Buyer',
  'accounts_payable':'Accounts payable',
  'receiving':'Receiving',
  'returns_warranty':'Returns & warranty',
  'other':'Other',
};

const SC_METHOD_LABELS={
  'email':'Email',
  'mobile_call':'Mobile call',
  'whatsapp':'WhatsApp',
  'office_phone':'Office phone',
};

const scRespLabel=k=>SC_RESPONSIBILITY_LABELS[k]||k||'—';
const scMethodLabel=k=>SC_METHOD_LABELS[k]||k||'—';
const scName=c=>((c.firstName||'')+' '+(c.lastName||'')).trim()||'(unnamed)';

/* A WhatsApp link needs the digits only. Built from the number as typed, with
   no country code invented — if the stored number is local, the link is local,
   which is the honest result. Same rule as the server's normaliser. */
const scWaDigits=n=>String(n||'').replace(/\D+/g,'');

App.register('store-contacts',function(el,args){
  const state=App._storeContacts||(App._storeContacts={q:'',showArchived:true});
  /* Selection lives in the URL (#/store-contacts/<customerId>) so it survives
     an ordinary navigation away and back. */
  const wantedId=(args&&args[0])||null;

  /* ---------- state ----------
     `data` is the last answer the SERVER gave for this store, and is the ONLY
     source of a concurrency token. Nothing else writes to it, so a token can
     never be older than the record on screen. */
  let data=null;          /* {customer, salesRep, contacts, hasPrimary} */
  let busy=null;          /* the contact id whose action is in flight */
  let notice=null;        /* {kind:'err'|'ok'|'warn', text, action?} */
  let contract=App._contactContract||null;

  const canManage=()=>App.can('customer_contacts.manage');

  /* ---------- API error → operator-facing message ----------
     Every branch is a sentence written for an operator. The raw response is
     never rendered. */
  function describe(e){
    const s=e&&e.status;
    const code=e&&e.data&&e.data.code;
    if(s===401)return {kind:'err',text:'Your session has expired. Sign in again to continue — nothing was changed.'};
    if(s===403)return {kind:'err',text:'Your account does not have permission to do that. Nothing was changed.'};
    if(s===404)return {kind:'err',text:'That contact could not be found. Reload this store.',action:'reload'};
    if(s===409&&code==='ACCOUNT_ALREADY_LINKED')return {kind:'warn',text:'Another contact is already recorded as using that portal account. Unlink it there first. Nothing was changed.'};
    if(s===409)return {kind:'warn',text:'Someone else changed this contact while you were working on it. Your change was NOT saved. Reload, then reapply what you need.',action:'reload'};
    if(s===422&&code==='PRIMARY_MUST_BE_REPLACED')return {kind:'warn',text:'That is the primary contact. Make another contact primary first, then archive this one. Nothing was changed.'};
    if(s===422)return {kind:'err',text:(e&&e.data&&e.data.error)||'That change is not allowed from this state. Nothing was changed.'};
    if(s===400&&e.data&&Array.isArray(e.data.errors))return {kind:'err',text:'That contact could not be saved: '+e.data.errors.map(x=>x.message).join(' ')};
    return {kind:'err',text:'That change could not be saved. Nothing was changed — check your connection and try again.'};
  }

  /* ---------- data ---------- */

  async function load(id){
    data=null;notice=null;render();
    try{
      data=await DB.storeContacts(id);
    }catch(e){
      notice=describe(e);
      data=null;
    }
    render();
  }

  async function reload(){
    const id=(data&&data.customer.id)||wantedId;
    if(id)await load(id);
  }

  /** Runs one governed action against one contact.
   *
   *  `busy` is the contact ID, not a boolean: the guard has to survive the
   *  re-render that follows, and a `disabled` attribute would not — a second
   *  click reaching the handler directly must still be refused. It is cleared
   *  only once the server has answered, so a double click cannot archive and
   *  then reactivate, or promote twice. */
  async function act(contactId, fn, successText){
    if(busy||!canManage())return;
    busy=contactId;notice=null;render();
    try{
      const updated=await fn();
      /* Replaced from the SERVER's response. The row is never optimistically
         moved: a screen showing an archived contact the API refused to archive
         is worse than one that took a moment. */
      data.contacts=data.contacts.map(c=>c.id===updated.id?updated:c);
      /* Promotion and archival change ANOTHER row too (the old primary), so
         those two re-read the store rather than patching one entry. */
      notice={kind:'ok',text:successText};
      toast(successText);
      DB.audit('contact.action',contactId,successText,'web');
    }catch(e){
      notice=describe(e);
    }finally{
      busy=null;render();
    }
  }

  /** Actions that change a second row re-read the whole store afterwards. */
  async function actAndReload(contactId, fn, successText){
    await act(contactId, fn, successText);
    if(notice&&notice.kind==='ok')await reload();
  }

  /* ---------- the add / edit form ---------- */

  function contactForm(existing){
    const c=existing||{firstName:'',lastName:'',jobTitle:'',responsibilities:[],
      mobile:'',officePhone:'',officeExtension:'',email:'',
      preferredContactMethod:'email',preferredLanguage:'',notes:'',isPrimary:false};
    const responsibilities=(contract&&contract.responsibilities&&contract.responsibilities.length)
      ? contract.responsibilities : Object.keys(SC_RESPONSIBILITY_LABELS);
    const methods=(contract&&contract.contactMethods&&contract.contactMethods.length)
      ? contract.contactMethods : Object.keys(SC_METHOD_LABELS);

    Modal.open({title:existing?'Edit Store Contact':'Add Store Contact',size:'wide',
      body:`
      <div class="section-label">WHO THEY ARE</div>
      <div class="grid g3">
        <div class="field"><label for="sc-fn">First name</label>
          <input class="input" id="sc-fn" maxlength="120" value="${esc(c.firstName)}"></div>
        <div class="field"><label for="sc-ln">Last name</label>
          <input class="input" id="sc-ln" maxlength="120" value="${esc(c.lastName)}"></div>
        <div class="field"><label for="sc-title">Job title</label>
          <input class="input" id="sc-title" maxlength="120" value="${esc(c.jobTitle)}"
            placeholder="as they describe it"></div>
      </div>

      <div class="section-label">WHAT THEY HANDLE</div>
      <div class="small muted" style="margin-bottom:6px">
        Tick only what this person actually handles. Nothing is assumed from a job title.
      </div>
      <div class="grid g3">
        ${responsibilities.map(k=>`<label class="checkbox-row">
          <input type="checkbox" data-resp="${esc(k)}"${c.responsibilities.includes(k)?' checked':''}>
          ${esc(scRespLabel(k))}</label>`).join('')}
      </div>

      <div class="section-label">HOW TO REACH THEM</div>
      <div class="small muted" style="margin-bottom:6px">
        An active contact needs at least one of these. Nothing here sends anything.
      </div>
      <div class="grid g3">
        <div class="field"><label for="sc-email">Email</label>
          <input class="input" id="sc-email" type="email" maxlength="254" value="${esc(c.email)}"></div>
        <div class="field"><label for="sc-mobile">Mobile</label>
          <input class="input" id="sc-mobile" maxlength="40" value="${esc(c.mobile)}"></div>
        <div class="field"><label for="sc-office">Office phone</label>
          <input class="input" id="sc-office" maxlength="40" value="${esc(c.officePhone)}"></div>
        <div class="field"><label for="sc-ext">Extension</label>
          <input class="input" id="sc-ext" maxlength="12" value="${esc(c.officeExtension)}"></div>
        <div class="field"><label for="sc-method">Preferred channel</label>
          <select class="select" id="sc-method">
            ${methods.map(m=>`<option value="${esc(m)}"${c.preferredContactMethod===m?' selected':''}>${esc(scMethodLabel(m))}</option>`).join('')}
          </select></div>
        <div class="field"><label for="sc-lang">Preferred language</label>
          <input class="input" id="sc-lang" maxlength="35" value="${esc(c.preferredLanguage)}"
            placeholder="e.g. en, es"></div>
      </div>

      <div class="field"><label for="sc-notes">Internal note</label>
        <textarea class="input" id="sc-notes" rows="3" maxlength="2000">${esc(c.notes)}</textarea>
        <div class="small muted">Visible only to staff. Never shown to the customer.</div></div>

      ${existing?'':`<label class="checkbox-row"><input type="checkbox" id="sc-primary">
        Make this the store's primary contact</label>`}

      <div class="dashed-banner">Adding a contact does not create a portal login, does not record
      consent, and sends nothing. Link an existing portal account separately if this person signs in.</div>`,
      foot:`<button class="btn" data-x>Cancel</button>
            <button class="btn btn-dark" data-ok>${existing?'Save changes':'Add contact'}</button>`,
      setup(ov,close){
        ov.querySelector('[data-x]').onclick=close;
        const ok=ov.querySelector('[data-ok]');
        let saving=false;
        ok.onclick=async()=>{
          if(saving)return;
          const fields={
            firstName:ov.querySelector('#sc-fn').value,
            lastName:ov.querySelector('#sc-ln').value,
            jobTitle:ov.querySelector('#sc-title').value,
            responsibilities:[...ov.querySelectorAll('[data-resp]:checked')].map(i=>i.dataset.resp),
            email:ov.querySelector('#sc-email').value,
            mobile:ov.querySelector('#sc-mobile').value,
            officePhone:ov.querySelector('#sc-office').value,
            officeExtension:ov.querySelector('#sc-ext').value,
            preferredContactMethod:ov.querySelector('#sc-method').value,
            preferredLanguage:ov.querySelector('#sc-lang').value,
            notes:ov.querySelector('#sc-notes').value,
          };
          const primaryBox=ov.querySelector('#sc-primary');
          if(primaryBox&&primaryBox.checked)fields.isPrimary=true;

          saving=true;ok.disabled=true;
          try{
            if(existing){
              await DB.updateStoreContact(data.customer.id,existing.id,fields,existing.concurrencyToken);
              notice={kind:'ok',text:'Contact updated.'};
            }else{
              await DB.createStoreContact(data.customer.id,fields);
              notice={kind:'ok',text:'Contact added. No portal login was created and nothing was sent.'};
            }
            close();
            await reload();
            toast('Saved');
          }catch(e){
            /* The modal stays open with the operator's typing intact: closing
               it on a validation failure would throw away what they wrote. */
            notice=describe(e);
            saving=false;ok.disabled=false;
            const banner=ov.querySelector('#sc-form-error')||(()=>{
              const d=document.createElement('div');
              d.id='sc-form-error';d.className='perm-notice err';
              d.style.marginTop='10px';ov.querySelector('.modal-body,.modal')?.appendChild(d);
              return d;
            })();
            banner.innerHTML=`<div class="small">${esc(notice.text)}</div>`;
          }
        };
      }});
  }

  function linkForm(contact){
    /* The only account the API accepts is the customer's own login, so this is
       a confirmation rather than a picker. Offering a search over every
       account would suggest a cross-customer link is possible; it is not. */
    Modal.confirm('Link portal account',
      `Record that <b>${esc(scName(contact))}</b> signs in with this store's portal account
       (<b>${esc(data.customer.business||data.customer.id)}</b>)?
       <br><br>This grants no capability, changes no password and sends nothing —
       it records which login this person uses.`,
      ()=>actAndReload(contact.id,
        ()=>DB.linkStoreContactPortal(data.customer.id,contact.id,data.customer.id,contact.concurrencyToken),
        'Portal account linked.'),
      'Link account');
  }

  /* ---------- render ---------- */

  function pickerHTML(){
    /* Customers come from the snapshot the panel already holds. This screen
       reads that list only to CHOOSE a store; every contact fact comes from
       the governed API. */
    const q=state.q.toLowerCase();
    const customers=(DB.d.users||[])
      .filter(u=>['customer','special customer'].includes(u.role))
      .filter(u=>!q||((u.business||'')+' '+(u.email||'')+' '+(u.customerNumber||'')).toLowerCase().includes(q))
      .slice(0,50);
    return `
    <div class="card card-pad" style="margin-bottom:12px">
      <div class="field">
        <label for="sc-q">Find a store</label>
        <div class="search-wrap">${I.search}<input class="input" id="sc-q" placeholder="Business, email or customer number…" value="${esc(state.q)}"></div>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Store</th></tr></thead>
        <tbody>${customers.length?customers.map(u=>{
          const sel=data&&data.customer.id===u.id;
          return `<tr${sel?' class="active"':''}>
            <td><button class="linklike" data-store="${esc(u.id)}"${sel?' aria-current="true"':''}>
              <span class="cell-main">${esc(u.business||u.email||u.id)}</span>
              <span class="cell-sub">${esc(u.customerNumber||'—')} · ${esc(u.email||'')}</span>
            </button></td></tr>`;}).join(''):`<tr><td class="empty-cell">No stores match</td></tr>`}
        </tbody></table></div>
    </div>`;
  }

  function repHTML(){
    const rep=data.salesRep;
    return `
    <div class="card card-pad" style="margin-bottom:12px">
      <div class="card-title" style="margin-bottom:2px">${esc(data.customer.business||data.customer.id)}</div>
      <div class="small muted">Customer ${esc(data.customer.customerNumber||'—')} · ${esc(data.customer.status||'')}</div>
      <div class="section-label" style="margin-top:12px">VEYORA SALES REP</div>
      ${rep?`<div class="small">${esc(rep.name||rep.id)} <span class="badge outline">${esc(rep.role)}</span></div>
        <div class="small muted">${esc(rep.email||'')}</div>`
      :`<div class="small muted">No Veyora sales rep is assigned to this store.</div>`}
      <div class="small muted" style="margin-top:6px">
        The sales rep is internal to Veyora and is assigned on the customer record, not here.
      </div>
    </div>`;
  }

  function channelsHTML(c){
    /* Ordinary links. Nothing on this screen sends: a person clicks, their own
       phone or mail client opens, and the platform is not involved. */
    const bits=[];
    if(c.email)bits.push(`<a class="btn btn-sm" href="mailto:${esc(c.email)}">Email</a>`);
    if(c.mobile)bits.push(`<a class="btn btn-sm" href="tel:${esc(c.mobile.replace(/[^\d+]/g,''))}">Call mobile</a>`);
    if(c.mobile)bits.push(`<a class="btn btn-sm" href="https://wa.me/${esc(scWaDigits(c.mobile))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`);
    if(c.officePhone)bits.push(`<a class="btn btn-sm" href="tel:${esc(c.officePhone.replace(/[^\d+]/g,''))}">Call office${c.officeExtension?' ext '+esc(c.officeExtension):''}</a>`);
    return bits.length?`<div class="flex" style="gap:6px;flex-wrap:wrap;margin-top:8px">${bits.join('')}</div>`:'';
  }

  function verificationHTML(c){
    const v=c.verification||{};
    if(v.state==='never')return `<span class="badge outline">Never verified</span>`;
    if(v.state==='stale')return `<span class="badge outline">Verified ${esc(fmtDateShort(v.verifiedAt))} — due a check</span>`;
    return `<span class="small muted">Verified ${esc(fmtDateShort(v.verifiedAt))}</span>`;
  }

  function contactHTML(c){
    const inFlight=busy===c.id;
    const dim=c.isActive?'':'opacity:.62';
    const manage=canManage();
    const disabled=busy?' disabled':'';
    return `
    <div class="card card-pad" style="margin-bottom:10px;${dim}">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap">
        <div>
          <div class="cell-main">${esc(scName(c))}
            ${c.isPrimary?'<span class="badge outline">Primary</span>':''}
            ${c.isActive?'':'<span class="badge outline">Archived</span>'}</div>
          <div class="cell-sub">${esc(c.jobTitle||'No job title recorded')}</div>
        </div>
        <div>${verificationHTML(c)}</div>
      </div>

      <div class="small muted" style="margin-top:6px">
        ${c.responsibilities.length
          ? 'Handles: '+c.responsibilities.map(r=>esc(scRespLabel(r))).join(', ')
          : 'No responsibilities recorded. Nothing is assumed from the job title.'}
      </div>
      <div class="small muted" style="margin-top:4px">
        Prefers ${esc(scMethodLabel(c.preferredContactMethod))}${c.preferredLanguage?' · '+esc(c.preferredLanguage):''}
      </div>
      <div class="small muted" style="margin-top:4px">
        ${c.portalUserId
          ? 'Signs in with this store’s portal account.'
          : 'No portal login recorded for this person.'}
      </div>
      ${c.notes?`<div class="small" style="white-space:pre-wrap;margin-top:6px">${esc(c.notes)}</div>`:''}

      ${channelsHTML(c)}

      ${manage?`<div class="flex" style="gap:6px;flex-wrap:wrap;margin-top:10px;justify-content:flex-end">
        ${c.isActive?`<button class="btn btn-sm" data-edit="${esc(c.id)}"${disabled}>Edit</button>`:''}
        ${c.isActive&&!c.isPrimary?`<button class="btn btn-sm btn-dark" data-primary="${esc(c.id)}"${disabled}>${inFlight?'Working…':'Make primary'}</button>`:''}
        ${c.isActive?`<button class="btn btn-sm" data-verify="${esc(c.id)}"${disabled}>Mark verified</button>`:''}
        ${c.isActive&&!c.portalUserId?`<button class="btn btn-sm" data-link="${esc(c.id)}"${disabled}>Link portal account</button>`:''}
        ${c.portalUserId?`<button class="btn btn-sm" data-unlink="${esc(c.id)}"${disabled}>Unlink portal account</button>`:''}
        ${c.isActive&&!c.isPrimary?`<button class="btn btn-sm" data-archive="${esc(c.id)}"${disabled}>Archive</button>`:''}
        ${c.isActive?'':`<button class="btn btn-sm" data-reactivate="${esc(c.id)}"${disabled}>Reactivate</button>`}
      </div>
      ${c.isPrimary&&c.isActive?`<div class="small muted" style="margin-top:6px;text-align:right">
        The primary contact is replaced, not removed: make another contact primary first.
      </div>`:''}`:''}
    </div>`;
  }

  function contactsHTML(){
    const shown=state.showArchived?data.contacts:data.contacts.filter(c=>c.isActive);
    const archivedCount=data.contacts.filter(c=>!c.isActive).length;
    return `
    ${notice?`<div class="card card-pad perm-notice ${notice.kind}" style="margin-bottom:12px">
      <div class="small">${esc(notice.text)}</div>
      ${notice.action==='reload'?'<button class="btn btn-sm" data-reload style="margin-top:10px">Reload this store</button>':''}
    </div>`:''}

    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
      <div class="section-label" style="margin:0">STORE CONTACTS</div>
      <div class="flex" style="gap:8px;align-items:center">
        ${archivedCount?`<label class="checkbox-row" style="margin:0">
          <input type="checkbox" id="sc-arch"${state.showArchived?' checked':''}>
          Show ${esc(String(archivedCount))} archived</label>`:''}
        ${canManage()?'<button class="btn btn-dark btn-sm" id="sc-add">Add contact</button>':''}
      </div>
    </div>

    ${data.hasPrimary?'':`<div class="dashed-banner" style="margin-bottom:10px">
      This store has no primary contact. Every other contact still works; a primary is who Veyora
      approaches first.
    </div>`}

    ${shown.length?shown.map(contactHTML).join(''):`
      <div class="card card-pad">
        <div class="small">No contacts are recorded for this store yet.</div>
        <div class="small muted" style="margin-top:6px">
          That is normal for a customer created before contacts existed. Nothing was migrated
          automatically: a contact invented from an old account record would be a person nobody
          chose, with a number nobody confirmed.
        </div>
      </div>`}

    ${canManage()?'':`<div class="small muted" style="margin-top:10px">
      You can read store contacts but not change them. That needs the
      <b>Manage store contacts</b> capability, which is granted per account.
    </div>`}`;
  }

  function deniedHTML(){
    return `<div class="card card-pad" style="border-left:4px solid var(--red,#c8402e)">
      <div class="card-title" style="margin-bottom:6px">Access denied</div>
      <div class="small" style="margin-bottom:4px">
        Your account does not have the <b>View store contacts</b> capability, so this screen is unavailable.
      </div>
      <div class="small muted">
        Store contacts are named people with phone numbers and email addresses, so this capability is
        granted per account. It is not implied by the administrator role, and not by being able to
        edit a customer's commercial record.
        Ask someone who holds <b>Manage account permissions</b> to grant it to you.
      </div>
    </div>`;
  }

  function render(){
    if(!App.can('customer_contacts.view')){el.innerHTML=deniedHTML();return;}

    el.innerHTML=`
      <div class="perm-layout">
        <div class="perm-accounts">${pickerHTML()}</div>
        <div class="perm-editor">${
          data?(repHTML()+contactsHTML())
          :(notice?`<div class="card card-pad perm-notice ${notice.kind}"><div class="small">${esc(notice.text)}</div></div>`
          :`<div class="card card-pad"><div class="muted small">Choose a store on the left to see the people who work there.</div></div>`)
        }</div>
      </div>`;

    const q=el.querySelector('#sc-q');
    if(q)q.oninput=debounce(()=>{state.q=q.value;render();
      const nq=el.querySelector('#sc-q');if(nq){nq.focus();nq.setSelectionRange(nq.value.length,nq.value.length);}});

    el.querySelectorAll('[data-store]').forEach(b=>b.onclick=()=>{
      location.hash='#/store-contacts/'+b.dataset.store;
    });

    const arch=el.querySelector('#sc-arch');
    if(arch)arch.onchange=()=>{state.showArchived=arch.checked;render();};

    const add=el.querySelector('#sc-add');
    if(add)add.onclick=()=>contactForm(null);

    el.querySelectorAll('[data-reload]').forEach(b=>b.onclick=()=>{b.disabled=true;reload();});

    const byId=id=>data.contacts.find(c=>c.id===id);

    el.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>contactForm(byId(b.dataset.edit)));
    el.querySelectorAll('[data-link]').forEach(b=>b.onclick=()=>linkForm(byId(b.dataset.link)));

    el.querySelectorAll('[data-primary]').forEach(b=>b.onclick=()=>{
      const c=byId(b.dataset.primary);
      /* Promotion demotes somebody else, so the whole store is re-read. */
      actAndReload(c.id,()=>DB.makeStoreContactPrimary(data.customer.id,c.id,c.concurrencyToken),
        scName(c)+' is now the primary contact.');
    });

    el.querySelectorAll('[data-verify]').forEach(b=>b.onclick=()=>{
      const c=byId(b.dataset.verify);
      act(c.id,()=>DB.verifyStoreContact(data.customer.id,c.id,c.concurrencyToken),
        'Details confirmed as current.');
    });

    el.querySelectorAll('[data-archive]').forEach(b=>b.onclick=()=>{
      const c=byId(b.dataset.archive);
      Modal.confirm('Archive contact',
        `Archive <b>${esc(scName(c))}</b>? The record is kept — orders and audit entries that name
         this person still resolve — and they can be reactivated later. Nothing is deleted.`,
        ()=>act(c.id,()=>DB.archiveStoreContact(data.customer.id,c.id,c.concurrencyToken),
          scName(c)+' archived. The record was kept.'),
        'Archive');
    });

    el.querySelectorAll('[data-reactivate]').forEach(b=>b.onclick=()=>{
      const c=byId(b.dataset.reactivate);
      act(c.id,()=>DB.reactivateStoreContact(data.customer.id,c.id,c.concurrencyToken),
        scName(c)+' reactivated as a non-primary contact.');
    });

    el.querySelectorAll('[data-unlink]').forEach(b=>b.onclick=()=>{
      const c=byId(b.dataset.unlink);
      Modal.confirm('Unlink portal account',
        `Record that <b>${esc(scName(c))}</b> no longer uses this store's portal account?
         The account itself is not changed, disabled or deleted.`,
        ()=>act(c.id,()=>DB.unlinkStoreContactPortal(data.customer.id,c.id,c.concurrencyToken),
          'Portal link removed. The account was not changed.'),
        'Unlink');
    });
  }

  /* ---------- entry ----------
     The capability may not have been probed yet on a direct visit. Probe, then
     render — a not-yet-answered probe must render as denied, never as the
     screen. */
  function start(){
    contract=App._contactContract||contract;
    render();
    if(!App.can('customer_contacts.view'))return;
    if(wantedId)load(wantedId);
  }

  if(App.capsChecked){
    start();
  }else{
    el.innerHTML=`<div class="card card-pad"><div class="muted small">Checking your permissions…</div></div>`;
    App.loadCaps().then(()=>{App.renderNav();start();});
  }
});
