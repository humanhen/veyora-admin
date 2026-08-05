/* Public marketing homepage — the "Editorial Showroom".

   A light, warm-neutral, photography-led page: an asymmetric split hero (no
   carousel), a restrained value strip, an off-grid collections composition, a
   single full-bleed statement, a featured-product portfolio, a framed video and
   a dark closing CTA.

   The global distribution map is deliberately gone — the concept was retired,
   not replaced, so there is no map, no map-style graphic and no infographic
   standing in for it.

   Only assets already in the repository are used. `homeHeader()` below is NOT
   the homepage header: it is the dark guest header that pages_auth.js,
   pages_catalog.js and pages_lists.js render inside `.guest-head`, so it stays
   exactly as it was. The homepage renders `editorialHeader()` instead. */
'use strict';

const WHATSAPP = 'https://wa.me/16467731000';
const SOCIAL = {
  instagram: 'https://www.instagram.com/veyora.vision/',
  facebook: 'https://www.facebook.com/veyoravision',
  linkedin: 'https://www.linkedin.com/company/veyoravision/',
};

function glassesIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="6.5" cy="14" r="3.5"/><circle cx="17.5" cy="14" r="3.5"/><path d="M10 14q2 -1.6 4 0"/><path d="M3 14 L2 9.5 M21 14 L22 9.5"/></svg>`;
}
function personIcon() {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
}
function waIcon() {
  return `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.96-.94 1.16-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.14-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.89 1.22 3.09.15.2 2.11 3.22 5.1 4.51.71.31 1.27.49 1.7.63.72.23 1.37.2 1.88.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z"/><path d="M12.05 2a9.9 9.9 0 0 0-8.57 14.84L2 22l5.31-1.39A9.9 9.9 0 1 0 12.05 2zm0 18.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.15.83.84-3.07-.2-.31a8.2 8.2 0 1 1 6.99 3.88z"/></svg>`;
}
function igIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`;
}
function fbIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 9h3V6h-3c-2.2 0-4 1.8-4 4v2H8v3h2v7h3v-7h2.6l.4-3H13v-2c0-.6.4-1 1-1z"/></svg>`;
}
function liIcon() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.5 9.5H3.7V20h2.8V9.5zM5.1 4a1.65 1.65 0 1 0 0 3.3 1.65 1.65 0 0 0 0-3.3zM20.3 20h-2.8v-5.6c0-1.5-.03-3.4-2.08-3.4-2.08 0-2.4 1.62-2.4 3.3V20h-2.8V9.5h2.69v1.43h.04c.37-.7 1.28-1.44 2.64-1.44 2.82 0 3.34 1.86 3.34 4.28V20z"/></svg>`;
}

/* The dark guest header used by the sign-in, catalogue and list pages. Left
   untouched by the homepage redesign — those pages are not being restyled. */
function homeHeader() {
  return `
    <header class="hm-head">
      <a class="hm-logo" href="#/"><img src="assets/logo-white.svg" alt="Veyora"/></a>
      <div class="hm-head-right">
        <a class="hm-pill ghost" href="#/">Home</a>
        <a class="hm-pill" href="#/products">${glassesIcon()}<span>Products</span></a>
        <a class="hm-account" href="${Store.session ? '#/products' : '#/login'}" title="Account">${personIcon()}</a>
      </div>
    </header>`;
}

/* Compact homepage header. Same destinations as before — Products goes to the
   catalogue, the account control goes to the catalogue when signed in and to
   sign-in otherwise — but it sits in the page flow rather than floating over
   the artwork, and both controls stay visible on a phone. */
function editorialHeader() {
  const signedIn = !!Store.session;
  return `
    <header class="hm-nav">
      <div class="hm-nav-in">
        <a class="hm-nav-logo" href="#/" aria-label="Veyora — home">
          <img src="assets/logo-black.svg" alt="Veyora" width="937" height="125"/>
        </a>
        <nav class="hm-nav-links" aria-label="Primary">
          <a href="#/products">Products</a>
          <a class="hm-nav-acct" href="${signedIn ? '#/products' : '#/login'}">${
            signedIn ? 'My account' : 'Sign in'}</a>
        </nav>
      </div>
    </header>`;
}

