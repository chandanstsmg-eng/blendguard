/**
 * Reads an SAP-style PROCESS ORDER sheet (PDF with real text, not a scan):
 *
 *   Process Order 1369327   Plant K104   Resource …   Start Date 06.10.2026   Finish Date 07.10.2026
 *   Material 4410000145 OTTO ROSE 029 A   Batch 4413760375   Order Quantity 15.000 KG
 *   Sale Order 1200048049   Inspection Lot …   Reservation 69750575   Order Type ZP29   Plan Delivery Date 15.09.2026
 *   MATERIAL INPUT
 *   Material Code | Description | Storage Location | Batch | Req Qty | UoM | Actual Qty | UoM
 *
 * The header is read label by label; the MATERIAL INPUT table by the x position
 * of its column headings (falling back to a pattern per line). What was read is
 * always shown to the supervisor for checking and correcting before use.
 */
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ROOT } from '../config.js';
import { badRequest } from '../utils/errors.js';
import { emptyProcessOrder, type ProcessOrderHeader } from '../../shared/types.js';

export interface PdfLine {
  code: string;
  description: string;
  storageLocation: string;
  batch: string;
  quantity: string;
  unit: string;
}

export interface PdfOrder {
  header: ProcessOrderHeader;
  lines: PdfLine[];
  warnings: string[];
}

interface Cell {
  x: number;
  end: number;
  text: string;
}

const MAX_PAGES = 20;

/** Text of every page as lines of cells (top to bottom, left to right). */
async function readCells(data: Uint8Array): Promise<Cell[][]> {
  let pdf;
  try {
    pdf = await getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      standardFontDataUrl: path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep,
      verbosity: 0,
    }).promise;
  } catch {
    throw badRequest('This file could not be opened as a PDF.', 'PDF_UNREADABLE');
  }
  if (pdf.numPages > MAX_PAGES) throw badRequest(`The PDF has more than ${MAX_PAGES} pages.`, 'PDF_TOO_LONG');
  const out: Cell[][] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const items = (content.items as { str?: string; transform?: number[]; width?: number }[])
      .filter((i) => typeof i.str === 'string' && i.str.trim() && i.transform)
      .map((i) => ({ x: i.transform![4], y: i.transform![5], w: i.width ?? 0, text: i.str!.replace(/\s+/g, ' ').trim() }));
    // Group into lines: items whose baselines are within 3 units.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: { y: number; items: typeof items }[] = [];
    for (const it of items) {
      const line = lines.find((l) => Math.abs(l.y - it.y) <= 3);
      if (line) line.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      // Pieces of one word or phrase printed separately are joined back into one cell.
      const cells: Cell[] = [];
      for (const it of l.items) {
        const last = cells.at(-1);
        if (last && it.x - last.end < 2.5) {
          last.text += (it.x - last.end > 0.8 ? ' ' : '') + it.text;
          last.end = it.x + it.w;
        } else cells.push({ x: it.x, end: it.x + it.w, text: it.text });
      }
      out.push(cells);
    }
    page.cleanup();
  }
  await pdf.destroy();
  return out;
}

// ───────────────────────────── header ─────────────────────────────

const LABELS: [keyof ProcessOrderHeader | 'orderQuantityRaw' | 'materialRaw', RegExp][] = [
  ['processOrder', /^process\s*order(\s*(no\.?|number))?$/i],
  ['plant', /^plant$/i],
  ['resource', /^resource$/i],
  ['startDate', /^start\s*date$/i],
  ['finishDate', /^finish\s*date$/i],
  ['materialRaw', /^material$/i],
  ['batch', /^batch$/i],
  ['orderQuantityRaw', /^order\s*quantity$/i],
  ['saleOrder', /^sales?\s*order$/i],
  ['inspectionLot', /^inspection\s*lot$/i],
  ['reservation', /^reservation$/i],
  ['orderType', /^order\s*type$/i],
  ['planDeliveryDate', /^plan(ned)?\s*delivery\s*date$/i],
];
type HeaderKey = (typeof LABELS)[number][0];

/** A label starting at cells[i] (it may be split over up to 3 cells, or share a cell with its value). */
function labelAt(cells: string[], i: number): { key: HeaderKey; used: number; rest: string } | null {
  for (let n = 3; n >= 1; n--) {
    if (i + n > cells.length) continue;
    const text = cells.slice(i, i + n).join(' ').trim();
    for (const [key, re] of LABELS) if (re.test(text)) return { key, used: n, rest: '' };
  }
  for (const [key, re] of LABELS) {
    const src = re.source.replace(/^\^/, '').replace(/\$$/, '');
    const m = new RegExp(`^(${src})\\s*:?\\s+(.+)$`, 'i').exec(cells[i]);
    if (m) return { key, used: 1, rest: m[m.length - 1] };
  }
  return null;
}

