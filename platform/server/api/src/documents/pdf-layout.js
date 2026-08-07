/* PDF layout primitives (Final Handover, Phase 5).
 *
 * A thin, deliberate layer over pdf-lib: pages, a text cursor, wrapping,
 * truncation, and a table that knows how to break across pages.
 *
 * WHY THIS EXISTS RATHER THAN CALLING pdf-lib DIRECTLY
 *
 * pdf-lib draws text at a coordinate. It has no concept of "this cell is 90pt
 * wide, the value is a 60-character company name, and the row after it must
 * still line up". Every document in this codebase needs those three things,
 * and writing them once means an invoice and a statement lay out identically
 * rather than nearly.
 *
 * WHY THE FONT METRICS MATTER
 *
 * `font.widthOfTextAtSize()` is EXACT for the standard PDF fonts — pdf-lib
 * carries the AFM tables. That is the entire reason a dependency was taken
 * rather than hand-rolling a PDF writer as this repository does for XLSX: a
 * financial document that silently overflows a column because the text width
 * was estimated is a real defect, and glyph widths are exactly the part a
 * hand-rolled writer gets wrong.
 *
 * DETERMINISM
 *
 * Nothing here reads a clock, a random source or the filesystem. The caller
 * supplies every date. Two runs over the same data produce byte-identical
 * output, which is asserted.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/* A4 in points. Chosen over Letter because Veyora's registered identity is
   European; the page size is a single constant if that ever changes. */
export const PAGE = Object.freeze({ width: 595.28, height: 841.89 });
export const MARGIN = Object.freeze({ top: 48, right: 48, bottom: 56, left: 48 });

export const COLOR = Object.freeze({
  ink: rgb(0.17, 0.16, 0.16),
  muted: rgb(0.53, 0.51, 0.49),
  rule: rgb(0.85, 0.84, 0.82),
  band: rgb(0.96, 0.955, 0.945),
  accent: rgb(0.13, 0.12, 0.13),
  positive: rgb(0.18, 0.42, 0.25),
  warning: rgb(0.68, 0.36, 0.10),
  negative: rgb(0.60, 0.18, 0.14),
});

/**
 * A document under construction.
 *
 * `onNewPage` is called for every page including the first, so a running
 * header is defined once rather than repeated at each call site — the
 * difference between an invoice whose second page is labelled and one whose
 * second page is a mystery.
 */
export async function createDocument({ title, author, subject, creationDate, producer = 'Veyora' }) {
  const pdf = await PDFDocument.create();

  /* Every one of these is set explicitly. Left alone, pdf-lib stamps the
     current time, which would make two generations of an unchanged invoice
     differ — and "is this the same document I sent?" is a question a customer
     is entitled to answer by comparing files. */
  pdf.setTitle(String(title || ''));
  pdf.setAuthor(String(author || ''));
  pdf.setSubject(String(subject || ''));
  pdf.setProducer(producer);
  pdf.setCreator(producer);
  pdf.setCreationDate(creationDate);
  pdf.setModificationDate(creationDate);

  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    oblique: await pdf.embedFont(StandardFonts.HelveticaOblique),
  };

  return { pdf, fonts, pages: [] };
}

