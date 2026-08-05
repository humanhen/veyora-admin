/* ================= Pages: Account Permissions (B2.4B1) =================

   The management surface for the per-account capabilities added in B2.4P.

   Two things about this screen are load-bearing and deliberately not
   conveniences:

   1. NOTHING here authorises anything. The API re-checks `permissions.manage`
      on every request. Hiding the nav entry and rendering an access-denied
      card are courtesies to the operator, not controls; a determined visit to
      #/account-permissions gets an honest refusal from the server, not a
      working screen.

   2. A toggled checkbox changes NOTHING until Save is pressed. The whole
      intended active set is sent in one PUT with the concurrency token from
      the matching read, so a second administrator's change cannot be silently
      overwritten — it fails with 409 and this screen says so rather than
      reporting a save that did not happen.                                    */
'use strict';

/* The four capabilities are grouped for the operator. The GROUPING is
   presentation; the KEYS come from the server's registry and are never
   invented here. A key the server does not return is not rendered, and there
   is no free-text or wildcard entry anywhere on this screen. */
const PERM_GROUPS=[
  {title:'Public content',keys:['public_content.view','public_content.edit','public_content.publish']},
  {title:'Permission administration',keys:['permissions.manage']},
];

/* Edit and publish are INDEPENDENT capabilities — holding one never implies
   the other. Said in the UI because "edit" reading as "edit and publish" is
   the mistake that would put unreviewed copy on a public, indexed site. */
const PERM_INDEPENDENCE='Editing and publishing are independent. Granting Edit does not allow publishing, and granting Publish does not allow editing.';

