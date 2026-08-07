/* ============ Veyora storefront — icon system ============

   One source of truth for every icon that stands in for a word.

   WHY THIS EXISTS. The portal used emoji as functional controls: 🛒 for the
   cart, 👤 for the account, 🗑 to remove a line, 📷 to upload. An emoji is not
   an icon. It renders in the operating system's own colour and shape, so it
   ignores the surrounding design entirely; it changes appearance between
   Windows, macOS, Android and iOS; a screen reader announces its CLDR name
   ("wastebasket", "bust in silhouette") rather than what the control does; and
   on a wholesale ordering system aimed at opticians it reads as consumer chat,
   not as trade software.

   HOUSE STYLE, matching the SVG already hand-written across these pages:
   24×24 viewBox, no fill, `stroke="currentColor"`, 1.7 stroke, round caps and
   joins. `currentColor` is the important one — an icon inherits the colour of
   the control it sits in, so it works on the dark topbar and on a white card
   without a second copy.

   ACCESSIBILITY. Every icon is `aria-hidden="true"` and `focusable="false"`:
   it is decoration sitting inside a control that carries its own accessible
   name from a `title`, an `aria-label` or its visible text. An icon that
   announced itself would double up with that name, which is worse than
   silence. A control that has no text MUST still carry an aria-label — the
   suite asserts it. */
'use strict';

/* Path data only. Every entry is drawn on the same 24×24 grid, so they line up
   optically at any size without per-icon nudging. */
const ICON_PATHS = Object.freeze({
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>'
      + '<path d="M2 3h2.6l2.2 11.2a1.6 1.6 0 0 0 1.6 1.3h8.9a1.6 1.6 0 0 0 1.6-1.3L21 7H5.2"/>',
  user: '<path d="M20 21v-1.8a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4V21"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M16 21v-1.8a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V21"/><circle cx="9" cy="7" r="3.6"/>'
       + '<path d="M22 21v-1.8a4 4 0 0 0-3-3.8M16 3.3a4 4 0 0 1 0 7.4"/>',
  heart: '<path d="M20.3 5.6a5 5 0 0 0-7.1 0L12 6.8l-1.2-1.2a5 5 0 0 0-7.1 7.1l1.2 1.2L12 21l7.1-7.1 1.2-1.2a5 5 0 0 0 0-7.1z"/>',
  receipt: '<path d="M5 3.5h14v17l-2.3-1.6-2.3 1.6-2.4-1.6-2.3 1.6L7.3 19 5 20.5z"/>'
         + '<path d="M9 8h6M9 12h6M9 16h3"/>',
  trash: '<path d="M3.5 6h17M9 6V4.2A1.2 1.2 0 0 1 10.2 3h3.6A1.2 1.2 0 0 1 15 4.2V6"/>'
       + '<path d="M18.2 6l-.8 13.1a1.8 1.8 0 0 1-1.8 1.7H8.4a1.8 1.8 0 0 1-1.8-1.7L5.8 6"/>'
       + '<path d="M10 10.5v6M14 10.5v6"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  pencil: '<path d="M12 20h8"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5l-4 1 1-4z"/>',
  repeat: '<path d="M17 2.5l3.5 3.5L17 9.5"/><path d="M3.5 12V10a4 4 0 0 1 4-4h13"/>'
        + '<path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 12v2a4 4 0 0 1-4 4h-13"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.2l2.8 2.8L16 9.5"/>',
  camera: '<path d="M22 18.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.8-2.6h6.4L17 7h3a2 2 0 0 1 2 2z"/>'
        + '<circle cx="12" cy="13.5" r="3.6"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="10" r="1.6"/>'
       + '<path d="M21 15.5l-4.6-4.3L5.5 19.5"/>',
  expand: '<path d="M14.5 3.5H20.5V9.5"/><path d="M9.5 20.5H3.5V14.5"/><path d="M20.5 3.5l-7 7"/><path d="M3.5 20.5l7-7"/>',
  paperclip: '<path d="M20.5 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l9.2-9.2a3.4 3.4 0 0 1 4.8 4.8l-9.2 9.2a1.7 1.7 0 0 1-2.4-2.4l8.5-8.5"/>',
  fileText: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>'
          + '<path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  glasses: '<circle cx="6" cy="14.5" r="3.6"/><circle cx="18" cy="14.5" r="3.6"/>'
         + '<path d="M9.6 14.5q2.4-1.7 4.8 0"/><path d="M2.4 14.5L1.6 9M21.6 14.5l.8-5.5"/>',
  package: '<path d="M20.5 7.6v8.8a1.7 1.7 0 0 1-.9 1.5l-7 3.9a1.7 1.7 0 0 1-1.7 0l-7-3.9a1.7 1.7 0 0 1-.9-1.5V7.6"/>'
         + '<path d="M3.4 7.3l8.6 4.7 8.6-4.7"/><path d="M12 12v9.4"/>'
         + '<path d="M11.2 2.3l-7 3.8a1.7 1.7 0 0 0 0 3l7 3.8a1.7 1.7 0 0 0 1.6 0l7-3.8a1.7 1.7 0 0 0 0-3l-7-3.8a1.7 1.7 0 0 0-1.6 0z"/>',
  link: '<path d="M10 13a4.5 4.5 0 0 0 6.8.5l2.7-2.7a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5"/>'
      + '<path d="M14 11a4.5 4.5 0 0 0-6.8-.5l-2.7 2.7a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.9-4.9"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  gift: '<path d="M3.5 11.5h17V20a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 20z"/>'
      + '<rect x="2.5" y="7.5" width="19" height="4"/><path d="M12 7.5v14"/>'
      + '<path d="M12 7.5H7.8a2.4 2.4 0 1 1 0-4.8C10.5 2.7 12 7.5 12 7.5z"/>'
      + '<path d="M12 7.5h4.2a2.4 2.4 0 1 0 0-4.8C13.5 2.7 12 7.5 12 7.5z"/>',
  undo: '<path d="M3.5 8.5h11a5.5 5.5 0 0 1 0 11H8"/><path d="M7.5 4L3.5 8.5 7.5 13"/>',
  alert: '<path d="M10.3 3.9L1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
       + '<path d="M12 9.5v4M12 17.4h.01"/>',
  trendUp: '<path d="M22 7l-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  star: '<path d="M12 2.8l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.6l6.5-.9z"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="M11.5 5.5L5 12l6.5 6.5"/>',
  currency: '<circle cx="12" cy="12" r="9"/><path d="M15 8.5H10.6a2.1 2.1 0 0 0 0 4.2h2.8a2.1 2.1 0 0 1 0 4.2H9"/>'
          + '<path d="M12 6.4v1.9M12 15.7v1.9"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6.8V12l3.4 2"/>',

  /* Navigation. These were a second hand-written registry (`NAVICON`) until
     this batch; they live here now so there is one place to change an icon. */
  home: '<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/>'
      + '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34 1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/>',
  bag: '<path d="M6 7h12l1 14H5L6 7z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
  burger: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  caretRight: '<path d="M9 5l7 7-7 7"/>',
  orders: '<rect x="3" y="4.5" width="18" height="16" rx="2"/>'
        + '<path d="M3 9.5h18M8 4.5v5M16 4.5v5"/><path d="M8 14h8M8 17.2h5"/>',
});

