/* The landing page's Global Distribution map — REMOVED.

   This file used to assert the map into place. The homepage redesign retired
   the concept outright: no map, no map section, no country labels, no route
   lines, no replacement artwork and no infographic standing in for it. The
   assertions are inverted accordingly — they now guard the removal, so the map
   cannot quietly come back, and they check the editorial homepage that took its
   place. Everything runs against the REAL storefront source on disk. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STOREFRONT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'storefront');
const readSf = p => fs.readFileSync(path.join(STOREFRONT, p), 'utf8');
/* Markup assertions look at code, not at the comments explaining it. */
const codeOf = p => readSf(p)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/<!--[\s\S]*?-->/g, ' ');

const HOME = codeOf('js/pages_home.js');
const CSS = readSf('css/store.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const flatCss = CSS.replace(/\s+/g, '');
const cssRule = sel => {
  const at = flatCss.indexOf(sel + '{');
  return at < 0 ? null : flatCss.slice(at, flatCss.indexOf('}', at) + 1);
};
/* Every asset the homepage points at. */
const homeAssets = () => [...HOME.matchAll(/(?:src|poster)="([^"]+)"/g)].map(m => m[1]);
/* The markup the route actually renders, without the helper functions declared
   above it — so "first on the page" means first on the page. */
const MARKUP = HOME.slice(HOME.indexOf('el.innerHTML ='),
                          HOME.indexOf('${whatsappFloat()}'));
/* The homepage's own responsive rules, and nothing else: the file has other
   900px and 820px media blocks (the product filters, the guest header) that a
   plain indexOf would drag in. */
const phoneAt = flatCss.indexOf('@media(max-width:900px){.hm-ed-in{');
const at820 = flatCss.indexOf('@media(max-width:820px){.hm-strip-in{');
const at560 = flatCss.indexOf('@media(max-width:560px){.hm-actions{');
const PHONE = flatCss.slice(phoneAt, flatCss.indexOf('}}', at560) + 2);
const BLOCK900 = flatCss.slice(phoneAt, at820);
const BLOCK820 = flatCss.slice(at820, at560);

/* ================= the map is gone ================= */

test('no map artwork is referenced by the homepage', () => {
  for (const asset of ['veyora-global-distribution-map.webp',
                       'veyora-global-distribution-map.png',
                       'global-distribution-map-B9WDMC-1.webp',
                       'global-distribution-map-B9WDMC-2.webp']) {
    assert.ok(!HOME.includes(asset), `${asset} must not be referenced`);
  }
  assert.ok(!/distribution-map/i.test(HOME), 'no map artwork of any name');
  assert.ok(!HOME.includes('assets/landing/'),
    'the landing/ folder held only the map — nothing points into it');
});

test('no map section, heading or copy survives', () => {
  for (const gone of ['hm-map', 'Global Distribution', 'Worldwide reach',
                      'Worldwide Reach', 'global reach']) {
    assert.ok(!HOME.includes(gone), `"${gone}" must be gone from the homepage`);
  }
  /* The regions the artwork labelled are not named anywhere either — a text
     list of countries would be the same section by another means. */
  for (const place of ['Canada', 'Morocco', 'UAE']) {
    assert.ok(!HOME.includes(place), `the map's "${place}" label is gone`);
  }
});

test('no map-specific styling survives', () => {
  assert.equal(cssRule('.hm-map'), null, '.hm-map rule removed');
  assert.equal(cssRule('.hm-map-sec'), null, '.hm-map-sec rule removed');
  assert.ok(!/hm-map/.test(flatCss), 'no map selector anywhere in the stylesheet');
});

test('nothing was swapped in to play the map’s part', () => {
  /* The brief was explicit: the concept is retired, not replaced. No second
     infographic, and no wide "reach" graphic sitting where the map sat. The
     rendered markup is checked, not the icon helpers above it — the Products
     and WhatsApp glyphs were always inline SVG and are unrelated. */
  assert.ok(!/\bmaps?\b/i.test(MARKUP), 'the word map appears nowhere on the page');
  assert.ok(!/infographic|\broutes?\b|territor|worldwide|continent/i.test(MARKUP),
    'no diagram or route artwork replaces it');
  assert.ok(!/<svg|<canvas|\.svg"/.test(MARKUP.replace(/logo-\w+\.svg/g, '')),
    'no inline graphic or drawn artwork sits in the page body');
});

/* ================= only supplied assets, all present ================= */

test('every image, poster and video the homepage uses exists on disk', () => {
  const assets = homeAssets();
  assert.ok(assets.length >= 10, 'the page is photography-led');
  for (const a of assets) {
    assert.ok(!/^https?:|^\/\//.test(a), `${a} must be a local asset, not a remote one`);
    const abs = path.join(STOREFRONT, a);
    assert.ok(fs.existsSync(abs), `${a} must exist — a 404 here is a blank frame`);
    assert.ok(fs.statSync(abs).size > 0, `${a} must not be empty`);
  }
});

test('the supplied campaign files are used unaltered', () => {
  /* Git tracks the bytes; this checks the page did not reach for a resized or
     re-encoded copy of a supplied asset instead of the asset itself. */
  const supplied = new Set(fs.readdirSync(path.join(STOREFRONT, 'assets', 'home')));
  for (const a of homeAssets().filter(a => a.startsWith('assets/home/'))) {
    assert.ok(supplied.has(path.basename(a)), `${a} is one of the supplied files`);
  }
  assert.ok(homeAssets().includes('assets/home/charlett-video.mp4'), 'the supplied video is kept');
  assert.ok(homeAssets().includes('assets/home/charlett-poster.webp'), 'and its poster');
});

/* ================= the editorial homepage that replaced it ================= */

test('the route, header destinations and WhatsApp are preserved', () => {
  assert.match(HOME, /Routes\['#\/'\] = Routes\['#\/home'\]/, '#/ and #/home still render it');
  assert.match(HOME, /public: true/, 'it is still a public page');
  assert.match(HOME, /\$\{editorialHeader\(\)\}/, 'the homepage header renders');
  assert.match(HOME, /href="#\/products"/, 'Products navigation survives');
  assert.match(HOME, /Store\.session \? '#\/products' : '#\/login'/,
    'the account control still goes to the catalogue or to sign-in');
  assert.match(HOME, /wa\.me\/16467731000/, 'the WhatsApp number is unchanged');
  assert.match(HOME, /class="hm-wa"/, 'the WhatsApp float is still rendered');
  assert.match(HOME, /document\.body\.classList\.add\('hm-dark'\)/,
    'the marketing-page body flag app.js toggles is still applied');
});

test('the dark guest header other pages depend on is untouched', () => {
  /* pages_auth / pages_catalog / pages_lists render homeHeader() inside
     .guest-head. The redesign must not have taken it with it. */
  assert.match(HOME, /function homeHeader\(\)/, 'homeHeader() still exists');
  assert.match(HOME, /class="hm-head"/);
  assert.match(HOME, /assets\/logo-white\.svg/, 'it still uses the white logo');
  assert.ok(cssRule('.hm-head'), '.hm-head styling is retained');
  assert.match(flatCss, /\.guest-head\.hm-head\{position:static/,
    'the guest-page override is retained');
});

test('there is no hero carousel and no carousel dots', () => {
  assert.ok(!/hm-hero-slides|hm-hero-dots|HOME_HERO/.test(HOME), 'the slideshow is gone');
  assert.ok(!/setInterval/.test(HOME), 'nothing auto-advances a hero');
  assert.ok(!/hm-hero/.test(flatCss), 'and no carousel styling survives');
  /* The first screen is a split composition instead. */
  assert.match(HOME, /class="hm-ed"/);
  assert.match(HOME, /class="hm-ed-art-main"/, 'a dominant campaign photograph');
  assert.match(cssRule('.hm-ed-in'), /grid-template-columns:minmax\(0,1fr\)minmax\(0,1\.12fr\)/,
    'asymmetric, not two equal halves');
});

test('the hero carries one photograph, not an overlapping pair', () => {
  /* The browser review found the second, overlapping frame produced a scroll
     position showing only pale studio architecture — no face, no eyewear, no
     subject. It was removed rather than repositioned. */
  assert.ok(!/hm-ed-art-inset/.test(HOME), 'the overlapping frame is gone from the markup');
  assert.ok(!/hm-ed-art-inset/.test(flatCss), 'and from the stylesheet');
  const heroImgs = (HOME.slice(HOME.indexOf('class="hm-ed"'), HOME.indexOf('class="hm-strip"'))
    .match(/<img/g) || []);
  assert.equal(heroImgs.length, 1, 'exactly one image in the hero');
  assert.ok(!/hero-08\.webp/.test(HOME), 'the secondary campaign file is no longer used');
  /* Nothing hangs outside its box any more, so nothing needs a negative pull. */
  const hero = cssRule('.hm-ed-art-main');
  assert.ok(!/position:absolute/.test(hero), 'the hero frame is in normal flow');
});

test('the canvas is light and the CTA is solid, not outlined', () => {
  const body = cssRule('body.hm-dark');
  assert.match(body, /--hm-canvas:#f5f2ec/, 'a warm ivory canvas');
  assert.match(body, /background:var\(--hm-canvas\)/);
  assert.ok(!/background:#0e0d0d/.test(body), 'the near-black page background is gone');
  assert.equal(cssRule('.hm-outline-btn'), null, 'the outlined CTA is gone');
  const btn = cssRule('.hm-btn');
  assert.match(btn, /background:var\(--hm-ink\)/, 'the primary CTA is solid dark');
  assert.match(btn, /min-height:50px/, 'and a comfortable tap target');
});

test('the sections appear in the redesigned order', () => {
  const order = ['hm-ed', 'hm-strip', 'hm-focus', 'hm-state',
                 'hm-port', 'hm-motion', 'hm-close'];
  let at = MARKUP.indexOf('${editorialHeader()}');
  assert.ok(at >= 0, 'the header renders first');
  for (const cls of order) {
    const next = MARKUP.indexOf(`<section class="${cls}"`);
    assert.ok(next > at, `${cls} comes after the section before it`);
    at = next;
  }
  assert.ok(MARKUP.indexOf('${editorialFooter()}') > at, 'and the footer last');
  /* The header and footer are the compact editorial pair, not the old ones. */
  assert.ok(!/homeFooter/.test(HOME), 'the old centred footer is gone');
  assert.ok(!MARKUP.includes('${homeHeader()}'),
    'the homepage does not render the dark guest header');
});

test('the copy the brief specified is on the page', () => {
  for (const line of ['CURATED EYEWEAR FOR OPTICAL RETAIL',
                      'Designed to move', 'with modern retail.',
                      'View Collections', 'Talk to Sales',
                      'CURATED COLLECTIONS', 'DEPENDABLE SUPPLY', 'RESPONSIVE PARTNERSHIP',
                      'Collections with', 'a point of view.', 'Explore Products',
                      'BUILT AROUND RETAILERS',
                      'More than a supplier.', 'A partner for what comes next.',
                      'THE VEYORA PORTFOLIO',
                      'Distinct brands.', 'One considered collection.',
                      'Eyewear selected for', 'the way retailers sell.']) {
    assert.ok(HOME.includes(line), `"${line}" is on the page`);
  }
});

/* ================= video behaviour is unchanged ================= */

test('the supplied video keeps its attributes and its in-view autoplay', () => {
  const tag = HOME.match(/<video[\s\S]*?><\/video>/);
  assert.ok(tag, 'the video element is present');
  for (const attr of ['muted', 'loop', 'playsinline', 'preload="metadata"',
                      'src="assets/home/charlett-video.mp4"',
                      'poster="assets/home/charlett-poster.webp"']) {
    assert.ok(tag[0].includes(attr), `the video keeps ${attr}`);
  }
  assert.ok(!/controls/.test(tag[0]), 'no controls, as before');
  /* The play logic itself is unchanged — only its container class moved. */
  assert.match(HOME, /querySelector\('\.hm-motion-frame video'\)/);
  assert.match(HOME, /vid\.muted = true/);
  assert.match(HOME, /new IntersectionObserver\(sync/);
  assert.match(HOME, /addEventListener\('scroll', sync/);
  assert.match(HOME, /addEventListener\('touchend', sync/);
  assert.match(HOME, /vid\.play\(\)\.catch\(\(\) => \{\}\)/, 'a rejected play() is swallowed');
  /* It is framed now, not full-bleed. */
  assert.equal(cssRule('.hm-video-sec'), null, 'the old full-width treatment is gone');
  assert.match(cssRule('.hm-motion-frame'), /padding:clamp\(8px,\.9vw,12px\)/, 'a frame around it');
});

/* ================= performance ================= */

test('only the first screen loads eagerly; everything below it is lazy', () => {
  const imgs = [...HOME.matchAll(/<img[\s\S]*?\/>/g)].map(m => m[0])
    .filter(t => t.includes('assets/home/'));
  const eager = imgs.filter(t => !t.includes('loading="lazy"'));
  assert.equal(eager.length, 1, 'only the hero frame loads eagerly');
  assert.ok(eager.every(t => t.includes('fetchpriority="high"')),
    'and it is prioritised');
  for (const t of imgs) {
    assert.match(t, /width="\d+"/, 'every image declares a width');
    assert.match(t, /height="\d+"/, 'and a height, so the box is reserved');
    assert.match(t, /alt="[^"]+"/, 'and carries alt text');
  }
});

test('the declared dimensions match the files on disk', () => {
  const size = file => {
    const b = fs.readFileSync(path.join(STOREFRONT, file));
    const chunk = b.slice(12, 16).toString();
    if (chunk === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
    if (chunk === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  };
  for (const tag of [...HOME.matchAll(/<img[\s\S]*?\/>/g)].map(m => m[0])) {
    const src = tag.match(/src="([^"]+)"/)[1];
    if (!src.endsWith('.webp')) continue;
    const [w, h] = size(src);
    assert.ok(tag.includes(`width="${w}"`), `${src}: declared width matches the file (${w})`);
    assert.ok(tag.includes(`height="${h}"`), `${src}: declared height matches the file (${h})`);
  }
});

/* Outbound destinations the homepage is allowed to LINK to. Linking is not
   loading: an <a href> to Veyora's own WhatsApp or social profile fetches
   nothing and executes nothing. What this guard exists to stop is a third-party
   *asset* — a CDN script, a webfont, a tracking pixel — which is caught by the
   asset assertions below regardless of host. A new host still has to be added
   here deliberately, so the list cannot grow by accident. */
const ALLOWED_LINK_HOSTS = Object.freeze([
  'wa.me',                  // the existing WhatsApp contact link
  'www.instagram.com',      // Veyora's own profiles, added with the editorial homepage
  'www.facebook.com',
  'www.linkedin.com',
]);

test('no third-party asset or dependency was introduced', () => {
  const hosts = [...HOME.matchAll(/https?:\/\/([^/'"`\s)]+)/g)].map(m => m[1]);
  for (const host of new Set(hosts)) {
    assert.ok(ALLOWED_LINK_HOSTS.includes(host),
      `${host} is an approved outbound destination`);
  }
  /* Every allowed host may be linked to and nothing more. If one of these URLs
     ever becomes the src of something the browser fetches, this fails. */
  assert.ok(!/(?:src|href)\s*=\s*["'`]https?:/.test(
    HOME.replace(/<a\b[\s\S]*?>/g, ' ')), 'no external asset is fetched');
  assert.ok(!/@import|url\(\s*["']?https?:/.test(HOME), 'no external stylesheet or font');
  assert.ok(!/<script|import |require\(/.test(HOME), 'no new dependency is pulled in');
});

/* ================= responsive ================= */

test('nothing can push the page sideways', () => {
  /* Every section is padded with a clamp rather than a percentage, and every
     grid track is minmax(0,…) so a wide child cannot blow the column out. */
  for (const sel of ['.hm-ed-in', '.hm-strip-in', '.hm-focus-in', '.hm-port-in',
                     '.hm-motion-in', '.hm-close-in', '.hm-foot-in']) {
    const rule = cssRule(sel);
    assert.ok(rule, `${sel} exists`);
    assert.match(rule, /clamp\(20px,4vw,40px\)/, `${sel} keeps copy off the screen edge`);
    assert.ok(!/width:100vw/.test(rule), `${sel} does not use 100vw`);
    if (/grid-template-columns/.test(rule)) {
      assert.ok(!/grid-template-columns:[^;}]*(?<!minmax\(0,)1fr/.test(rule)
                || /minmax\(0,/.test(rule), `${sel} uses minmax(0,…) tracks`);
    }
  }
  /* The one element that hangs outside its box is the hero's offset frame, and
     the section it lives in clips. */
  assert.match(cssRule('.hm-ed'), /overflow:hidden/);
  assert.match(flatCss, /html,body\{overflow-x:clip\}/, 'the page-level guard is still there');
});

test('the phone layout stacks and stays reachable', () => {
  const block = BLOCK900;
  assert.match(block, /\.hm-ed-in\{grid-template-columns:minmax\(0,1fr\)/, 'the hero stacks');
  assert.match(block, /\.hm-focus-in\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(block, /\.hm-focus-pair\{grid-template-columns:minmax\(0,1fr\);height:auto/,
    'the paired frames stack and drop their shared height');
  assert.match(block, /\.hm-port-in\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(block, /\.hm-motion-in\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(block, /\.hm-close-in\{grid-template-columns:minmax\(0,1fr\)/);
  const block820 = BLOCK820;
  assert.match(block820, /\.hm-strip-in\{grid-template-columns:minmax\(0,1fr\)/, 'the strip stacks');
  /* The old page hid the header controls on a phone. They stay now. */
  assert.ok(!/\.hm-nav-links\{display:none/.test(flatCss), 'header controls are never hidden');
  assert.ok(!/hm-head-right\{display:none/.test(flatCss),
    'and the rule that used to hide them on the homepage is gone');
  /* Header type and logo scale with the viewport instead of overflowing, and
     the row is inset the same 20px as the copy below it. */
  assert.match(cssRule('.hm-nav-logoimg'), /height:clamp\(17px,4\.8vw,24px\)/);
  assert.match(cssRule('.hm-nav-in'), /padding:clamp\(11px,1\.2vw,14px\)clamp\(20px,5\.6vw,40px\)/);
  assert.match(cssRule('.hm-nav-linksa'), /font-size:clamp\(10px,1\.6vw,11\.5px\)/);
  assert.match(cssRule('.hm-nav-linksa'), /white-space:nowrap/);
});

test('the phone layout is its own design, not the desktop grid squeezed', () => {
  const phone = PHONE;
  /* Campaign photography leads the first screen — the frame is ordered above
     the headline rather than sitting a full screen below it. */
  assert.match(phone, /\.hm-ed-art\{order:-1\}/, 'the hero photograph comes first on a phone');
  assert.match(phone, /\.hm-ed-art-main\{aspect-ratio:5\/4;max-height:48vh\}/,
    'and it is a landscape crop that fits the first screen, not a tall portrait');
  assert.match(phone, /@media\(max-width:560px\)\{[^@]*\.hm-ed-art-main\{aspect-ratio:3\/2\}/,
    'shallower still on the smallest phones, so the CTA clears a 667px fold');
  /* Nothing is nudged, overlapped or offset at phone widths. */
  assert.ok(!/margin:-|margin-top:-|margin-left:-/.test(phone),
    'no negative margins anywhere in the phone rules');
  assert.ok(!/position:absolute/.test(phone), 'nothing is absolutely placed on a phone');
  assert.ok(!/width:7\d%|width:6\d%/.test(phone),
    'no part-width staggered frames — image widths are consistent');
  /* Horizontal page padding stays in the 20–24px band. */
  assert.match(cssRule('.hm-ed-in'), /clamp\(20px,4vw,40px\)/);
  assert.match(phone, /\.hm-ed-in\{[^}]*clamp\(20px,5\.6vw,32px\)/);
});

test('no image container is excessively tall on any screen', () => {
  /* Every photographic box is bounded either by an aspect-ratio or by a
     viewport-relative cap — nothing can run for multiple screens. */
  assert.match(cssRule('.hm-ed-art-main'), /aspect-ratio:4\/5/);
  assert.match(cssRule('.hm-ed-art-main'), /max-height:min\(70vh,680px\)/,
    'the desktop hero is capped below the fold height');
  assert.match(cssRule('.hm-focus-pair'), /height:clamp\(400px,54vh,580px\)/,
    'the paired frames share one bounded height');
  /* The portfolio tiles are square boxes holding 4:5 files. The box carries the
     aspect-ratio (so the height is bounded before the image loads) and the
     image is `contain`ed inside it rather than cropped — see the crop test
     below, which is where the "nothing is cut off" half of this is asserted. */
  assert.match(cssRule('.hm-port-feature'), /aspect-ratio:1\/1/);
  assert.match(cssRule('.hm-port-feature'), /max-width:420px/,
    'the feature product shot is width-capped so it cannot tower');
  assert.match(cssRule('.hm-port-rowfigure'), /aspect-ratio:1\/1/);
  assert.match(cssRule('.hm-motion-framevideo'), /aspect-ratio:16\/9/);
  const phone = PHONE;
  assert.match(phone, /\.hm-focus-aimg\{aspect-ratio:4\/5\}/);
  assert.match(phone, /\.hm-focus-bimg\{aspect-ratio:3\/2\}/);
});

test('every photograph is cropped to its own subject, not centred generically', () => {
  /* One value per image, derived from where the subject actually sits in the
     file. A single generic 50% 50% everywhere is what produced the neck, lips
     and blank-wall crops the browser review found. */
  const positions = {
    '.hm-ed-art-main': '50%46%',      // hero-04  model 31–82% down
    '.hm-focus-aimg': '50%25%',       // hero-05  two faces at 32% and 45%
    '.hm-focus-bimg': '50%30%',       // hero-10  face 25–48%
    '.hm-state>img': '57%43%',         // hero-02  face right of centre
  };
  const seen = new Set();
  for (const [sel, pos] of Object.entries(positions)) {
    const rule = cssRule(sel);
    assert.ok(rule, `${sel} exists`);
    assert.ok(rule.includes(`object-position:${pos}`), `${sel} is cropped to ${pos}`);
    seen.add(pos);
  }
  assert.ok(seen.size === Object.keys(positions).length,
    'each campaign image gets its own crop, not one shared value');
  /* The product shots are the exception on purpose: they are never cropped at
     all. A 4:5 file sits inside a square tile under `object-fit:contain`, so
     the whole frame shows and the stone tile background fills the remainder.
     `contain` is the assertion that matters — with `cover` the crop values
     above would start applying to product photography too. */
  for (const sel of ['.hm-port-featureimg', '.hm-port-rowimg']) {
    assert.match(cssRule(sel), /object-fit:contain/,
      `${sel} shows the whole product rather than cropping it`);
  }
});

test('no fixed pixel height can squash a section on a phone', () => {
  for (const sel of ['.hm-state', '.hm-ed-in', '.hm-focus-in', '.hm-port-in',
                     '.hm-motion-in', '.hm-close-in']) {
    const rule = cssRule(sel);
    assert.ok(!/[^-]height:\d+px/.test(rule), `${sel} declares no fixed height`);
  }
  assert.match(cssRule('.hm-state'), /min-height:clamp\(340px,50vh,520px\)/,
    'the statement section is bounded, not pinned to the viewport');
  /* The paired-frame height is a clamp, and it is released entirely on a phone. */
  assert.match(PHONE, /\.hm-focus-pair\{[^}]*height:auto/);
});

test('one dark editorial WhatsApp style is shared by every storefront page', () => {
  /* The appearance lives in the BASE rule, so the homepage, the guest pages and
     every authenticated page (Products, Orders, Backorders, Returns, Favorites,
     Reorder, Spare Parts, My Account — all of which render `.hm-wa.shell-wa`
     from app.js) inherit one identical control. */
  const base = cssRule('.hm-wa');
  assert.ok(base, 'the shared base rule exists');
  assert.match(base, /background:#191612/, 'charcoal, matching the primary CTA');
  assert.match(base, /color:#f5f2ec/, 'with an ivory glyph');
  assert.match(base, /border:1pxsolidrgba\(245,242,236,\.16\)/, 'a thin neutral border');
  assert.match(base, /box-shadow:08px24pxrgba\(25,22,18,\.3\)/, 'a restrained shadow');
  assert.match(cssRule('.hm-wa:hover'), /background:#000/);
  assert.match(cssRule('.hm-wasvg'), /width:22px;height:22px/, 'one glyph size everywhere');
  /* Literal colours, not --hm-* tokens: those are declared on body.hm-dark,
     which the authenticated pages remove, so a token here would resolve to
     nothing outside the homepage. */
  assert.ok(!/var\(--hm-/.test(base), 'the base rule does not depend on homepage tokens');
});

test('no storefront WhatsApp rule uses the old orange', () => {
  for (const m of flatCss.matchAll(/(?:^|[{}])([^{}@]*(?:hm-wa|shell-wa)[^{}]*)\{([^}]*)\}/g)) {
    assert.ok(!/ED6A2F/i.test(m[2]), `${m[1]} must not carry the orange`);
  }
  /* Belt and braces: the colour is gone from the stylesheet altogether. */
  assert.ok(!/ED6A2F/i.test(flatCss), 'the orange is no longer used anywhere');
});

test('the homepage control keeps its own geometry', () => {
  const rule = cssRule('body.hm-dark.hm-wa');
  assert.ok(rule, 'the homepage float is positioned');
  assert.match(rule, /width:48px;height:48px/, 'a 48px target on desktop');
  assert.match(rule, /bottom:calc\(22px\+env\(safe-area-inset-bottom\)\)/);
  /* Geometry only — colour, border and shadow now come from the base rule, so
     the duplicated homepage-only override is gone. */
  assert.ok(!/background:|color:|border:|box-shadow:/.test(rule),
    'no duplicate colour override survives on the homepage rule');
  const block820 = BLOCK820;
  assert.match(block820, /body\.hm-dark\.hm-wa\{width:44px;height:44px;bottom:calc\(14px\+env\(safe-area-inset-bottom\)\);right:14px\}/,
    'smaller and further into the corner on a tablet, still a 44px target');
  /* The footer reserves the button's height below its last line. */
  assert.match(block820, /padding-bottom:calc\(72px\+env\(safe-area-inset-bottom\)\)/);
  assert.match(cssRule('.hm-foot-in'), /clamp\(52px,5vw,76px\)/, 'desktop reserve');
});

test('the float is dropped altogether on a phone', () => {
  /* No corner on a 375px screen keeps it off a headline, a photograph or the
     primary CTA at every scroll position, so at 560px and below the homepage
     hides it rather than shrinking it further. */
  assert.match(PHONE, /@media\(max-width:560px\)\{[^@]*body\.hm-dark\.hm-wa\{display:none\}/,
    'the homepage float is hidden at 560px and below');
  /* The rule is scoped to the homepage body flag and appears only in the 560
     block — the desktop and tablet float are untouched. */
  /* A selector boundary before .hm-wa, so this matches the bare base rule and
     not the `body.hm-dark .hm-wa` override that legitimately hides it. */
  assert.ok(!/[{},]\.hm-wa\{display:none/.test(flatCss),
    'the shared base rule is never hidden');
  assert.ok(!/shell-wa[^{]*\{[^}]*display:none/.test(flatCss),
    'the signed-in shell control is never hidden');
  assert.ok(!/display:none/.test(BLOCK900 + BLOCK820),
    'nothing is hidden at desktop or tablet widths');
  /* And the three non-floating routes to sales are all still on the page. */
  assert.match(MARKUP, /class="hm-textlink" href="\$\{WHATSAPP\}"[^>]*>Talk to Sales</,
    'hero text link');
  assert.match(MARKUP, /class="hm-btn ghost" href="\$\{WHATSAPP\}"[^>]*>Talk to Sales</,
    'closing CTA button');
  assert.match(HOME, /href="\$\{WHATSAPP\}"[^>]*>Talk to sales</, 'footer link');
});

test('the signed-in shell keeps its size, its lift and its safe area', () => {
  /* Only the appearance was shared out; the shell's geometry is untouched —
     48px, above the 44px minimum, and lifted clear of the bottom navigation
     with the home-indicator inset on a phone. */
  assert.match(cssRule('.shell-wa'), /width:48px;height:48px/);
  assert.match(flatCss, /@media\(max-width:900px\)\{\.hm-wa\.shell-wa\{bottom:calc\(72px\+env\(safe-area-inset-bottom\)\);right:16px\}\}/,
    'still lifted above the bottom navigation');
  assert.ok(!/shell-wa[^{]*\{[^}]*display:none/.test(flatCss),
    'the authenticated control is never hidden');
  assert.ok(!/\.shell-wa[^{]*\{[^}]*var\(--hm-/.test(flatCss),
    'no homepage token leaks into the shell control');
  /* The homepage's phone hide is scoped to body.hm-dark, which app.js removes
     on every authenticated route, so it can never reach the shell. */
  assert.match(PHONE, /body\.hm-dark\.hm-wa\{display:none\}/);
  assert.ok(!/\.hm-wa\.shell-wa\{[^}]*display:none/.test(flatCss));
});

test('Talk to Sales is reachable without relying on the float', () => {
  const links = [...MARKUP.matchAll(/>\s*(Talk to Sales|Talk to sales)\s*</g)];
  assert.ok(links.length >= 2,
    'the hero text link and the closing CTA both offer it, plus the footer');
  assert.match(MARKUP, /class="hm-textlink" href="\$\{WHATSAPP\}"/,
    'a restrained secondary text link sits under the primary CTA');
  /* On a phone the primary button goes full width and the text link falls
     beneath it rather than competing on the same line. */
  assert.match(PHONE, /\.hm-actions\.hm-btn\{flex:11100%\}/);
});

/* ================= the rest of the app is not restyled ================= */

test('the homepage stylesheet stays inside hm- selectors', () => {
  /* Everything the redesign added is either an hm- class or the body flag. */
  const added = [...flatCss.matchAll(/(^|[},])((?:\.hm-|body\.hm-dark)[^{]*)\{/g)];
  assert.ok(added.length > 40, 'the homepage block is present');
  for (const sel of ['.pcard2', '.prod-head', '.login-box', '.bottomnav', '.topbar',
                     '.qtybox', '.vrow', '.card', '.btn', 'table.list']) {
    assert.ok(flatCss.includes(sel), `${sel} still exists — nothing was deleted wholesale`);
  }
  /* No bare element or global selector was added by the redesign. */
  assert.ok(!/\bbody\{[^}]*background:var\(--hm-canvas\)/.test(flatCss),
    'the ivory canvas is scoped to the homepage body flag, not to body');
});
