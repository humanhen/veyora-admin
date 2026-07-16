/* Public marketing homepage — replica of the original veyora.com landing page. */
'use strict';

// same slide set + order as the original carousel
const HOME_HERO = ['assets/home/hero-03.webp', 'assets/home/hero-02.webp',
  'assets/home/hero-04.webp'];
const WHATSAPP = 'https://wa.me/16467731000';

function glassesIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6.5" cy="14" r="3.5"/><circle cx="17.5" cy="14" r="3.5"/><path d="M10 14q2 -1.6 4 0"/><path d="M3 14 L2 9.5 M21 14 L22 9.5"/></svg>`;
}
function personIcon() {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
}
function waIcon() {
  return `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.89 1.22 3.09.15.2 2.11 3.22 5.1 4.51.71.31 1.27.49 1.7.63.72.23 1.37.2 1.88.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z"/><path d="M12.05 2a9.9 9.9 0 0 0-8.57 14.84L2 22l5.31-1.39A9.9 9.9 0 1 0 12.05 2zm0 18.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.15.83.84-3.07-.2-.31a8.2 8.2 0 1 1 6.99 3.88z"/></svg>`;
}

function homeHeader() {
  return `
    <header class="hm-head">
      <a class="hm-logo" href="#/"><img src="assets/logo-white.svg" alt="Veyora"/></a>
      <div class="hm-head-right">
        <a class="hm-pill" href="#/products">${glassesIcon()}<span>Products</span></a>
        <a class="hm-account" href="${Store.session ? '#/products' : '#/login'}" title="Account">${personIcon()}</a>
      </div>
    </header>`;
}

function homeFooter() {
  return `
    <footer class="hm-footer">
      <div>© ${new Date().getFullYear()} Veyora. All rights reserved.</div>
      <nav>
        <a href="#/">Privacy policy</a><span>|</span>
        <a href="#/">Terms of service</a><span>|</span>
        <a href="#/">Accessibility Statement</a><span>|</span>
        <a href="${WHATSAPP}" target="_blank" rel="noopener">Talk to sales</a>
      </nav>
    </footer>`;
}

function whatsappFloat() {
  return `<a class="hm-wa" href="${WHATSAPP}" target="_blank" rel="noopener" title="Chat on WhatsApp">${waIcon()}</a>`;
}

