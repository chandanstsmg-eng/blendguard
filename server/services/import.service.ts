/**
 * Production instruction upload (spec §5, option 2: soft copy). The supervisor
 * uploads a CSV or a PROCESS ORDER PDF, sees a preview with every problem
 * flagged, corrects it on screen and approves it. Approval creates an APPROVED
 * formula revision that can be assigned straight away. The original file is
 * kept with the revision.
 *
 * CSV layout (a template is offered on screen):
 *
 *   Perfume Name,Oud Royale          ← optional detail rows (key,value)
 *   Formula Code,FR-OUD-210
 *   Revision,C
 *   SOP Number,SOP-PB-014
 *   Seq,Ingredient Code,Quantity,Unit,Tolerance Minus,Tolerance Plus,Remarks
 *   1,RM-1001,220,g,1,1,
 *   …
 *
 * A PROCESS ORDER PDF (see process-order.service) is read into the same draft:
 * header details, ingredient lines with storage location and batch, ±1%
 * tolerance, and a "goes for lab test" tick per line. The formula code is the
 * material number and the revision is the process order number.
 *
 * Quantities and tolerances use the row's unit (mg, g or kg) and are converted
 * to whole milligrams without floating point. Every check runs on the server,
 * again, on whatever the supervisor corrected.
 */
import { db } from '../db/prisma.js';
import { badRequest, conflict } from '../utils/errors.js';
import { audit, type Actor } from './audit.service.js';
import { readProcessOrderPdf } from './process-order.service.js';
import type { ProcessOrderHeader } from '../../shared/types.js';
import { acceptanceWindow } from '../../shared/weighing.js';

export interface ImportMeta {
  perfumeName: string;
  code: string;
  revision: string;
  sopNumber: string;
}

/** One ingredient line as read from the file (or corrected on screen), before checking. */
export interface DraftLine {
  row: number;
  seq: string;
  ingredientCode: string;
  /** Description printed on the process order (shown next to the ingredient list name). */
  description: string | null;
  quantity: string;
  unit: string;
  tolMinus: string;
  tolPlus: string;
  remarks: string | null;
  storageLocation: string | null;
  sourceBatch: string | null;
  /** Goes for lab test: skipped by default when the job is assigned, added at the end. */
  labTest: boolean;
}

export interface Draft {
  meta: ImportMeta;
  processOrder: ProcessOrderHeader | null;
  lines: DraftLine[];
  /** Notes from reading the file itself. */
  readWarnings?: string[];
}

export interface ImportLine extends DraftLine {
  seqNo: number | null;
  ingredientName: string | null;
  targetMg: number | null;
  tolMinusMg: number | null;
  tolPlusMg: number | null;
  errors: string[];
  warnings: string[];
}

export interface ImportPreview {
  meta: ImportMeta;
  processOrder: ProcessOrderHeader | null;
  lines: ImportLine[];
  errors: string[];
  warnings: string[];
  batchSizeMg: number;
  ok: boolean;
}

/** RFC 4180-ish: quoted fields, doubled quotes, comma / semicolon / tab delimiters. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

const UNIT_MG: Record<string, bigint> = { mg: 1n, g: 1000n, gm: 1000n, gram: 1000n, grams: 1000n, kg: 1_000_000n };

/**
 * Reads a non-negative amount written with a dot as the decimal point, as SAP
 * prints it ("1.250", "0.400", "25.000"). Commas are only accepted as
 * thousands separators when a decimal dot follows ("1,250.000"). Anything that
 * could be read two ways is refused rather than guessed: "0,500" (half or
 * five hundred?), "1.250,000", "1 250.000" (a space would otherwise cut it to 1).
 */
export function parseAmount(value: string): { ok: true; plain: string } | { ok: false; error: string } {
  const v = value.trim();
  if (!v) return { ok: false, error: 'is empty' };
  if (/\s/.test(v)) return { ok: false, error: 'has a space inside the number. Write it without spaces, e.g. 1250.000' };
  if (/^\d{1,3}(,\d{3})+\.\d+$/.test(v)) return { ok: true, plain: v.replace(/,/g, '') };
  if (v.includes(',')) return { ok: false, error: 'uses a comma, which could be a decimal comma or a thousands separator. Use a dot for decimals, e.g. 0.500' };
  if (!/^\d+(\.\d+)?$/.test(v)) return { ok: false, error: 'is not a plain number' };
  return { ok: true, plain: v };
}

