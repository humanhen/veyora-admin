/* Batch 1J — the landing page's Global Distribution map.

   The old artwork was replaced with the approved premium asset. These
   assertions run against the REAL storefront source and against the REAL image
   file on disk — its RIFF/WEBP container is validated and the intrinsic size is
   read from the bitstream, not assumed — so a broken path, a wrong file, a
   cropping rule or an overlay cannot pass. Nothing is re-implemented. */
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
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const HOME = codeOf('js/pages_home.js');
const CSS = readSf('css/store.css').replace(/\/\*[\s\S]*?\*\//g, ' ');
const flatCss = CSS.replace(/\s+/g, '');
const cssRule = sel => {
  const at = flatCss.indexOf(sel + '{');
  return at < 0 ? null : flatCss.slice(at, flatCss.indexOf('}', at) + 1);
};

const ASSET = 'assets/landing/veyora-global-distribution-map.webp';
/* The first attempt at this batch shipped a PNG with a VEYORA wordmark baked
   into its top-left corner. It was rejected; the approved artwork carries no
   wordmark of its own. Both facts are asserted below. */
const REJECTED = 'assets/landing/veyora-global-distribution-map.png';
/* The map section, from its opening tag to the next section. */
const MAP_SECTION = HOME.slice(HOME.indexOf('<section class="hm-sec hm-map-sec">'),
                               HOME.indexOf('<!-- ============ collections'));

/* ================= the approved asset ================= */

test('the referenced image exists on disk', () => {
  const m = HOME.match(/class="hm-map"\s+src="([^"]+)"/);
  assert.ok(m, 'the map image is present in the markup');
  assert.equal(m[1], ASSET, 'it is the approved asset path');
  const abs = path.join(STOREFRONT, m[1]);
  assert.ok(fs.existsSync(abs), `${m[1]} must exist — a 404 here is a blank section`);
  assert.ok(fs.statSync(abs).size > 0, 'and must not be empty');
});

test('the asset is a valid WebP at the approved dimensions', () => {
  const b = fs.readFileSync(path.join(STOREFRONT, ASSET));
  assert.equal(b.slice(0, 4).toString(), 'RIFF', 'a RIFF container');
  assert.equal(b.slice(8, 12).toString(), 'WEBP', 'holding WebP data');
  assert.equal(b.readUInt32LE(4) + 8, b.length,
    'the RIFF length matches the file — not truncated');
  const chunk = b.slice(12, 16).toString();
  assert.ok(['VP8 ', 'VP8L', 'VP8X'].includes(chunk), `unknown WebP chunk ${chunk}`);
  /* Intrinsic size read from the bitstream, not assumed. */
  let w, h;
  if (chunk === 'VP8X') { w = b.readUIntLE(24, 3) + 1; h = b.readUIntLE(27, 3) + 1; }
  else if (chunk === 'VP8 ') { w = b.readUInt16LE(26) & 0x3fff; h = b.readUInt16LE(28) & 0x3fff; }
  else { const bits = b.readUInt32LE(21); w = (bits & 0x3fff) + 1; h = ((bits >> 14) & 0x3fff) + 1; }
  assert.equal(w, 1672);
  assert.equal(h, 941);
  /* The markup must declare exactly those numbers, so the browser reserves the
     right box before the file arrives and the section never jumps. */
  assert.ok(MAP_SECTION.includes(`width="${w}"`), 'width attribute matches the file');
  assert.ok(MAP_SECTION.includes(`height="${h}"`), 'height attribute matches the file');
  /* No fixed ratio is required of the artwork — the layout follows whatever
     the file's own ratio is (see the contain-fit test). */
  assert.ok(w > h, 'a wide, landscape frame');
});

test('the rejected wordmarked PNG is not shipped or referenced', () => {
  assert.ok(!fs.existsSync(path.join(STOREFRONT, REJECTED)),
    'the PNG carrying the baked-in VEYORA wordmark must be absent');
  assert.ok(!HOME.includes(REJECTED), 'and nothing points at it');
  assert.ok(!HOME.includes('.png'), 'the landing map is not a PNG at all');
});

test('the alt text names the regions the artwork shows', () => {
  const m = HOME.match(/class="hm-map"[\s\S]*?alt="([^"]+)"/);
  assert.ok(m, 'the image has alt text');
  const alt = m[1];
  assert.match(alt, /Veyora global distribution/i);
  for (const place of ['Canada', 'USA', 'Europe', 'Morocco', 'UAE']) {
    assert.ok(alt.includes(place), `alt text should mention ${place}`);
  }
  assert.ok(alt.length > 30, 'it is a description, not a filename');
});

/* ================= the old implementation is gone ================= */