Routes['#/'] = Routes['#/home'] = {
  public: true, title: 'Global Eyewear Distribution',
  render(el) {
    document.body.classList.add('hm-dark');
    el.innerHTML = `
      ${homeHeader()}

      <!-- ============ hero ============ -->
      <section class="hm-hero">
        <div class="hm-hero-slides">
          ${HOME_HERO.map((s, i) => `<img src="${s}" alt="" class="${i === 0 ? 'on' : ''}"/>`).join('')}
        </div>
        <div class="hm-hero-shade"></div>
        <div class="hm-hero-inner">
          <div class="hm-label">Global eyewear distribution<br/>for optical retailers</div>
          <h1>Framing the<br/>future</h1>
          <p>Veyora helps optical retailers access quality eyewear collections with
             reliable service, responsive logistics, and support built around their business.</p>
          <a class="hm-outline-btn" href="#/products">Explore collections</a>
        </div>
        <div class="hm-hero-dots">${HOME_HERO.map((s, i) =>
          `<span class="${i === 0 ? 'on' : ''}" data-dot="${i}"></span>`).join('')}</div>
      </section>

      <!-- ============ global distribution ============ -->
      <section class="hm-sec hm-map-sec">
        <div class="hm-label hm-center">Worldwide reach</div>
        <h2 class="hm-h2">Global Distribution</h2>
        <img class="hm-map" src="assets/global-distribution-map-B9WDMC-1.webp" alt="Veyora global distribution map" loading="lazy"/>
      </section>

      <!-- ============ collections ============ -->
      <section class="hm-sec">
        <div class="hm-label hm-center">Curated for optical retail</div>
        <h2 class="hm-h2 lg">The right collection is only<br/>the beginning.</h2>
        <div class="hm-three-labels">
          <span>Curated Collections</span>
          <span>Reliable Replenishment</span>
          <span>Retailer-First Support</span>
        </div>
        <div class="hm-collage">
          <img class="c-a" src="assets/home/hero-04.webp" alt="" loading="lazy"/>
          <img class="c-b" src="assets/home/hero-01.webp" alt="" loading="lazy"/>
          <img class="c-c" src="assets/home/hero-10.webp" alt="" loading="lazy"/>
          <img class="c-d" src="assets/home/hero-07.webp" alt="" loading="lazy"/>
          <img class="c-e" src="assets/home/hero-08.webp" alt="" loading="lazy"/>
          <img class="c-f" src="assets/home/hero-06-hq.webp" alt="" loading="lazy"/>
          <img class="c-g" src="assets/home/hero-09.webp" alt="" loading="lazy"/>
          <img class="c-h" src="assets/home/hero-02.webp" alt="" loading="lazy"/>
          <img class="c-i" src="assets/home/hero-03.webp" alt="" loading="lazy"/>
        </div>
      </section>

      <!-- ============ built for retail success ============ -->
      <section class="hm-bleed">
        <img src="assets/home/hero-05.webp" alt="" loading="lazy"/>
        <div class="hm-bleed-shade"></div>
        <div class="hm-bleed-text">
          <div class="hm-label hm-center">Built for retail success</div>
          <h2 class="hm-h2">More than eyewear distribution. A partner<br/>built to help retailers move with confidence.</h2>
        </div>
      </section>

      <!-- ============ portfolio ============ -->
      <section class="hm-sec hm-portfolio">
        <div class="hm-port-text">
          <div class="hm-label">Our portfolio</div>
          <h3>A house of eyewear brands, backed by one distribution partner.</h3>
          <p>At Veyora, precision, quality, and modern vision come together.</p>
          <p>At Veyora, we don't just sell products. We help you build success.</p>
        </div>
        <div class="hm-port-grid">
          <img src="assets/home/product-shot-01.webp" alt="" loading="lazy"/>
          <img src="assets/home/product-shot-02.webp" alt="" loading="lazy"/>
          <img src="assets/home/product-shot-03.webp" alt="" loading="lazy"/>
          <img src="assets/home/product-shot-04.webp" alt="" loading="lazy"/>
        </div>
      </section>

      <!-- ============ veyora in motion ============ -->
      <section class="hm-video-sec">
        <video src="assets/home/charlett-video.mp4" poster="assets/home/charlett-poster.webp"
               muted loop playsinline preload="metadata" disableremoteplayback></video>
      </section>
      <section class="hm-sec hm-cta">
        <div class="hm-label hm-center">Veyora in motion</div>
        <h2 class="hm-h2">Our Vision Can Be Yours</h2>
        <p class="hm-cta-p">At Veyora, we don't just sell products. We help you build success.</p>
        <a class="hm-outline-btn" href="#/products">Start Purchase</a>
      </section>

      ${homeFooter()}
      ${whatsappFloat()}`;

    /* hero carousel: crossfade every 6s */
    const slides = [...el.querySelectorAll('.hm-hero-slides img')];
    const dots = [...el.querySelectorAll('.hm-hero-dots span')];
    let cur = 0;
    function show(i) {
      slides[cur].classList.remove('on'); dots[cur].classList.remove('on');
      cur = (i + slides.length) % slides.length;
      slides[cur].classList.add('on'); dots[cur].classList.add('on');
    }
    const timer = setInterval(() => {
      if (!document.body.contains(slides[0])) { clearInterval(timer); return; }
      show(cur + 1);
    }, 6000);
    dots.forEach(d => d.onclick = () => show(parseInt(d.dataset.dot, 10)));

    /* the motion video starts by itself when scrolled into view — no play
       button. iOS Low-Power blocks play() until any touch, so retry on the
       first touch as well. */
    const vid = el.querySelector('.hm-video-sec video');
    vid.muted = true;   // belt & braces: some browsers ignore the attribute
    const tryPlay = () => vid.play().catch(() => {});
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) tryPlay(); else vid.pause(); });
    }, { threshold: 0.25 });
    io.observe(vid);
    document.addEventListener('touchend', function once() {
      if (vid.paused && vid.getBoundingClientRect().top < innerHeight) tryPlay();
      if (!document.body.contains(vid)) document.removeEventListener('touchend', once);
    }, { passive: true });
  },
};
