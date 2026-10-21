/**
 * Accuracy guards: acceptance window vs scale division, amount parsing on
 * upload, single-use supervisor sign-offs and the record-integrity triggers.
 * Database checks run inside a transaction that is rolled back, so nothing
 * here changes what the other test files see.
 */
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { acceptanceWindow, evaluate } from '../shared/weighing.js';

process.env.DATABASE_URL = inject('testDbUrl');

const scale = { resolutionMg: 10, uncertaintyMg: 20, validated: true };
const read = (grossMg: number | null, stable = true, connected = true) => ({ grossMg, stable, connected, at: Date.now() });

describe('acceptance window snapped to the scale division', () => {
  it('keeps the limits inclusive', () => {
    const line = { targetMg: 180_000, tolMinusMg: 500, tolPlusMg: 500 };
    const w = acceptanceWindow(line, scale);
    expect(w).toMatchObject({ acceptLowMg: 179_520, acceptHighMg: 180_480, certifiable: true });
    expect(evaluate(read(w.acceptLowMg), 0, line, scale).verdict).toBe('OK');
    expect(evaluate(read(w.acceptHighMg), 0, line, scale).verdict).toBe('OK');
    expect(evaluate(read(w.acceptLowMg - 10), 0, line, scale).verdict).toBe('UNDER');
    expect(evaluate(read(w.acceptHighMg + 10), 0, line, scale).verdict).toBe('OVER');
  });

  it('25 000 mg ±1 % on a 10 mg scale with 20 mg uncertainty', () => {
    const line = { targetMg: 25_000, tolMinusMg: 250, tolPlusMg: 250 };
    expect(acceptanceWindow(line, scale)).toMatchObject({ lowLimitMg: 24_750, highLimitMg: 25_250, acceptLowMg: 24_770, acceptHighMg: 25_230, certifiable: true });
    expect(evaluate(read(400_000 + 24_770), 400_000, line, scale).verdict).toBe('OK');
    expect(evaluate(read(400_000 + 24_760), 400_000, line, scale).verdict).toBe('UNDER');
  });

  it('cannot certify 2345 mg ±23 mg on a 10 mg scale: no reading can land in 2342–2348', () => {
    const line = { targetMg: 2_345, tolMinusMg: 23, tolPlusMg: 23 };
    const w = acceptanceWindow(line, scale);
    expect(w).toMatchObject({ acceptLowMg: 2_350, acceptHighMg: 2_340, certifiable: false });
    expect(evaluate(read(2_340), 0, line, scale).verdict).toBe('CANNOT_CERTIFY');
    expect(evaluate(read(2_350), 0, line, scale).verdict).toBe('CANNOT_CERTIFY');
  });

  it('snaps limits that fall between divisions inwards', () => {
    // 1000 ±35, guard 20: 985..1015 → 990..1010.
    expect(acceptanceWindow({ targetMg: 1_000, tolMinusMg: 35, tolPlusMg: 35 }, scale)).toMatchObject({ acceptLowMg: 990, acceptHighMg: 1_010 });
  });

  it('a negative net (container lighter than its zero) is never accepted', () => {
    const line = { targetMg: 10_000, tolMinusMg: 100, tolPlusMg: 100 };
    const ev = evaluate(read(399_000), 400_000, line, scale);
    expect(ev).toMatchObject({ verdict: 'UNDER', netMg: -1_000, remainingMg: 11_000 });
  });
});

describe('sign-off tokens', () => {
  it('carry a unique id and are bound to station, batch and (optionally) action', async () => {
    const { signSignoff, readSignoff } = await import('../server/utils/crypto.js');
    const a = signSignoff({ by: 'u', byName: 'S', stationId: 's1', batchId: 'b1' });
    const b = signSignoff({ by: 'u', byName: 'S', stationId: 's1', batchId: 'b1' });
    const ra = readSignoff(a, 's1', 'b1', 'ALLOW_REWEIGH');
    expect(ra?.jti).toBeTruthy();
    expect(ra?.jti).not.toBe(readSignoff(b, 's1', 'b1')?.jti);
    expect(readSignoff(a, 's2', 'b1')).toBeNull();
    const bound = signSignoff({ by: 'u', byName: 'S', stationId: 's1', batchId: 'b1', action: 'ACCEPT_VESSEL' });
    expect(readSignoff(bound, 's1', 'b1', 'ALLOW_REWEIGH')).toBeNull();
    expect(readSignoff(bound, 's1', 'b1', 'ACCEPT_VESSEL')?.action).toBe('ACCEPT_VESSEL');
  });
});

