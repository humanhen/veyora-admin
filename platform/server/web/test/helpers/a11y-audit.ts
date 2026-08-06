/* The in-page accessibility and responsive audit (Fast-Track WS2 Phase 4).
 *
 * Exported as a STRING because it is evaluated inside the browser, not here.
 * Everything below runs against the real computed layout after the CSS cascade
 * and media queries have resolved — which is the only place the questions this
 * phase asks can actually be answered.
 *
 * It is not axe-core and does not claim to be. It implements the checks that
 * (a) matter for this site, (b) are decidable automatically, and (c) fail for
 * a real reason rather than a heuristic one. Automated checking finds roughly
 * a third of WCAG issues at best; the rest needs a person, and §7 of
 * 29_ACCESSIBILITY_AND_RESPONSIVE_QA.md says so plainly.
 *
 * Every finding carries a selector-ish description so a failure names the
 * element rather than the count.
 */

export const AUDIT_SOURCE = String.raw`
(() => {
  const findings = [];
  const add = (rule, detail, element) => findings.push({ rule, detail, element: element ? describe(element) : null });

  function describe(el) {
    if (!el || !el.tagName) return String(el);
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '');
  }

  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /* An element is off-screen-but-available (a skip link, a visually-hidden
     label) rather than invisible. Those must NOT be treated as decorative. */
  const offscreenButPresent = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.right < 0 || rect.bottom < 0 || rect.left > document.documentElement.scrollWidth;
  };

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const names = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => (n.textContent || '').trim())
        .filter(Boolean);
      if (names.length) return names.join(' ');
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (label && (label.textContent || '').trim()) return label.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping && (wrapping.textContent || '').trim()) return wrapping.textContent.trim();
    const text = (el.textContent || '').trim();
    if (text) return text;
    const img = el.querySelector('img[alt]');
    if (img && img.getAttribute('alt').trim()) return img.getAttribute('alt').trim();
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    if (el.tagName === 'INPUT' && el.getAttribute('type') === 'submit') return el.value || '';
    return '';
  };

  // ---- 1. horizontal overflow -------------------------------------------
  const docWidth = document.documentElement.scrollWidth;
  const viewportWidth = document.documentElement.clientWidth;
  if (docWidth > viewportWidth + 1) {
    add('horizontal-overflow', 'document scrollWidth ' + docWidth + ' exceeds viewport ' + viewportWidth);
    /* Name the culprits, not just the symptom. An element inside its own
       overflow-x:auto container is fine — that is a deliberate scroll
       region — so those are skipped. */
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || offscreenButPresent(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right <= viewportWidth + 1) continue;
      let scrollable = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ov = getComputedStyle(p).overflowX;
        if (ov === 'auto' || ov === 'scroll') { scrollable = true; break; }
      }
      if (scrollable) continue;
      if (el.children.length && el.getBoundingClientRect().width <= viewportWidth + 1) continue;
      add('horizontal-overflow-element', 'right edge at ' + Math.round(rect.right) + 'px', el);
    }
  }

  // ---- 2. document-level requirements ------------------------------------
  const html = document.documentElement;
  if (!html.getAttribute('lang')) add('html-lang', 'the document declares no language');
  if (!document.title || !document.title.trim()) add('document-title', 'the document has no title');

  const viewportMeta = document.querySelector('meta[name="viewport"]');
  if (!viewportMeta) {
    add('viewport-meta', 'no viewport meta tag — a phone will lay the page out at 980px');
  } else {
    const content = (viewportMeta.getAttribute('content') || '').toLowerCase();
    if (/user-scalable\s*=\s*(no|0)/.test(content)) add('viewport-zoom', 'user scaling is disabled: ' + content);
    const max = content.match(/maximum-scale\s*=\s*([\d.]+)/);
    if (max && Number(max[1]) < 2) add('viewport-zoom', 'maximum-scale below 2: ' + content);
  }

  // ---- 3. landmarks -------------------------------------------------------
  const mains = document.querySelectorAll('main, [role="main"]');
  if (mains.length === 0) add('landmark-main', 'the page has no main landmark');
  if (mains.length > 1) add('landmark-main', mains.length + ' main landmarks — there must be exactly one');
  if (!document.querySelector('header, [role="banner"]')) add('landmark-banner', 'no header landmark');
  if (!document.querySelector('footer, [role="contentinfo"]')) add('landmark-contentinfo', 'no footer landmark');
  const navs = [...document.querySelectorAll('nav, [role="navigation"]')];
  if (navs.length > 1) {
    for (const nav of navs) {
      if (!accessibleName(nav) && !nav.getAttribute('aria-label') && !nav.getAttribute('aria-labelledby')) {
        add('landmark-nav-name', 'multiple navigations, and this one has no accessible name', nav);
      }
    }
  }

  // ---- 4. headings --------------------------------------------------------
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
  const h1s = headings.filter((h) => h.tagName === 'H1');
  if (h1s.length !== 1) add('heading-h1', h1s.length + ' visible H1 elements — there must be exactly one');
  let previous = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName[1]);
    if (previous && level > previous + 1) {
      add('heading-order', 'jumps from h' + previous + ' to h' + level, heading);
    }
    previous = level;
  }
  for (const heading of headings) {
    if (!(heading.textContent || '').trim()) add('heading-empty', 'an empty heading', heading);
  }

  // ---- 5. images ----------------------------------------------------------
  for (const img of document.querySelectorAll('img')) {
    if (img.getAttribute('alt') === null) add('img-alt', 'no alt attribute at all', img);
  }

  // ---- 6. accessible names on interactive elements ------------------------
  for (const el of document.querySelectorAll('a[href], button, [role="button"], [role="link"]')) {
    if (!visible(el) && !offscreenButPresent(el)) continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (!accessibleName(el)) add('control-name', 'an interactive element with no accessible name', el);
  }

  // ---- 7. form controls ---------------------------------------------------
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden') continue;
    if (el.getAttribute('aria-hidden') === 'true') continue;
    if (!accessibleName(el)) add('field-label', 'a form field with no label or accessible name', el);
    /* A required field must say so in the accessibility tree, not only with a
       red asterisk. */
    if (el.hasAttribute('required') && el.getAttribute('aria-required') === 'false') {
      add('field-required', 'required, but aria-required="false"', el);
    }
  }
  const groups = document.querySelectorAll('fieldset');
  for (const group of groups) {
    if (!group.querySelector('legend')) add('fieldset-legend', 'a fieldset with no legend', group);
  }

  // ---- 8. duplicate ids and dangling references ---------------------------
  const seen = new Set();
  for (const el of document.querySelectorAll('[id]')) {
    if (seen.has(el.id)) add('duplicate-id', 'id "' + el.id + '" appears more than once', el);
    seen.add(el.id);
  }
  for (const attribute of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']) {
    for (const el of document.querySelectorAll('[' + attribute + ']')) {
      for (const id of (el.getAttribute(attribute) || '').split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(id)) add('dangling-aria-reference', attribute + ' points at missing id "' + id + '"', el);
      }
    }
  }
  for (const label of document.querySelectorAll('label[for]')) {
    if (!document.getElementById(label.getAttribute('for'))) {
      add('dangling-label', 'label[for] points at missing id "' + label.getAttribute('for') + '"', label);
    }
  }

  // ---- 9. tab order -------------------------------------------------------
  for (const el of document.querySelectorAll('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) {
      add('positive-tabindex', 'tabindex="' + el.getAttribute('tabindex') + '" overrides document order', el);
    }
  }

  // ---- 10. skip link ------------------------------------------------------
  const focusables = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
    .filter((el) => el.getAttribute('tabindex') !== '-1');
  const first = focusables[0];
  if (!first || first.tagName !== 'A' || !/^#/.test(first.getAttribute('href') || '')) {
    add('skip-link', 'the first focusable element is not an in-page skip link', first || null);
  } else if (!document.getElementById(first.getAttribute('href').slice(1))) {
    add('skip-link-target', 'the skip link points at a missing target: ' + first.getAttribute('href'), first);
  }

  // ---- 11. tap targets ----------------------------------------------------
  /* WCAG 2.2 AA 2.5.8 Target Size (Minimum): 24 x 24 CSS pixels, with an
     explicit exception for links inside a sentence of text. Both are
     implemented; the exception is why prose links are skipped rather than
     the threshold being lowered to make the page pass. */
  const MIN = 24;
  for (const el of document.querySelectorAll('a[href], button, input[type="submit"], input[type="button"], [role="button"]')) {
    if (!visible(el)) continue;
    const inSentence = el.tagName === 'A' && el.parentElement
      && /^(P|LI|SPAN|TD|DD|DT|BLOCKQUOTE)$/.test(el.parentElement.tagName)
      && getComputedStyle(el).display === 'inline';
    if (inSentence) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN || rect.height < MIN) {
      add('tap-target', Math.round(rect.width) + 'x' + Math.round(rect.height) + ' is under ' + MIN + 'x' + MIN, el);
    }
  }

  // ---- 12. text contrast --------------------------------------------------
  /* Computed colour against the nearest ancestor with an opaque background.
     Elements over a background image or gradient are SKIPPED and counted, not
     guessed at — a contrast figure invented against an unknown backdrop is
     worse than an honest gap, and the count is reported so the gap is
     visible. */
  let contrastSkipped = 0;
  let contrastMeasured = 0;
  const skipReasons = { translucentText: 0, backgroundImage: 0, noOpaqueBackground: 0 };

  const parseColor = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const channel = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const hasOwnText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 1);

  for (const el of document.querySelectorAll('body *')) {
    if (!hasOwnText(el) || !visible(el) || offscreenButPresent(el)) continue;
    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    if (!fg) { contrastSkipped += 1; skipReasons.translucentText += 1; continue; }

    let bg = null;
    let unknown = false;
    for (let p = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.backgroundImage && s.backgroundImage !== 'none') { unknown = true; break; }
      const c = parseColor(s.backgroundColor);
      if (c && c.a >= 0.95) { bg = c; break; }
    }
    if (unknown) { contrastSkipped += 1; skipReasons.backgroundImage += 1; continue; }
    if (!bg) { contrastSkipped += 1; skipReasons.noOpaqueBackground += 1; continue; }

    /* A translucent text colour is not unmeasurable — it is composited over
       the background, which is exactly what the browser paints and what a
       reader sees. This site uses rgba text colours for most of its body copy,
       so treating translucency as "cannot measure" would have skipped 62% of
       the text on the site and called the remaining 38% a contrast audit.
       Alpha-blend first, then measure the result. */
    const painted = fg.a >= 0.999 ? fg : {
      r: fg.a * fg.r + (1 - fg.a) * bg.r,
      g: fg.a * fg.g + (1 - fg.a) * bg.g,
      b: fg.a * fg.b + (1 - fg.a) * bg.b,
    };

    contrastMeasured += 1;
    const size = parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    const actual = ratio(painted, bg);
    if (actual < required) {
      /* The RESOLVED background is reported, not the element's own (which is
         almost always transparent and tells a reader nothing). */
      const bgText = 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')';
      add('contrast', actual.toFixed(2) + ':1 (' + style.color + ' over ' + bgText
        + '), needs ' + required + ':1 at ' + Math.round(size) + 'px/' + weight, el);
    }
  }

  // ---- 13. legible text size ---------------------------------------------
  /* Two thresholds, because they mean different things. Below 10px is
     effectively unreadable and is treated as a defect. Between 10px and 12px
     is a typographic decision — this site uses uppercase letter-spaced micro
     labels, a normal editorial pattern that happens to sit at the edge — and
     is reported separately so a design decision is not disguised as a bug. */
  for (const el of document.querySelectorAll('body *')) {
    if (!hasOwnText(el) || !visible(el) || offscreenButPresent(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 10) add('font-size-illegible', Math.round(size * 10) / 10 + 'px text', el);
    else if (size < 12) add('font-size-small', Math.round(size * 10) / 10 + 'px text', el);
  }

  return {
    findings,
    stats: {
      url: location.pathname,
      viewportWidth,
      /* Both are reported. clientWidth excludes a classic scrollbar and is the
         right thing to measure overflow against; innerWidth includes it and is
         the right thing to check the emulation against. Conflating them makes a
         15px scrollbar look like a 15px layout defect.
         (No backticks anywhere in this file below the export: it is a
         String.raw template, and a backtick would end it.) */
      innerWidth: window.innerWidth,
      documentWidth: docWidth,
      headings: headings.length,
      images: document.querySelectorAll('img').length,
      controls: document.querySelectorAll('a[href], button, input, select, textarea').length,
      contrastMeasured,
      contrastSkipped,
      contrastSkipReasons: skipReasons,
    },
  };
})()
`;
