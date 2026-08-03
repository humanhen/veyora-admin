/* ================= Minimal XLSX reader (dependency-free) =================

   Batch 1K. The credential workbook has to be read on the operator's own
   Windows machine and nowhere else, so the reader must not drag a parser into
   the API image — `npm ci --omit=dev` builds production and a spreadsheet
   library has no business being there.

   This handles the shape Excel and Google Sheets actually emit for a simple
   single-sheet workbook: a ZIP of XML with shared strings, inline strings,
   numbers and formula results. It deliberately does NOT try to be a general
   spreadsheet library — no styles, no dates-as-serials interpretation, no
   multi-sheet selection beyond the first sheet. Anything it cannot read it
   REFUSES loudly rather than returning half a workbook, because a silently
   short read here would look like "these customers weren't in the file".

   If a real workbook ever defeats it, prepare-credential-migration.mjs will use
   ExcelJS instead when it is installed locally (npm i -D exceljs). Nothing in
   this file, or in that fallback, ever runs on the server.                    */
'use strict';

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** Read a ZIP central directory and return {name: Buffer} for every entry. */
function unzip(buf) {
  if (buf.length < 22) throw new Error('not a zip file (too short)');
  /* The end-of-central-directory record is last, but a trailing comment may
     follow it, so scan backwards for the signature. */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    /* The local header repeats the name and extra fields, and its extra length
       often differs from the central one — read it rather than assuming. */
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, zlib.inflateRawSync(raw));
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
  }
  return files;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = XML_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** All <t> text inside a fragment, concatenated (rich text arrives split). */
function textOf(fragment) {
  let out = '';
  for (const m of fragment.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

/** "BC12" -> 0-based column index 54. */
export function columnIndex(ref) {
  const letters = String(ref).match(/^[A-Z]+/i);
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read the FIRST worksheet of an xlsx buffer.
 * @returns {{ headers: string[], rows: string[][], sheetName: string }}
 *          Every cell is returned as a trimmed string; empty cells are ''.
 */
export function readXlsx(buffer) {
  const files = unzip(buffer);

  const sharedXml = files.get('xl/sharedStrings.xml');
  const shared = [];
  if (sharedXml) {
    for (const m of sharedXml.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      shared.push(textOf(m[1]));
    }
  }

  /* First sheet in workbook order, not alphabetical file order. */
  let sheetPath = null, sheetName = '';
  const wb = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = wb.toString('utf8').match(/<sheet\b[^>]*\/?>/);
    if (first) {
      sheetName = decodeXml((first[0].match(/name="([^"]*)"/) || [, ''])[1]);
      const rid = (first[0].match(/r:id="([^"]*)"/) || [])[1];
      if (rid) {
        const rel = rels.toString('utf8')
          .match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`));
        const target = rel && (rel[0].match(/Target="([^"]*)"/) || [])[1];
        if (target) sheetPath = target.startsWith('/')
          ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
      }
    }
  }
  if (!sheetPath || !files.has(sheetPath)) {
    sheetPath = [...files.keys()].find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  }
  if (!sheetPath) throw new Error('no worksheet found in workbook');

  const sheet = files.get(sheetPath).toString('utf8');
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rIndex = parseInt((rm[1].match(/\br="(\d+)"/) || [, '0'])[1], 10);
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const col = columnIndex((attrs.match(/\br="([A-Z]+)\d+"/i) || [, 'A'])[1]);
      const type = (attrs.match(/\bt="([^"]*)"/) || [, 'n'])[1];
      let value = '';
      if (type === 's') {
        const idx = parseInt(textOfV(body), 10);
        value = Number.isFinite(idx) ? (shared[idx] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else if (type === 'str') {
        value = decodeXml(textOfV(body));
      } else {
        value = textOfV(body);      // number / boolean / date serial, as text
      }
      cells[col] = String(value).trim();
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    /* r="7" on the row means blank rows above were omitted — keep the
       positions so a reported "source row" matches what the operator sees. */
    if (rIndex > 0) rows[rIndex - 1] = cells;
    else rows.push(cells);
  }
  for (let i = 0; i < rows.length; i++) if (rows[i] === undefined) rows[i] = [];

  const headers = (rows.shift() || []).map(h => String(h || '').trim());
  return { headers, rows, sheetName };
}

function textOfV(body) {
  const m = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
  return m ? decodeXml(m[1]) : '';
}