function readHeader(lines: Cell[][]): ProcessOrderHeader {
  const raw: Partial<Record<HeaderKey, string>> = {};
  for (const line of lines) {
    const cells = line.map((c) => c.text);
    let current: HeaderKey | null = null;
    for (let i = 0; i < cells.length; ) {
      const label = labelAt(cells, i);
      if (label) {
        current = label.key;
        raw[current] ??= '';
        if (label.rest) raw[current] = `${raw[current]} ${label.rest}`.trim();
        i += label.used;
        continue;
      }
      if (current) raw[current] = `${raw[current] ?? ''} ${cells[i].replace(/^:\s*/, '')}`.trim();
      i++;
    }
  }
  const h = emptyProcessOrder();
  for (const [k, v] of Object.entries(raw)) if (k in h) (h as unknown as Record<string, string>)[k] = (v ?? '').slice(0, 80);
  // "4410000145 OTTO ROSE 029 A" → material code + description.
  const mat = (raw.materialRaw ?? '').trim();
  const mm = /^([A-Za-z0-9][A-Za-z0-9._/-]*)\s*(.*)$/.exec(mat);
  if (mm) {
    h.material = mm[1].slice(0, 40);
    h.materialDescription = mm[2].trim().slice(0, 80);
  }
  // "15.000 KG" → quantity + unit. Spaces inside the number are kept ("1 250.000") so the
  // check flags them, instead of the quantity being cut short at the space.
  const qm = /^([\d.,\s]*\d[\d.,]*)\s*([A-Za-z]+)?/.exec((raw.orderQuantityRaw ?? '').trim());
  if (qm) {
    h.orderQuantity = qm[1];
    h.orderUom = (qm[2] ?? '').toUpperCase();
  }
  return h;
}

// ───────────────────────────── MATERIAL INPUT table ─────────────────────────────

const STOP = /^(material\s*output|total|prepared\s*by|checked\s*by|approved\s*by|signature|page\s*\d|remarks?\b|note\b|by[- ]?products?|packing)/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,}$/;
// Loose on purpose: any number-like token is taken whole ("0,500", "1.250,000") so the
// import check can refuse an ambiguous format instead of this reader dropping or cutting it.
const QTY = /^\d[\d.,]*$/;
const UNIT = /^(KG|G|GM|GRAM|GRAMS|MG|L|ML|LTR|EA|PC|PCS|NOS)$/i;

type Col = 'code' | 'description' | 'storageLocation' | 'batch' | 'quantity' | 'unit' | 'actual' | 'actualUnit';

/** Column start positions from the heading row(s). */
function columns(head: Cell[]): { col: Col; x: number }[] | null {
  const cols: { col: Col; x: number }[] = [];
  const find = (re: RegExp, after = -Infinity) => head.find((c) => re.test(c.text) && c.x > after);
  const code = find(/^material(\s*code)?$|^(item|component|material)\s*(code|no\.?)$/i);
  const desc = find(/^(material\s*)?desc(ription)?\.?$/i);
  const req = find(/^req(uired)?\.?(\s*qty\.?|\s*quantity)?$/i);
  if (!code || !desc || !req) return null;
  cols.push({ col: 'code', x: code.x }, { col: 'description', x: desc.x });
  const storage = find(/^(storage|stor\.?)(\s*loc(ation)?\.?)?$/i, desc.x);
  if (storage) cols.push({ col: 'storageLocation', x: storage.x });
  const batch = find(/^batch$/i, desc.x);
  if (batch) cols.push({ col: 'batch', x: batch.x });
  cols.push({ col: 'quantity', x: req.x });
  const uom = find(/^(uom|unit)$/i, req.x);
  if (uom) cols.push({ col: 'unit', x: uom.x });
  const actual = find(/^actual(\s*qty\.?)?$/i, req.x);
  if (actual) {
    cols.push({ col: 'actual', x: actual.x });
    const uom2 = find(/^(uom|unit)$/i, actual.x);
    if (uom2) cols.push({ col: 'actualUnit', x: uom2.x });
  }
  return cols.sort((a, b) => a.x - b.x);
}