describe('amounts on upload', () => {
  let imp: typeof import('../server/services/import.service.js');
  beforeAll(async () => {
    imp = await import('../server/services/import.service.js');
  });

  it('reads SAP dot decimals and comma thousands, refuses anything ambiguous', () => {
    expect(imp.toMg('1.250', 'KG')).toBe(1_250_000);
    expect(imp.toMg('0.400', 'KG')).toBe(400_000);
    expect(imp.toMg('1,250.000', 'g')).toBe(1_250_000);
    expect(imp.toMg('0,500', 'KG')).toBeNull(); // not 500 kg
    expect(imp.toMg('1,250', 'g')).toBeNull();
    expect(imp.toMg('1.250,000', 'g')).toBeNull();
    expect(imp.toMg('1 250.000', 'g')).toBeNull(); // not 1 g
    expect(imp.toMg('1.2.3', 'g')).toBeNull();
    expect(imp.toMg('12.3456', 'g')).toBeNull(); // finer than 1 mg
  });

  const line = (over: Partial<import('../server/services/import.service.js').DraftLine> = {}) => ({
    row: 1, seq: '1', ingredientCode: 'RM-1001', description: null, quantity: '100', unit: 'g', tolMinus: '1', tolPlus: '1',
    remarks: null, storageLocation: null, sourceBatch: null, labTest: false, ...over,
  });
  const meta = { perfumeName: 'Accuracy', code: 'FR-ACC-1', revision: 'A', sopNumber: '' };

  it('flags a decimal comma, a space in a number, a missing unit, zero tolerance and an unweighable line', async () => {
    const p = await imp.checkDraft({
      meta, processOrder: null,
      lines: [
        line({ quantity: '0,500', unit: 'KG' }),
        line({ seq: '2', ingredientCode: 'RM-1002', quantity: '1 250.000' }),
        line({ seq: '3', ingredientCode: 'RM-1003', unit: '' }),
        line({ seq: '4', ingredientCode: 'RM-1004', tolMinus: '0', tolPlus: '0' }),
        line({ seq: '5', ingredientCode: 'RM-1005', quantity: '2.345', tolMinus: '0.023', tolPlus: '0.023' }),
        line({ seq: '6', ingredientCode: 'RM-1006', quantity: '25', tolMinus: '0.25', tolPlus: '0.25' }),
      ],
    });
    const errs = p.lines.map((l) => l.errors.join(' '));
    expect(errs[0]).toMatch(/comma/);
    expect(errs[1]).toMatch(/space/);
    expect(errs[2]).toMatch(/Unit is missing/);
    expect(errs[3]).toMatch(/cannot be zero/);
    expect(errs[4]).toMatch(/Too small to weigh/);
    expect(errs[5]).toBe('');
    expect(p.ok).toBe(false);
  });

  it('checks the lines add up to the Order Quantity within 0.5 %', async () => {
    const { emptyProcessOrder } = await import('../shared/types.js');
    const po = { ...emptyProcessOrder(), processOrder: '99', orderQuantity: '0.200', orderUom: 'KG' };
    const lines = [line(), line({ seq: '2', ingredientCode: 'RM-1002' })];
    const good = await imp.checkDraft({ meta, processOrder: po, lines });
    expect(good.errors.join(' ')).not.toMatch(/add up/);
    const bad = await imp.checkDraft({ meta, processOrder: { ...po, orderQuantity: '0.250' }, lines });
    expect(bad.errors.join(' ')).toMatch(/add up to 0.2 KG, but the Order Quantity is 0.250 KG/);
    const noUnit = await imp.checkDraft({ meta, processOrder: { ...po, orderUom: '' }, lines });
    expect(noUnit.errors.join(' ')).toMatch(/Order Quantity has no unit/);
  });

  it('keeps a space-separated or decimal-comma quantity in a process order PDF whole, so it is flagged', async () => {
    const { makeSampleOrder, SAMPLE_LINES, SAMPLE_HEADER } = await import('../scripts/make-sample-order.js');
    const lines = SAMPLE_LINES.map((l, i) => (i === 0 ? { ...l, qty: '0,400' } : i === 1 ? { ...l, qty: '1 300.000', uom: 'G' } : l));
    const p = await imp.previewPdf(await makeSampleOrder(lines, { ...SAMPLE_HEADER, orderQuantity: '1 250.000' }));
    expect(p.processOrder?.orderQuantity).toBe('1 250.000');
    expect(p.lines[0]).toMatchObject({ quantity: '0,400', targetMg: null });
    expect(p.lines[1]).toMatchObject({ quantity: '1 300.000', targetMg: null });
    expect(p.lines[0].errors.join(' ')).toMatch(/comma/);
    expect(p.lines[1].errors.join(' ')).toMatch(/space/);
    expect(p.errors.join(' ')).toMatch(/Order Quantity "1 250.000" has a space/);
    expect(p.ok).toBe(false);
  });
});

