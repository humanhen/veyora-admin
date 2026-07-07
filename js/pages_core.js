/* ================= Pages: Dashboard + Tasks ================= */
'use strict';

/* ============================================================ DASHBOARD */
App.register('dashboard',function(el){
  const state=App._dash||(App._dash={range:'This month'});
  const RANGES=['This month','14 days','30 days','60 days','90 days','All time','Custom'];

  function rangeDates(){
    const today=new Date();
    const end=today;
    let start;
    switch(state.range){
      case 'This month':start=new Date(today.getFullYear(),today.getMonth(),1);break;
      case '14 days':start=new Date(today-13*864e5);break;
      case '30 days':start=new Date(today-29*864e5);break;
      case '60 days':start=new Date(today-59*864e5);break;
      case '90 days':start=new Date(today-89*864e5);break;
      case 'Custom':
        start=state.from?new Date(state.from):new Date(today.getFullYear(),today.getMonth(),1);
        return [start,state.to?new Date(state.to):end];
      default:start=new Date('2020-01-01');
    }
    return [start,end];
  }

  function render(){
    const d=DB.d;
    const [start,end]=rangeDates();
    const inRange=o=>{const t=new Date(o.date);return t>=start&&t<=new Date(end.getTime()+864e5);};
    const orders=d.orders.filter(inRange);
    const okOrders=orders.filter(o=>o.status!=='cancelled');
    const revenue=okOrders.reduce((s,o)=>s+o.total,0);
    /* last-24h pulse */
    const cut24=new Date(Date.now()-864e5);
    const p24=d.orders.filter(o=>new Date(o.date)>=cut24&&o.status!=='cancelled');
    const rev24=p24.reduce((s,o)=>s+o.total,0);
    const aov24=p24.length?rev24/p24.length:null;
    const agents=d.users.filter(u=>['agent','super-agent'].includes(u.role));
    const cut7=new Date(Date.now()-7*864e5);
    const activeAgents=new Set(d.orders.filter(o=>o.agentId&&new Date(o.date)>=cut7).map(o=>o.agentId)).size;
    const customers=d.users.filter(u=>['customer','special customer'].includes(u.role));
    const orderedCust=new Set(okOrders.map(o=>o.customerId)).size;
    /* by country */
    const byCountry={};
    for(const c of customers){byCountry[c.country]=byCountry[c.country]||{users:0,orders:0,revenue:0};byCountry[c.country].users++;}
    for(const o of okOrders){
      const c=DB.user(o.customerId);if(!c)continue;
      const k=c.country||'US';byCountry[k]=byCountry[k]||{users:0,orders:0,revenue:0};
      byCountry[k].orders++;byCountry[k].revenue+=o.total;
    }
    const countries=Object.keys(byCountry).sort();
    /* status distribution — across all orders, like the guide */
    const statuses=['pending','approved','processing','collecting','collected','shipped','completed','cancelled'];
    const dist=statuses.map(s=>({s,n:d.orders.filter(o=>o.status===s).length})).filter(x=>x.n>0);
    const distTotal=Math.max(1,dist.reduce((s,x)=>s+x.n,0));
    const distColors={pending:'#e0a72e',approved:'#8d877b',processing:'#7f5fc4',collecting:'#7f5fc4',collected:'#7f5fc4',shipped:'#3273b8',completed:'#2e8b4f',cancelled:'#c8402e'};

    const fmtR=dt=>dt.toISOString().slice(0,10);
    const countryTable=(key,fmt)=>{
      const rows=countries.map(c=>`<tr><td>${esc(c)}</td><td>${fmt(byCountry[c][key])}</td></tr>`).join('');
      return rows||`<tr><td colspan="2" style="text-align:center;color:var(--muted);padding:14px">No data</td></tr>`;
    };

    el.innerHTML=`
    <div class="dash">
    <div class="page-head">
      <div><div class="page-title">Dashboard</div><div class="page-sub">What needs attention today</div></div>
      <div class="date-note">${I.calendar} ${fmtR(start)} &rarr; ${fmtR(end)}</div>
    </div>
    <div class="range-bar">
      ${RANGES.map(r=>`<button class="chip ${state.range===r?'active':''}" data-range="${r}">${r}</button>`).join('')}
      ${state.range==='Custom'?`
        <input type="date" class="input" id="dash-from" value="${state.from||''}" style="padding:5px 8px">
        <span class="muted">&rarr;</span>
        <input type="date" class="input" id="dash-to" value="${state.to||''}" style="padding:5px 8px">`:''}
    </div>

    <div class="section-label">PULSE &middot; LAST 24H <span style="font-weight:400;letter-spacing:0">&nbsp; ${fmtR(cut24)} &rarr; ${fmtR(end)} &middot; deltas vs prior 24h</span></div>
    <div class="grid g6">
      <div class="stat-card"><div class="stat-label">REVENUE &middot; LAST 24H ${I.money}</div><div class="stat-value">${p24.length?money(rev24):'—'}</div><div class="stat-note">${p24.length?'vs prior 24h':'no prior 24h data to compare'}</div></div>
      <div class="stat-card"><div class="stat-label">ORDERS &middot; LAST 24H ${I.cart}</div><div class="stat-value">${p24.length}</div><div class="stat-note">vs prior 24h (0)</div></div>
      <div class="stat-card"><div class="stat-label">AVG ORDER VALUE &middot; L… ${I.chart}</div><div class="stat-value">${aov24!=null?money(aov24):'—'}</div><div class="stat-note">no prior 24h data</div></div>
      <div class="stat-card"><div class="stat-label">ACTIVE CARTS &middot; N… ${I.cart}</div><div class="stat-value">0</div><div class="stat-note">click to show abandoned-ca…</div></div>
      <div class="stat-card"><div class="stat-label">AGENTS ACTIVE &middot; 7D ${I.user}</div><div class="stat-value">${activeAgents} / ${agents.length}</div><div class="stat-note">placed at least one order</div></div>
      <div class="stat-card"><div class="stat-label">CUSTOMERS ORDERIN… ${I.users}</div><div class="stat-value">${orderedCust} / ${customers.length}</div><div class="stat-note">of total customer base</div></div>
    </div>

    <div class="section-label">PERFORMANCE &middot; ${fmtR(start)} &rarr; ${fmtR(end)}</div>
    <div class="grid g4">
      <div class="stat-card"><div class="stat-label">TOTAL USERS ${I.users}</div><div class="stat-value">${d.users.length}</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL PRODUCTS ${I.box}</div><div class="stat-value">${d.products.length}</div></div>
      <div class="stat-card"><div class="stat-label">TOTAL ORDERS ${I.cart}</div><div class="stat-value">${d.orders.length}</div></div>
      <div class="stat-card"><div class="stat-label">REVENUE ${I.money}</div><div class="stat-value">${money0(revenue)}</div></div>
    </div>

    <div class="section-label">BY COUNTRY</div>
    <div class="grid g3">
      ${[['Users','users',v=>v],['Orders','orders',v=>v],['Revenue','revenue',v=>money0(v)]].map(([t,k,f])=>`
      <div class="card card-pad">
        <div class="card-title" style="margin-bottom:10px">${t}</div>
        <table class="mini-tbl"><thead><tr><th>Country</th><th>${t}</th></tr></thead>
        <tbody>${countryTable(k,f)}</tbody></table>
      </div>`).join('')}
    </div>

    <div class="grid" style="grid-template-columns:2fr 1fr;margin-top:16px">
      <div class="card card-pad">
        <div class="card-title">Order Status Distribution</div>
        ${dist.length?dist.map(x=>`
          <div class="status-bar-row">
            <span class="dot" style="background:${distColors[x.s]||'#999'}"></span>
            <span style="width:90px;text-transform:capitalize">${x.s}</span>
            <div class="status-bar-track"><div class="status-bar-fill" style="width:${Math.max(2,x.n/distTotal*100)}%;background:${distColors[x.s]||'#999'}"></div></div>
            <b>${x.n}</b> <span class="muted">(${(x.n/distTotal*100).toFixed(1)}%)</span>
          </div>`).join(''):'<div class="muted small">No orders in range</div>'}
      </div>
      <div class="card card-pad">
        <div class="card-title">Quick Actions</div>
        <button class="btn" id="qa-add-product" style="width:100%;justify-content:center">${I.box} Add Product</button>
      </div>
    </div>
    </div>`;

    el.querySelectorAll('[data-range]').forEach(b=>b.onclick=()=>{state.range=b.dataset.range;render();});
    const df=el.querySelector('#dash-from'),dt=el.querySelector('#dash-to');
    if(df)df.onchange=()=>{state.from=df.value;render();};
    if(dt)dt.onchange=()=>{state.to=dt.value;render();};
    el.querySelector('#qa-add-product').onclick=()=>{location.hash='#/product-edit/new';};
  }
  render();
});