/**
 * An inline SVG icon.
 *
 * @param {string} name  a key of ICON_PATHS
 * @param {object} [opt] `size` in px (default 18), `cls` for an extra class,
 *                       `filled` to paint the shape rather than stroke it —
 *                       used for the ON state of a toggle such as a favourite.
 * @returns {string} SVG markup, or '' for an unknown name.
 *
 * An unknown name returns EMPTY rather than a placeholder glyph. A missing
 * icon should look like a mistake, not like a different icon.
 */
function icon(name, opt = {}) {
  const paths = ICON_PATHS[name];
  if (!paths) return '';
  const size = Number(opt.size) || 18;
  const cls = opt.cls ? ` class="${opt.cls}"` : '';
  const fill = opt.filled ? 'currentColor' : 'none';
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}"`
    + ` stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`
    + ` aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** The large mark an empty state is built around. Same icons, quieter. */
function emptyIcon(name) {
  return icon(name, { size: 34, cls: 'empty-ic' });
}

/**
 * A nav icon: no width/height, so the nav's own CSS sizes it.
 *
 * The bottom nav sizes its icons responsively and the topbar sizes them
 * differently again, which is why these omit the attributes rather than
 * picking a number that both then have to override.
 */
function navIcon(name) {
  return icon(name).replace(/ width="\d+" height="\d+"/, '');
}

/* Exposed for the tests, which assert every name is reachable and that no
   call site asks for one that does not exist. A function rather than a bare
   const because a `const` at the top level of a plain browser script is not a
   property of the global object, so a sandbox could not otherwise see it. */
function iconNames() {
  return Object.keys(ICON_PATHS);
}