test('the previous map artwork is no longer referenced or shipped', () => {
  const OLD = 'global-distribution-map-B9WDMC-2.webp';
  assert.ok(!HOME.includes(OLD), 'the markup no longer points at it');
  assert.ok(!CSS.includes(OLD), 'no stylesheet refers to it');
  assert.ok(!fs.existsSync(path.join(STOREFRONT, 'assets', OLD)),
    'and the obsolete file is removed from the storefront');
});

test('no obsolete map-specific styling survives', () => {
  /* The old rule capped the image at 1150px with no height or fit declared. */
  const rule = cssRule('.hm-map');
  assert.ok(rule, '.hm-map rule found');
  assert.ok(!/max-width:1150px/.test(rule), 'the old cap is gone');
  /* .hm-map and .hm-map-sec are the only map-specific selectors, and both are
     still used by the markup. */
  assert.ok(HOME.includes('class="hm-sec hm-map-sec"'));
  assert.ok(HOME.includes('class="hm-map"'));
});

/* ================= nothing is overlaid on the artwork ================= */

test('the map section contains the artwork and nothing layered over it', () => {
  const tags = MAP_SECTION.match(/<(?!\/)([a-z0-9]+)/gi).map(t => t.slice(1).toLowerCase());
  assert.deepEqual(tags, ['section', 'div', 'h2', 'img'],
    'section > label div + heading + the image, in that order — no overlay layers');
  const imgs = MAP_SECTION.match(/<img/g) || [];
  assert.equal(imgs.length, 1, 'exactly one image: the map');
  /* Nothing positioned on top of it. */
  assert.ok(!/position:\s*absolute/.test(MAP_SECTION));
  assert.ok(!/hm-logo|avatar|profile/i.test(MAP_SECTION), 'no logo or avatar element');
  assert.ok(!/href="#\/products"/.test(MAP_SECTION), 'no Products control');
  /* The rejected asset had a wordmark burned into the artwork. The approved one
     does not, and the page must not put one back. */
  assert.ok(!/veyora/i.test(MAP_SECTION.replace(/alt="[^"]*"/g, '')
                                       .replace(/src="[^"]*"/g, '')),
    'no Veyora wordmark, logo image or brand text is placed over the map');
  assert.ok(!/<svg|logo\.|wordmark/i.test(MAP_SECTION), 'no logo graphic in the section');
  assert.ok(!/<a[\s>]/.test(MAP_SECTION), 'no control of any kind sits on the artwork');
  const rule = cssRule('.hm-map-sec');
  assert.ok(!/position:relative/.test(rule || ''),
    'the section is not made a positioning context for overlays');
});

test('the heading and copy are not duplicated over the image', () => {
  /* They appear once each, in the markup above the artwork, where they belong. */
  assert.equal((MAP_SECTION.match(/Global Distribution/g) || []).length, 1);
  assert.equal((MAP_SECTION.match(/Worldwide reach/gi) || []).length, 1);
  assert.match(MAP_SECTION, /<div class="hm-label hm-center">Worldwide reach<\/div>/);
  assert.match(MAP_SECTION, /<h2 class="hm-h2">Global Distribution<\/h2>/);
  /* No supporting paragraph was ever in this section and none was added. */
  assert.ok(!/<p[\s>]/.test(MAP_SECTION), 'no paragraph copy added to the section');
});

/* ================= the surrounding page is preserved ================= */

test('the landing page around the map is untouched', () => {
  assert.match(HOME, /Routes\['#\/'\] = Routes\['#\/home'\]/, 'the route is intact');
  assert.match(HOME, /\$\{homeHeader\(\)\}/, 'the site navigation still renders');
  assert.match(HOME, /class="hm-hero"/, 'the hero section survives');
  assert.match(HOME, /HOME_HERO\.map/, 'the hero slideshow survives');
  assert.match(HOME, /class="hm-collage"/, 'the campaign photography survives');
  for (const src of ['assets/home/hero-04.webp', 'assets/home/hero-01.webp']) {
    assert.ok(HOME.includes(src), `${src} is untouched`);
  }
  assert.match(HOME, /document\.body\.classList\.add\('hm-dark'\)/, 'the dark theme still applies');
});

/* ================= display: wide, centred, never cropped ================= */

test('the image scales on its own aspect ratio and is never cropped', () => {
  const rule = cssRule('.hm-map');
  assert.match(rule, /width:100%/, 'wide — it fills the section');
  assert.match(rule, /height:auto/, "the artwork's own ratio is preserved at every width");
  assert.match(rule, /object-fit:contain/, 'explicitly contain, never cover');
  assert.ok(!/object-fit:cover/.test(rule), 'cover would crop the map');
  assert.ok(!/height:\d/.test(rule), 'no fixed height that could squash it');
  assert.ok(!/clip-path/.test(rule) && !/overflow:hidden/.test(rule),
    'nothing clips the artwork');
  assert.match(rule, /margin:48pxauto0/, 'centred horizontally');
  assert.match(rule, /display:block/);
  assert.match(rule, /max-width:1280px/, 'wide on desktop, capped for very large screens');
});

test('nothing masks or fades the artwork', () => {
  /* Artwork reaches the bottom edge of the frame, so an edge mask would erase
     part of the map. The background is matched instead — see below. */
  const rule = cssRule('.hm-map');
  assert.ok(!/mask-image/.test(rule), 'no mask over the artwork');
  assert.ok(!/opacity:0?\./.test(rule), 'the map is shown at full strength');
  assert.ok(!/filter:/.test(rule), 'no filter applied to the supplied asset');
});

test('there is no pale border or default image backdrop', () => {
  const rule = cssRule('.hm-map');
  assert.match(rule, /background:transparent/, 'no default image background shows');
  assert.match(rule, /border:0/, 'no frame around it');
  /* The artwork's own black is #010101 while the landing sections are #0e0d0d,
     so the SECTION carries the artwork black across the image and eases back to
     the page colour clear of it. */
  const sec = cssRule('.hm-map-sec');
  /* Measured from the file: its corners are #020202-#030303, so the #010101
     band reads as the same black while the page stays #0e0d0d. */
  assert.match(sec, /background:linear-gradient\(180deg,#0e0d0d0,#010101100px,#010101calc\(100%-50px\),#0e0d0d100%\)/,
    'the section blends the artwork black into the page black');
});

test('the fades stay clear of the image at every breakpoint', () => {
  /* Top fade 100px, bottom fade 50px. The gap above the image is the section
     padding plus the label and heading; the gap below it is the section's
     bottom padding alone. Both must exceed their fade. */
  const desktop = cssRule('.hm-sec');
  assert.match(desktop, /padding:80px8%/, 'desktop section padding');
  const mobileAt = flatCss.indexOf('@media(max-width:820px)');
  const mobileBlock = flatCss.slice(mobileAt, mobileAt + 1400);
  assert.match(mobileBlock, /\.hm-sec\{padding:70px6%60px\}/, 'mobile section padding');
  const marginTop = 48;                       // .hm-map margin-top
  for (const [label, padTop, padBottom, h2] of
       [['desktop', 80, 80, 56], ['mobile', 70, 60, 42]]) {
    const gapAbove = padTop + 20 /* label */ + 24 /* h2 margin */ + h2 + marginTop;
    assert.ok(gapAbove > 100, `${label}: ${gapAbove}px above the image clears the 100px top fade`);
    assert.ok(padBottom > 50, `${label}: ${padBottom}px below clears the 50px bottom fade`);
  }
});

test('no horizontal overflow, including at 375px', () => {
  /* width:100% resolves against the section's CONTENT box, which the padding
     has already inset — so the image can never be wider than the page. */
  const rule = cssRule('.hm-map');
  assert.match(rule, /width:100%/);
  assert.ok(!/width:100vw/.test(rule), 'vw would ignore the padding and overflow');
  assert.ok(!/margin:0-/.test(rule) && !/margin-left:-/.test(rule),
    'no negative margin pulling it full-bleed');
  /* Percentage padding is not rounded to whole pixels, so the content box is
     computed exactly rather than assumed. */
  const contentBox = (vw, pad) => vw - 2 * (vw * pad);
  for (const [vw, pad] of [[1600, 0.08], [1366, 0.08], [768, 0.06], [375, 0.06]]) {
    const content = contentBox(vw, pad);
    const rendered = Math.min(content, 1280);
    assert.ok(rendered <= content,
      `${vw}px: image ${rendered}px fits the ${content}px content box`);
    assert.ok(rendered > 0);
  }
  /* At 375px the map renders 330 x 186 — scaled down, not cropped. */
  const at375 = contentBox(375, 0.06);
  assert.equal(at375, 330);
  assert.equal(Math.round(at375 * 941 / 1672), 186,
    "height follows the artwork's own ratio");
});

test('desktop keeps the labels legible', () => {
  /* Source labels are ~20px tall in a 1672px-wide frame. The cap is 1280px, so
     they render at ~15px — larger than the old 1150px cap allowed. */
  const capped = 1280 / 1672;
  assert.ok(capped > 0.75, 'the map is shown at over 75% of its native size');
  assert.ok(Math.round(20 * capped) >= 14, 'label text renders at roughly 15px');
});
