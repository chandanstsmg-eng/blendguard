/**
 * Supervisor console: live station status, supervisor calls, job assignment
 * from approved formulas, station settings, the daily scale check, batch
 * approval, reports and biometric enrolment.
 */
import type { BatchStatus } from '@prisma/client';
import { db } from '../db/prisma.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { verifySecret } from '../utils/crypto.js';
import { audit, auditNow, type Actor } from './audit.service.js';
import { emitCalls, emitJobs, emitStation } from './realtime.service.js';
import { buildRun } from './run.service.js';
import { configureStation, readScale, toSnapshot } from './scale.service.js';
import { scaleValidated, toStationInfo } from './session.service.js';

/** Rows in the overview's job table (the newest); counts always cover every job. */
export const OVERVIEW_JOB_ROWS = 60;

export async function overview() {
  const batchInclude = {
    formula: true,
    operator: { select: { name: true, operatorCode: true } },
    station: { select: { code: true } },
    steps: { select: { status: true, seq: true, stage: true, ingredientName: true, targetMg: true, tolMinusMg: true, tolPlusMg: true, tareGrossMg: true, holdReason: true, startedAt: true } },
  } as const;
  const [stations, calls, recent, waitingLab, operators, formulas, byStatus, labReadyJobs] = await Promise.all([
    db().station.findMany({ orderBy: { code: 'asc' } }),
    db().supervisorCall.findMany({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      orderBy: { createdAt: 'asc' },
      include: { station: { select: { code: true, name: true } }, raisedBy: { select: { name: true } } },
    }),
    db().batch.findMany({ orderBy: [{ assignedAt: 'desc' }], take: OVERVIEW_JOB_ROWS, include: batchInclude }),
    // Jobs waiting for the lab or for approval can be days old; they always stay in view.
    db().batch.findMany({ where: { status: { in: ['AWAITING_LAB', 'SUBMITTED', 'UNDER_REVIEW'] } }, orderBy: [{ assignedAt: 'desc' }], include: batchInclude }),
    db().user.findMany({
      where: { role: 'OPERATOR' },
      orderBy: { operatorCode: 'asc' },
      include: { stationAccess: { include: { station: { select: { code: true } } } }, credentials: { where: { revokedAt: null }, select: { id: true, label: true, createdAt: true, lastUsedAt: true } } },
    }),
    db().formula.findMany({ where: { status: 'APPROVED' }, orderBy: { code: 'asc' }, include: { _count: { select: { lines: true } } } }),
    db().batch.groupBy({ by: ['status'], _count: { _all: true } }),
    db().batch.count({ where: { status: 'AWAITING_LAB', steps: { some: { status: 'LOCKED' } } } }),
  ]);

  const seen = new Set(recent.map((b) => b.id));
  const batches = [...recent, ...waitingLab.filter((b) => !seen.has(b.id))];
  const active = new Set(['IN_PROGRESS', 'PAUSED', 'ON_HOLD']);
  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])) as Partial<Record<BatchStatus, number>>;
  return {
    /** Jobs per status across the whole database (the table below lists only the newest). */
    counts,
    labReadyCount: labReadyJobs,
    jobRows: OVERVIEW_JOB_ROWS,
    stations: stations.map((s) => {
      const current = batches.find((b) => b.stationId === s.id && active.has(b.status));
      const step = current?.steps.find((x) => x.status === 'CURRENT' || x.status === 'ON_HOLD');
      const scale = readScale(s.id);
      return {
        ...toStationInfo(s),
        bound: !!s.tokenHash,
        scaleConnected: scale.connected,
        /** Why a real scale gives no weight (no COM port / bridge, no answer, out of range…). */
        scaleFault: scale.connected ? null : (scale.fault ?? null),
        current: current
          ? {
              batchId: current.id,
              batchNo: current.batchNo,
              perfumeName: current.formula.perfumeName,
              operator: current.operator.name,
              status: current.status,
              done: current.steps.filter((x) => x.status === 'COMPLETED').length,
              total: current.steps.length,
              stepSeq: step?.seq ?? null,
              stepStage: step?.stage ?? null,
              stepStatus: step?.status ?? null,
              ingredient: step?.ingredientName ?? null,
              holdReason: step?.holdReason ?? current.holdReason ?? null,
              targetMg: step?.targetMg ?? null,
              tolMinusMg: step?.tolMinusMg ?? null,
              tolPlusMg: step?.tolPlusMg ?? null,
              tareGrossMg: step?.tareGrossMg ?? null,
              stepStartedAt: step?.startedAt?.toISOString() ?? null,
              startedAt: current.startedAt?.toISOString() ?? null,
            }
          : null,
        scaleGrossMg: scale.connected ? scale.grossMg : null,
        scaleStable: scale.stable,
      };
    }),
    calls: calls.map((c) => ({ id: c.id, stationCode: c.station.code, stationName: c.station.name, batchId: c.batchId, seq: c.seq, reason: c.reason, status: c.status, raisedBy: c.raisedBy.name, createdAt: c.createdAt.toISOString() })),
    batches: batches.map((b) => ({
      id: b.id,
      batchNo: b.batchNo,
      perfumeName: b.formula.perfumeName,
      formula: `${b.formula.code} rev ${b.formula.revision}`,
      operator: b.operator.name,
      station: b.station.code,
      status: b.status,
      simulated: b.simulated,
      done: b.steps.filter((x) => x.status === 'COMPLETED').length,
      total: b.steps.length,
      skipped: b.steps.filter((x) => x.status === 'SKIPPED').length,
      labReady: b.status === 'AWAITING_LAB' && b.steps.some((x) => x.status === 'LOCKED'),
      assignedAt: b.assignedAt.toISOString(),
      submittedAt: b.submittedAt?.toISOString() ?? null,
      /** Not one of the newest rows: listed because it waits for the lab or for approval. */
      older: !seen.has(b.id),
    })),
    operators: operators.map((o) => ({
      id: o.id,
      operatorCode: o.operatorCode,
      name: o.name,
      active: o.active,
      locked: !!o.lockedUntil && o.lockedUntil.getTime() > Date.now(),
      stations: o.stationAccess.map((a) => a.station.code),
      credentials: o.credentials.map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt.toISOString(), lastUsedAt: c.lastUsedAt?.toISOString() ?? null })),
    })),
    formulas: formulas.map((f) => ({ id: f.id, code: f.code, revision: f.revision, perfumeName: f.perfumeName, lines: f._count.lines, batchSizeMg: f.batchSizeMg })),
  };
}