/** A line error that says why an amount could not be read. */
function amountError(what: string, value: string) {
  const p = parseAmount(value);
  return p.ok ? `${what} "${value}" is finer than 1 mg.` : `${what} "${value}" ${p.error}.`;
}

/** "12.345" g → 12345 mg, exactly. Null when not a valid amount (see parseAmount) or not a whole mg. */
export function toMg(value: string, unit: string): number | null {
  const per = UNIT_MG[unit.trim().toLowerCase()];
  const parsed = parseAmount(value);
  if (!per || !parsed.ok) return null;
  const [int, frac = ''] = parsed.plain.split('.');
  const scale = 10n ** BigInt(frac.length);
  const num = BigInt(int + frac) * per;
  if (num % scale !== 0n) return null;
  const mg = num / scale;
  return mg > 2_000_000_000n ? null : Number(mg);
}

/** Exact decimal text for a whole number of mg in a unit: 12345 mg → "12.345" (g). */
export function mgToUnit(mg: number, unit: string): string {
  const per = UNIT_MG[unit.trim().toLowerCase()];
  if (!per) return '';
  const digits = per.toString().length - 1;
  const v = BigInt(mg);
  const frac = digits ? (v % per).toString().padStart(digits, '0').replace(/0+$/, '') : '';
  return frac ? `${v / per}.${frac}` : `${v / per}`;
}

