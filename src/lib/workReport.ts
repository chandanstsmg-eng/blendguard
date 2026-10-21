/**
 * The batch record as a PDF. Jobs from a process order follow the plant's
 * PROCESS ORDER layout (company block, process order header, MATERIAL INPUT
 * with required and actual quantities); other jobs print as a BATCH RECORD
 * with the job's own header. Both continue with the weighing record, lab
 * ingredients, problems, the supervisor's decision and signatures.
 *
 * The operator downloads it at the end of a job; the supervisor opens the same
 * report as the final report. The letterhead comes from the server's
 * configuration (COMPANY_* in .env); a logo at public/company-logo.png (PNG) is
 * printed top right, otherwise the company name is printed in its place.
 */
import type { jsPDF } from 'jspdf';
import type { RowInput } from 'jspdf-autotable';
import type { BatchStatus, RunState, RunStep, SessionUser, StationInfo } from '@shared/types';
import { api } from './api';
import { fmtSeconds, g, qtyInUnit } from './utils';

/** Letterhead served by GET /api/company. */
export interface Company {
  name: string;
  address: string[];
  docNo: string;
}

/** Extra details the supervisor's final report adds. Everything but the heading is optional. */
export interface ReportExtras {
  heading: string;
  lab?: Record<number, { skippedBy: string | null; releasedBy: string | null }>;
  submittedBy?: string | null;
  assignedBy?: string | null;
  assignedAt?: string | null;
  /** The scale the batch was weighed on, and the daily check that covered it. */
  scale?: { model: string; checkedAt: string | null; checkedBy: string | null; validUntil: string | null } | null;
  decision?: { kind: 'APPROVED' | 'REJECTED'; by: string | null; at: string; note: string | null } | null;
  /** Who resolved each problem, by deviation id. */
  resolvedBy?: Record<string, string | null>;
}

type ReportPerson = Pick<SessionUser, 'name' | 'operatorCode'>;
type ReportStation = Pick<StationInfo, 'name' | 'code' | 'scaleResolutionMg'>;

let companyRequest: Promise<Company | null> | null = null;

/** The plant's letterhead, fetched once per page load. */
export function loadCompany(): Promise<Company | null> {
  companyRequest ??= api.get<Company>('/company').catch(() => {
    companyRequest = null;
    return null;
  });
  return companyRequest;
}

const BRAND: [number, number, number] = [217, 82, 26];
const LAB_FILL: [number, number, number] = [251, 239, 211];
const GRID: [number, number, number] = [120, 120, 120];
const BAND: [number, number, number] = [230, 230, 230];
const WARN_INK: [number, number, number] = [138, 90, 0];

export const STATUS_TEXT: Record<BatchStatus, string> = {
  ASSIGNED: 'Not started',
  IN_PROGRESS: 'In progress',
  PAUSED: 'Paused',
  ON_HOLD: 'On hold',
  AWAITING_SUBMISSION: 'Done, not sent yet',
  AWAITING_LAB: 'Waiting for lab ingredient',
  SUBMITTED: 'Pending approval',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CORRECTION: 'Sent back for correction',
};