async function nextBatchNo(): Promise<string> {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const prefix = `PB-${ymd}-`;
  const last = await db().batch.findFirst({ where: { batchNo: { startsWith: prefix } }, orderBy: { batchNo: 'desc' } });
  const n = last ? Number(last.batchNo.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(2, '0')}`;
}

export interface AssignInput {
  formulaId: string;
  operatorId: string;
  stationId: string;
  backupOperatorId?: string | null;
  plannedStart?: string | null;
  instructions?: string | null;
  /** Ingredients (by sequence number) that go for lab test: skipped from the start. */
  labSeqs?: number[];
}

/** Assign a job. The steps are a frozen snapshot of the approved formula revision (traceability). */
export async function assignJob(actor: Actor, input: AssignInput) {
  const formula = await db().formula.findUnique({ where: { id: input.formulaId }, include: { lines: { orderBy: { seq: 'asc' }, include: { ingredient: true } } } });
  if (!formula) throw notFound('Formula');
  if (formula.status !== 'APPROVED') throw conflict('Only an approved formula revision can be assigned.', 'FORMULA_NOT_APPROVED');
  if (!formula.lines.length) throw conflict('This formula has no ingredients.', 'NO_STEPS');
  const labSeqs = new Set(input.labSeqs ?? []);
  for (const seq of labSeqs) if (!formula.lines.some((l) => l.seq === seq)) throw badRequest(`Ingredient #${seq} is not in this formula.`, 'BAD_STEP');
  if (formula.lines.every((l) => labSeqs.has(l.seq))) throw badRequest('At least one ingredient must not go for lab test, so the operator can start.', 'LAST_INGREDIENT');
  const access = await db().stationAccess.findUnique({ where: { userId_stationId: { userId: input.operatorId, stationId: input.stationId } } });
  if (!access) throw badRequest('That operator is not authorised for that station.', 'NO_STATION_ACCESS');
  if (input.backupOperatorId) {
    if (input.backupOperatorId === input.operatorId) throw badRequest('The backup operator must be a different person.', 'SAME_BACKUP');
    const b = await db().stationAccess.findUnique({ where: { userId_stationId: { userId: input.backupOperatorId, stationId: input.stationId } } });
    if (!b) throw badRequest('The backup operator is not authorised for that station.', 'NO_STATION_ACCESS');
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const batchNo = await nextBatchNo();
    try {
      const batch = await db().$transaction(async (tx) => {
        const created = await tx.batch.create({
          data: {
            batchNo,
            formulaId: formula.id,
            stationId: input.stationId,
            operatorId: input.operatorId,
            backupOperatorId: input.backupOperatorId || null,
            plannedStart: input.plannedStart ? new Date(input.plannedStart) : null,
            instructions: input.instructions?.trim() || null,
            processOrder: formula.processOrder ?? undefined,
            assignedById: actor.userId!,
            steps: {
              create: formula.lines.map((l) => ({
                ...(labSeqs.has(l.seq)
                  ? { status: 'SKIPPED' as const, skippedAt: new Date(), skippedById: actor.userId!, skipNote: 'Goes for lab test (marked when the job was assigned)' }
                  : {}),
                storageLocation: l.storageLocation,
                sourceBatch: l.sourceBatch,
                uom: l.uom,
                seq: l.seq,
                ingredientId: l.ingredientId,
                ingredientCode: l.ingredient.code,
                ingredientName: l.ingredient.name,
                targetMg: l.targetMg,
                tolMinusMg: l.tolMinusMg,
                tolPlusMg: l.tolPlusMg,
                remarks: l.remarks,
              })),
            },
          },
        });
        await audit(tx, {
          type: 'JOB_ASSIGNED', outcome: 'SUCCESS', ...actor, batchId: created.id, newState: 'ASSIGNED',
          details: { batchNo, formula: `${formula.code} rev ${formula.revision}`, operatorId: input.operatorId, stationId: input.stationId, backupOperatorId: input.backupOperatorId ?? null, labTest: [...labSeqs] },
        });
        for (const l of formula.lines.filter((x) => labSeqs.has(x.seq))) {
          await audit(tx, {
            type: 'INGREDIENT_SKIPPED', outcome: 'SUCCESS', ...actor, batchId: created.id, prevState: 'LOCKED/ASSIGNED', newState: 'SKIPPED/ASSIGNED',
            details: { seq: l.seq, ingredient: l.ingredient.code, ingredientName: l.ingredient.name, note: 'Goes for lab test (marked when the job was assigned)' },
          });
        }
        return created;
      });
      emitJobs(input.stationId);
      return { id: batch.id, batchNo: batch.batchNo };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002' && attempt < 2) continue;
      throw err;
    }
  }
  throw conflict('Could not create a batch number. Please try again.');
}

