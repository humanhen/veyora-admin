/* My account: profile, addresses, password, favourites, spare parts, invoices. */
'use strict';

Routes['#/account'] = {
  title: 'My Account',
  async render(el) {
    const [{ user: u }, addr, inv] = await Promise.all([
      API.get('/user/get-user-detail'),
      API.get('/user/get-addresses'),
      API.get('/user/invoices'),
    ]);
    el.innerHTML = `
      <h1 class="pagetitle">My account</h1>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:2;min-width:300px">
          <div class="card"><div class="pad">
            <h3 style="font-size:15px;margin-bottom:12px">Business details
              <span class="sub" style="font-weight:400">· customer #${esc(u.customerNumber || '—')}</span></h3>
            <form id="profForm"><div class="grid2">
              <div class="field"><label>First name</label><input name="firstName" value="${esc(u.firstName)}"/></div>
              <div class="field"><label>Last name</label><input name="lastName" value="${esc(u.lastName)}"/></div>
              <div class="field"><label>Business</label><input name="business" value="${esc(u.business)}"/></div>
              <div class="field"><label>Tax ID</label><input name="taxId" value="${esc(u.taxId)}"/></div>
              <div class="field"><label>Phone</label><input name="phone" value="${esc(u.phone)}"/></div>
              <div class="field"><label>Email</label><input value="${esc(u.email)}" disabled/></div>
              <div class="field"><label>Address</label><input name="address" value="${esc(u.address)}"/></div>
              <div class="field"><label>City</label><input name="city" value="${esc(u.city)}"/></div>
              <div class="field"><label>State</label><input name="state" value="${esc(u.state)}"/></div>
              <div class="field"><label>ZIP</label><input name="zip" value="${esc(u.zip)}"/></div>
            </div>
            <button class="btn sm" type="submit">Save changes</button></form>
          </div></div>

          <div class="card" style="margin-top:14px"><div class="pad">
            <h3 style="font-size:15px;margin-bottom:12px">Change password</h3>
            <form id="pwForm"><div class="grid2">
              <div class="field"><label>Current password</label><input name="current" type="password" autocomplete="current-password"/></div>
              <div class="field"><label>New password (8+ chars)</label><input name="next" type="password" minlength="8" autocomplete="new-password"/></div>
            </div>
            <button class="btn sm" type="submit">Update password</button></form>
          </div></div>
        </div>

        <div style="flex:1;min-width:260px">
          <div class="card"><div class="pad">
            <h3 style="font-size:15px;margin-bottom:8px">Account</h3>
            <div class="summary-row"><span>Terms</span><b>Net ${u.paymentTerms || 30}</b></div>
            <div class="summary-row"><span>Balance</span><b>${money(u.balance)}</b></div>
            <div class="summary-row"><span>Prices in catalog</span>
              <button class="btn ghost sm" id="hideP">${Store.realHide ? 'Show' : 'Hide'}</button></div>
            <button class="btn danger sm" style="width:100%;margin-top:14px" id="logoutBtn">Sign out</button>
          </div></div>

          <div class="card" style="margin-top:14px"><div class="pad">
            <h3 style="font-size:15px;margin-bottom:8px">Invoices</h3>
            ${inv.invoices.length ? inv.invoices.slice(0, 8).map(i => `
              <div class="summary-row"><span>${esc(i.number)} <span class="sub">${fmtDate(i.issuedOn)}</span></span>
                <b>${money(i.amount)}</b></div>`).join('')
              : '<p class="sub">No invoices yet</p>'}
          </div></div>
        </div>
      </div>`;

    el.querySelector('#profForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      await API.post('/user/update-profile', {
        firstName: f.firstName.value, lastName: f.lastName.value, business: f.business.value,
        taxId: f.taxId.value, phone: f.phone.value, address: f.address.value,
        city: f.city.value, state: f.state.value, zip: f.zip.value,
      });
      toast('Profile saved');
    };
    el.querySelector('#pwForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await API.post('/user/change-password', { current: f.current.value, next: f.next.value });
        toast('Password updated');
        f.reset();
      } catch (ex) { toast(ex.message, true); }
    };
    el.querySelector('#hideP').onclick = async () => {
      const r = await API.post('/user/toggle-hide-prices');
      Store.realHide = r.hidePrices;      // the permanent account setting
      applyPricingMode();
      toast(r.hidePrices ? 'Prices hidden by default' : 'Prices shown by default');
      route();
    };
    el.querySelector('#logoutBtn').onclick = async () => {
      await API.post('/auth/logout').catch(() => {});
      Store.session = null;
      location.hash = '#/login';
    };
  },
};

Routes['#/favourites'] = {
  title: 'Favourites',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle" style="display:flex;justify-content:space-between;align-items:center">Favourites
      <button class="btn sm" id="allToCart">Add all to cart</button></h1>
      <div id="grid" class="pgrid2"></div>`;
    const res = await API.get('/user/favourites');
    const grid = el.querySelector('#grid');
    if (!res.products.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big">♡</div>No favourites yet — tap the heart on any product</div>`;
    }
    for (const p of res.products) grid.appendChild(productCard(p));
    el.querySelector('#allToCart').onclick = async () => {
      await API.post('/user/favourites/add-all-to-cart');
      toast('In-stock favourites added to cart');
      refreshCartBadge();
    };
  },
};

Routes['#/spare-parts'] = {
  title: 'Spare Parts',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle">Spare parts</h1>
      <div class="card"><div class="pad">
        <h3 style="font-size:15px;margin-bottom:10px">Request a part</h3>
        <form id="spForm"><div class="grid2">
          <div class="field"><label>Model / SKU</label><input name="model" required/></div>
          <div class="field"><label>Part needed</label><input name="part" placeholder="e.g. left temple, nose pads" required/></div>
        </div>
        <div class="field"><label>Notes</label><textarea name="notes" rows="2"></textarea></div>
        <div class="field"><label>Photo (optional)</label><input name="photo" type="file" accept="image/*"/></div>
        <button class="btn sm" type="submit">Submit request</button></form>
      </div></div>
      <div id="list" style="margin-top:14px"></div>`;
    const list = el.querySelector('#list');
    async function load() {
      const res = await API.get('/user/get-spare-part');
      list.innerHTML = res.spareParts.length ? `<div class="card"><div class="pad">
        <table class="list"><thead><tr><th>Model</th><th>Part</th><th>Status</th><th>Date</th></tr></thead>
        <tbody>${res.spareParts.map(s => `
          <tr><td><b>${esc(s.model)}</b></td><td>${esc(s.part)}${s.notes ? `<br/><span class="sub">${esc(s.notes)}</span>` : ''}</td>
          <td>${pill(s.status)}</td><td>${fmtDate(s.created_at)}</td></tr>`).join('')}
        </tbody></table></div></div>` : '';
    }
    el.querySelector('#spForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      let image = null;
      if (f.photo.files[0]) {
        const fd = new FormData();
        fd.append('image', f.photo.files[0]);
        const up = await API.post('/user/spare-part-image', fd);
        image = up.path;
      }
      await API.post('/user/add-spare-part', {
        model: f.model.value, part: f.part.value, notes: f.notes.value, image,
      });
      toast('Request submitted');
      f.reset();
      load();
    };
    await load();
  },
};