/** ±1% of the quantity (at least 1 mg), in the line's unit. */
export function defaultTolerance(quantity: string, unit: string): string {
  const mg = toMg(quantity, unit);
  return mg == null ? '' : mgToUnit(Math.max(1, Math.round(mg / 100)), unit);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const META_KEYS: Record<string, keyof ImportMeta> = {
  perfumename: 'perfumeName', perfume: 'perfumeName', product: 'perfumeName', productname: 'perfumeName',
  formulacode: 'code', formula: 'code', formulano: 'code', formulanumber: 'code',
  revision: 'revision', rev: 'revision', version: 'revision',
  sopnumber: 'sopNumber', sop: 'sopNumber', sopno: 'sopNumber',
};
const COLS: Record<string, string> = {
  seq: 'seq', sequence: 'seq', step: 'seq', no: 'seq', sno: 'seq',
  ingredientcode: 'code', code: 'code', materialcode: 'code', rmcode: 'code', ingredient: 'code', material: 'code',
  quantity: 'qty', qty: 'qty', requiredquantity: 'qty', target: 'qty', weight: 'qty', reqqty: 'qty',
  unit: 'unit', uom: 'unit',
  toleranceminus: 'tolMinus', tolminus: 'tolMinus', minus: 'tolMinus', tolerancelow: 'tolMinus',
  toleranceplus: 'tolPlus', tolplus: 'tolPlus', plus: 'tolPlus', tolerancehigh: 'tolPlus',
  tolerance: 'tol', tol: 'tol',
  remarks: 'remarks', remark: 'remarks', notes: 'remarks', note: 'remarks',
  storagelocation: 'storage', storage: 'storage',
  batch: 'batch',
  labtest: 'lab', lab: 'lab',
};

export function csvToDraft(csv: string): Draft & { tableFound: boolean } {
  const rows = parseCsv(csv);
  const meta: ImportMeta = { perfumeName: '', code: '', revision: '', sopNumber: '' };
  const headerIdx = rows.findIndex((r) => {
    const keys = r.map((c) => COLS[norm(c)]);
    return keys.includes('code') && keys.includes('qty');
  });
  for (const r of rows.slice(0, Math.max(0, headerIdx))) {
    const key = META_KEYS[norm(r[0] ?? '')];
    if (key && r[1]) meta[key] = r[1].slice(0, 80);
  }
  const header = headerIdx >= 0 ? rows[headerIdx].map((c) => COLS[norm(c)] ?? '') : [];
  const col = (r: string[], k: string) => {
    const i = header.indexOf(k);
    return i >= 0 ? (r[i] ?? '').trim() : '';
  };
  const body = headerIdx >= 0 ? rows.slice(headerIdx + 1) : [];
  const lines: DraftLine[] = body.slice(0, 301).map((r, i) => {
    const both = col(r, 'tol');
    return {
      row: headerIdx + 2 + i,
      seq: col(r, 'seq') || String(i + 1),
      ingredientCode: col(r, 'code').toUpperCase(),
      description: null,
      quantity: col(r, 'qty'),
      // No default unit: a quantity without one must be checked, not assumed.
      unit: col(r, 'unit'),
      tolMinus: col(r, 'tolMinus') || both,
      tolPlus: col(r, 'tolPlus') || both,
      remarks: col(r, 'remarks').slice(0, 200) || null,
      storageLocation: col(r, 'storage') || null,
      sourceBatch: col(r, 'batch') || null,
      labTest: /^(y|yes|true|1|x|lab)$/i.test(col(r, 'lab')),
    };
  });
  return { meta, processOrder: null, lines, tableFound: headerIdx >= 0 };
}

/** Reads a PROCESS ORDER PDF into a draft (±1% tolerance, nothing ticked for lab yet). */
export async function pdfToDraft(pdf: Uint8Array): Promise<Draft> {
  const o = await readProcessOrderPdf(pdf);
  return {
    meta: {
      perfumeName: (o.header.materialDescription || o.header.material).slice(0, 80),
      code: o.header.material,
      revision: o.header.processOrder.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 20),
      sopNumber: '',
    },
    processOrder: o.header,
    lines: o.lines.slice(0, 301).map((l, i) => {
      // A line without a unit stays without one and is flagged; never assume KG.
      const unit = l.unit;
      const tol = defaultTolerance(l.quantity, unit);
      return {
        row: i + 1,
        seq: String(i + 1),
        ingredientCode: l.code.toUpperCase(),
        description: l.description || null,
        quantity: l.quantity,
        unit,
        tolMinus: tol,
        tolPlus: tol,
        remarks: null,
        storageLocation: l.storageLocation || null,
        sourceBatch: l.batch || null,
        labTest: false,
      };
    }),
    readWarnings: o.warnings,
  };
}

export async function previewImport(csv: string, override: Partial<ImportMeta> = {}): Promise<ImportPreview> {
  const draft = csvToDraft(csv);
  return checkDraft(draft, override, draft.tableFound);
}

export async function previewPdf(pdf: Uint8Array): Promise<ImportPreview> {
  return checkDraft(await pdfToDraft(pdf));
}