App.register('account-permissions',function(el,args){
  const state=App._perms||(App._perms={q:'',role:'',page:1});
  /* Selection lives in the URL (#/account-permissions/<id>) so it survives an
     ordinary navigation away and back, exactly like #/suitcases/<id>. */
  const wantedId=(args&&args[0])||null;

  /* ---------- per-account editing state ----------
     `loaded` is the last state the SERVER confirmed. `draft` is what the
     operator has toggled. Save compares the two; nothing else may write to
     `loaded`, so an unsaved toggle can never be mistaken for a saved one. */
  let registry=App._permRegistry||null;
  let loaded=null;        /* {user, permissions, activePermissions, concurrencyToken} */
  let draft=null;         /* Set of keys */
  let busy=false;         /* a save is in flight */
  let notice=null;        /* {kind:'err'|'ok'|'warn', text, action?} */

  const dirty=()=>{
    if(!loaded||!draft)return false;
    const a=loaded.activePermissions.slice().sort();
    const b=[...draft].sort();
    return a.length!==b.length||a.some((k,i)=>k!==b[i]);
  };

  /* ---------- API error → operator-facing message ----------
     Every branch produces a sentence written for an administrator. The raw
     response is never rendered: an API error string, a stack or an
     infrastructure detail leaking into the panel is both alarming and useless
     to the person reading it. */
  function describe(e){
    const s=e&&e.status;
    if(s===401)return {kind:'err',text:'Your session has expired. Sign in again to continue — nothing was changed.'};
    if(s===403)return {kind:'err',text:'Your account does not have permission to manage account permissions. Nothing was changed.'};
    if(s===404)return {kind:'err',text:'That account no longer exists. It may have been deleted by another administrator.'};
    if(s===409)return {kind:'warn',text:'Another administrator changed this account’s permissions while you were editing. Your changes were NOT saved. Reload the current permissions, then reapply what you need.',action:'reload'};
    if(s===422)return {kind:'err',text:'This change would remove the last account able to manage permissions, which would lock everyone out of permission administration. Grant Manage account permissions to another active account first. Nothing was changed.'};
    return {kind:'err',text:'The permissions could not be saved. Nothing was changed — check your connection and try again.'};
  }

  /* ---------- data ---------- */

  async function ensureRegistry(){
    if(registry)return registry;
    registry=await DB.permissionRegistry();
    App._permRegistry=registry;
    return registry;
  }

  async function selectAccount(id){
    loaded=null;draft=null;notice=null;
    render();
    try{
      await ensureRegistry();
      const res=await DB.accountPermissions(id);
      loaded=res;
      draft=new Set(res.activePermissions);
    }catch(e){
      notice=describe(e);
      loaded=null;draft=null;
    }
    render();
  }

  /** Re-read after a 409 so the operator sees what is actually stored now. */
  async function reloadSelected(){
    if(!loaded&&!wantedId)return;
    const id=(loaded&&loaded.user.id)||wantedId;
    await selectAccount(id);
    if(!notice)notice={kind:'ok',text:'Reloaded the current saved permissions for this account.'};
    render();
  }

  async function save(){
    if(!loaded||!draft||busy||!dirty())return;
    busy=true;notice=null;render();
    /* The complete intended active set, de-duplicated by the Set itself and
       ordered by the registry so the request is deterministic. Only registry
       keys can be present — the checkboxes are the only input. */
    const keys=registry.map(p=>p.key).filter(k=>draft.has(k));
    try{
      const res=await DB.saveAccountPermissions(loaded.user.id,keys,loaded.concurrencyToken);
      /* Local state is replaced only now, from the SERVER's response, and the
         new token replaces the old one — the previous token is dead. */
      loaded=res;
      draft=new Set(res.activePermissions);
      const parts=[];
      if(res.granted.length)parts.push('granted '+res.granted.length);
      if(res.revoked.length)parts.push('revoked '+res.revoked.length);
      notice={kind:'ok',text:'Permissions saved for '+(res.user.displayName||res.user.id)+(parts.length?' — '+parts.join(', '):' — no change')+'.'};
      DB.audit('account-permissions.save',res.user.displayName||res.user.id,
        'granted: '+(res.granted.join(', ')||'none')+'; revoked: '+(res.revoked.join(', ')||'none'),'web');
      toast('Permissions saved');
    }catch(e){
      /* No automatic retry, and `loaded` is untouched — the screen must not
         imply a save that the server refused. */
      notice=describe(e);
    }finally{
      busy=false;render();
    }
  }

  /** Switching accounts with unsaved toggles asks first, so a half-finished
      grant is not lost silently. */
  function go(id){
    if(dirty()){
      Modal.confirm('Discard unsaved changes?',
        'You have unsaved permission changes for <b>'+esc(loaded.user.displayName||loaded.user.id)+'</b>. They have not been saved and will be lost.',
        ()=>{loaded=null;draft=null;location.hash='#/account-permissions/'+id;},'Discard changes');
      return;
    }
    location.hash='#/account-permissions/'+id;
  }

  /* ---------- render ---------- */

  function accountListHTML(){
    /* Reuses the account list the panel already loaded and already shows on
       the Users screen — no second user directory, and no new search API.
       The fields shown are the ones the Users screen already displays;
       nothing about pricing, balance, address, tax id or credentials appears
       on this screen. */
    let list=(DB.d.users||[]).slice();
    if(state.role)list=list.filter(u=>u.role===state.role);
    if(state.q){
      const q=state.q.toLowerCase();
      list=list.filter(u=>(u.business||'').toLowerCase().includes(q)||(u.email||'').toLowerCase().includes(q)
        ||(u.username||'').toLowerCase().includes(q)||((u.firstName||'')+' '+(u.lastName||'')).toLowerCase().includes(q));
    }
    list.sort((a,b)=>String(a.business||a.username||'').localeCompare(String(b.business||b.username||'')));
    const p=paginate(list,state.page,8);
    return `
    <div class="card card-pad" style="margin-bottom:12px">
      <div class="search-wrap">${I.search}<input class="input" id="pm-q" placeholder="Search accounts…" value="${esc(state.q)}"></div>
      <select class="select" id="pm-role" style="margin-top:8px;width:100%"><option value="">All roles</option>
        ${['customer','special customer','agent','super-agent','warehouse','admin'].map(r=>`<option ${state.role===r?'selected':''} value="${r}">${r}</option>`).join('')}</select>
    </div>
    <div class="card">
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Account</th><th>Role / Status</th></tr></thead>
        <tbody>${p.slice.length?p.slice.map(u=>{
          const sel=loaded&&loaded.user.id===u.id;
          return `<tr${sel?' class="active"':''}>
            <td><button class="linklike" data-pick="${esc(u.id)}"${sel?' aria-current="true"':''}>
                  <span class="cell-main">${esc(u.business||((u.firstName||'')+' '+(u.lastName||'')).trim()||u.username||u.id)}</span>
                  <span class="cell-sub">@${esc(u.username||'—')}</span></button></td>
            <td><span class="badge outline">${esc(u.role||'—')}</span> ${u.status&&u.status!=='active'?statusBadge(u.status):''}</td>
          </tr>`;}).join(''):`<tr><td colspan="2" class="empty-cell">No accounts match that search</td></tr>`}
        </tbody></table></div>
      ${pagerHTML(p)}
    </div>`;
  }

  function historyLine(row){
    if(!row)return '<span class="muted">Never granted</span>';
    if(row.isActive)return 'Granted '+fmtDateShort(row.grantedAt)+(row.grantedBy?' by '+esc(DB.userName(row.grantedBy)):'');
    if(row.revokedAt)return '<span class="muted">Revoked '+fmtDateShort(row.revokedAt)+(row.revokedBy?' by '+esc(DB.userName(row.revokedBy)):'')+'</span>';
    return '<span class="muted">Not granted</span>';
  }

  function editorHTML(){
    if(notice&&!loaded){
      return `<div class="card card-pad perm-notice ${notice.kind}">
        <div class="small">${esc(notice.text)}</div>
        ${notice.action==='reload'?'<button class="btn btn-sm" data-reload style="margin-top:10px">Reload current permissions</button>':''}
      </div>`;
    }
    if(!loaded)return `<div class="card card-pad"><div class="muted small">Select an account on the left to view and manage its capabilities.</div></div>`;

    const byKey={};
    loaded.permissions.forEach(p=>{byKey[p.permissionKey]=p;});
    const changed=dirty();

    return `
    <div class="card card-pad" style="margin-bottom:12px">
      <div class="card-title" style="margin-bottom:2px">${esc(loaded.user.displayName||loaded.user.id)}</div>
      <div class="small muted">
        <span class="badge outline">${esc(loaded.user.role||'—')}</span>
        ${loaded.user.status==='active'?statusBadge('active'):statusBadge(loaded.user.status||'unknown')}
      </div>
      ${loaded.user.status!=='active'?`<div class="small muted" style="margin-top:8px">
        This account is not active, so it cannot use any capability until it is reactivated.
        Permissions may still be edited — revoking here takes effect immediately if it is reactivated later.</div>`:''}
    </div>

    ${notice?`<div class="card card-pad perm-notice ${notice.kind}" style="margin-bottom:12px">
      <div class="small">${esc(notice.text)}</div>
      ${notice.action==='reload'?'<button class="btn btn-sm" data-reload style="margin-top:10px">Reload current permissions</button>':''}
    </div>`:''}

    <form class="card card-pad" id="pm-form" novalidate>
      ${PERM_GROUPS.map(g=>{
        const defs=g.keys.map(k=>registry.find(p=>p.key===k)).filter(Boolean);
        if(!defs.length)return '';
        return `<div class="section-label">${esc(g.title.toUpperCase())}</div>
        ${defs.map(def=>{
          const row=byKey[def.key];
          const on=draft.has(def.key);
          const id='pm-cb-'+def.key.replace(/[^a-z]+/gi,'-');
          return `<div class="perm-row">
            <label class="checkbox-row" for="${id}">
              <input type="checkbox" id="${id}" data-perm="${esc(def.key)}" ${on?'checked':''} ${busy?'disabled':''}>
              <span class="perm-label">${esc(def.label)}</span>
            </label>
            <div class="perm-desc small muted">${esc(def.description)}</div>
            <div class="perm-hist small">${historyLine(row)}</div>
          </div>`;}).join('')}`;
      }).join('')}
      <div class="small muted" style="margin-top:6px">${esc(PERM_INDEPENDENCE)}</div>
      <div class="flex" style="justify-content:flex-end;gap:8px;margin-top:14px">
        <span class="small ${changed?'':'muted'}" id="pm-dirty" role="status" aria-live="polite">${changed?'Unsaved changes':'No unsaved changes'}</span>
        <button type="button" class="btn" data-reset ${changed&&!busy?'':'disabled'}>Reset</button>
        <button type="submit" class="btn btn-dark" data-save ${changed&&!busy?'':'disabled'}>${busy?'Saving…':'Save permissions'}</button>
      </div>
    </form>`;
  }

  function deniedHTML(){
    /* A direct visit without the capability. Says what is true and offers no
       way around it — there is deliberately no bootstrap control here. The
       first `permissions.manage` grant is a reviewed database operation
       performed outside this panel; see 19_ACCOUNT_PERMISSION_SYSTEM.md. */
    return `<div class="card card-pad" style="border-left:4px solid var(--red,#c8402e)">
      <div class="card-title" style="margin-bottom:6px">Access denied</div>
      <div class="small" style="margin-bottom:4px">
        Your account does not have the <b>Manage account permissions</b> capability, so this screen is unavailable.
      </div>
      <div class="small muted">
        This capability is granted per account and is not implied by the administrator role.
        Ask someone who already holds it to grant it to you.
      </div>
    </div>`;
  }

  function render(){
    if(!App.can('permissions.manage')){el.innerHTML=deniedHTML();return;}
    el.innerHTML=`
      <div class="perm-layout">
        <div class="perm-accounts">${accountListHTML()}</div>
        <div class="perm-editor">${editorHTML()}</div>
      </div>`;

    const q=el.querySelector('#pm-q');
    if(q)q.oninput=debounce(()=>{state.q=q.value;state.page=1;render();
      const nq=el.querySelector('#pm-q');if(nq){nq.focus();nq.setSelectionRange(nq.value.length,nq.value.length);}});
    const role=el.querySelector('#pm-role');
    if(role)role.onchange=e=>{state.role=e.target.value;state.page=1;render();};
    bindPager(el,pg=>{state.page=pg;render();});
    el.querySelectorAll('[data-pick]').forEach(b=>b.onclick=()=>go(b.dataset.pick));
    el.querySelectorAll('[data-reload]').forEach(b=>b.onclick=()=>{b.disabled=true;reloadSelected();});

    /* A toggle only edits the DRAFT and repaints the buttons. It never calls
       the API — no permission changes until Save. */
    el.querySelectorAll('[data-perm]').forEach(cb=>cb.onchange=()=>{
      if(!draft)return;
      if(cb.checked)draft.add(cb.dataset.perm);else draft.delete(cb.dataset.perm);
      paintDirty();
    });

    const form=el.querySelector('#pm-form');
    if(form)form.onsubmit=e=>{e.preventDefault();save();};
    const reset=el.querySelector('[data-reset]');
    if(reset)reset.onclick=()=>{if(loaded){draft=new Set(loaded.activePermissions);notice=null;render();}};
  }

  /** Repaints only the save/reset affordances after a toggle, so the checkbox
      the operator is using does not get torn out from under the keyboard. */
  function paintDirty(){
    const changed=dirty();
    const s=el.querySelector('[data-save]'),r=el.querySelector('[data-reset]'),d=el.querySelector('#pm-dirty');
    if(s)s.disabled=!changed||busy;
    if(r)r.disabled=!changed||busy;
    if(d){d.textContent=changed?'Unsaved changes':'No unsaved changes';d.classList.toggle('muted',!changed);}
  }

  /* ---------- entry ----------
     The capability may not have been probed yet on a direct visit (a page
     load straight to #/account-permissions). Probe, then render — a not-yet
     answered probe must render as denied, never as the screen. */
  if(App.capsChecked){
    render();
    if(wantedId&&App.can('permissions.manage'))selectAccount(wantedId);
  }else{
    el.innerHTML=`<div class="card card-pad"><div class="muted small">Checking your permissions…</div></div>`;
    App.loadCaps().then(()=>{
      App.renderNav();
      render();
      if(wantedId&&App.can('permissions.manage'))selectAccount(wantedId);
    });
  }
});
