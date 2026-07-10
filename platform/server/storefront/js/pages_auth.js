/* Login / activation / forgot-password screens. */
'use strict';

function authCard(inner) {
  return h(`<div class="auth-wrap"><div class="auth-card">
    <div class="logo">VEY<span>O</span>RA</div>
    <div class="tag">Wholesale Eyewear Portal</div>
    ${inner}
  </div></div>`);
}

Routes['#/login'] = {
  public: true, title: 'Sign in',
  render(el) {
    const card = authCard(`
      <div class="auth-err" style="display:none"></div>
      <form>
        <div class="field"><label>Email or username</label>
          <input name="email" autocomplete="username" required autofocus /></div>
        <div class="field"><label>Password</label>
          <input name="password" type="password" autocomplete="current-password" required /></div>
        <button class="btn" type="submit">Sign in</button>
      </form>
      <div class="auth-links">
        <a href="#/forgot">Forgot password?</a>
        <a href="#/activate">Activate account</a>
      </div>`);
    const err = card.querySelector('.auth-err');
    card.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      f.querySelector('button').disabled = true;
      err.style.display = 'none';
      try {
        const res = await API.post('/auth/login',
          { email: f.email.value.trim(), password: f.password.value }, { noRedirect: true });
        Store.session = { user: res.user };
        refreshCartBadge();
        const dest = sessionStorage.getItem('veyora_after_login') || '#/products';
        sessionStorage.removeItem('veyora_after_login');
        location.hash = dest === '#/login' ? '#/products' : dest;
      } catch (ex) {
        err.textContent = ex.data?.message || ex.message;
        err.style.display = '';
        f.querySelector('button').disabled = false;
      }
    };
    el.appendChild(card);
  },
};

/** Shared two-step OTP flow (activation + forgot password). */
function otpFlow(el, { title, requestPath, verifyPath, donePath, doneMsg }) {
  let email = '';
  function step1() {
    const card = authCard(`
      <p class="sub" style="margin-bottom:16px">${title}</p>
      <div class="auth-err" style="display:none"></div>
      <form>
        <div class="field"><label>Account email</label>
          <input name="email" type="email" required autofocus /></div>
        <button class="btn" type="submit">Send code</button>
      </form>
      <div class="auth-links"><a href="#/login">← Back to sign in</a></div>`);
    card.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      email = e.target.email.value.trim();
      e.target.querySelector('button').disabled = true;
      await API.post(requestPath, { email }, { noRedirect: true });
      step2();
    };
    el.innerHTML = ''; el.appendChild(card);
  }
  function step2() {
    const card = authCard(`
      <p class="sub" style="margin-bottom:16px">We emailed a 6-digit code to <b>${esc(email)}</b>. Enter it below with your new password.</p>
      <div class="auth-err" style="display:none"></div>
      <form>
        <div class="field"><label>6-digit code</label>
          <input name="code" inputmode="numeric" pattern="[0-9]{6}" required autofocus /></div>
        <div class="field"><label>New password (8+ characters)</label>
          <input name="password" type="password" minlength="8" autocomplete="new-password" required /></div>
        <button class="btn" type="submit">Set password</button>
      </form>
      <div class="auth-links"><a href="#/login">← Back to sign in</a></div>`);
    const err = card.querySelector('.auth-err');
    card.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      f.querySelector('button').disabled = true;
      err.style.display = 'none';
      try {
        const v = await API.post(verifyPath, { email, code: f.code.value.trim() }, { noRedirect: true });
        await API.post(donePath, { token: v.token, password: f.password.value }, { noRedirect: true });
        toast(doneMsg);
        location.hash = '#/login';
      } catch (ex) {
        err.textContent = ex.data?.error || ex.message;
        err.style.display = '';
        f.querySelector('button').disabled = false;
      }
    };
    el.innerHTML = ''; el.appendChild(card);
  }
  step1();
}

Routes['#/activate'] = {
  public: true, title: 'Activate account',
  render(el) {
    otpFlow(el, {
      title: 'Activate your Veyora account: enter the email address on file and we\'ll send you a one-time code.',
      requestPath: '/auth/request-activation-otp',
      verifyPath: '/auth/verify-activation-otp',
      donePath: '/auth/set-password',
      doneMsg: 'Account activated — you can sign in now',
    });
  },
};

/* Magic-link landing from the welcome/activation email: token in the URL,
   just pick a password. */
Routes['#/set-password'] = {
  public: true, title: 'Set your password',
  render(el, [token]) {
    if (!token) { location.hash = '#/activate'; return; }
    const card = authCard(`
      <p class="sub" style="margin-bottom:16px">Welcome to Veyora — choose a password to activate your account.</p>
      <div class="auth-err" style="display:none"></div>
      <form>
        <div class="field"><label>New password (8+ characters)</label>
          <input name="password" type="password" minlength="8" autocomplete="new-password" required autofocus /></div>
        <div class="field"><label>Confirm password</label>
          <input name="confirm" type="password" minlength="8" autocomplete="new-password" required /></div>
        <button class="btn" type="submit">Set password &amp; sign in</button>
      </form>`);
    const err = card.querySelector('.auth-err');
    card.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.password.value !== f.confirm.value) {
        err.textContent = 'Passwords do not match'; err.style.display = ''; return;
      }
      f.querySelector('button').disabled = true;
      err.style.display = 'none';
      try {
        await API.post('/auth/set-password', { token, password: f.password.value }, { noRedirect: true });
        toast('Account activated — signing you in');
        location.hash = '#/login';
      } catch (ex) {
        err.textContent = ex.data?.error || ex.message || 'This link has expired — request a new one';
        err.style.display = '';
        f.querySelector('button').disabled = false;
      }
    };
    el.appendChild(card);
  },
};

Routes['#/forgot'] = {
  public: true, title: 'Reset password',
  render(el) {
    otpFlow(el, {
      title: 'Reset your password: enter your account email and we\'ll send you a one-time code.',
      requestPath: '/auth/forgot-password',
      verifyPath: '/auth/verify-forgot-otp',
      donePath: '/auth/reset-password',
      doneMsg: 'Password updated — sign in with your new password',
    });
  },
};