function readTable(lines: Cell[][], warnings: string[]): PdfLine[] {
  const start = lines.findIndex((l) => /material\s*input/i.test(l.map((c) => c.text).join(' ')));
  // Without the MATERIAL INPUT title, look for the heading row itself.
  const headIdx = lines.findIndex((l, i) => i > start && columns(l) != null);
  let cols = headIdx >= 0 ? columns(lines[headIdx]) : null;
  // Headings printed over two lines ("Req" / "Qty"): merge with the next line.
  let bodyFrom = headIdx + 1;
  if (cols && headIdx + 1 < lines.length) {
    const merged = columns([...lines[headIdx], ...lines[headIdx + 1]]);
    const nextIsHeading = lines[headIdx + 1].every((c) => !QTY.test(c.text) && !/^\d{4,}$/.test(c.text));
    if (merged && nextIsHeading) {
      cols = merged;
      bodyFrom = headIdx + 2;
    }
  }

  const out: PdfLine[] = [];
  const first = cols ? bodyFrom : Math.max(0, start + 1);
  for (const line of lines.slice(first)) {
    const text = line.map((c) => c.text).join(' ').trim();
    if (STOP.test(text)) break;
    if (cols) {
      const row: Partial<Record<Col, string>> = {};
      for (const c of line) {
        let col: Col = cols[0].col;
        for (const k of cols) if (c.x >= k.x - 4) col = k.col;
        row[col] = `${row[col] ?? ''} ${c.text}`.trim();
      }
      if (row.code && CODE.test(row.code.split(' ')[0]) && row.quantity) {
        const [code, ...descStart] = row.code.split(' ');
        // The whole cell is the quantity (a unit printed inside it is split off): "1 250.000"
        // must reach the check as written, not as "1".
        const q = row.quantity.split(' ');
        const unitInCell = q.length > 1 && UNIT.test(q.at(-1)!) ? q.pop()! : '';
        out.push({
          code,
          description: [descStart.join(' '), row.description ?? ''].join(' ').trim(),
          storageLocation: row.storageLocation ?? '',
          batch: row.batch ?? '',
          quantity: q.join(' '),
          unit: (row.unit ?? unitInCell).toUpperCase(),
        });
      } else if (out.length && !row.code && !row.quantity && row.description) {
        // A description that wrapped onto the next line.
        out.at(-1)!.description = `${out.at(-1)!.description} ${row.description}`.trim();
      }
      continue;
    }
    // Fallback: "4410000145 Rose Oil Bulgarian 1000 4413760375 1.250 KG".
    const tokens = text.split(/\s+/);
    const qi = tokens.findIndex((t, i) => i > 0 && QTY.test(t) && UNIT.test(tokens[i + 1] ?? ''));
    if (qi > 0 && CODE.test(tokens[0]) && /\d/.test(tokens[0])) {
      // "… 1 250.000 KG": a 1–3 digit group right before a 3-digit quantity is a space thousands
      // separator; keep it with the quantity so the check refuses it rather than reading 250.
      const split = qi > 1 && /^\d{1,3}$/.test(tokens[qi - 1]) && /^\d{3}(\D|$)/.test(tokens[qi]);
      const from = split ? qi - 1 : qi;
      out.push({ code: tokens[0], description: tokens.slice(1, from).join(' '), storageLocation: '', batch: '', quantity: tokens.slice(from, qi + 1).join(' '), unit: tokens[qi + 1].toUpperCase() });
    }
  }
  if (!cols && out.length) warnings.push('The MATERIAL INPUT column headings were not recognised; storage location and batch could not be read. Please check every line.');
  return out;
}

export async function readProcessOrderPdf(data: Uint8Array): Promise<PdfOrder> {
  if (data.length < 5 || String.fromCharCode(...data.slice(0, 5)) !== '%PDF-') throw badRequest('This file is not a PDF.', 'PDF_UNREADABLE');
  const lines = await readCells(data);
  const warnings: string[] = [];
  if (!lines.length) {
    throw badRequest('No text found in this PDF. It looks like a scanned image; please upload the PDF printed from SAP (or a CSV).', 'PDF_NO_TEXT');
  }
  const tableAt = lines.findIndex((l) => /material\s*input/i.test(l.map((c) => c.text).join(' ')));
  const header = readHeader(tableAt >= 0 ? lines.slice(0, tableAt) : lines.slice(0, 12));
  const items = readTable(lines, warnings);
  if (!header.processOrder) warnings.push('Process order number not found in the PDF. Please type it in.');
  return { header, lines: items, warnings };
}