/** An approved formula's lines, for the assign screen (which ones go for lab test). */
export async function formulaDetail(formulaId: string) {
  const f = await db().formula.findUnique({ where: { id: formulaId }, include: { lines: { orderBy: { seq: 'asc' }, include: { ingredient: { select: { code: true, name: true } } } } } });
  if (!f) throw notFound('Formula');
  return {
    id: f.id,
    code: f.code,
    revision: f.revision,
    perfumeName: f.perfumeName,
    status: f.status,
    batchSizeMg: f.batchSizeMg,
    processOrder: (f.processOrder as Record<string, string> | null) ?? null,
    hasPdf: !!f.sourceFileName?.toLowerCase().endsWith('.pdf'),
    lines: f.lines.map((l) => ({ seq: l.seq, code: l.ingredient.code, name: l.ingredient.name, targetMg: l.targetMg, uom: l.uom, storageLocation: l.storageLocation, sourceBatch: l.sourceBatch, labTest: l.labTest })),
  };
}

export async function setCallStatus(actor: Actor, callId: string, status: 'ACKNOWLEDGED' | 'CLOSED') {
  const call = await db().supervisorCall.findUnique({ where: { id: callId } });
  if (!call) throw notFound('Call');
  await db().$transaction(async (tx) => {
    await tx.supervisorCall.update({
      where: { id: callId },
      data: status === 'ACKNOWLEDGED' ? { status, acknowledgedAt: new Date(), acknowledgedById: actor.userId } : { status, closedAt: new Date(), closedById: actor.userId },
    });
    await audit(tx, { type: status === 'ACKNOWLEDGED' ? 'SUPERVISOR_CALL_ACKNOWLEDGED' : 'SUPERVISOR_CALL_CLOSED', outcome: 'SUCCESS', ...actor, stationId: call.stationId, batchId: call.batchId, prevState: call.status, newState: status, details: { callId, reason: call.reason } });
  });
  emitCalls(call.stationId);
}

export interface StationSettings {
  allowFingerprint?: boolean;
  allowFace?: boolean;
  allowPin?: boolean;
  allowAssisted?: boolean;
  defaultLanguage?: 'en' | 'hi' | 'ml';
  audioEnabled?: boolean;
  audioVolume?: number;
  allowPause?: boolean;
  autoAccept?: boolean;
  idleMinutes?: number;
}

export async function updateStation(actor: Actor, stationId: string, patch: StationSettings) {
  const before = await db().station.findUnique({ where: { id: stationId } });
  if (!before) throw notFound('Station');
  const after = await db().$transaction(async (tx) => {
    const s = await tx.station.update({ where: { id: stationId }, data: patch });
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v).map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k], to: v }]));
    await audit(tx, { type: 'STATION_SETTINGS_CHANGED', outcome: 'SUCCESS', ...actor, stationId, details: { station: s.code, changed } });
    return s;
  });
  configureStation(after);
  emitStation(stationId);
  return toStationInfo(after);
}

/** How long a zero reading stays usable for the second step of a scale check. */
const ZERO_VALID_MS = 10 * 60_000;
/** Zero readings taken in step 1 of a scale check, per station. Never sent by the screen. */
const scaleZeros = new Map<string, { mg: number; at: number; by: string }>();