const PROBLEM_TEXT: Record<string, string> = { OVERWEIGHT: 'Too much poured', VESSEL_CHANGED: 'Container weight changed', OTHER: 'Other' };
const RESOLUTION_TEXT: Record<string, string> = {
  EXCESS_REMOVED_REWEIGH: 'Excess removed, re-weighed',
  EXCESS_REMOVED_BY_OPERATOR: 'Excess taken out by the operator, correct weight saved',
  VESSEL_WEIGHT_ACCEPTED: 'Container weight accepted',
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A problem and how it was resolved, in plain words, from the deviation's
 * details: what the scale showed, the limits, what was removed or accepted and
 * whether earlier ingredients in the same container may be affected.
 */
export function describeDeviation(d: RunState['deviations'][number], steps: RunStep[], resolutionMg = 10): { problem: string; resolution: string } {
  const gr = (v: unknown) => (num(v) == null ? null : `${g(num(v)!, resolutionMg)} g`);
  const det = d.details ?? {};
  const rw = (det.resolvedWith ?? null) as Record<string, unknown> | null;
  const parts: string[] = [];
  if (d.type === 'OVERWEIGHT') {
    if (gr(det.netMg)) parts.push(`${gr(det.netMg)} poured${gr(det.targetMg) ? ` against ${gr(det.targetMg)}` : ''}.`);
  } else if (d.type === 'VESSEL_CHANGED') {
    const drift = num(det.driftMg ?? det.drift);
    if (gr(det.expectedGrossMg) && gr(det.foundGrossMg)) parts.push(`Expected ${gr(det.expectedGrossMg)}, found ${gr(det.foundGrossMg)}${drift != null ? ` (${drift > 0 ? '+' : ''}${g(drift, resolutionMg)} g)` : ''}.`);
    if (gr(det.limitMg)) parts.push(`Allowed ±${gr(det.limitMg)}${gr(det.stationLimitMg) && det.stationLimitMg !== det.limitMg ? ` (station limit ±${gr(det.stationLimitMg)})` : ''}.`);
  }
  const res: string[] = [];
  if (rw) {
    if (num(rw.removedMg) != null) res.push(`Removed ${gr(rw.removedMg)}${gr(rw.grossBeforeMg) && gr(rw.grossAfterMg) ? ` (gross ${gr(rw.grossBeforeMg)} → ${gr(rw.grossAfterMg)})` : ''}.`);
    else if (gr(rw.grossAfterMg)) res.push(`Gross after removal ${gr(rw.grossAfterMg)}.`);
    if (gr(rw.acceptedGrossMg)) res.push(`Container weight accepted at ${gr(rw.acceptedGrossMg)} gross.`);
    const earlier = Array.isArray(rw.earlierInContainer) ? (rw.earlierInContainer as { seq?: number; ingredient?: string }[]) : [];
    if (rw.earlierIngredientsMayBeAffected && earlier.length) {
      const names = earlier.map((e) => steps.find((s) => s.seq === e.seq)?.ingredientName ?? e.ingredient ?? `#${e.seq}`);
      res.push(`Earlier ingredients in this container may be affected: ${names.join(', ')}.`);
    }
  }
  return { problem: parts.join(' '), resolution: res.join(' ') };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 06.10.2026, the date format used on the process order. */
const sapDate = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
};
const dateTime = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${sapDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const clock = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** "1 h 04 min", "3 min 05 s": seconds matter for single ingredients. */
export function span(fromIso: string | null, toIso: string | null) {
  if (!fromIso || !toIso) return '-';
  return fmtSeconds((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000);
}

async function logo(path: string): Promise<string | null> {
  try {
    const r = await fetch(path);
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('image')) return null;
    const blob = await r.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const lastY = (doc: jsPDF) => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

function labNote(s: RunStep) {
  if (!s.skippedAt) return '';
  return s.status === 'SKIPPED' ? 'LAB TEST - pending' : 'LAB TEST - added after lab report';
}

const tableStyles = { font: 'helvetica', fontSize: 7.5, cellPadding: 3, lineColor: GRID, lineWidth: 0.5, textColor: 0 } as const;

export async function buildReportPdf(run: RunState, operator: ReportPerson | null, station: ReportStation | null, extras: ReportExtras = { heading: 'Operator report' }) {
  // Loaded only when a report is made, so the operator screens stay light.
  const [{ jsPDF }, { default: autoTable }, company, image, developer] = await Promise.all([import('jspdf'), import('jspdf-autotable'), loadCompany(), logo('/company-logo.png'), logo('/dhishaai-logo.png')]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const L = 24;
  const inner = W - 2 * L;
  const res = station?.scaleResolutionMg ?? 10;
  const po = run.processOrder;
  const title = po ? 'PROCESS ORDER' : 'BATCH RECORD';
  doc.setProperties({ title: `${po ? `Process Order ${po.processOrder}` : 'Batch record'} - ${run.batchNo}`, subject: extras.heading, creator: 'BlendGuard', author: company?.name ?? '' });

  // ── Company block ──
  let y = 24;
  doc.setDrawColor(...GRID).setLineWidth(0.6);
  doc.rect(L, y, inner, 40);
  doc.setTextColor(0);
  if (company) {
    doc.setFont('helvetica', 'bold').setFontSize(9).text(company.name, L + 6, y + 23, { maxWidth: 150 });
    doc.setFont('helvetica', 'normal').setFontSize(8).text(company.address, L + 160, y + 17);
    doc.setFont('helvetica', 'normal').setFontSize(7).text(company.docNo, W - L - 6, y + 11, { align: 'right' });
  }
  doc.setFont('helvetica', 'bold').setFontSize(16).text(title, W / 2 + 10, y + 25, { align: 'center' });
  if (image) {
    // Fit the logo under the doc number at its own proportions, right-aligned.
    const p = doc.getImageProperties(image);
    const s = Math.min(96 / p.width, 24 / p.height);
    const w = p.width * s;
    const h = p.height * s;
    doc.addImage(image, 'PNG', W - L - 6 - w, y + 14, w, h, undefined, 'FAST');
  }
  else if (company) doc.setFont('helvetica', 'bold').setFontSize(15).setTextColor(...BRAND).text(company.name.split(/\s+/)[0], W - L - 6, y + 33, { align: 'right' });
  doc.setTextColor(0);
  y += 40;

  // ── Header: the process order, or the job itself ──
  const lab = (t: string) => ({ content: t, styles: { fontStyle: 'bold' as const } });
  const val = (t: string | null | undefined, colSpan = 1) => ({ content: t || '', colSpan });
  const batchSize = `${qtyInUnit(run.batchSizeMg, 'KG', res)} KG`;
  autoTable(doc, {
    startY: y,
    margin: { left: L, right: L },
    theme: 'grid',
    styles: { ...tableStyles, minCellHeight: 14 },
    body: (po
      ? [
          [lab('Process Order'), val(po.processOrder), lab('Plant'), val(po.plant), lab('Resource'), val(po.resource), lab('Start Date'), val(po.startDate), lab('Finish Date'), val(po.finishDate)],
          [lab('Material'), val(po.material), val(po.materialDescription, 4), lab('Batch'), val(po.batch), lab('Order Quantity'), val(`${po.orderQuantity} ${po.orderUom}`.trim())],
          [lab('Sale Order'), val(po.saleOrder), lab('Inspection Lot'), val(po.inspectionLot), lab('Reservation'), val(po.reservation), lab('Order Type'), val(po.orderType), lab('Plan Delivery Date'), val(po.planDeliveryDate)],
        ]
      : [
          [lab('Batch'), val(run.batchNo), lab('Formula'), val(`${run.formulaCode} rev ${run.revision}`), lab('Product'), val(run.perfumeName, 3), lab('Batch Size'), val(batchSize)],
          [lab('Process Order'), val('n/a'), lab('Station'), val(station ? `${station.name} (${station.code})` : ''), lab('Start Date'), val(sapDate(run.startedAt)), lab('Finish Date'), val(sapDate(run.completedAt)), lab('Sent'), val(sapDate(run.submittedAt))],
        ]) as RowInput[],
  });
  y = lastY(doc);

  // ── Material input: required and actual ──
  const rows = run.steps.map((s) => {
    const uom = (s.uom ?? 'G').toUpperCase();
    const note = labNote(s);
    const done = s.acceptedNetMg != null;
    return {
      lab: !!s.skippedAt,
      cells: [
        s.ingredientCode,
        note ? `${s.ingredientName}\n${note}` : s.ingredientName,
        s.storageLocation ?? '',
        s.sourceBatch ?? '',
        s.lotNumber ?? '',
        qtyInUnit(s.targetMg, uom, res),
        `-${qtyInUnit(s.tolMinusMg, uom, res)} / +${qtyInUnit(s.tolPlusMg, uom, res)}`,
        uom,
        done ? qtyInUnit(s.acceptedNetMg!, uom, res) : '',
        done ? uom : '',
        done ? `${sapDate(s.acceptedAt)}\n${clock(s.acceptedAt)}` : '',
        done && s.startedAt ? span(s.startedAt, s.acceptedAt) : '',
      ],
    };
  });
  autoTable(doc, {
    startY: y + 6,
    margin: { left: L, right: L },
    theme: 'grid',
    styles: tableStyles,
    headStyles: { fillColor: [255, 255, 255], textColor: 0, fontStyle: 'bold' },
    head: [
      [{ content: 'MATERIAL INPUT', colSpan: 12, styles: { fillColor: BAND, halign: 'left' } }],
      ['Material Code', 'Description', 'Storage Location', 'Batch', 'Lot', 'Req Qty', 'Tolerance', 'UoM', 'Actual Qty', 'UoM', 'Weighed at', 'Time taken'],
    ],
    body: rows.map((r) => r.cells),
    columnStyles: {
      0: { cellWidth: 62 },
      2: { cellWidth: 52 },
      3: { cellWidth: 58 },
      4: { cellWidth: 56 },
      5: { cellWidth: 54, halign: 'right' },
      6: { cellWidth: 74, halign: 'right' },
      7: { cellWidth: 28 },
      8: { cellWidth: 56, halign: 'right', fontStyle: 'bold' },
      9: { cellWidth: 28 },
      10: { cellWidth: 52 },
      11: { cellWidth: 50 },
    },
    didParseCell: (d) => {
      if (d.section === 'body' && rows[d.row.index]?.lab) d.cell.styles.fillColor = LAB_FILL;
    },
  });
  y = lastY(doc);

  // ── Weighing record ──
  const done = run.steps.filter((s) => s.status === 'COMPLETED');
  const finishedAt = run.completedAt ?? done.map((s) => s.acceptedAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const sc = extras.scale;
  const scaleCheck = sc?.checkedAt ? `${dateTime(sc.checkedAt)}${sc.checkedBy ? ` by ${sc.checkedBy}` : ''}, valid until ${dateTime(sc.validUntil)}` : sc ? 'No passed check found' : '-';
  autoTable(doc, {
    startY: y + 10,
    margin: { left: L, right: L },
    theme: 'grid',
    styles: tableStyles,
    head: [[{ content: `WEIGHING RECORD - ${extras.heading.toUpperCase()}`, colSpan: 8, styles: { fillColor: BAND, textColor: 0, fontStyle: 'bold' } }]],
    body: [
      [lab('Operator'), `${operator?.name ?? '-'}${operator?.operatorCode ? ` (ID ${operator.operatorCode})` : ''}`, lab('Station'), `${station?.name ?? '-'}${station?.code ? ` (${station.code})` : ''}`, lab('BlendGuard batch'), run.batchNo, lab('Status'), STATUS_TEXT[run.status] ?? run.status],
      [lab('Started'), dateTime(run.startedAt), lab('Completed'), dateTime(finishedAt), lab('Total time'), span(run.startedAt, finishedAt), lab('Ingredients'), `${done.length} of ${run.steps.length} weighed`],
      [lab('Assigned'), extras.assignedAt ? `${dateTime(extras.assignedAt)}${extras.assignedBy ? ` by ${extras.assignedBy}` : ''}` : (extras.assignedBy ?? '-'), lab('Sent to scientist'), `${dateTime(run.submittedAt)}${extras.submittedBy ? ` by ${extras.submittedBy}` : ''}`, lab('Formula'), `${run.formulaCode} rev ${run.revision}`, lab('Product'), run.perfumeName],
      [lab('Scale'), sc?.model ?? '-', lab('Scale check'), { content: scaleCheck, colSpan: 3 }, lab('Batch size'), batchSize],
    ] as RowInput[],
  });
  y = lastY(doc);

  const notes: string[] = [];
  if (run.simulated) notes.push('TRAINING RECORD: weighed on the training simulator. Not a production record and cannot be approved.');
  const pending = run.steps.filter((s) => s.status === 'SKIPPED').length;
  if (pending) notes.push(`${pending} ingredient${pending > 1 ? 's are' : ' is'} still waiting for the lab report, so this batch is not complete.`);
  if (notes.length) {
    doc.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...WARN_INK);
    for (const n of notes) {
      y += 13;
      doc.text(n, L, y);
    }
    doc.setTextColor(0);
  }

  // ── Lab ingredients ──
  const labSteps = run.steps.filter((s) => s.skippedAt);
  if (labSteps.length) {
    autoTable(doc, {
      startY: y + 10,
      margin: { left: L, right: L },
      theme: 'grid',
      styles: tableStyles,
      headStyles: { fillColor: LAB_FILL, textColor: 0, fontStyle: 'bold' },
      head: [
        [{ content: 'LAB TEST INGREDIENTS', colSpan: 6 }],
        ['Material Code', 'Description', 'Skipped for lab', 'Reason', 'Lab ingredient arrived', 'Added'],
      ],
      body: labSteps.map((s) => {
        const who = extras.lab?.[s.seq];
        return [
          s.ingredientCode,
          s.ingredientName,
          `${dateTime(s.skippedAt)}${who?.skippedBy ? `\n${who.skippedBy}` : ''}`,
          s.skipNote ?? '',
          s.labReleasedAt ? `${dateTime(s.labReleasedAt)}${who?.releasedBy ? `\n${who.releasedBy}` : ''}` : 'Not yet',
          dateTime(s.acceptedAt),
        ];
      }),
    });
    y = lastY(doc);
  }

  // ── Problems ──
  if (run.deviations.length) {
    const seqCode = new Map(run.steps.map((s) => [s.seq, s.ingredientCode]));
    autoTable(doc, {
      startY: y + 10,
      margin: { left: L, right: L },
      theme: 'grid',
      styles: tableStyles,
      headStyles: { fillColor: [247, 222, 222], textColor: 0, fontStyle: 'bold' },
      head: [
        [{ content: 'PROBLEMS', colSpan: 7 }],
        ['Time', 'Material Code', 'Problem', 'State', 'Resolution', 'Resolved by', 'Scientist note'],
      ],
      columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 62 }, 3: { cellWidth: 80 }, 5: { cellWidth: 70 } },
      body: run.deviations.map((d) => {
        const txt = describeDeviation(d, run.steps, res);
        return [
          dateTime(d.raisedAt),
          d.seq != null ? (seqCode.get(d.seq) ?? `#${d.seq}`) : '-',
          `${PROBLEM_TEXT[d.type] ?? d.type}${txt.problem ? `\n${txt.problem}` : ''}`,
          d.resolvedAt ? `Resolved ${dateTime(d.resolvedAt)}` : 'Open',
          `${d.resolution ? (RESOLUTION_TEXT[d.resolution] ?? d.resolution) : ''}${txt.resolution ? `\n${txt.resolution}` : ''}`.trim(),
          (d.resolvedAt && extras.resolvedBy?.[d.id]) || '',
          d.resolutionNote ?? '',
        ];
      }),
    });
    y = lastY(doc);
  }

  // ── Supervisor decision ──
  const dec = extras.decision;
  const decisionRow = dec
    ? [lab(dec.kind === 'APPROVED' ? 'Approved by' : 'Rejected by'), dec.by ?? '-', lab(dec.kind === 'APPROVED' ? 'Approved at' : 'Rejected at'), dateTime(dec.at), lab(dec.kind === 'APPROVED' ? 'Note' : 'Reason'), { content: dec.note ?? '', colSpan: 3 }]
    : [lab('Decision'), { content: run.status === 'SUBMITTED' ? 'Waiting for scientist approval' : 'Not reviewed yet', colSpan: 7 }];
  if (y + 40 > H - 40) {
    doc.addPage();
    y = 30;
  }
  autoTable(doc, {
    startY: y + 10,
    margin: { left: L, right: L },
    theme: 'grid',
    styles: tableStyles,
    head: [[{ content: 'SCIENTIST REVIEW (password confirmed in BlendGuard)', colSpan: 8, styles: { fillColor: BAND, textColor: 0, fontStyle: 'bold' } }]],
    body: [decisionRow] as RowInput[],
    didParseCell: (d) => {
      if (d.section === 'body' && dec && d.column.index === 1) d.cell.styles.textColor = dec.kind === 'APPROVED' ? [26, 120, 60] : [180, 40, 40];
    },
  });
  y = lastY(doc);

  // ── Signatures: Name and Date under each line ──
  if (y + 90 > H - 30) {
    doc.addPage();
    y = 40;
  }
  y += 44;
  doc.setDrawColor(60).setLineWidth(0.6);
  const sw = (inner - 40) / 3;
  const people: [string, string, string][] = [
    ['Operator signature', operator?.name ?? '', ''],
    ['Scientist signature', dec?.by ?? '', dec ? sapDate(dec.at) : ''],
    ['QC / Lab signature', '', ''],
  ];
  people.forEach(([label, who, when], i) => {
    const x = L + i * (sw + 20);
    doc.line(x, y, x + sw, y);
    doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(90).text(label, x, y + 10);
    doc.setTextColor(0).setFontSize(8);
    doc.text('Name:', x, y + 26);
    doc.text('Date:', x + sw * 0.62, y + 26);
    doc.setDrawColor(150).setLineWidth(0.4);
    doc.line(x + 26, y + 28, x + sw * 0.58, y + 28);
    doc.line(x + sw * 0.62 + 22, y + 28, x + sw, y + 28);
    if (who) doc.text(who, x + 29, y + 25, { maxWidth: sw * 0.58 - 30 });
    if (when) doc.text(when, x + sw * 0.62 + 25, y + 25);
    doc.setDrawColor(60).setLineWidth(0.6);
  });

  // ── Footer on every page ──
  const pages = doc.getNumberOfPages();
  const stamp = dateTime(new Date().toISOString());
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor(110);
    doc.text(`${company?.name ? `${company.name} - ` : ''}${extras.heading} - ${run.batchNo} - generated ${stamp} by BlendGuard`, L, H - 14);
    const pageText = `Page ${p} of ${pages}`;
    doc.text(pageText, W - L, H - 14, { align: 'right' });
    if (developer) {
      // "Developed by" + the DhishaAI logo, left of the page number.
      const dp = doc.getImageProperties(developer);
      const dh = 13;
      const dw = (dp.width / dp.height) * dh;
      const dx = W - L - doc.getTextWidth(pageText) - 14 - dw;
      doc.addImage(developer, 'PNG', dx, H - 14 - dh + 3.5, dw, dh, undefined, 'FAST');
      doc.text('Developed by', dx - 3, H - 14, { align: 'right' });
    }
    if (run.simulated) {
      doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor(...WARN_INK).text('TRAINING RECORD', W / 2, H - 14, { align: 'center' });
    }
  }
  doc.setTextColor(0);
  return doc;
}

const fileName = (run: RunState, extras?: ReportExtras) => `${extras?.heading.toLowerCase().includes('final') ? 'Final-report' : 'Operator-report'}-${run.processOrder?.processOrder || run.batchNo}.pdf`;

/** Saves the PDF to the browser's Downloads folder. */
export async function downloadWorkReport(run: RunState, operator: ReportPerson | null, station: ReportStation | null, extras?: ReportExtras) {
  const doc = await buildReportPdf(run, operator, station, extras);
  doc.save(fileName(run, extras));
}

/** Opens the PDF in a new browser tab (to read or print). */
export async function openWorkReport(run: RunState, operator: ReportPerson | null, station: ReportStation | null, extras?: ReportExtras) {
  // Opened straight away (inside the click), then pointed at the PDF once it is built: pop-up blockers allow that.
  const win = window.open('', '_blank');
  const doc = await buildReportPdf(run, operator, station, extras);
  const url = URL.createObjectURL(doc.output('blob'));
  if (win) win.location.href = url;
  else doc.save(fileName(run, extras));
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}