/** A cursor over one document. */
export function createCanvas(doc, { onNewPage = null } = {}) {
  let page = null;
  let y = 0;
  let pageNumber = 0;

  function newPage() {
    page = doc.pdf.addPage([PAGE.width, PAGE.height]);
    doc.pages.push(page);
    pageNumber += 1;
    y = PAGE.height - MARGIN.top;
    if (onNewPage) onNewPage(api, pageNumber);
    return page;
  }

  /** Ensures `height` points remain; starts a page if not. */
  function ensure(height) {
    if (!page) newPage();
    if (y - height < MARGIN.bottom) newPage();
    return page;
  }

  const contentWidth = PAGE.width - MARGIN.left - MARGIN.right;

  const api = {
    get page() { return page || newPage(); },
    get y() { return y; },
    set y(value) { y = value; },
    get pageNumber() { return pageNumber; },
    get pageCount() { return doc.pages.length; },
    contentWidth,
    fonts: doc.fonts,
    newPage,
    ensure,

    move(dy) { y -= dy; return api; },

    /** One line of text. Never wraps — use `paragraph` for that. */
    text(value, {
      x = MARGIN.left, size = 9.5, font = doc.fonts.regular, color = COLOR.ink,
      align = 'left', width = contentWidth, maxWidth = null, lineGap = 4,
    } = {}) {
      ensure(size + lineGap);
      /* Sanitised on BOTH branches. `truncate` folds internally, but the
         untruncated branch used to hand the raw string to
         `widthOfTextAtSize`, which THROWS on a character the standard font
         cannot encode — so one emoji in a customer's business name was a 500
         on their invoice download. */
      const shown = maxWidth
        ? truncate(value, font, size, maxWidth)
        : sanitize(value);
      const drawn = font.widthOfTextAtSize(shown, size);
      let drawX = x;
      if (align === 'right') drawX = x + width - drawn;
      else if (align === 'center') drawX = x + (width - drawn) / 2;
      api.page.drawText(shown, { x: drawX, y: y - size, size, font, color });
      y -= size + lineGap;
      return api;
    },

    /** Wrapped text. Returns the height consumed. */
    paragraph(value, {
      x = MARGIN.left, size = 9, font = doc.fonts.regular, color = COLOR.muted,
      width = contentWidth, lineGap = 3.5,
    } = {}) {
      const lines = wrap(String(value ?? ''), font, size, width);
      for (const line of lines) {
        ensure(size + lineGap);
        api.page.drawText(line, { x, y: y - size, size, font, color });
        y -= size + lineGap;
      }
      return lines.length * (size + lineGap);
    },

    rule({ x = MARGIN.left, width = contentWidth, thickness = 0.6, color = COLOR.rule, gap = 6 } = {}) {
      ensure(gap + thickness);
      y -= gap;
      api.page.drawLine({
        start: { x, y }, end: { x: x + width, y }, thickness, color,
      });
      y -= thickness;
      return api;
    },

    band({ x = MARGIN.left, width = contentWidth, height = 18, color = COLOR.band } = {}) {
      ensure(height);
      api.page.drawRectangle({ x, y: y - height, width, height, color });
      return api;
    },

    /** Draws at an absolute position without moving the cursor — for footers
     *  and running headers, which must not disturb the flow. */
    absolute(value, { x, yPos, size = 8, font = doc.fonts.regular, color = COLOR.muted, align = 'left', width = 0, maxWidth = null }) {
      /* Sanitised here too — this is the path the masthead and the party
         blocks use, which is where a customer's own free text lands. */
      const shown = maxWidth ? truncate(value, font, size, maxWidth) : sanitize(value);
      const drawn = font.widthOfTextAtSize(shown, size);
      let drawX = x;
      if (align === 'right') drawX = x + width - drawn;
      else if (align === 'center') drawX = x + (width - drawn) / 2;
      (page || newPage()).drawText(shown, { x: drawX, y: yPos, size, font, color });
    },
  };

  return api;
}

/* ---------------------------------------------------------------------------
   Text measurement
   --------------------------------------------------------------------------- */

/* pdf-lib's standard fonts are WinAnsi-encoded and throw on a character they
   cannot represent — an em dash is fine, an emoji is not. A customer's name or
   a note is free text, so it is folded to representable characters BEFORE
   measurement, or the width would be computed for a string that then fails to
   draw. */
const FOLD = new Map([
  ['‘', "'"], ['’', "'"], ['“', '"'], ['”', '"'],
  ['–', '-'], ['—', '-'], ['…', '...'], [' ', ' '],
  [' ', ' '], [' ', ' '], ['−', '-'],
]);

export function sanitize(value) {
  let out = '';
  for (const ch of String(value ?? '')) {
    if (FOLD.has(ch)) { out += FOLD.get(ch); continue; }
    const code = ch.codePointAt(0);
    /* Control characters go; anything outside WinAnsi becomes '?' rather than
       throwing. A mangled character on an invoice is a cosmetic problem; a
       500 on a customer's invoice download is not. */
    if (code < 0x20 || code === 0x7f) { out += ' '; continue; }
    out += code <= 0xff ? ch : '?';
  }
  return out;
}

export function measure(value, font, size) {
  return font.widthOfTextAtSize(sanitize(value), size);
}