/** A reading the scale check may use: from the scale itself, connected, recent and stable. */
function checkReading(stationId: string) {
  const state = readScale(stationId);
  const snap = toSnapshot(state);
  if (!snap.connected || snap.grossMg == null) throw conflict('The scale is not connected. Check the cable or the scale bridge, then try again.', 'SCALE_DISCONNECTED');
  if (!snap.stable) throw conflict('The reading is not steady yet. Wait until the scale settles, then try again.', 'SCALE_UNSTABLE');
  return { grossMg: snap.grossMg, simulated: state.mode === 'SIMULATED' };
}

/**
 * Daily scale check, step 1: with the pan empty, the server reads the scale's
 * zero. The value is kept here on the server, never sent back by the screen.
 */
export async function readScaleZero(actor: Actor, stationId: string) {
  const st = await db().station.findUnique({ where: { id: stationId } });
  if (!st) throw notFound('Station');
  const r = checkReading(stationId);
  const at = Date.now();
  scaleZeros.set(stationId, { mg: r.grossMg, at, by: actor.userId! });
  return { zeroMg: r.grossMg, at: new Date(at).toISOString(), validForSec: ZERO_VALID_MS / 1000 };
}

/**
 * Daily scale check, step 2: with the reference weight on the pan, the server
 * reads the scale again. Observed = reading − zero. Within the scale's stated
 * uncertainty → validated for 24 h. Nothing typed on the screen is a weight.
 *
 * The training simulator has no pan to put a weight on: there the reference
 * weight is added by the simulator itself and the check is recorded as simulated.
 */
export async function validateScale(actor: Actor, stationId: string, referenceMg: number, note: string) {
  const st = await db().station.findUnique({ where: { id: stationId } });
  if (!st) throw notFound('Station');
  const zero = scaleZeros.get(stationId);
  if (!zero || zero.by !== actor.userId || Date.now() - zero.at > ZERO_VALID_MS) {
    throw conflict('Read the zero first: empty the scale and press "Read zero".', 'ZERO_NEEDED');
  }
  const r = checkReading(stationId);
  const res = Math.max(1, st.scaleResolutionMg);
  const observedMg = r.simulated ? Math.round(referenceMg / res) * res : r.grossMg - zero.mg;
  if (!r.simulated && observedMg < referenceMg / 2) {
    throw conflict('The scale reads almost the same as the zero. Place the reference weight on the pan, wait until it is steady, then press Check.', 'NO_WEIGHT');
  }
  scaleZeros.delete(stationId);
  const errorMg = observedMg - referenceMg;
  const pass = Math.abs(errorMg) <= st.scaleUncertaintyMg;
  const now = new Date();
  const updated = await db().$transaction(async (tx) => {
    const s = await tx.station.update({
      where: { id: stationId },
      data: pass ? { scaleValidatedUntil: new Date(now.getTime() + 24 * 3600_000), scaleValidatedAt: now, scaleValidatedById: actor.userId } : { scaleValidatedUntil: null },
    });
    await audit(tx, {
      type: 'SCALE_VALIDATION', outcome: pass ? 'SUCCESS' : 'FAILED', ...actor, stationId,
      prevState: scaleValidated(st) ? 'VALIDATED' : 'NOT_VALIDATED', newState: pass ? 'VALIDATED' : 'NOT_VALIDATED',
      details: {
        station: st.code, scaleModel: st.scaleModel, source: r.simulated ? 'SIMULATED' : 'SCALE',
        zeroMg: zero.mg, zeroAt: new Date(zero.at).toISOString(), readingMg: r.simulated ? null : r.grossMg,
        referenceMg, observedMg, errorMg, allowedMg: st.scaleUncertaintyMg, note,
      },
    });
    return s;
  });
  emitStation(stationId);
  return { pass, errorMg, observedMg, simulated: r.simulated, station: toStationInfo(updated) };
}

/**
 * One day on the floor: jobs finished, problems raised, how quickly calls were
 * answered, and per-operator figures. `date` is YYYY-MM-DD in plant local time.
 */
