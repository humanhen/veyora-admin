/* Agent tools: customer list, create customer, customer detail. */
'use strict';

Routes['#/customers'] = {
  title: 'My Customers',
  async render(el, [sub]) {
    if (sub) return renderCustomerDetail(el, sub);
    el.innerHTML = `<h1 class="pagetitle" style="display:flex;justify-content:space-between;align-items:center">My customers
      <button class="btn sm" onclick="location.hash='#/create-customer'">+ New customer</button></h1>
      <div class="catbar"><div class="search"><input id="cSearch" placeholder="Search customers…"/></div></div>
      <div class="card" id="box"><div class="pad">Loading…</div></div>`;
    const box = el.querySelector('#box');
    const res = await API.get('/user/customer-list');
    let rows = res.customers;
    function draw(list) {
      box.innerHTML = list.length ? `<div style="overflow-x:auto"><table class="list">
        <thead><tr><th>#</th><th>Business</th><th>Contact</th><th>City</th><th>Status</th><th>Balance</th></tr></thead>
        <tbody>${list.map(c => `
          <tr class="click" data-id="${esc(c.id)}">
            <td class="sub">${esc(c.customerNumber || '')}</td>
            <td><b>${esc(c.business)}</b></td>
            <td>${esc((c.firstName + ' ' + c.lastName).trim())}<br/><span class="sub">${esc(c.email)}</span></td>
            <td>${esc(c.city)}${c.country === 'CA' ? ' 🇨🇦' : ''}</td>
            <td>${pill(c.status)}</td>
            <td>${money(c.balance)}</td>
          </tr>`).join('')}
        </tbody></table></div>`
        : `<div class="empty"><div class="big">👥</div>No customers yet</div>`;
      box.querySelectorAll('tr.click').forEach(tr =>
        tr.onclick = () => location.hash = '#/customers/' + tr.dataset.id);
    }
    draw(rows);
    el.querySelector('#cSearch').oninput = debounce(e => {
      const s = e.target.value.toLowerCase();
      draw(rows.filter(c => (c.business + c.email + c.firstName + c.lastName + c.city)
        .toLowerCase().includes(s)));
    }, 200);
  },
};

async function renderCustomerDetail(el, id) {
  const { customer: c, recentOrders } = await API.get('/user/my-customer/' + encodeURIComponent(id));
  el.innerHTML = `
    <h1 class="pagetitle">${esc(c.business)} ${pill(c.status)}</h1>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
      <div class="card" style="flex:2;min-width:300px"><div class="pad">
        <form id="custForm"><div class="grid2">
          <div class="field"><label>First name</label><input name="firstName" value="${esc(c.firstName)}"/></div>
          <div class="field"><label>Last name</label><input name="lastName" value="${esc(c.lastName)}"/></div>
          <div class="field"><label>Business</label><input name="business" value="${esc(c.business)}"/></div>
          <div class="field"><label>Phone</label><input name="phone" value="${esc(c.phone)}"/></div>
          <div class="field"><label>Address</label><input name="address" value="${esc(c.address)}"/></div>
          <div class="field"><label>City</label><input name="city" value="${esc(c.city)}"/></div>
          <div class="field"><label>State</label><input name="state" value="${esc(c.state)}"/></div>
          <div class="field"><label>ZIP</label><input name="zip" value="${esc(c.zip)}"/></div>
        </div><button class="btn sm" type="submit">Save</button></form>
      </div></div>
      <div class="card" style="flex:1;min-width:260px"><div class="pad">
        <h3 style="font-size:15px;margin-bottom:8px">Recent orders</h3>
        ${recentOrders.length ? recentOrders.map(o => `
          <div class="summary-row"><span>${esc(o.number)} <span class="sub">${fmtDate(o.order_date)}</span></span>
            <span>${pill(o.status)} <b>${money(o.total)}</b></span></div>`).join('')
          : '<p class="sub">No orders yet</p>'}
      </div></div>
    </div>`;
  el.querySelector('#custForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await API.post('/user/update-customer/' + encodeURIComponent(id), {
      firstName: f.firstName.value, lastName: f.lastName.value, business: f.business.value,
      phone: f.phone.value, address: f.address.value, city: f.city.value,
      state: f.state.value, zip: f.zip.value,
    });
    toast('Customer saved');
  };
}

Routes['#/create-customer'] = {
  title: 'New Customer',
  async render(el) {
    el.innerHTML = `<h1 class="pagetitle">New customer</h1>
      <div class="card" style="max-width:720px"><div class="pad">
        <form id="ncForm"><div class="grid2">
          <div class="field"><label>Business name *</label><input name="business" required/></div>
          <div class="field"><label>Email *</label><input name="email" type="email" required/></div>
          <div class="field"><label>First name</label><input name="firstName"/></div>
          <div class="field"><label>Last name</label><input name="lastName"/></div>
          <div class="field"><label>Phone</label><input name="phone"/></div>
          <div class="field"><label>Tax ID</label><input name="taxId"/></div>
          <div class="field"><label>Address</label><input name="address"/></div>
          <div class="field"><label>City</label><input name="city"/></div>
          <div class="field"><label>State / Province</label><input name="state"/></div>
          <div class="field"><label>ZIP / Postal</label><input name="zip"/></div>
          <div class="field"><label>Country</label>
            <select name="country"><option value="US">United States</option><option value="CA">Canada</option></select>
          </div>
        </div>
        <p class="sub" style="margin-bottom:12px">The customer gets an activation email to set their own password.</p>
        <button class="btn" type="submit">Create customer</button></form>
      </div></div>`;
    el.querySelector('#ncForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        const res = await API.post('/user/create-customer', {
          business: f.business.value, email: f.email.value, firstName: f.firstName.value,
          lastName: f.lastName.value, phone: f.phone.value, taxId: f.taxId.value,
          address: f.address.value, city: f.city.value, state: f.state.value,
          zip: f.zip.value, country: f.country.value,
        });
        toast(`Customer ${res.customer.business} created`);
        location.hash = '#/customers';
      } catch (ex) { toast(ex.message, true); }
    };
  },
};
