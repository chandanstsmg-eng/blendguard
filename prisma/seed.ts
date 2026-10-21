/**
 * Demo data for a fresh install: stations, racks, raw materials with lots,
 * two approved formulas, operators, a supervisor and three assigned jobs.
 *
 * Rack/bin locations here are DEMO values. On a real install the supervisor
 * configures them; an ingredient without a configured location is shown to
 * the operator as "location not set — call supervisor", never guessed.
 */
import { db } from '../server/db/prisma.js';
import { config } from '../server/config.js';
import { hashSecret } from '../server/utils/crypto.js';
import { assignJob } from '../server/services/supervisor.service.js';

const g = (grams: number) => Math.round(grams * 1000);

/** Default tolerances by quantity (demo values — the approved formula is the authority). */
function tol(targetG: number) {
  if (targetG >= 50) return g(0.5);
  if (targetG >= 10) return g(0.2);
  return g(0.05);
}

type Ing = {
  code: string; name: string; rack: string | null; bin: number | null; color: string; ppe?: string[]; lotTracked?: boolean; handling?: string[]; hazards?: string[];
  lots?: { lot: string; status?: 'RELEASED' | 'QUARANTINE' | 'REJECTED'; expiresInDays?: number }[];
};

// `color` is the cap / sticker colour on the demo bottles; operators match it by sight.
const INGREDIENTS: Ing[] = [
  { code: 'RM-1001', name: 'Iso E Super', rack: 'A', bin: 3, color: '#2f6fd6', ppe: ['GLOVES'], handling: ['Wear nitrile gloves.'] },
  { code: 'RM-1002', name: 'Hedione', rack: 'A', bin: 7, color: '#2aa198', ppe: ['GLOVES'], handling: ['Wear nitrile gloves.'] },
  { code: 'RM-1003', name: 'Ambroxan (crystals)', rack: 'B', bin: 2, color: '#d4a017', ppe: ['SPATULA'], handling: ['Solid crystals. Use a clean spatula.', 'Close the jar straight after use.'] },
  { code: 'RM-1004', name: 'Cedarwood Oil, Virginia', rack: 'B', bin: 5, color: '#8b5a2b', ppe: ['GLOVES'], handling: ['Wear nitrile gloves.'], hazards: ['IRRITANT'] },
  { code: 'RM-1005', name: 'Patchouli Oil, Indonesia', rack: 'B', bin: 11, color: '#5b3a29', lotTracked: true, handling: ['Thick oil. Pour slowly.'], lots: [{ lot: 'PT-2408A', expiresInDays: 400 }] },
  { code: 'RM-1006', name: 'Vanillin', rack: 'A', bin: 12, color: '#f2e6c9', ppe: ['MASK'], handling: ['Powder. Avoid making dust.', 'Wear a dust mask.'] },
  { code: 'RM-1007', name: 'Rose Oxide', rack: 'D', bin: 1, color: '#d63c78', ppe: ['DROPPER'], handling: ['Very strong. Small amount only.', 'Use a dropper.'], hazards: ['FLAMMABLE'] },
  {
    code: 'RM-1008', name: 'Bergamot Oil, Calabria', rack: 'C', bin: 8, color: '#7cb342', ppe: ['GLOVES'], lotTracked: true,
    handling: ['Keep the bottle closed when not pouring. Light sensitive.', 'Wear nitrile gloves.'], hazards: ['FLAMMABLE', 'IRRITANT'],
    lots: [{ lot: 'BG-2409A', expiresInDays: 300 }, { lot: 'BG-2407Q', status: 'QUARANTINE', expiresInDays: 250 }],
  },
  { code: 'RM-1009', name: 'Safraleine', rack: 'D', bin: 4, color: '#c0392b', ppe: ['DROPPER'], handling: ['Very strong. Use a dropper.'] },
  {
    code: 'RM-1010', name: 'Oud Oil, Assam', rack: 'D', bin: 9, color: '#3d2b1f', lotTracked: true,
    handling: ['Precious material. Weigh slowly, drop by drop.', 'Return the bottle to the locked cabinet.'],
    lots: [{ lot: 'OUD-2402', expiresInDays: 700 }, { lot: 'OUD-2311', expiresInDays: -20 }],
  },
  { code: 'RM-1011', name: 'Galaxolide 50% IPM', rack: 'A', bin: 10, color: '#7e57c2', handling: ['Thick liquid. Pour slowly.'], hazards: ['ENVIRONMENT'] },
  { code: 'RM-1012', name: 'Pink Pepper CO2 Extract', rack: 'C', bin: 2, color: '#e57373', ppe: ['DROPPER', 'GLOVES'], lotTracked: true, handling: ['Use a dropper.'], hazards: ['IRRITANT'], lots: [{ lot: 'PP-2405', expiresInDays: 180 }] },
  { code: 'RM-1013', name: 'Lemon Oil, Sicily', rack: 'C', bin: 3, color: '#f4d03f', ppe: ['GLOVES'], lotTracked: true, handling: ['Keep the bottle closed. Light sensitive.'], hazards: ['FLAMMABLE', 'IRRITANT'], lots: [{ lot: 'LE-2409', expiresInDays: 200 }] },
  { code: 'RM-1014', name: 'Linalool', rack: 'A', bin: 1, color: '#9575cd', ppe: ['GLOVES'], handling: ['Wear nitrile gloves.'], hazards: ['IRRITANT'] },
  // Deliberately without a configured location, to show the "not set" path.
  { code: 'RM-1015', name: 'Dihydromyrcenol', rack: null, bin: null, color: '#4fc3f7', ppe: ['GLOVES'], handling: ['Wear nitrile gloves.'], hazards: ['FLAMMABLE'] },
];