export async function shiftReport(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const from = new Date(y, m - 1, d);
  const to = new Date(y, m - 1, d + 1);
  const inDay = { gte: from, lt: to };

  const [batches, calls, deviations] = await Promise.all([
    db().batch.findMany({
      where: { OR: [{ startedAt: inDay }, { completedAt: inDay }, { submittedAt: inDay }] },
      orderBy: { startedAt: 'asc' },
      include: {
        formula: { select: { perfumeName: true, code: true, revision: true } },
        operator: { select: { id: true, name: true, operatorCode: true } },
        station: { select: { code: true, name: true } },
        steps: { select: { status: true, wrongScans: true, startedAt: true, acceptedAt: true, targetMg: true, acceptedNetMg: true } },
      },
    }),
    db().supervisorCall.findMany({ where: { createdAt: inDay }, include: { station: { select: { code: true } } } }),
    db().deviation.findMany({
      where: { raisedAt: inDay },
      orderBy: { raisedAt: 'asc' },
      include: { step: { select: { seq: true, ingredientName: true } }, batch: { select: { batchNo: true, station: { select: { code: true } }, operator: { select: { name: true } } } } },
    }),
  ]);

  type OpRow = { operatorId: string; name: string; operatorCode: string | null; jobs: number; jobsFinished: number; ingredients: number; wrongScans: number; problems: number; secondsTotal: number };
  const ops = new Map<string, OpRow>();
  for (const b of batches) {
    const row = ops.get(b.operator.id) ?? { operatorId: b.operator.id, name: b.operator.name, operatorCode: b.operator.operatorCode, jobs: 0, jobsFinished: 0, ingredients: 0, wrongScans: 0, problems: 0, secondsTotal: 0 };
    row.jobs++;
    if (b.completedAt) row.jobsFinished++;
    for (const s of b.steps) {
      row.wrongScans += s.wrongScans;
      if (s.acceptedAt && s.startedAt && s.acceptedAt >= from && s.acceptedAt < to) {
        row.ingredients++;
        row.secondsTotal += (s.acceptedAt.getTime() - s.startedAt.getTime()) / 1000;
      }
    }
    ops.set(b.operator.id, row);
  }
  for (const dv of deviations) {
    const b = batches.find((x) => x.id === dv.batchId);
    const row = b && ops.get(b.operator.id);
    if (row) row.problems++;
  }

  const answered = calls.filter((c) => c.acknowledgedAt || c.closedAt);
  const responseSec = answered.map((c) => ((c.acknowledgedAt ?? c.closedAt)!.getTime() - c.createdAt.getTime()) / 1000);

  return {
    date,
    totals: {
      jobsStarted: batches.filter((b) => b.startedAt && b.startedAt >= from && b.startedAt < to).length,
      jobsFinished: batches.filter((b) => b.completedAt && b.completedAt >= from && b.completedAt < to).length,
      jobsSubmitted: batches.filter((b) => b.submittedAt && b.submittedAt >= from && b.submittedAt < to).length,
      ingredients: [...ops.values()].reduce((s, o) => s + o.ingredients, 0),
      problems: deviations.length,
      problemsOpen: deviations.filter((d) => !d.resolvedAt).length,
      calls: calls.length,
      avgCallResponseSec: responseSec.length ? Math.round(responseSec.reduce((a, b) => a + b, 0) / responseSec.length) : null,
      wrongScans: [...ops.values()].reduce((s, o) => s + o.wrongScans, 0),
    },
    operators: [...ops.values()]
      .map(({ secondsTotal, ...o }) => ({ ...o, avgSecPerIngredient: o.ingredients ? Math.round(secondsTotal / o.ingredients) : null }))
      .sort((a, b) => b.ingredients - a.ingredients),
    batches: batches.map((b) => ({
      id: b.id,
      batchNo: b.batchNo,
      perfumeName: b.formula.perfumeName,
      formula: `${b.formula.code} rev ${b.formula.revision}`,
      operator: b.operator.name,
      station: b.station.code,
      status: b.status,
      simulated: b.simulated,
      done: b.steps.filter((s) => s.status === 'COMPLETED').length,
      total: b.steps.length,
      startedAt: b.startedAt?.toISOString() ?? null,
      completedAt: b.completedAt?.toISOString() ?? null,
      minutes: b.startedAt && b.completedAt ? Math.round((b.completedAt.getTime() - b.startedAt.getTime()) / 60000) : null,
    })),
    deviations: deviations.map((dv) => ({
      id: dv.id,
      batchNo: dv.batch.batchNo,
      station: dv.batch.station.code,
      operator: dv.batch.operator.name,
      seq: dv.step?.seq ?? null,
      ingredient: dv.step?.ingredientName ?? null,
      type: dv.type,
      raisedAt: dv.raisedAt.toISOString(),
      resolvedAt: dv.resolvedAt?.toISOString() ?? null,
      resolution: dv.resolution,
      note: dv.resolutionNote,
    })),
  };
}

/**
 * Everything one operator did on one day, in order: sign-in, each job and every
 * step inside it (find, scan, container + zero, weights, pauses), problems and
 * supervisor help on their jobs, through to sign-out. Built from the
 * append-only audit trail, so it is the same record auditors see.
 */