/** Every check on a draft, whether it came from a CSV, a PDF or the supervisor's corrections. */
export async function checkDraft(draft: Draft, override: Partial<ImportMeta> = {}, tableFound = true): Promise<ImportPreview> {
  const fromPdf = !!draft.processOrder;
  const errors: string[] = [];
  const warnings: string[] = [...(draft.readWarnings ?? [])];
  const meta: ImportMeta = { ...draft.meta };
  for (const [k, v] of Object.entries(override) as [keyof ImportMeta, string | undefined][]) if (v != null) meta[k] = v.trim().slice(0, 80);

  if (!tableFound) errors.push('No ingredient table found. The file needs a header row with at least "Ingredient Code" and "Quantity" columns.');
  else if (!draft.lines.length) errors.push(fromPdf ? 'No ingredients found in the MATERIAL INPUT table of this PDF.' : 'The ingredient table is empty.');
  if (draft.lines.length > 300) errors.push('Too many rows (more than 300).');

  const codes = [...new Set(draft.lines.map((l) => l.ingredientCode.trim().toUpperCase()).filter(Boolean))];
  const ingredients = await db().ingredient.findMany({ where: { code: { in: codes, mode: 'insensitive' } }, select: { code: true, name: true } });
  const byCode = new Map(ingredients.map((i) => [i.code.toUpperCase(), i]));

  // The strictest scale on the floor: a line must be weighable on any station it may be assigned to.
  const stations = await db().station.findMany({ select: { scaleResolutionMg: true, scaleUncertaintyMg: true } });
  const strictest = stations.length
    ? { resolutionMg: Math.max(...stations.map((s) => s.scaleResolutionMg)), uncertaintyMg: Math.max(...stations.map((s) => s.scaleUncertaintyMg)) }
    : null;

  const seen = new Map<number, number>();
  const seenCode = new Map<string, number>();
  const lines: ImportLine[] = draft.lines.slice(0, 300).map((d, i) => {
    const rowNo = d.row;
    const e: string[] = [];
    const w: string[] = [];
    const code = d.ingredientCode.trim().toUpperCase();
    const unit = d.unit.trim();
    const seqRaw = d.seq.trim();
    const seq = seqRaw ? (/^\d{1,3}$/.test(seqRaw) ? Number(seqRaw) : null) : i + 1;
    if (seq == null || seq < 1) e.push(`Sequence "${seqRaw}" is not a whole number.`);
    else if (seen.has(seq)) e.push(`Sequence ${seq} appears twice (also row ${seen.get(seq)}).`);
    else seen.set(seq, rowNo);

    const ing = code ? byCode.get(code) : undefined;
    if (!code) e.push(`${fromPdf ? 'Material code' : 'Ingredient code'} is missing.`);
    else if (!ing) e.push(`${fromPdf ? 'Material' : 'Ingredient'} "${code}" is not in the ingredient list. Add it under Setup → Ingredients first.`);
    if (code && seenCode.has(code)) w.push(`${code} is also on row ${seenCode.get(code)}.`);
    else if (code) seenCode.set(code, rowNo);

    if (!unit) e.push('Unit is missing (use mg, g or kg).');
    else if (!UNIT_MG[unit.toLowerCase()]) e.push(`Unit "${unit}" is not supported (use mg, g or kg).`);
    const qty = d.quantity.trim();
    const targetMg = UNIT_MG[unit.toLowerCase()] ? toMg(qty, unit) : null;
    if (UNIT_MG[unit.toLowerCase()] && targetMg == null) e.push(amountError('Quantity', qty));
    else if (targetMg === 0) e.push('Quantity is zero.');

    const minus = d.tolMinus.trim();
    const plus = d.tolPlus.trim();
    const tolMinusMg = minus && UNIT_MG[unit.toLowerCase()] ? toMg(minus, unit) : null;
    const tolPlusMg = plus && UNIT_MG[unit.toLowerCase()] ? toMg(plus, unit) : null;
    if (!minus || !plus) e.push('Tolerance is missing. Every line needs a minus and plus tolerance.');
    else if (tolMinusMg == null || tolPlusMg == null) {
      if (UNIT_MG[unit.toLowerCase()]) e.push(amountError('Tolerance', tolMinusMg == null ? minus : plus));
    } else if (tolMinusMg === 0 || tolPlusMg === 0) e.push('Tolerance cannot be zero. No scale can certify an exact amount.');
    else if (targetMg != null && tolMinusMg >= targetMg) e.push('Minus tolerance is as large as the quantity.');
    else if (targetMg != null && strictest) {
      // Minimum weighable quantity: after the guard band and rounding to scale divisions some reading must still pass.
      const win = acceptanceWindow({ targetMg, tolMinusMg, tolPlusMg }, strictest);
      if (!win.certifiable) {
        e.push(`Too small to weigh: the tolerance is narrower than the scale can certify (guard band ${win.guardMg} mg, scale division ${strictest.resolutionMg} mg). Ask for a wider tolerance or a larger quantity.`);
      }
    }

    return {
      ...d,
      row: rowNo,
      seq: seqRaw,
      seqNo: seq,
      ingredientCode: code,
      description: d.description?.trim().slice(0, 120) || null,
      quantity: qty,
      unit,
      tolMinus: minus,
      tolPlus: plus,
      remarks: d.remarks?.trim().slice(0, 200) || null,
      storageLocation: d.storageLocation?.trim().slice(0, 40) || null,
      sourceBatch: d.sourceBatch?.trim().slice(0, 40) || null,
      labTest: !!d.labTest,
      ingredientName: ing?.name ?? null,
      targetMg,
      tolMinusMg,
      tolPlusMg,
      errors: e,
      warnings: w,
    };
  });
  lines.sort((a, b) => (a.seqNo ?? 999) - (b.seqNo ?? 999));
  const seqs = lines.map((l) => l.seqNo).filter((s): s is number => s != null);
  if (seqs.length && seqs.some((s, i) => s !== i + 1)) warnings.push('Sequence numbers are not 1, 2, 3… without gaps. They will be renumbered in this order.');

  if (!meta.perfumeName) errors.push(fromPdf ? 'Material description (product name) is missing.' : 'Perfume name is missing.');
  if (!meta.code) errors.push(fromPdf ? 'Material number is missing.' : 'Formula code is missing.');
  else if (!/^[A-Za-z0-9._-]{2,40}$/.test(meta.code)) errors.push('Formula code may only use letters, numbers, dot and dash.');
  if (!meta.revision) errors.push(fromPdf ? 'Process order number is missing.' : 'Revision is missing.');
  else if (!/^[A-Za-z0-9._-]{1,20}$/.test(meta.revision)) errors.push('Revision may only use letters, numbers, dot and dash (up to 20).');
  if (meta.code && meta.revision) {
    const dup = await db().formula.findUnique({ where: { code_revision: { code: meta.code, revision: meta.revision } }, select: { status: true } });
    if (dup) errors.push(fromPdf ? `Process order ${meta.revision} for material ${meta.code} has already been uploaded.` : `Formula ${meta.code} rev ${meta.revision} already exists. Use a new revision.`);
    const current = await db().formula.findFirst({ where: { code: meta.code, status: 'APPROVED' }, select: { revision: true } });
    if (current && !dup) warnings.push(`Approving replaces rev ${current.revision} for new jobs. Jobs already assigned keep their revision.`);
  }
  if (lines.length && lines.every((l) => l.labTest)) errors.push('At least one ingredient must not go for lab test, so the operator can start.');

  const batchSizeMg = lines.reduce((s, l) => s + (l.targetMg ?? 0), 0);

  // The lines must add up to the order: catches a misread decimal or unit on any one line.
  const po = draft.processOrder;
  const orderQty = po?.orderQuantity?.trim() ?? '';
  if (po && orderQty) {
    const orderUnit = (po.orderUom ?? '').trim();
    if (!orderUnit) errors.push('Order Quantity has no unit. Type the unit (KG, G or MG) in the process order details.');
    else if (!UNIT_MG[orderUnit.toLowerCase()]) warnings.push(`Order Quantity is in ${orderUnit}; the ingredient total could not be compared with it.`);
    else {
      const orderMg = toMg(orderQty, orderUnit);
      if (orderMg == null) errors.push(amountError('Order Quantity', orderQty));
      else if (lines.length && lines.every((l) => l.targetMg != null)) {
        // Within 0.5 %, in whole mg: |sum − order| × 200 ≤ order.
        if (Math.abs(batchSizeMg - orderMg) * 200 > orderMg) {
          errors.push(`The ingredient quantities add up to ${mgToUnit(batchSizeMg, orderUnit)} ${orderUnit}, but the Order Quantity is ${orderQty} ${orderUnit} (more than 0.5% apart). Check every quantity and unit.`);
        }
      }
    }
  }

  const ok = !errors.length && lines.length > 0 && lines.every((l) => !l.errors.length);
  return { meta, processOrder: draft.processOrder, lines, errors, warnings, batchSizeMg, ok };
}