const OUD_ROYALE: [string, number, string?][] = [
  ['RM-1001', 220],
  ['RM-1002', 160],
  ['RM-1003', 25, 'Crush any lumps before weighing'],
  ['RM-1004', 95],
  ['RM-1005', 70, 'Use approved lot'],
  ['RM-1006', 18],
  ['RM-1007', 4.5, 'Handle carefully'],
  ['RM-1008', 180, 'Use approved lot'],
  ['RM-1009', 6],
  ['RM-1010', 12, 'Use approved lot'],
  ['RM-1011', 110],
  ['RM-1012', 9.5, 'Use approved lot'],
];

const CITRUS_VEIL: [string, number, string?][] = [
  ['RM-1013', 120, 'Use approved lot'],
  ['RM-1008', 90, 'Use approved lot'],
  ['RM-1015', 60],
  ['RM-1002', 80],
  ['RM-1014', 25],
];

export async function seed(opts: { quiet?: boolean } = {}) {
  const log = (m: string) => !opts.quiet && console.log(`  ${m}`);
  const p = db();
  const now = Date.now();

  for (const [i, r] of [
    ['A', 'Rack A', 'Aroma chemicals'],
    ['B', 'Rack B', 'Woods and resins'],
    ['C', 'Rack C', 'Citrus and naturals'],
    ['D', 'Rack D', 'Precious materials (locked cabinet)'],
  ].entries()) {
    await p.rack.create({ data: { code: r[0], label: r[1], zone: r[2], rows: 3, cols: 4, sortOrder: i } });
  }

  const ids = new Map<string, string>();
  for (const ing of INGREDIENTS) {
    const created = await p.ingredient.create({
      data: {
        code: ing.code,
        name: ing.name,
        barcode: ing.lotTracked ? null : ing.code.replace('-', ''),
        lotTracked: !!ing.lotTracked,
        rackCode: ing.rack,
        bin: ing.bin,
        handling: ing.handling ?? [],
        hazards: ing.hazards ?? [],
        ppe: ing.ppe ?? [],
        colorHex: ing.color,
        lots: {
          create: (ing.lots ?? []).map((l) => ({
            lotNumber: l.lot,
            barcode: `${ing.code.replace('-', '')}-${l.lot}`,
            status: l.status ?? 'RELEASED',
            expiresOn: l.expiresInDays != null ? new Date(now + l.expiresInDays * 86400_000) : null,
          })),
        },
      },
    });
    ids.set(ing.code, created.id);
  }

  const supervisor = await p.user.create({ data: { username: 'scientist', name: 'Meena Rao', role: 'SUPERVISOR', passwordHash: await hashSecret(config.demo.supervisorPassword) } });
  // A second scientist, so a batch one of them worked on can be approved by the other.
  await p.user.create({ data: { username: 'scientist2', name: 'Arjun Shetty', role: 'SUPERVISOR', passwordHash: await hashSecret(config.demo.adminPassword) } });

  const formula = async (code: string, revision: string, perfumeName: string, sop: string, lines: [string, number, string?][], status: 'APPROVED' | 'SUPERSEDED') =>
    p.formula.create({
      data: {
        code, revision, perfumeName, sopNumber: sop, status,
        batchSizeMg: lines.reduce((s, l) => s + g(l[1]), 0),
        approvedById: supervisor.id,
        approvedAt: new Date(now - (status === 'SUPERSEDED' ? 90 : 10) * 86400_000),
        lines: { create: lines.map(([c, grams, remarks], i) => ({ seq: i + 1, ingredientId: ids.get(c)!, targetMg: g(grams), tolMinusMg: tol(grams), tolPlusMg: tol(grams), remarks: remarks ?? null })) },
      },
    });
  await formula('F-2041', 'B', 'Oud Royale', 'SOP-PM-2041', OUD_ROYALE.map(([c, w, r]) => [c, c === 'RM-1010' ? 10 : w, r]), 'SUPERSEDED');
  const oud = await formula('F-2041', 'C', 'Oud Royale', 'SOP-PM-2041', OUD_ROYALE, 'APPROVED');
  const citrus = await formula('F-1187', 'B', 'Citrus Veil', 'SOP-PM-1187', CITRUS_VEIL, 'APPROVED');

  const station = (code: string, name: string, extra: object = {}) =>
    p.station.create({
      data: {
        code, name,
        allowFingerprint: true, allowFace: true, allowPin: true, allowAssisted: true,
        scaleMode: 'SIMULATED', scaleModel: 'Training simulator (3200 g × 0.01 g)', scaleResolutionMg: 10, scaleUncertaintyMg: 20,
        scaleValidatedUntil: new Date(now + 7 * 86400_000), scaleValidatedAt: new Date(now), scaleValidatedById: supervisor.id,
        ...extra,
      },
    });
  const st1 = await station('ST-01', 'Mixing Station 01');
  const st2 = await station('ST-02', 'Mixing Station 02', { defaultLanguage: 'hi' });
  // A real-scale station: METTLER TOLEDO on the station PC through the scale bridge (no bridge key yet in the demo).
  const st3 = await station('ST-03', 'Mixing Station 03', {
    scaleMode: 'BRIDGE', scaleModel: 'METTLER TOLEDO (MT-SICS)', scalePort: 'COM3', scaleValidatedUntil: null, scaleValidatedAt: null, scaleValidatedById: null, allowPin: false,
  });

  const pin = await hashSecret(config.demo.operatorPin);
  const op = (operatorCode: string, name: string, language: string, stations: string[]) =>
    p.user.create({ data: { operatorCode, name, role: 'OPERATOR', language, pinHash: pin, stationAccess: { create: stations.map((stationId) => ({ stationId })) } } });
  const suresh = await op('1001', 'Suresh Kumar', 'en', [st1.id, st2.id]);
  const lakshmi = await op('1002', 'Lakshmi Narayan', 'hi', [st1.id, st2.id]);
  await op('1003', 'Imran Pasha', 'en', [st2.id, st3.id]);
  await op('1004', 'Anjali Nair', 'ml', [st1.id]);

  const actor = { userId: supervisor.id, role: 'SUPERVISOR', stationId: null, sourceDevice: 'seed' };
  const today = new Date();
  const at = (h: number, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).toISOString();
  await assignJob(actor, { formulaId: oud.id, operatorId: suresh.id, stationId: st1.id, plannedStart: at(9), instructions: 'Use the 2 L stainless vessel. Clean vessel before starting.' });
  await assignJob(actor, { formulaId: citrus.id, operatorId: suresh.id, stationId: st1.id, plannedStart: at(13, 30), instructions: null });
  await assignJob(actor, { formulaId: citrus.id, operatorId: lakshmi.id, stationId: st2.id, backupOperatorId: suresh.id, plannedStart: at(10), instructions: null });

  log('Demo data loaded: stations ST-01..03, operators 1001–1004, scientists "scientist" and "scientist2", 3 jobs.');
}
