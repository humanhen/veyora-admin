/* Report generation for the catalogue audit (B2.4C1).

   JSON and CSV, written with Node built-ins only — no CSV library, no
   spreadsheet library.

   CSV is a hostile format and this module treats it as one:

     - commas, quotes and line breaks are quoted and escaped per RFC 4180;
     - a leading `=`, `+`, `-`, `@`, tab or carriage return is NEUTRALISED,
       because a spreadsheet will otherwise interpret the cell as a formula.
       A field like `=cmd|'/c calc'!A1` in a catalogue export becomes remote
       code execution the moment a reviewer opens the report in Excel. The
       neutralisation prefixes a single quote, which Excel and LibreOffice
       both treat as "this is text" and do not display.

   Writing refuses to overwrite by default. These reports are the input to a
   human review; silently replacing yesterday's file with today's would
   destroy the annotations someone made against it. */

import fs from 'node:fs';
import path from 'node:path';

/* ---------------------------------------------------------------------------
   CSV
   --------------------------------------------------------------------------- */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** One CSV cell, safe for both RFC 4180 parsers and spreadsheet applications. */
export function csvCell(value) {
  let text;
  if (value === null || value === undefined) text = '';
  else if (Array.isArray(value)) text = value.join('; ');
  else if (typeof value === 'boolean') text = value ? 'true' : 'false';
  else text = String(value);

  /* Formula neutralisation happens BEFORE quoting, so the guard character is
     inside the quoted field where a parser will return it as data. */
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;

  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** A whole CSV document. CRLF line endings, as RFC 4180 specifies. */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => csvCell(c.header ?? c.key)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(c.value ? c.value(row) : row[c.key])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------------------------
   Report definitions
   --------------------------------------------------------------------------- */

const READINESS_COLUMNS = [
  { key: 'productId', header: 'product_id' },
  { key: 'sku', header: 'sku' },
  { key: 'name', header: 'name' },
  { key: 'outcome', header: 'outcome' },
  { key: 'brandClassification', header: 'brand_classification' },
  { key: 'proposedBrandId', header: 'proposed_brand_id' },
  { key: 'proposedSlug', header: 'proposed_public_slug' },
  { key: 'variationCount', header: 'variation_count' },
  { key: 'usableVariationCount', header: 'usable_variation_count' },
  { key: 'mediaCount', header: 'media_count' },
  { header: 'reason_codes', value: (r) => r.reasonCodes.join('; ') },
];

const CHANGE_COLUMNS = [
  { key: 'recordType', header: 'record_type' },
  { key: 'recordId', header: 'record_id' },
  { key: 'field', header: 'field' },
  { key: 'currentValue', header: 'current_value' },
  { key: 'proposedValue', header: 'proposed_value' },
  { key: 'reasonCode', header: 'reason_code' },
  { key: 'confidence', header: 'confidence' },
  { key: 'requiresHumanApproval', header: 'requires_human_approval' },
  { header: 'depends_on', value: (r) => r.dependsOn.join('; ') },
  { key: 'note', header: 'note' },
];

const BRAND_COLUMNS = [
  { key: 'originalValue', header: 'source_brand_value' },
  { key: 'comparisonKey', header: 'comparison_key' },
  { key: 'classification', header: 'classification' },
  { key: 'proposedBrandId', header: 'proposed_brand_id' },
  { key: 'proposedBrandName', header: 'proposed_brand_name' },
  { key: 'proposedBrandSlug', header: 'proposed_brand_slug' },
  { key: 'productCount', header: 'product_count' },
  { key: 'requiresHumanApproval', header: 'requires_human_approval' },
  { header: 'spelling_variants', value: (r) => r.spellingVariants.map((v) => `${v.value} (${v.productCount})`).join('; ') },
  { header: 'notes', value: (r) => r.notes.join(' ') },
];

const INTEGRITY_COLUMNS = [
  { key: 'code', header: 'code' },
  { key: 'recordType', header: 'record_type' },
  { header: 'record_ids', value: (r) => r.recordIds.join('; ') },
  { key: 'field', header: 'field' },
  { key: 'message', header: 'message' },
];

/* ---------------------------------------------------------------------------
   Assembly
   --------------------------------------------------------------------------- */

/** The complete set of artefacts, as strings. Writing is a separate step so
    the whole report can be built and asserted without touching a disk. */
export function buildReports(audit) {
  const summary = {
    tool: 'audit-public-catalogue',
    mode: 'DRY_RUN',
    mutationsPerformed: 0,
    contractVersion: audit.contractVersion,
    input: { source: audit.input.source, exportedAt: audit.input.exportedAt },
    counts: audit.summary,
    guarantees: [
      'No database was contacted.',
      'No record was created, updated, deleted or published.',
      'No SQL was generated.',
      'No publication or verification state was proposed.',
      'No description, source reference, review date or media was invented.',
    ],
  };

  const detail = {
    ...summary,
    readiness: audit.classifications,
    brandMapping: audit.mapping.entries,
    integrity: audit.integrity,
    plan: {
      changes: audit.plan.changes,
      missing: audit.plan.missingByRecord,
      newBrands: audit.plan.newBrands,
    },
    brandSlugCollisions: audit.brandSlugCollisions,
  };

  return [
    { name: 'summary.json', content: JSON.stringify(summary, null, 2) + '\n' },
    { name: 'audit-detail.json', content: JSON.stringify(detail, null, 2) + '\n' },
    { name: 'product-readiness.csv', content: toCsv(READINESS_COLUMNS, audit.classifications) },
    { name: 'proposed-changes.csv', content: toCsv(CHANGE_COLUMNS, audit.plan.changes) },
    { name: 'brand-mapping-review.csv', content: toCsv(BRAND_COLUMNS, audit.mapping.entries) },
    { name: 'integrity-findings.csv', content: toCsv(INTEGRITY_COLUMNS, audit.integrity) },
  ];
}

export class ReportWriteError extends Error {
  constructor(message, { code, file } = {}) {
    super(message);
    this.name = 'ReportWriteError';
    this.code = code ?? 'WRITE_FAILED';
    this.file = file ?? null;
  }
}

/**
 * Writes the artefacts into `outputDir`.
 *
 * Refuses to overwrite unless `overwrite` is true, and checks EVERY target
 * before writing ANY of them — a half-written report set is worse than none,
 * because a reviewer cannot tell which files are current.
 */
export function writeReports(outputDir, reports, { overwrite = false } = {}) {
  if (typeof outputDir !== 'string' || outputDir.trim() === '') {
    throw new ReportWriteError('An output directory is required.', { code: 'NO_OUTPUT_DIR' });
  }
  const dir = path.resolve(outputDir);

  if (!overwrite) {
    const existing = reports
      .map((r) => path.join(dir, r.name))
      .filter((file) => fs.existsSync(file));
    if (existing.length) {
      throw new ReportWriteError(
        `Refusing to overwrite ${existing.length} existing file(s). Use --overwrite to replace them.`,
        { code: 'WOULD_OVERWRITE', file: existing[0] }
      );
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const report of reports) {
    const file = path.join(dir, report.name);
    fs.writeFileSync(file, report.content, 'utf8');
    written.push(file);
  }
  return written;
}