function editorialFooter() {
  return `
    <footer class="hm-foot">
      <div class="hm-foot-in">
        <a class="hm-foot-logo" href="#/" aria-label="Veyora — home">
          <img src="assets/logo-white.svg" alt="Veyora" width="937" height="125" loading="lazy"/>
        </a>
        <nav class="hm-foot-links" aria-label="Footer">
          <a href="#/">Privacy policy</a>
          <a href="#/">Terms of service</a>
          <a href="#/">Accessibility Statement</a>
          <a href="${WHATSAPP}" target="_blank" rel="noopener">Talk to sales</a>
          <span class="hm-foot-social" aria-label="Social">
            <a class="hm-soc" href="${SOCIAL.instagram}" target="_blank" rel="noopener" title="Instagram" aria-label="Veyora on Instagram">${igIcon()}</a>
            <a class="hm-soc" href="${SOCIAL.facebook}" target="_blank" rel="noopener" title="Facebook" aria-label="Veyora on Facebook">${fbIcon()}</a>
            <a class="hm-soc" href="${SOCIAL.linkedin}" target="_blank" rel="noopener" title="LinkedIn" aria-label="Veyora on LinkedIn">${liIcon()}</a>
          </span>
        </nav>
        <div class="hm-foot-legal">© ${new Date().getFullYear()} Veyora. All rights reserved.</div>
      </div>
    </footer>`;
}

function whatsappFloat() {
  return `<a class="hm-wa" href="${WHATSAPP}" target="_blank" rel="noopener"
             title="Talk to sales on WhatsApp" aria-label="Talk to sales on WhatsApp">${waIcon()}</a>`;
}

