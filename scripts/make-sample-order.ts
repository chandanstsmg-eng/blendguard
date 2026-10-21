/**
 * Writes docs/samples/process-order-sample.pdf: a PROCESS ORDER sheet in the
 * same layout as the plant's SAP print-out, using the demo ingredient codes,
 * for trying the PDF upload (Assign job → Upload) and for the tests.
 *
 *   npx tsx scripts/make-sample-order.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ROOT } from '../server/config.js';

export interface SampleLine {
  code: string;
  description: string;
  storage: string;
  batch: string;
  qty: string;
  uom: string;
}

export const SAMPLE_HEADER = {
  processOrder: '1369327',
  plant: 'K104',
  resource: '',
  startDate: '06.10.2026',
  finishDate: '07.10.2026',
  material: '4410000145',
  materialDescription: 'OTTO ROSE 029 A',
  batch: '4413760375',
  orderQuantity: '1.250',
  orderUom: 'KG',
  saleOrder: '1200048049',
  inspectionLot: '',
  reservation: '69750575',
  orderType: 'ZP29',
  planDeliveryDate: '15.09.2026',
};

export const SAMPLE_LINES: SampleLine[] = [
  { code: 'RM-1001', description: 'ISO E SUPER', storage: '1000', batch: '4413700121', qty: '0.400', uom: 'KG' },
  { code: 'RM-1002', description: 'HEDIONE', storage: '1000', batch: '4413700187', qty: '0.300', uom: 'KG' },
  { code: 'RM-1007', description: 'ROSE OXIDE', storage: '1010', batch: '4413700340', qty: '25.000', uom: 'G' },
  { code: 'RM-1014', description: 'LINALOOL', storage: '1000', batch: '4413700412', qty: '0.150', uom: 'KG' },
  { code: 'RM-1004', description: 'CEDARWOOD OIL VIRGINIA', storage: '1010', batch: '4413700455', qty: '0.200', uom: 'KG' },
  { code: 'RM-1006', description: 'VANILLIN', storage: '1020', batch: '4413700498', qty: '75.000', uom: 'G' },
  { code: 'RM-1011', description: 'GALAXOLIDE 50% IPM', storage: '1000', batch: '4413700533', qty: '0.100', uom: 'KG' },
];

export async function makeSampleOrder(lines = SAMPLE_LINES, header = SAMPLE_HEADER): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Process Order ${header.processOrder}`);
  const page = doc.addPage([842, 595]); // A4 landscape
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const line = rgb(0.45, 0.45, 0.45);
  const text = (s: string, x: number, y: number, size = 7.5, f = font, color = black) => s && page.drawText(s, { x, y, size, font: f, color });
  const box = (x: number, y: number, w: number, h: number) => page.drawRectangle({ x, y, width: w, height: h, borderColor: line, borderWidth: 0.6 });

  const L = 24;
  const W = 842 - 2 * L;
  let y = 560;
  // Company block, title, document number and logo text.
  box(L, y - 34, W, 34);
  text('Synthite Ind. Pvt. Ltd', L + 6, y - 20, 8, bold);
  text('Synthite Valley, Kolenchery, Cochin', L + 150, y - 14);
  text('Kerala 682311, India', L + 150, y - 25);
  text('PROCESS ORDER', L + 330, y - 22, 14, bold);
  text('SYN/PRN-001/B', L + W - 120, y - 12, 7);
  text('Synthite', L + W - 92, y - 28, 13, bold, rgb(0.85, 0.32, 0.1));
  y -= 34;

  // Header grid: label/value pairs.
  const rows: [string, string, number][][] = [
    [['Process Order', header.processOrder, 0], ['Plant', header.plant, 160], ['Resource', header.resource, 290], ['Start Date', header.startDate, 470], ['Finish Date', header.finishDate, 630]],
    [['Material', `${header.material}`, 0], ['', header.materialDescription, 160], ['Batch', header.batch, 470], ['Order Quantity', `${header.orderQuantity} ${header.orderUom}`, 630]],
    [['Sale Order', header.saleOrder, 0], ['Inspection Lot', header.inspectionLot, 160], ['Reservation', header.reservation, 290], ['Order Type', header.orderType, 470], ['Plan Delivery Date', header.planDeliveryDate, 630]],
  ];
  for (const r of rows) {
    box(L, y - 14, W, 14);
    for (const [label, value, x] of r) {
      text(label, L + x + 4, y - 10, 7.5, bold);
      text(value, L + x + (label ? 74 : 4), y - 10);
    }
    y -= 14;
  }

  // MATERIAL INPUT table.
  y -= 6;
  page.drawRectangle({ x: L, y: y - 13, width: W, height: 13, color: rgb(0.9, 0.9, 0.9) });
  text('MATERIAL INPUT', L + 4, y - 10, 8, bold);
  y -= 13;
  const cols = [0, 90, 300, 400, 500, 580, 630, 720];
  const heads = ['Material Code', 'Description', 'Storage Location', 'Batch', 'Req Qty', 'UoM', 'Actual Qty', 'UoM'];
  box(L, y - 14, W, 14);
  heads.forEach((h, i) => text(h, L + cols[i] + 4, y - 10, 7.5, bold));
  y -= 14;
  for (const l of lines) {
    box(L, y - 14, W, 14);
    [l.code, l.description, l.storage, l.batch, l.qty, l.uom, '', ''].forEach((v, i) => text(v, L + cols[i] + 4, y - 10));
    y -= 14;
  }
  y -= 24;
  text('Prepared by: ____________________', L + 4, y);
  text('Checked by: ____________________', L + 300, y);
  return doc.save();
}

// Run directly: write the sample file.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('make-sample-order.ts')) {
  const dir = path.join(ROOT, 'docs', 'samples');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'process-order-sample.pdf');
  writeFileSync(file, await makeSampleOrder());
  console.log(`Written ${path.relative(ROOT, file)}`);
}