export async function operatorActivity(operatorId: string, date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const from = new Date(y, m - 1, d);
  const to = new Date(y, m - 1, d + 1);
  const operator = await db().user.findUnique({ where: { id: operatorId }, select: { id: true, name: true, operatorCode: true, role: true } });
  if (!operator || operator.role !== 'OPERATOR') throw notFound('Operator');

  // Their own actions, plus what the system or a supervisor did on their jobs (overweight holds, sign-offs).
  const own = await db().batch.findMany({ where: { OR: [{ operatorId }, { backupOperatorId: operatorId }] }, select: { id: true } });
  const events = await db().auditEvent.findMany({
    where: { at: { gte: from, lt: to }, OR: [{ userId: operatorId }, { batchId: { in: own.map((b) => b.id) }, NOT: { userId: operatorId } }] },
    orderBy: { seqNo: 'asc' },
    take: 5000,
  });
  const batchIds = [...new Set(events.map((e) => e.batchId).filter((x): x is string => !!x))];
  const actorIds = [...new Set(events.map((e) => e.userId).filter((x): x is string => !!x && x !== operatorId))];
  const [batches, stations, actors] = await Promise.all([
    db().batch.findMany({
      where: { id: { in: batchIds } },
      include: { formula: { select: { perfumeName: true, code: true, revision: true } }, station: { select: { code: true } }, steps: { select: { status: true, acceptedAt: true } } },
    }),
    db().station.findMany({ select: { id: true, code: true, name: true } }),
    db().user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }),
  ]);
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const stationById = new Map(stations.map((s) => [s.id, s]));
  const actorById = new Map(actors.map((a) => [a.id, a.name]));

  // Pauses: each JOB_PAUSED until the next JOB_RESUMED of the same job (or the end of the log).
  let pausedSec = 0;
  const pausedAt = new Map<string, Date>();
  for (const e of events) {
    if (e.type === 'JOB_PAUSED' && e.outcome === 'SUCCESS' && e.batchId) pausedAt.set(e.batchId, e.at);
    if (e.type === 'JOB_RESUMED' && e.outcome === 'SUCCESS' && e.batchId && pausedAt.has(e.batchId)) {
      pausedSec += (e.at.getTime() - pausedAt.get(e.batchId)!.getTime()) / 1000;
      pausedAt.delete(e.batchId);
    }
  }
  const mine = events.filter((e) => e.userId === operatorId);
  const signIns = mine.filter((e) => e.type === 'AUTH_SUCCESS');
  const signOuts = mine.filter((e) => e.type === 'SIGN_OUT');
  const firstAt = mine[0]?.at ?? null;
  const lastAt = mine.at(-1)?.at ?? null;

  return {
    date,
    operator: { id: operator.id, name: operator.name, operatorCode: operator.operatorCode },
    summary: {
      firstSignIn: signIns[0]?.at.toISOString() ?? null,
      lastSignOut: signOuts.at(-1)?.at.toISOString() ?? null,
      firstActivity: firstAt?.toISOString() ?? null,
      lastActivity: lastAt?.toISOString() ?? null,
      signIns: signIns.length,
      jobsStarted: mine.filter((e) => e.type === 'JOB_STARTED' && e.outcome === 'SUCCESS').length,
      jobsSubmitted: mine.filter((e) => e.type === 'BATCH_SUBMITTED' && e.outcome === 'SUCCESS').length,
      ingredients: mine.filter((e) => e.type === 'WEIGHT_ACCEPTED').length,
      wrongScans: mine.filter((e) => e.type === 'BARCODE_SCAN' && e.outcome === 'REJECTED').length,
      problems: events.filter((e) => e.type === 'WEIGHT_OVER' || (e.type === 'VESSEL_CHANGED' && e.outcome === 'REJECTED')).length,
      pausedSec: Math.round(pausedSec),
    },
    jobs: batches
      .map((b) => ({
        id: b.id,
        batchNo: b.batchNo,
        perfumeName: b.formula.perfumeName,
        formula: `${b.formula.code} rev ${b.formula.revision}`,
        station: b.station.code,
        status: b.status,
        simulated: b.simulated,
        done: b.steps.filter((s) => s.status === 'COMPLETED').length,
        total: b.steps.length,
        startedAt: b.startedAt?.toISOString() ?? null,
        completedAt: b.completedAt?.toISOString() ?? null,
        submittedAt: b.submittedAt?.toISOString() ?? null,
      }))
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')),
    events: events.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      type: e.type,
      outcome: e.outcome,
      batchNo: e.batchId ? (batchById.get(e.batchId)?.batchNo ?? null) : null,
      station: e.stationId ? (stationById.get(e.stationId)?.code ?? null) : null,
      /** Who did it when it was not the operator: a supervisor's name, or SYSTEM for the scale. */
      by: e.userId === operatorId ? (e.role === 'SYSTEM' ? 'SYSTEM' : null) : e.role === 'SYSTEM' ? 'SYSTEM' : (actorById.get(e.userId ?? '') ?? e.role ?? null),
      details: e.details as Record<string, unknown>,
    })),
  };
}

/**
 * One job for the supervisor: every ingredient with its state (including those
 * skipped for the lab), plus who did the work — the basis of the final report.
 */