/* ============================================================ TASKS */
App.register('tasks',function(el){
  const state=App._tasks||(App._tasks={who:'To Me',open:'Open',sel:null});
  const sess=Auth.current();

  function render(){
    const d=DB.d;
    const mine=d.tasks.filter(t=>
      (state.who==='To Me'?t.assignedTo===sess.id:t.createdBy===sess.id)&&
      (state.open==='Open'?t.status==='open':t.status==='done'));
    const sel=d.tasks.find(t=>t.id===state.sel);
    const isAdmin=sess.role==='admin';

    el.innerHTML=`
    <div class="card card-pad" style="margin-bottom:16px">
      <div class="spread">
        <div><div class="page-title" style="font-size:16px">Tasks</div>
        <div class="page-sub">Internal-only. Customers never see this tab.</div></div>
        <div class="flex">
          <span class="chip-row" style="background:#f1ede3;border-radius:9px;padding:3px">
            <button class="chip ${state.who==='To Me'?'active':''}" data-who="To Me" style="border:none">To Me</button>
            <button class="chip ${state.who==='By Me'?'active':''}" data-who="By Me" style="border:none">By Me</button>
          </span>
          <span class="chip-row" style="background:#f1ede3;border-radius:9px;padding:3px">
            <button class="chip ${state.open==='Open'?'active':''}" data-open="Open" style="border:none">Open</button>
            <button class="chip ${state.open==='Done'?'active':''}" data-open="Done" style="border:none">Done</button>
          </span>
          ${isAdmin?`<button class="btn btn-dark" id="new-task">${I.plus} New Task</button>`:''}
        </div>
      </div>
    </div>
    <div class="tasks-layout">
      <div class="card">
        ${mine.length?mine.map(t=>`
          <div class="task-item ${state.sel===t.id?'sel':''}" data-task="${t.id}">
            <div class="cell-main">${esc(t.subject)}</div>
            <div class="cell-sub">${esc(DB.userName(t.assignedTo))} &middot; ${t.messages.length} message${t.messages.length!==1?'s':''} &middot; ${fmtDateShort(t.createdAt)}</div>
            ${t.status==='done'?'<div style="margin-top:5px">'+statusBadge('done')+'</div>':''}
          </div>`).join(''):
        `<div class="task-empty">${I.tasks}<div>No ${state.open.toLowerCase()} tasks ${state.who==='To Me'?'assigned to you':'created by you'}.</div></div>`}
      </div>
      <div class="card card-pad">
        ${!sel?`<div class="task-empty">${I.comment}<div>Select a task to view the conversation</div></div>`:`
        <div class="spread" style="margin-bottom:8px">
          <div>
            <div class="card-title" style="margin:0">${esc(sel.subject)}</div>
            <div class="cell-sub">Assigned to ${esc(DB.userName(sel.assignedTo))} &middot; created by ${esc(DB.userName(sel.createdBy))}</div>
          </div>
          ${sel.status==='open'?`<button class="btn btn-sm" id="mark-done">${I.check} Mark done</button>`:statusBadge('done')}
        </div>
        <div class="divider"></div>
        <div class="thread">
          ${sel.messages.map(m=>`<div class="msg ${m.by===sess.id?'mine':''}">${esc(m.text)}<div class="msg-meta">${esc(DB.userName(m.by))} &middot; ${fmtDateTime(m.at)}</div></div>`).join('')}
        </div>
        ${sel.status==='open'?`
        <div class="flex" style="margin-top:14px">
          <input class="input" id="reply-input" placeholder="Write a reply…" style="flex:1">
          <button class="btn btn-dark" id="reply-send">${I.send} Reply</button>
        </div>`:''}
        `}
      </div>
    </div>`;

    el.querySelectorAll('[data-who]').forEach(b=>b.onclick=()=>{state.who=b.dataset.who;state.sel=null;render();});
    el.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>{state.open=b.dataset.open;state.sel=null;render();});
    el.querySelectorAll('[data-task]').forEach(t=>t.onclick=()=>{
      state.sel=t.dataset.task;
      const task=DB.d.tasks.find(x=>x.id===state.sel);
      if(task&&task.assignedTo===sess.id)task.unread=false;
      DB.save();App.updateBell();render();
    });
    const nt=el.querySelector('#new-task');
    if(nt)nt.onclick=()=>{
      const staff=DB.d.users.filter(u=>['admin','agent','super-agent','warehouse'].includes(u.role));
      Modal.open({title:'New Task',
        body:`
        <div class="field"><label>Assign to</label>
          <select class="select" id="nt-to">${staff.map(u=>`<option value="${u.id}">${esc(u.firstName+' '+u.lastName)} (${esc(u.role)})</option>`).join('')}</select></div>
        <div class="field"><label>Subject</label><input class="input" id="nt-subject" placeholder="Short title"></div>
        <div class="field"><label>Message</label><textarea class="input" id="nt-msg" placeholder="Describe the task…"></textarea></div>`,
        foot:`<button class="btn" data-x>Cancel</button><button class="btn btn-dark" data-save>Create Task</button>`,
        setup(ov,close){
          ov.querySelector('[data-x]').onclick=close;
          ov.querySelector('[data-save]').onclick=()=>{
            const to=ov.querySelector('#nt-to').value,
                  subject=ov.querySelector('#nt-subject').value.trim(),
                  msg=ov.querySelector('#nt-msg').value.trim();
            if(!subject||!msg)return toast('Subject and message are required',true);
            DB.d.tasks.unshift({id:uid('t'),subject,assignedTo:to,createdBy:sess.id,status:'open',
              unread:to!==sess.id,createdAt:new Date().toISOString(),
              messages:[{by:sess.id,text:msg,at:new Date().toISOString()}]});
            DB.save();DB.audit('task.create',subject,'Assigned to '+DB.userName(to));
            App.updateBell();close();render();toast('Task created');
          };
        }});
    };
    const md=el.querySelector('#mark-done');
    if(md)md.onclick=()=>{
      const t=DB.d.tasks.find(x=>x.id===state.sel);
      t.status='done';DB.save();DB.audit('task.done',t.subject,'Task closed');
      App.updateBell();render();toast('Task marked done');
    };
    const rs=el.querySelector('#reply-send');
    if(rs){
      const send=()=>{
        const inp=el.querySelector('#reply-input');
        const txt=inp.value.trim();if(!txt)return;
        const t=DB.d.tasks.find(x=>x.id===state.sel);
        t.messages.push({by:sess.id,text:txt,at:new Date().toISOString()});
        if(t.assignedTo!==sess.id)t.unread=true;
        DB.save();App.updateBell();render();
      };
      rs.onclick=send;
      el.querySelector('#reply-input').addEventListener('keydown',e=>{if(e.key==='Enter')send();});
    }
  }
  render();
});