Routes['#/'] = Routes['#/home'] = {
  public: true, title: 'Curated Eyewear for Optical Retail',
  render(el) {
    /* `hm-dark` is the marketing-homepage body flag (app.js toggles it for #/
       and #/home; the authenticated pages remove it). It now carries the light
       editorial canvas — the name is historical, the scope is unchanged. */
    document.body.classList.add('hm-dark');
    el.innerHTML = `
      ${editorialHeader()}

      <!-- ============ 1. editorial split hero ============ -->
      <section class="hm-ed">
        <div class="hm-ed-in">
          <div class="hm-ed-copy">
            <p class="hm-eyebrow">CURATED EYEWEAR FOR OPTICAL RETAIL</p>
            <h1 class="hm-display">Designed to move<br/>with modern retail.</h1>
            <p class="hm-lead">Veyora brings together distinctive eyewear collections,
               dependable supply and responsive support for independent optical retailers.</p>
            <div class="hm-actions">
              <a class="hm-btn" href="#/products">View Collections</a>
              <a class="hm-textlink" href="${WHATSAPP}" target="_blank" rel="noopener">Talk to Sales</a>
            </div>
          </div>
          ${/* One photograph carries the hero. A second, overlapping frame was
               tried and dropped: mid-scroll it left a large pale stretch of
               studio architecture with no face, eyewear or subject in view. The
               single frame is the only image above the fold, fetched at high
               priority, and it declares its intrinsic size so the box is
               reserved before the file arrives. */''}
          <figure class="hm-ed-art">
            <img class="hm-ed-art-main" src="assets/home/hero-04.webp"
                 width="1600" height="2400" fetchpriority="high" decoding="async"
                 alt="Veyora campaign portrait — a model in aviator sunglasses seated in an arched white studio"/>
          </figure>
        </div>
      </section>

      <!-- ============ 2. retailer value strip ============ -->
      <section class="hm-strip">
        <div class="hm-strip-in">
          <article>
            <span class="hm-strip-no">01</span>
            <h2>CURATED COLLECTIONS</h2>
            <p>Distinctive eyewear selected for independent optical retail.</p>
          </article>
          <article>
            <span class="hm-strip-no">02</span>
            <h2>DEPENDABLE SUPPLY</h2>
            <p>Clear availability, replenishment and ordering support.</p>
          </article>
          <article>
            <span class="hm-strip-no">03</span>
            <h2>RESPONSIVE PARTNERSHIP</h2>
            <p>Practical support shaped around each retailer’s business.</p>
          </article>
        </div>
      </section>

      <!-- ============ 3. collections in focus ============ -->
      <section class="hm-focus">
        <div class="hm-focus-in">
          <div class="hm-focus-lead">
            <p class="hm-eyebrow">COLLECTIONS IN FOCUS</p>
            <h2 class="hm-display sm">Collections with<br/>a point of view.</h2>
            <p class="hm-body">A considered portfolio of eyewear brands, selected to give
               optical retailers variety without losing focus.</p>
            <a class="hm-textlink" href="#/products">Explore Products</a>
          </div>
          ${/* Two frames, one pair: same top and bottom line, different widths.
               Both crops were chosen against the actual photographs so each one
               shows a face and the eyewear. A third, wider frame of draped
               studio fabric was dropped — its subject read as empty space. */''}
          <div class="hm-focus-pair">
            <figure class="hm-focus-a">
              <img src="assets/home/hero-05.webp" width="1600" height="2400"
                   loading="lazy" decoding="async"
                   alt="Two models wearing Veyora sunglasses against draped ivory fabric"/>
            </figure>
            <figure class="hm-focus-b">
              <img src="assets/home/hero-10.webp" width="1000" height="1500"
                   loading="lazy" decoding="async"
                   alt="Model wearing tortoiseshell Veyora optical frames"/>
            </figure>
          </div>
        </div>
      </section>

      <!-- ============ 4. full-bleed campaign statement ============ -->
      <section class="hm-state">
        <img src="assets/home/hero-02.webp" width="1600" height="866"
             loading="lazy" decoding="async"
             alt="Close campaign portrait of a model in black Veyora sunglasses"/>
        <div class="hm-state-scrim"></div>
        <div class="hm-state-copy">
          <p class="hm-eyebrow on-dark">BUILT AROUND RETAILERS</p>
          <h2>More than a supplier.<br/>A partner for what comes next.</h2>
        </div>
      </section>

      <!-- ============ 5. product-focused portfolio ============ -->
      <section class="hm-port">
        <div class="hm-port-in">
          <figure class="hm-port-feature">
            <img src="assets/home/product-shot-03.webp" width="800" height="800"
                 loading="lazy" decoding="async"
                 alt="Charlett Saint Cloud sunglasses arranged on a leather case"/>
          </figure>
          <div class="hm-port-side">
            <p class="hm-eyebrow">THE VEYORA PORTFOLIO</p>
            <h2 class="hm-display sm">Distinct brands.<br/>One considered collection.</h2>
            <p class="hm-body">Veyora brings precision, quality and contemporary design
               together in a portfolio created for modern optical retail.</p>
            <a class="hm-textlink" href="#/products">See all products</a>
            <div class="hm-port-row">
              <figure>
                <img src="assets/home/product-shot-01.webp" width="800" height="800"
                     loading="lazy" decoding="async" alt="Gold aviator frames from the Veyora portfolio"/>
              </figure>
              <figure>
                <img src="assets/home/product-shot-02.webp" width="800" height="800"
                     loading="lazy" decoding="async" alt="Detail of a Veyora metal frame and temple"/>
              </figure>
              <figure>
                <img src="assets/home/product-shot-04.webp" width="800" height="800"
                     loading="lazy" decoding="async" alt="Veyora frames styled on a studio surface"/>
              </figure>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ 6. veyora in motion ============ -->
      <section class="hm-motion">
        <div class="hm-motion-in">
          <div class="hm-motion-copy">
            <p class="hm-eyebrow">VEYORA IN MOTION</p>
            <h2 class="hm-display xs">The collection,<br/>in movement.</h2>
            <p class="hm-body">A closer look at the frames, the finishes and the way the
               collection carries on the face.</p>
          </div>
          <figure class="hm-motion-frame">
            <video src="assets/home/charlett-video.mp4" poster="assets/home/charlett-poster.webp"
                   muted loop playsinline preload="metadata" disableremoteplayback></video>
          </figure>
        </div>
      </section>

      <!-- ============ 7. closing CTA ============ -->
      <section class="hm-close">
        <div class="hm-close-in">
          <h2 class="hm-display sm on-dark">Eyewear selected for<br/>the way retailers sell.</h2>
          <div class="hm-close-side">
            <p>Explore the collection or speak directly with the Veyora team.</p>
            <div class="hm-actions">
              <a class="hm-btn light" href="#/products">View Collections</a>
              <a class="hm-btn ghost" href="${WHATSAPP}" target="_blank" rel="noopener">Talk to Sales</a>
            </div>
          </div>
        </div>
      </section>

      ${editorialFooter()}
      ${whatsappFloat()}`;

    /* The motion video starts by itself when scrolled into view — no play
       button. IO + a plain scroll fallback (some browsers throttle IO), and
       a touch retry because iOS Low-Power blocks play() until any gesture. */
    const vid = el.querySelector('.hm-motion-frame video');
    vid.muted = true;   // belt & braces: some browsers ignore the attribute
    const inView = () => {
      const r = vid.getBoundingClientRect();
      return r.top < innerHeight * 0.85 && r.bottom > innerHeight * 0.15;
    };
    const sync = () => {
      if (!document.body.contains(vid)) {
        removeEventListener('scroll', sync);
        removeEventListener('touchend', sync);
        return;
      }
      if (inView()) { if (vid.paused) vid.play().catch(() => {}); }
      else if (!vid.paused) vid.pause();
    };
    try {
      new IntersectionObserver(sync, { threshold: 0.25 }).observe(vid);
    } catch { /* very old browser */ }
    addEventListener('scroll', sync, { passive: true });
    addEventListener('touchend', sync, { passive: true });
    sync();
  },
};