export async function batchDetail(batchId: string) {
  const b = await db().batch.findUnique({
    where: { id: batchId },
    include: {
      operator: { select: { id: true, name: true, operatorCode: true } },
      station: { select: { id: true, code: true, name: true, scaleResolutionMg: true, scaleModel: true, scaleValidatedAt: true, scaleValidatedById: true } },
      steps: { select: { seq: true, skippedById: true, labReleasedById: true, completedById: true } },
      deviations: { select: { id: true, resolvedById: true } },
      readings: { where: { purpose: 'ACCEPTED' }, select: { scaleModel: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!b) throw notFound('Job');

  // The scale check that covered this batch: the last one passed before its first saved weight.
  const firstWeight = b.readings[0]?.createdAt ?? null;
  const check = firstWeight
    ? await db().auditEvent.findFirst({ where: { type: 'SCALE_VALIDATION', outcome: 'SUCCESS', stationId: b.stationId, at: { lte: firstWeight } }, orderBy: { at: 'desc' } })
    : null;
  let checkedAt = check?.at ?? null;
  let checkedById = check?.userId ?? null;
  // A check recorded at installation has no audit event; the station still knows it.
  if (!check && firstWeight && b.station.scaleValidatedAt && b.station.scaleValidatedAt <= firstWeight) {
    checkedAt = b.station.scaleValidatedAt;
    checkedById = b.station.scaleValidatedById;
  }

  const ids = [
    ...new Set(
      [b.submittedById, b.assignedById, b.approvedById, b.rejectedById, checkedById, ...b.steps.flatMap((s) => [s.skippedById, s.labReleasedById]), ...b.deviations.map((d) => d.resolvedById)].filter(
        (x): x is string => !!x,
      ),
    ),
  ];
  const people = new Map((await db().user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const name = (id: string | null | undefined) => (id ? (people.get(id) ?? null) : null);
  const models = [...new Set(b.readings.map((r) => r.scaleModel))];
  return {
    run: await buildRun(batchId),
    operator: { id: b.operator.id, name: b.operator.name, operatorCode: b.operator.operatorCode },
    station: { code: b.station.code, name: b.station.name, scaleResolutionMg: b.station.scaleResolutionMg },
    /** People who weighed on this batch (operator, backup): they may not approve it. */
    workerIds: [...new Set([b.operatorId, b.backupOperatorId, ...b.steps.map((s) => s.completedById)].filter((x): x is string => !!x))],
    assignedBy: people.get(b.assignedById) ?? null,
    assignedAt: b.assignedAt.toISOString(),
    submittedBy: name(b.submittedById),
    scale: {
      model: models.length ? models.join(', ') : b.station.scaleModel,
      checkedAt: checkedAt?.toISOString() ?? null,
      checkedBy: name(checkedById),
      validUntil: checkedAt ? new Date(checkedAt.getTime() + 24 * 3600_000).toISOString() : null,
    },
    decision: b.approvedAt
      ? { kind: 'APPROVED' as const, by: name(b.approvedById), at: b.approvedAt.toISOString(), note: b.approvalNote }
      : b.rejectedAt
        ? { kind: 'REJECTED' as const, by: name(b.rejectedById), at: b.rejectedAt.toISOString(), note: b.rejectReason }
        : null,
    /** Who resolved each problem, by deviation id. */
    resolvedBy: Object.fromEntries(b.deviations.filter((d) => d.resolvedById).map((d) => [d.id, name(d.resolvedById)])) as Record<string, string | null>,
    lab: Object.fromEntries(
      b.steps
        .filter((s) => s.skippedById || s.labReleasedById)
        .map((s) => [s.seq, { skippedBy: name(s.skippedById), releasedBy: name(s.labReleasedById) }]),
    ) as Record<number, { skippedBy: string | null; releasedBy: string | null }>,
  };
}

const MAX_PASSWORD_FAILS = 5;
const LOCK_MINUTES = 15;

/**
 * The signed-in supervisor re-enters their own password to sign a decision.
 * Wrong passwords count towards the same lock-out as signing in.
 */
async function confirmPassword(actor: Actor, password: string, batchId: string, purpose: string) {
  const user = await db().user.findUnique({ where: { id: actor.userId ?? '' } });
  if (!user || !user.active || user.role !== 'SUPERVISOR') throw forbidden('Only a scientist can approve or reject a batch.', 'NOT_SUPERVISOR');
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw new AppError(429, 'Too many wrong passwords. Please wait 15 minutes or ask another scientist to unlock you.', 'LOCKED');
  if (await verifySecret(password, user.passwordHash)) {
    if (user.failedAttempts) await db().user.update({ where: { id: user.id }, data: { failedAttempts: 0 } });
    return user;
  }
  const fails = user.failedAttempts + 1;
  const locked = fails >= MAX_PASSWORD_FAILS;
  await db().user.update({ where: { id: user.id }, data: { failedAttempts: locked ? 0 : fails, lockedUntil: locked ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil } });
  await auditNow({ type: 'AUTH_FAILED', outcome: 'FAILED', ...actor, batchId, details: { method: purpose, reason: 'WRONG_PASSWORD', lockedOut: locked } });
  if (locked) throw new AppError(429, 'Too many wrong passwords. Please wait 15 minutes or ask another scientist to unlock you.', 'LOCKED');
  throw new AppError(403, 'That password is not correct.', 'WRONG_PASSWORD');
}

export interface Decision {
  decision: 'APPROVE' | 'REJECT';
  password: string;
  note: string;
  version?: number;
}

/**
 * A supervisor approves or rejects a submitted batch, signing with their own
 * password. never the person who weighed it, and a
 * batch weighed on the training simulator can never be approved as production.
 * Rejection needs a reason. Only the approv… / reject… columns, status and
 * version change: the weighing record itself stays exactly as submitted.
 */
export async function decideBatch(actor: Actor, batchId: string, input: Decision) {
  if (actor.role !== 'SUPERVISOR') throw forbidden('Only a scientist can approve or reject a batch.', 'NOT_SUPERVISOR');
  const note = input.note.trim();
  const approve = input.decision === 'APPROVE';
  if (!approve && note.length < 3) throw badRequest('Write why the batch is rejected.', 'REASON_REQUIRED');
  const b = await db().batch.findUnique({ where: { id: batchId }, include: { steps: { select: { completedById: true } }, deviations: { select: { resolvedAt: true } } } });
  if (!b) throw notFound('Job');
  const type = approve ? 'BATCH_APPROVED' : 'BATCH_REJECTED';
  const refuse = async (err: AppError): Promise<never> => {
    await auditNow({ type, outcome: 'REJECTED', ...actor, batchId, prevState: b.status, details: { batchNo: b.batchNo, reason: err.code, message: err.message } });
    throw err;
  };

  if (b.status !== 'SUBMITTED') await refuse(conflict(b.status === 'APPROVED' || b.status === 'REJECTED' ? 'This batch has already been decided.' : 'Only a batch the operator has sent can be approved or rejected.', 'NOT_SUBMITTED'));
  if (input.version !== undefined && input.version !== b.version) throw conflict('The screen was out of date and has been refreshed. Please check and try again.', 'STALE');
  const workers = new Set([b.operatorId, b.backupOperatorId, ...b.steps.map((s) => s.completedById)].filter(Boolean));
  if (workers.has(actor.userId)) await refuse(forbidden('You weighed this batch, so another scientist must review it.', 'OWN_BATCH'));
  if (approve && b.simulated) await refuse(conflict('This batch was weighed on the training simulator. A training record cannot be approved as production.', 'TRAINING_RECORD'));
  if (approve && b.deviations.some((d) => !d.resolvedAt)) await refuse(conflict('A problem on this batch is still open. Resolve it before approving.', 'OPEN_PROBLEM'));

  await confirmPassword(actor, input.password, batchId, approve ? 'BATCH_APPROVAL' : 'BATCH_REJECTION');

  const now = new Date();
  const newState = approve ? 'APPROVED' : 'REJECTED';
  await db().$transaction(async (tx) => {
    const r = await tx.batch.updateMany({
      where: { id: batchId, status: 'SUBMITTED', version: b.version },
      data: approve
        ? { status: 'APPROVED', approvedById: actor.userId, approvedAt: now, approvalNote: note || null, version: { increment: 1 } }
        : { status: 'REJECTED', rejectedById: actor.userId, rejectedAt: now, rejectReason: note, version: { increment: 1 } },
    });
    if (r.count !== 1) throw conflict('Someone else changed this batch a moment ago. Please check and try again.', 'STALE');
    await audit(tx, {
      type, outcome: 'SUCCESS', ...actor, batchId, prevState: 'SUBMITTED', newState,
      details: { batchNo: b.batchNo, note: note || null, passwordConfirmed: true, operatorId: b.operatorId, simulated: b.simulated },
    });
  });
  emitJobs(b.stationId);
  return { status: newState, at: now.toISOString() };
}

export async function revokeCredential(actor: Actor, credentialId: string) {
  const c = await db().webAuthnCredential.findUnique({ where: { id: credentialId } });
  if (!c || c.revokedAt) throw notFound('Registered device');
  await db().$transaction(async (tx) => {
    await tx.webAuthnCredential.update({ where: { id: credentialId }, data: { revokedAt: new Date() } });
    await audit(tx, { type: 'CREDENTIAL_REVOKED', outcome: 'SUCCESS', ...actor, details: { operatorId: c.userId, label: c.label } });
  });
}

export async function unlockUser(actor: Actor, userId: string) {
  await db().$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { failedAttempts: 0, lockedUntil: null } });
    await audit(tx, { type: 'ACCOUNT_UNLOCKED', outcome: 'SUCCESS', ...actor, details: { userId } });
  });
}