/** Truncates with an ellipsis so a long value cannot run into the next column. */
export function truncate(value, font, size, maxWidth) {
  const clean = sanitize(value);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  const ellipsis = '...';
  const room = maxWidth - font.widthOfTextAtSize(ellipsis, size);
  if (room <= 0) return '';
  let low = 0;
  let high = clean.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (font.widthOfTextAtSize(clean.slice(0, mid), size) <= room) low = mid;
    else high = mid - 1;
  }
  return clean.slice(0, low) + ellipsis;
}

/** Greedy word wrap. A single word longer than the line is broken by
 *  character rather than left to overflow. */
export function wrap(value, font, size, maxWidth) {
  const clean = sanitize(value);
  if (clean === '') return [];
  const lines = [];
  for (const paragraph of clean.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      if (font.widthOfTextAtSize(word, size) <= maxWidth) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) { lines.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    }
    lines.push(line);
  }
  return lines;
}

/* ---------------------------------------------------------------------------
   Tables
   --------------------------------------------------------------------------- */

/**
 * Draws a table, breaking across pages and repeating the header.
 *
 * @param columns `[{ key, label, width, align, font }]`. Widths are points and
 *   must sum to at most the content width — asserted, because a table that
 *   silently overflows the page is the defect this whole layer exists to make
 *   impossible.
 */
export function drawTable(canvas, { columns, rows, size = 8.5, rowGap = 5, headerGap = 6 }) {
  const total = columns.reduce((sum, c) => sum + c.width, 0);
  if (total > canvas.contentWidth + 0.5) {
    throw new Error(`table columns total ${total.toFixed(1)}pt but the content width is ${canvas.contentWidth.toFixed(1)}pt`);
  }

  const drawHeader = () => {
    canvas.band({ height: size + headerGap + 2 });
    canvas.move(size + headerGap + 2);
    let x = MARGIN.left + 4;
    const headerY = canvas.y + headerGap - 1;
    for (const column of columns) {
      const label = sanitize(column.label);
      const width = column.width - 8;
      const drawn = canvas.fonts.bold.widthOfTextAtSize(label, size);
      const drawX = column.align === 'right' ? x + width - drawn : x;
      canvas.page.drawText(label, { x: drawX, y: headerY, size, font: canvas.fonts.bold, color: COLOR.ink });
      x += column.width;
    }
    canvas.move(2);
  };

  drawHeader();

  for (const row of rows) {
    /* Every cell is wrapped first, so the row's height is known BEFORE any of
       it is drawn. Drawing then discovering the row does not fit is how a
       table ends up with a header on one page and its first line on the next. */
    const cells = columns.map((column) => ({
      column,
      lines: wrap(String(row[column.key] ?? ''), column.font || canvas.fonts.regular, size, column.width - 8),
    }));
    const height = Math.max(1, ...cells.map((c) => c.lines.length)) * (size + 2.5) + rowGap;

    if (canvas.y - height < MARGIN.bottom) {
      canvas.newPage();
      drawHeader();
    }

    const top = canvas.y;
    let x = MARGIN.left + 4;
    for (const cell of cells) {
      const font = cell.column.font || canvas.fonts.regular;
      const width = cell.column.width - 8;
      let lineY = top - size;
      for (const line of cell.lines) {
        const drawn = font.widthOfTextAtSize(line, size);
        const drawX = cell.column.align === 'right' ? x + width - drawn : x;
        canvas.page.drawText(line, { x: drawX, y: lineY, size, font, color: cell.column.color || COLOR.ink });
        lineY -= size + 2.5;
      }
      x += cell.column.width;
    }
    canvas.y = top - height;
    canvas.page.drawLine({
      start: { x: MARGIN.left, y: canvas.y + rowGap / 2 },
      end: { x: MARGIN.left + canvas.contentWidth, y: canvas.y + rowGap / 2 },
      thickness: 0.4, color: COLOR.rule,
    });
  }
}

/** Serialises. `useObjectStreams: false` keeps the output stable and
 *  inspectable; the size difference on a two-page invoice is negligible. */
export async function finish(doc) {
  return Buffer.from(await doc.pdf.save({ useObjectStreams: false }));
}