/** Creates an approved formula revision from a CSV upload. Re-validates everything server-side. */
export async function approveImport(actor: Actor, fileName: string, csv: string, meta: ImportMeta) {
  const draft = csvToDraft(csv);
  return approveDraft(actor, fileName, await checkDraft(draft, meta, draft.tableFound), { csv });
}

/** Creates an approved formula revision from a checked draft (CSV or PDF, possibly corrected on screen). */
export async function approveDraft(actor: Actor, fileName: string, p: ImportPreview, source: { csv?: string; pdf?: Uint8Array }) {
  if (!p.ok) throw badRequest('The upload still has problems. Fix them and upload again.', 'IMPORT_INVALID', { errors: p.errors, lines: p.lines.filter((l) => l.errors.length).map((l) => ({ row: l.row, errors: l.errors })) });

  const ingredients = await db().ingredient.findMany({ where: { code: { in: p.lines.map((l) => l.ingredientCode), mode: 'insensitive' } }, select: { id: true, code: true } });
  const idOf = new Map(ingredients.map((i) => [i.code.toUpperCase(), i.id]));
  const now = new Date();
  try {
    const f = await db().$transaction(async (tx) => {
      const superseded = await tx.formula.updateMany({ where: { code: p.meta.code, status: 'APPROVED' }, data: { status: 'SUPERSEDED' } });
      const created = await tx.formula.create({
        data: {
          code: p.meta.code,
          revision: p.meta.revision,
          perfumeName: p.meta.perfumeName,
          sopNumber: p.meta.sopNumber || null,
          status: 'APPROVED',
          batchSizeMg: p.batchSizeMg,
          sourceFileName: fileName.slice(0, 200),
          // The CSV as uploaded; for a PDF, what was approved (after any on-screen corrections).
          sourceFile: source.csv ?? JSON.stringify({ meta: p.meta, processOrder: p.processOrder, lines: p.lines.map(({ errors, warnings, ...l }) => l) }),
          sourcePdf: source.pdf ? Buffer.from(source.pdf) : null,
          processOrder: p.processOrder ? { ...p.processOrder } : undefined,
          importedById: actor.userId,
          approvedById: actor.userId,
          approvedAt: now,
          lines: {
            create: p.lines.map((l, i) => ({
              seq: i + 1,
              ingredientId: idOf.get(l.ingredientCode)!,
              targetMg: l.targetMg!,
              tolMinusMg: l.tolMinusMg!,
              tolPlusMg: l.tolPlusMg!,
              remarks: l.remarks,
              storageLocation: l.storageLocation,
              sourceBatch: l.sourceBatch,
              uom: l.unit.toUpperCase(),
              labTest: l.labTest,
            })),
          },
        },
      });
      await audit(tx, {
        type: 'FORMULA_IMPORTED', outcome: 'SUCCESS', ...actor, newState: 'APPROVED',
        details: {
          formulaId: created.id, formula: `${p.meta.code} rev ${p.meta.revision}`, perfumeName: p.meta.perfumeName, sopNumber: p.meta.sopNumber || null, fileName,
          lines: p.lines.length, batchSizeMg: p.batchSizeMg, supersededRevisions: superseded.count,
          source: source.pdf ? 'PDF' : 'CSV', processOrder: p.processOrder?.processOrder ?? null, labTest: p.lines.filter((l) => l.labTest).map((l) => l.ingredientCode),
        },
      });
      return created;
    });
    return { id: f.id, code: f.code, revision: f.revision, perfumeName: f.perfumeName, labSeqs: p.lines.map((l, i) => (l.labTest ? i + 1 : 0)).filter(Boolean) };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw conflict(`Formula ${p.meta.code} rev ${p.meta.revision} already exists.`, 'DUPLICATE_FORMULA');
    throw err;
  }
}

export const TEMPLATE_CSV = [
  'Perfume Name,',
  'Formula Code,',
  'Revision,',
  'SOP Number,',
  'Seq,Ingredient Code,Quantity,Unit,Tolerance Minus,Tolerance Plus,Remarks,Lab Test',
  '1,RM-1001,220,g,1,1,,',
  '2,RM-1002,160,g,0.5,0.5,,',
  '3,RM-1007,2.5,g,0.05,0.05,Use a dropper,yes',
].join('\r\n');