describe('record integrity in the database', () => {
  class Rollback extends Error {}

  it('freezes completed steps, submitted batches, approved formula lines and resolved deviations; refuses TRUNCATE', async () => {
    const { db } = await import('../server/db/prisma.js');
    const prisma = db();
    const ing = await prisma.ingredient.findFirstOrThrow();
    const st = await prisma.station.findFirstOrThrow();
    const user = await prisma.user.findFirstOrThrow({ where: { role: 'OPERATOR' } });

    await expect(
      prisma.$transaction(async (tx) => {
        const refused = async (sql: string, re: RegExp) => {
          await tx.$executeRawUnsafe('SAVEPOINT t');
          await expect(tx.$executeRawUnsafe(sql)).rejects.toThrow(re);
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT t');
        };
        const f = await tx.formula.create({
          data: { code: 'FR-ACC-DB', revision: 'A', perfumeName: 'x', status: 'APPROVED', batchSizeMg: 1_000, lines: { create: [{ seq: 1, ingredientId: ing.id, targetMg: 1_000, tolMinusMg: 100, tolPlusMg: 100 }] } },
          include: { lines: true },
        });
        await refused(`UPDATE "FormulaLine" SET "targetMg" = 2000 WHERE id = '${f.lines[0].id}'`, /approved formula/);
        await refused(`DELETE FROM "FormulaLine" WHERE id = '${f.lines[0].id}'`, /approved formula/);

        const b = await tx.batch.create({ data: { batchNo: 'ACC-DB-1', formulaId: f.id, stationId: st.id, operatorId: user.id, assignedById: user.id, status: 'IN_PROGRESS', simulated: true } });
        const base = { batchId: b.id, ingredientId: ing.id, ingredientCode: ing.code, ingredientName: ing.name, targetMg: 1_000, tolMinusMg: 100, tolPlusMg: 100 };
        const done = await tx.batchStep.create({ data: { ...base, seq: 1, status: 'COMPLETED', stage: 'DONE', containerNo: 1, tareGrossMg: 5_000, acceptedNetMg: 1_000, acceptedGrossMg: 6_000 } });
        const tared = await tx.batchStep.create({ data: { ...base, seq: 2, status: 'CURRENT', stage: 'WEIGH', containerNo: 1, tareGrossMg: 6_000 } });
        await refused(`UPDATE "BatchStep" SET "remarks" = 'x' WHERE id = '${done.id}'`, /completed ingredient step/);
        await refused(`UPDATE "BatchStep" SET "tolPlusMg" = 500 WHERE id = '${tared.id}'`, /once the scale was zeroed/);
        await tx.batchStep.update({ where: { id: tared.id }, data: { remarks: 'allowed' } });

        await refused(`UPDATE "Batch" SET simulated = false WHERE id = '${b.id}'`, /training record/);
        await tx.batch.update({ where: { id: b.id }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
        await refused(`UPDATE "Batch" SET "holdReason" = 'edit' WHERE id = '${b.id}'`, /cannot be changed/);
        await refused(`UPDATE "Batch" SET status = 'IN_PROGRESS' WHERE id = '${b.id}'`, /only be approved or rejected/);
        await refused(`DELETE FROM "Batch" WHERE id = '${b.id}'`, /cannot be deleted/);
        await tx.batch.update({ where: { id: b.id }, data: { version: { increment: 1 } } });
        await tx.batch.update({ where: { id: b.id }, data: { status: 'APPROVED' } });
        await refused(`UPDATE "Batch" SET status = 'REJECTED' WHERE id = '${b.id}'`, /only be approved or rejected/);

        const d = await tx.deviation.create({ data: { batchId: b.id, stepId: tared.id, type: 'OVERWEIGHT', details: { netMg: 1 }, raisedById: user.id } });
        await refused(`UPDATE "Deviation" SET details = '{"netMg": 0}' WHERE id = '${d.id}'`, /cannot be edited/);
        await tx.deviation.update({ where: { id: d.id }, data: { resolvedAt: new Date(), resolvedById: user.id, resolution: 'X', resolutionDetails: { grossAfterMg: 1 } } });
        await refused(`UPDATE "Deviation" SET "resolutionNote" = 'later' WHERE id = '${d.id}'`, /resolved deviation/);

        for (const t of ['AuditEvent', 'WeightReading', 'BatchStep', 'Batch', 'Deviation']) await refused(`TRUNCATE "${t}" CASCADE`, /TRUNCATE/);

        await tx.$executeRawUnsafe(`INSERT INTO "SignoffUse" ("jti", "action", "batchId", "usedById") VALUES ('j1', 'A', 'b', 'u')`);
        expect(await tx.$executeRawUnsafe(`INSERT INTO "SignoffUse" ("jti", "action", "batchId", "usedById") VALUES ('j1', 'A', 'b', 'u') ON CONFLICT ("jti") DO NOTHING`)).toBe(0);
        throw new Rollback();
      }, { timeout: 30_000 }),
    ).rejects.toBeInstanceOf(Rollback);
  });
});
