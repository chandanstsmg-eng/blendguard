/**
 * Manufacturing state machine (spec §7 and §15). Every rule is enforced here,
 * on the server, inside a transaction that holds a row lock on the batch:
 *
 *   batch:  ASSIGNED → IN_PROGRESS ⇄ PAUSED
 *                       IN_PROGRESS ⇄ ON_HOLD (supervisor)
 *                       IN_PROGRESS → AWAITING_SUBMISSION → SUBMITTED (locked)
 *                       IN_PROGRESS → AWAITING_LAB → IN_PROGRESS (lab ingredient released, operator continues)
 *
 *   step:   LOCKED → CURRENT[FIND → SCAN → WEIGH] → COMPLETED[DONE]
 *                     CURRENT ⇄ ON_HOLD (vessel changed; scientist releases)
 *           Too much poured: no hold. The alarm sounds, the operator takes the extra out,
 *           and the over-pour (recorded as a problem) closes when the corrected weight is saved.
 *           LOCKED / CURRENT (before zeroing) → SKIPPED (supervisor, until the lab report)
 *           SKIPPED → LOCKED (supervisor: lab ingredient arrived)
 *
 * When only skipped ingredients are left the batch waits in AWAITING_LAB. It
 * does not occupy the station, so the operator can work on other jobs meanwhile.
 *
 * Exactly one step is CURRENT (or ON_HOLD) while a batch runs. The next step
 * becomes CURRENT in the same transaction that commits the previous step's
 * accepted weight, so it can never unlock before that commit (rule 10).
 *
 * Expected rejections (wrong barcode, weight out of range…) are committed and
 * returned as results — they must be recorded (rule 11). Requests that break
 * the sequence are refused with an AppError and audited as REJECTED.
 */
import type { Batch, BatchStep, Prisma, ReadingPurpose, ReadingVerdict, Station } from '@prisma/client';
import { db, type Tx } from '../db/prisma.js';
import { AppError, badRequest, conflict, forbidden } from '../utils/errors.js';
import { readSignoff } from '../utils/crypto.js';
import { audit, auditNow, type Actor } from './audit.service.js';
import { buildRun } from './run.service.js';
import { emitCalls, emitJobs, emitRun } from './realtime.service.js';
import { readScale, readingSource, simNewJob, simUseContainer, toSnapshot, type SimAction } from './scale.service.js';
import { scaleValidated } from './session.service.js';
import { acceptanceWindow, evaluate, type Evaluation, type ScaleSnapshot } from '../../shared/weighing.js';
import type { AcceptResult, RunState, ScaleState, ScanResult, SessionUser } from '../../shared/types.js';

export interface Ctx {
  user: SessionUser;
  station: Station;
  device: string;
}

type LoadedBatch = Batch & { steps: BatchStep[] };

const actorOf = (ctx: Ctx): Actor => ({ userId: ctx.user.id, role: ctx.user.role, stationId: ctx.station.id, sourceDevice: ctx.device });

const stepState = (s: Pick<BatchStep, 'status' | 'stage'>) => `${s.status}/${s.stage}`;

async function lockBatch(tx: Tx, batchId: string): Promise<LoadedBatch> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Batch" WHERE id = ${batchId} FOR UPDATE`;
  if (!locked.length) throw new AppError(404, 'Job not found.', 'NOT_FOUND');
  return tx.batch.findUniqueOrThrow({ where: { id: batchId }, include: { steps: { orderBy: { seq: 'asc' } } } });
}

/** Rule 2: only the assigned (or backup) operator, on the batch's station, with station access. */
async function assertOperatorAccess(tx: Tx, ctx: Ctx, b: Batch) {
  if (ctx.user.role !== 'OPERATOR') throw forbidden('Only the assigned operator can run this job.', 'NOT_OPERATOR');
  if (b.stationId !== ctx.station.id) throw forbidden('This job belongs to another station.', 'WRONG_STATION');
  if (b.operatorId !== ctx.user.id && b.backupOperatorId !== ctx.user.id) throw forbidden('This job is not assigned to you.', 'NOT_ASSIGNED');
  const access = await tx.stationAccess.findUnique({ where: { userId_stationId: { userId: ctx.user.id, stationId: ctx.station.id } } });
  if (!access) throw forbidden('You are not authorised for this station.', 'NO_STATION_ACCESS');
}

function activeStep(b: LoadedBatch) {
  return b.steps.find((s) => s.status === 'CURRENT' || s.status === 'ON_HOLD') ?? null;
}

/** The step whose weight was saved last (by time, not by number). */
function lastSaved<S extends Pick<BatchStep, 'acceptedAt' | 'seq'>>(steps: S[]): S | undefined {
  return steps.reduce<S | undefined>((best, s) => (!best || (s.acceptedAt?.getTime() ?? 0) > (best.acceptedAt?.getTime() ?? 0) || ((s.acceptedAt?.getTime() ?? 0) === (best.acceptedAt?.getTime() ?? 0) && s.seq > best.seq) ? s : best), undefined);
}

/** The next ingredient to do: the next one in order, else an earlier one released from the lab. */
function nextLocked(b: LoadedBatch, afterSeq: number) {
  return b.steps.find((s) => s.seq > afterSeq && s.status === 'LOCKED') ?? b.steps.find((s) => s.status === 'LOCKED') ?? null;
}

function assertRunning(b: Batch) {
  if (b.status === 'PAUSED') throw conflict('This job is paused.', 'PAUSED');
  if (b.status === 'ON_HOLD') throw conflict('This job is on hold. Call your scientist.', 'BATCH_ON_HOLD');
  if (b.status !== 'IN_PROGRESS') throw conflict('This job is not in progress.', 'NOT_IN_PROGRESS');
}

/** Rules 4, 9: the request must be for the current ingredient, at the expected stage. */
function currentStepFor(b: LoadedBatch, seq: number, stage: BatchStep['stage'] | BatchStep['stage'][]) {
  assertRunning(b);
  const step = activeStep(b);
  if (!step || step.seq !== seq) throw conflict('Ingredients must be done in the set order.', 'NOT_CURRENT_STEP', { currentSeq: step?.seq ?? null });
  if (step.status === 'ON_HOLD') throw conflict('This ingredient is on hold. Call your scientist.', 'STEP_ON_HOLD');
  if (!(Array.isArray(stage) ? stage : [stage]).includes(step.stage)) throw conflict('That action is not available at this point.', 'WRONG_STAGE', { stage: step.stage });
  return step;
}

/**
 * Runs one state change: lock → access check → optimistic version check →
 * change → version bump → commit → push new state to the station.
 */
async function mutate<T>(
  action: string,
  ctx: Ctx,
  batchId: string,
  version: number | undefined,
  fn: (tx: Tx, b: LoadedBatch) => Promise<T>,
  opts: { access?: 'operator' | 'none'; versionOptional?: boolean } = {},
): Promise<{ result: T; run: RunState }> {
  let result: T;
  try {
    result = await db().$transaction(
      async (tx) => {
        const b = await lockBatch(tx, batchId);
        if (opts.access !== 'none') await assertOperatorAccess(tx, ctx, b);
        // A missing version is treated as stale: the change must be based on what the screen showed.
        // Optional only where a screen does not send it yet (start from the job list, supervisor
        // sign-off, recovery check).
        if ((version === undefined && !opts.versionOptional) || (version !== undefined && version !== b.version)) {
          throw conflict('The screen was out of date and has been refreshed. Please check and try again.', 'STALE');
        }
        const r = await fn(tx, b);
        await tx.batch.update({ where: { id: b.id }, data: { version: { increment: 1 } } });
        return r;
      },
      { timeout: 15_000 },
    );
  } catch (err) {
    if (err instanceof AppError) {
      await auditNow({
        type: action,
        outcome: 'REJECTED',
        ...actorOf(ctx),
        batchId,
        details: { code: err.code, message: err.message, ...(err.extra ?? {}) },
      });
    }
    throw err;
  }
  const run = await buildRun(batchId);
  emitRun(ctx.station.id, run);
  return { result, run };
}

// ───────────────────────────── job lifecycle ─────────────────────────────

export async function startJob(ctx: Ctx, batchId: string, version?: number) {
  return mutate('JOB_START', ctx, batchId, version, async (tx, b) => {
    const labContinue = b.status === 'AWAITING_LAB';
    if (b.status !== 'ASSIGNED' && !labContinue) throw conflict('This job has already been started.', 'ALREADY_STARTED');
    // Two different jobs starting at once each lock only their own batch; locking the station
    // (and the operator) serialises them, so the second one sees the first as busy.
    await tx.$queryRaw`SELECT id FROM "Station" WHERE id = ${b.stationId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${ctx.user.id} FOR UPDATE`;
    const busy = await tx.batch.findFirst({
      where: { id: { not: b.id }, status: { in: ['IN_PROGRESS', 'PAUSED', 'ON_HOLD'] }, OR: [{ stationId: b.stationId }, { operatorId: ctx.user.id }] },
      select: { batchNo: true },
    });

    // Continuing after the lab: the supervisor has released a skipped ingredient.
    if (labContinue) {
      const ready = b.steps.find((s) => s.status === 'LOCKED');
      if (!ready) throw conflict('The lab ingredient is not ready yet. Please wait for your scientist.', 'LAB_NOT_READY');
      if (busy) throw conflict(`Finish job ${busy.batchNo} first.`, 'OTHER_JOB_ACTIVE', { batchNo: busy.batchNo });
      await tx.batchStep.update({ where: { id: ready.id }, data: { status: 'CURRENT', stage: 'FIND', startedAt: new Date() } });
      await tx.batch.update({ where: { id: b.id }, data: { status: 'IN_PROGRESS' } });
      await audit(tx, { type: 'LAB_INGREDIENT_STARTED', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, prevState: 'AWAITING_LAB', newState: 'IN_PROGRESS', details: { batchNo: b.batchNo, seq: ready.seq, ingredient: ready.ingredientCode } });
      return;
    }

    // Rule 3: approved formula revision only.
    const formula = await tx.formula.findUniqueOrThrow({ where: { id: b.formulaId } });
    if (formula.status !== 'APPROVED') throw conflict('This formula revision is not approved for production. Call your scientist.', 'FORMULA_NOT_APPROVED');
    if (!b.steps.length) throw conflict('This job has no ingredients. Call your scientist.', 'NO_STEPS');
    if (busy) throw conflict(`Finish job ${busy.batchNo} first.`, 'OTHER_JOB_ACTIVE', { batchNo: busy.batchNo });

    // Ingredients the supervisor skipped for the lab are passed over.
    const first = b.steps.find((s) => s.status === 'LOCKED');
    if (!first) throw conflict('Every ingredient is waiting for the lab. Call your scientist.', 'LAB_NOT_READY');
    await tx.batchStep.update({ where: { id: first.id }, data: { status: 'CURRENT', stage: 'FIND', startedAt: new Date() } });
    await tx.batch.update({ where: { id: b.id }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });
    simNewJob(ctx.station.id); // training scale only
    await audit(tx, { type: 'JOB_STARTED', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, prevState: 'ASSIGNED', newState: 'IN_PROGRESS', details: { batchNo: b.batchNo, formula: `${formula.code} rev ${formula.revision}` } });
  }, { versionOptional: true }); // the job list (Home.tsx) does not send a version yet
}

export async function pauseJob(ctx: Ctx, batchId: string, version?: number) {
  return mutate('JOB_PAUSE', ctx, batchId, version, async (tx, b) => {
    if (!ctx.station.allowPause) throw forbidden('Pausing is not allowed at this station.', 'PAUSE_NOT_ALLOWED');
    if (b.status !== 'IN_PROGRESS') throw conflict('Only a running job can be paused.', 'NOT_IN_PROGRESS');
    const step = activeStep(b);
    await tx.batch.update({ where: { id: b.id }, data: { status: 'PAUSED', pausedAt: new Date() } });
    await audit(tx, { type: 'JOB_PAUSED', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, prevState: 'IN_PROGRESS', newState: 'PAUSED', details: { seq: step?.seq, stage: step?.stage } });
  });
}

export async function resumeJob(ctx: Ctx, batchId: string, equipmentChecked: boolean, version?: number) {
  return mutate('JOB_RESUME', ctx, batchId, version, async (tx, b) => {
    if (b.status !== 'PAUSED') throw conflict('This job is not paused.', 'NOT_PAUSED');
    if (!equipmentChecked) throw badRequest('Please confirm the equipment check first.', 'EQUIPMENT_CHECK_REQUIRED');
    const step = activeStep(b);
    await tx.batch.update({ where: { id: b.id }, data: { status: 'IN_PROGRESS', pausedAt: null } });
    await audit(tx, {
      type: 'JOB_RESUMED', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, prevState: 'PAUSED', newState: 'IN_PROGRESS',
      details: { seq: step?.seq, stage: step?.stage, equipmentChecked: true, pausedMinutes: b.pausedAt ? Math.round((Date.now() - b.pausedAt.getTime()) / 60000) : null },
    });
  });
}

/** Recovery after a refresh / reconnect: the operator confirms the equipment before continuing. */
export async function confirmRecovery(ctx: Ctx, batchId: string) {
  const out = await mutate('JOB_RECOVERY_CHECK', ctx, batchId, undefined, async (tx, b) => {
    const step = activeStep(b);
    // If the scale was zeroed for this ingredient before the restart, the container must still
    // be on it. Lighter than the zero by more than the guard band means it was taken off or
    // swapped: weighing on against the old zero would be wrong, so the step waits for a supervisor
    // (ACCEPT_VESSEL only releases it once the container is back, see supervisorAction).
    let held = false;
    if (b.status === 'IN_PROGRESS' && step?.status === 'CURRENT' && step.stage === 'WEIGH' && step.tareGrossMg != null) {
      const snap = toSnapshot(readScale(ctx.station.id));
      const { guardMg } = acceptanceWindow(step, scaleSpec(ctx.station));
      if (snap.connected && snap.stable && snap.grossMg != null && snap.grossMg < step.tareGrossMg - guardMg) {
        held = true;
        const vessel = { seq: step.seq, containerNo: step.containerNo, phase: 'RECOVERY', expectedGrossMg: step.tareGrossMg, foundGrossMg: snap.grossMg, limitMg: guardMg };
        await tx.batchStep.update({ where: { id: step.id }, data: { status: 'ON_HOLD', holdReason: 'VESSEL_CHANGED' } });
        await tx.deviation.create({ data: { batchId: b.id, stepId: step.id, type: 'VESSEL_CHANGED', details: vessel, raisedById: ctx.user.id } });
        await raiseCall(tx, ctx.station.id, b.id, step.seq, ctx.user.id, 'VESSEL_CHANGED');
        await audit(tx, { type: 'VESSEL_CHANGED', outcome: 'REJECTED', ...actorOf(ctx), batchId: b.id, prevState: stepState(step), newState: 'ON_HOLD/WEIGH', details: vessel });
      }
    }
    await audit(tx, { type: 'JOB_RECOVERY_CHECK', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, details: { status: b.status, seq: step?.seq, stage: step?.stage, vesselChanged: held } });
    return held;
  }, { versionOptional: true }); // the recovery route does not pass a version
  if (out.result) emitCalls(ctx.station.id);
  return out;
}

// ─────────────────────────────── the steps ───────────────────────────────

export async function markFound(ctx: Ctx, batchId: string, seq: number, version?: number) {
  return mutate('INGREDIENT_FOUND', ctx, batchId, version, async (tx, b) => {
    const step = currentStepFor(b, seq, 'FIND');
    await tx.batchStep.update({ where: { id: step.id }, data: { stage: 'SCAN', foundAt: new Date() } });
    await audit(tx, { type: 'INGREDIENT_LOCATED', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, prevState: 'CURRENT/FIND', newState: 'CURRENT/SCAN', details: { seq, ingredient: step.ingredientCode } });
  });
}

export async function scanBarcode(ctx: Ctx, batchId: string, seq: number, rawBarcode: string, source: 'scanner' | 'simulator', version?: number) {
  const barcode = rawBarcode.trim();
  if (!barcode || barcode.length > 128 || !/^[\x20-\x7E]+$/.test(barcode)) throw badRequest('The barcode could not be read. Scan again.', 'BAD_BARCODE');
  if (source === 'simulator' && ctx.station.scaleMode !== 'SIMULATED') throw forbidden('The scan simulator is only available on training stations.', 'NOT_TRAINING');

  const { result, run } = await mutate('BARCODE_SCAN', ctx, batchId, version, async (tx, b) => {
    // Scanning the right bottle also proves it was found, so the scan is accepted from FIND too.
    const step = currentStepFor(b, seq, ['FIND', 'SCAN']);
    const lot = await tx.ingredientLot.findUnique({ where: { barcode }, include: { ingredient: true } });
    const ingredient = lot?.ingredient ?? (await tx.ingredient.findUnique({ where: { barcode } }));

    let reason: Extract<ScanResult, { ok: false }>['reason'] | null = null;
    if (!ingredient) reason = 'UNKNOWN_BARCODE';
    else if (ingredient.id !== step.ingredientId) reason = 'WRONG_INGREDIENT';
    else if (ingredient.lotTracked && !lot) reason = 'LOT_REQUIRED';
    // The process order names the material batch to use; another lot of the same material is refused.
    else if (lot && step.sourceBatch && lot.lotNumber.trim().toUpperCase() !== step.sourceBatch.trim().toUpperCase()) reason = 'WRONG_LOT';
    else if (lot?.status === 'QUARANTINE') reason = 'LOT_QUARANTINE';
    else if (lot?.status === 'REJECTED') reason = 'LOT_REJECTED';
    else if (lot?.expiresOn && lot.expiresOn.getTime() < Date.now()) reason = 'LOT_EXPIRED';

    const details = { seq, barcode, source, expected: step.ingredientCode, scanned: ingredient?.code ?? null, lot: lot?.lotNumber ?? null, expectedLot: step.sourceBatch ?? null };
    if (reason) {
      await tx.batchStep.update({ where: { id: step.id }, data: { wrongScans: { increment: 1 } } });
      await audit(tx, { type: 'BARCODE_SCAN', outcome: 'REJECTED', ...actorOf(ctx), batchId: b.id, details: { ...details, reason } });
      // The batch the process order asks for, so the screen can say which bottle to take instead.
      return { ok: false as const, reason, scannedName: ingredient?.name ?? null, expectedLot: reason === 'WRONG_LOT' ? (step.sourceBatch ?? null) : null };
    }
    const now = new Date();
    await tx.batchStep.update({
      where: { id: step.id },
      data: { stage: 'WEIGH', foundAt: step.foundAt ?? now, scannedAt: now, scannedBarcode: barcode, lotId: lot?.id ?? null, lotNumber: lot?.lotNumber ?? null },
    });
    await audit(tx, { type: 'BARCODE_SCAN', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, prevState: stepState(step), newState: 'CURRENT/WEIGH', details });
    return { ok: true as const, lotNumber: lot?.lotNumber ?? null };
  });
  return { ...result, run } as ScanResult;
}

function scaleSpec(st: Station) {
  return { resolutionMg: st.scaleResolutionMg, uncertaintyMg: st.scaleUncertaintyMg, validated: scaleValidated(st) };
}

/**
 * Stores a reading. `scale` is the very reading the decision was made on (never a fresh
 * read), so the recorded source and model always belong to the recorded weight.
 */
async function recordReading(tx: Tx, b: Batch, step: BatchStep, purpose: ReadingPurpose, verdict: ReadingVerdict, ev: Pick<Evaluation, 'netMg'> | null, gross: number | null, stable: boolean, ctx: { userId: string | null; scale: ScaleState }) {
  const { scale } = ctx;
  await tx.weightReading.create({
    data: {
      batchId: b.id,
      stepId: step.id,
      purpose,
      verdict,
      grossMg: gross,
      tareMg: step.tareGrossMg,
      netMg: ev?.netMg ?? null,
      stable,
      source: readingSource(scale),
      scaleModel: scale.model,
      userId: ctx.userId,
    },
  });
}

export const CONTAINERS = [1, 2, 3] as const;

/**
 * Zero the scale with the chosen mixing container (1–3) on it, for this ingredient.
 * The container number is recorded with the zero and locked from then on.
 */
export async function tareScale(ctx: Ctx, batchId: string, seq: number, containerNo: number, version?: number) {
  const { result, run } = await mutate('SCALE_ZERO', ctx, batchId, version, async (tx, b) => {
    if (!(CONTAINERS as readonly number[]).includes(containerNo)) throw badRequest('Choose container 1, 2 or 3.', 'CONTAINER_REQUIRED');
    const step = currentStepFor(b, seq, 'WEIGH');
    if (step.tareGrossMg != null || step.containerNo != null) throw conflict('The scale is already zeroed for this ingredient.', 'ALREADY_TARED');
    // Refuse before zeroing, so the supervisor can still skip or change the line: once zeroed it is locked.
    const spec = scaleSpec(ctx.station);
    const win = acceptanceWindow(step, spec);
    if (!win.certifiable) {
      throw conflict('This amount is too small for this scale to weigh within tolerance. Call your scientist.', 'CANNOT_CERTIFY', { targetMg: step.targetMg, tolMinusMg: step.tolMinusMg, tolPlusMg: step.tolPlusMg, guardMg: win.guardMg, resolutionMg: spec.resolutionMg });
    }
    simUseContainer(ctx.station.id, containerNo); // training scale only: the chosen container goes on the scale
    const reading = readScale(ctx.station.id);
    const snap = toSnapshot(reading);
    if (!snap.connected || snap.grossMg == null) throw conflict('Scale disconnected. Call scientist.', 'SCALE_DISCONNECTED');
    if (!scaleValidated(ctx.station)) throw conflict('This scale has not been checked. Call scientist.', 'SCALE_NOT_VALIDATED');
    if (!snap.stable) throw conflict('Wait. Keep the container still.', 'SCALE_UNSTABLE');
    if (snap.grossMg <= 0) throw conflict('Place the mixing vessel on the scale.', 'NO_VESSEL');

    // Vessel continuity: a container must weigh what it weighed when its last ingredient was accepted.
    // (Older steps without a container number count as container 1.) The most recently saved one counts:
    // a lab ingredient added later can have a lower number than ingredients weighed before it.
    //
    // The allowed drift is also capped by the room left in the PREVIOUS ingredient's acceptance window:
    // anything added (or lost) after its acceptance is really more (or less) of that ingredient, so it
    // may not push the previous ingredient past its own limits unnoticed.
    const prev = lastSaved(b.steps.filter((s) => s.status === 'COMPLETED' && (s.containerNo ?? 1) === containerNo));
    if (prev?.acceptedGrossMg != null) {
      const driftMg = snap.grossMg - prev.acceptedGrossMg;
      const pw = acceptanceWindow(prev, spec);
      const roomMg = prev.acceptedNetMg == null ? 0 : driftMg > 0 ? pw.acceptHighMg - prev.acceptedNetMg : prev.acceptedNetMg - pw.acceptLowMg;
      const limitMg = Math.max(0, Math.min(ctx.station.vesselDriftLimitMg, roomMg));
      // A supervisor waiver covers only the weight the supervisor actually saw and accepted.
      const waiver = Math.abs(driftMg) > limitMg
        ? await tx.deviation.findFirst({ where: { stepId: step.id, type: 'VESSEL_CHANGED', resolution: 'VESSEL_WEIGHT_ACCEPTED' }, orderBy: { resolvedAt: 'desc' } })
        : null;
      const waivedGrossMg = (waiver?.resolutionDetails as { acceptedGrossMg?: unknown } | null)?.acceptedGrossMg;
      const waived = typeof waivedGrossMg === 'number' && Math.abs(snap.grossMg - waivedGrossMg) <= ctx.station.vesselDriftLimitMg;
      if (Math.abs(driftMg) > limitMg && !waived) {
        const details = {
          seq, containerNo, expectedGrossMg: prev.acceptedGrossMg, foundGrossMg: snap.grossMg, driftMg, limitMg,
          stationLimitMg: ctx.station.vesselDriftLimitMg, prevSeq: prev.seq, prevRoomMg: roomMg,
          waivedGrossMg: typeof waivedGrossMg === 'number' ? waivedGrossMg : null,
        };
        await tx.batchStep.update({ where: { id: step.id }, data: { status: 'ON_HOLD', holdReason: 'VESSEL_CHANGED' } });
        await tx.deviation.create({ data: { batchId: b.id, stepId: step.id, type: 'VESSEL_CHANGED', details, raisedById: ctx.user.id } });
        await raiseCall(tx, ctx.station.id, b.id, seq, ctx.user.id, 'VESSEL_CHANGED');
        await audit(tx, { type: 'VESSEL_CHANGED', outcome: 'REJECTED', ...actorOf(ctx), batchId: b.id, prevState: stepState(step), newState: 'ON_HOLD/WEIGH', details });
        return { ok: false as const, code: 'VESSEL_CHANGED' };
      }
    }

    await tx.batchStep.update({ where: { id: step.id }, data: { containerNo, tareGrossMg: snap.grossMg, taredAt: new Date() } });
    const fresh = { ...step, tareGrossMg: snap.grossMg };
    await recordReading(tx, b, fresh, 'TARE', 'OK', { netMg: 0 }, snap.grossMg, true, { userId: ctx.user.id, scale: reading });
    await audit(tx, { type: 'SCALE_ZEROED', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, details: { seq, ingredient: step.ingredientCode, containerNo, tareGrossMg: snap.grossMg } });
    return { ok: true as const };
  });
  if (!result.ok) emitCalls(ctx.station.id);
  return { ...result, run };
}

/** Ingredients already accepted into the same container: removing excess from it removes some of them too. */
function earlierInContainer(b: LoadedBatch, step: BatchStep) {
  return b.steps
    .filter((s) => s.id !== step.id && s.status === 'COMPLETED' && (s.containerNo ?? 1) === (step.containerNo ?? 1))
    .map((s) => ({ seq: s.seq, ingredient: s.ingredientCode, acceptedNetMg: s.acceptedNetMg }));
}

/**
 * Too much poured. The station sounds the alarm; the operator takes the extra out
 * and weighs on — the step is NOT held and no scientist is needed. The excess is
 * recorded as a problem (with the reading) once per over-pour, and closes by itself
 * when the corrected weight is saved (see closeOverweight). Returns whether a new
 * problem was raised.
 */
async function recordOverweight(tx: Tx, b: LoadedBatch, step: BatchStep, ev: Evaluation, gross: number | null, purpose: ReadingPurpose, actor: Actor & { userId: string }, scale: ScaleState) {
  await recordReading(tx, b, step, purpose, 'OVER', ev, gross, true, { userId: actor.userId, scale });
  const open = await tx.deviation.findFirst({ where: { stepId: step.id, type: 'OVERWEIGHT', resolvedAt: null } });
  if (open) return false;
  const details = {
    seq: step.seq, targetMg: step.targetMg, netMg: ev.netMg, acceptHighMg: ev.acceptHighMg, highLimitMg: ev.highLimitMg, excessMg: (ev.netMg ?? 0) - step.targetMg,
    grossMg: gross, tareGrossMg: step.tareGrossMg, containerNo: step.containerNo, earlierInContainer: earlierInContainer(b, step),
  };
  await tx.deviation.create({ data: { batchId: b.id, stepId: step.id, type: 'OVERWEIGHT', details, raisedById: actor.userId } });
  await audit(tx, { type: 'WEIGHT_OVER', outcome: 'REJECTED', ...actor, batchId: b.id, prevState: stepState(step), newState: stepState(step), details });
  return true;
}

/**
 * The corrected weight of an over-poured step is being saved: the over-pour problem
 * is closed with what the scale showed before and after. Taking excess out of a
 * container that already holds earlier ingredients takes some of those out too;
 * the record says so, for the scientist's review before approval.
 */
async function closeOverweight(tx: Tx, b: LoadedBatch, step: BatchStep, ev: Evaluation, gross: number | null, actor: Actor & { userId: string }, now: Date) {
  const open = await tx.deviation.findMany({ where: { stepId: step.id, type: 'OVERWEIGHT', resolvedAt: null }, orderBy: { raisedAt: 'asc' } });
  if (!open.length) return;
  const raised = (open[0].details ?? {}) as { grossMg?: number | null; netMg?: number | null };
  const grossBeforeMg = raised.grossMg ?? (raised.netMg != null && step.tareGrossMg != null ? step.tareGrossMg + raised.netMg : null);
  const earlier = earlierInContainer(b, step);
  const resolvedWith: Prisma.InputJsonObject = {
    grossBeforeMg, grossAfterMg: gross, netAfterMg: ev.netMg, removedMg: grossBeforeMg != null && gross != null ? grossBeforeMg - gross : null,
    containerNo: step.containerNo, earlierInContainer: earlier, earlierIngredientsMayBeAffected: earlier.length > 0,
  };
  await tx.deviation.updateMany({
    where: { stepId: step.id, type: 'OVERWEIGHT', resolvedAt: null },
    data: { resolvedAt: now, resolvedById: actor.userId, resolution: 'EXCESS_REMOVED_BY_OPERATOR', resolutionNote: null, resolutionDetails: resolvedWith },
  });
  await audit(tx, { type: 'OVERWEIGHT_CORRECTED', outcome: 'SUCCESS', ...actor, batchId: b.id, details: { seq: step.seq, ingredient: step.ingredientCode, resolvedWith } });
}

/** Operator presses WEIGHT CORRECT. The server re-reads the scale and decides. */
export async function acceptWeight(ctx: Ctx, batchId: string, seq: number, version?: number): Promise<AcceptResult> {
  const { result, run } = await mutate('WEIGHT_ACCEPT', ctx, batchId, version, async (tx, b) => {
    const step = currentStepFor(b, seq, 'WEIGH');
    // The lot may have expired (or been blocked) between the scan and now.
    if (step.lotId) {
      const lot = await tx.ingredientLot.findUnique({ where: { id: step.lotId } });
      if (!lot || lot.status !== 'RELEASED') throw conflict('This lot is no longer released for use. Call your scientist.', 'LOT_NOT_RELEASED', { lot: step.lotNumber, status: lot?.status ?? null });
      if (lot.expiresOn && lot.expiresOn.getTime() < Date.now()) throw conflict('This lot has expired. Call your scientist.', 'LOT_EXPIRED', { lot: step.lotNumber, expiresOn: lot.expiresOn.toISOString() });
    }
    const reading = readScale(ctx.station.id);
    const snap = toSnapshot(reading);
    const ev = evaluate(snap, step.tareGrossMg, step, scaleSpec(ctx.station));
    const actor = { ...actorOf(ctx), userId: ctx.user.id };

    // Lighter than the zero by more than the guard band: the container was taken off or swapped.
    if (snap.connected && snap.grossMg != null && step.tareGrossMg != null && snap.grossMg < step.tareGrossMg - ev.guardMg) {
      throw conflict('The container is lighter than when the scale was zeroed. Put the same container back, or call your scientist.', 'VESSEL_REMOVED', { seq, tareGrossMg: step.tareGrossMg, grossMg: snap.grossMg, guardMg: ev.guardMg });
    }
    if (ev.verdict === 'OVER') {
      await recordOverweight(tx, b, step, ev, snap.grossMg, 'ACCEPT_ATTEMPT', actor, reading);
      return { ok: false as const, verdict: ev.verdict, netMg: ev.netMg };
    }
    if (ev.verdict !== 'OK') {
      await recordReading(tx, b, step, 'ACCEPT_ATTEMPT', ev.verdict, ev, snap.grossMg, snap.stable, { userId: ctx.user.id, scale: reading });
      await audit(tx, { type: 'WEIGHT_REJECTED', outcome: 'REJECTED', ...actor, batchId: b.id, details: { seq, verdict: ev.verdict, netMg: ev.netMg, targetMg: step.targetMg, acceptLowMg: ev.acceptLowMg, acceptHighMg: ev.acceptHighMg } });
      return { ok: false as const, verdict: ev.verdict, netMg: ev.netMg };
    }

    // Accepted. Commit this step and unlock the next one in the same transaction.
    const now = new Date();
    await closeOverweight(tx, b, step, ev, snap.grossMg, actor, now);
    await recordReading(tx, b, step, 'ACCEPTED', 'OK', ev, snap.grossMg, true, { userId: ctx.user.id, scale: reading });
    await tx.batchStep.update({
      where: { id: step.id },
      data: { status: 'COMPLETED', stage: 'DONE', acceptedNetMg: ev.netMg, acceptedGrossMg: snap.grossMg, acceptedAt: now, completedById: ctx.user.id },
    });
    const simulated = readingSource(reading) === 'SIMULATED';
    await audit(tx, {
      type: 'WEIGHT_ACCEPTED', outcome: 'SUCCESS', ...actor, batchId: b.id, prevState: 'CURRENT/WEIGH', newState: 'COMPLETED/DONE',
      details: { seq, ingredient: step.ingredientCode, lot: step.lotNumber, targetMg: step.targetMg, netMg: ev.netMg, grossMg: snap.grossMg, tareMg: step.tareGrossMg, acceptLowMg: ev.acceptLowMg, acceptHighMg: ev.acceptHighMg, source: readingSource(reading), scaleModel: reading.model },
    });

    const next = nextLocked(b, step.seq);
    const waitingForLab = b.steps.filter((s) => s.status === 'SKIPPED');
    if (next) {
      await tx.batchStep.update({ where: { id: next.id }, data: { status: 'CURRENT', stage: 'FIND', startedAt: now } });
      await tx.batch.update({ where: { id: b.id }, data: simulated ? { simulated: true } : {} });
    } else if (waitingForLab.length) {
      // Everything available is done; the batch waits (without holding the station) for the lab ingredient.
      await tx.batch.update({ where: { id: b.id }, data: { status: 'AWAITING_LAB', ...(simulated ? { simulated: true } : {}) } });
      await audit(tx, { type: 'WAITING_FOR_LAB', outcome: 'INFO', ...actor, batchId: b.id, prevState: 'IN_PROGRESS', newState: 'AWAITING_LAB', details: { skipped: waitingForLab.map((s) => ({ seq: s.seq, ingredient: s.ingredientCode })) } });
    } else {
      await tx.batch.update({ where: { id: b.id }, data: { status: 'AWAITING_SUBMISSION', completedAt: now, ...(simulated ? { simulated: true } : {}) } });
      await audit(tx, { type: 'ALL_INGREDIENTS_COMPLETED', outcome: 'SUCCESS', ...actor, batchId: b.id, prevState: 'IN_PROGRESS', newState: 'AWAITING_SUBMISSION', details: { steps: b.steps.length } });
    }
    return { ok: true as const, netMg: ev.netMg! };
  });
  return { ...result, run } as AcceptResult;
}

/**
 * Called whenever a station's scale settles. If the operator has poured too much,
 * the over-pour is recorded straight away (once) — they do not need to press
 * anything. The station sounds the alarm and the operator takes the extra out.
 */
export async function checkOverweight(stationId: string) {
  const station = await db().station.findUnique({ where: { id: stationId } });
  if (!station) return;
  const b = await db().batch.findFirst({
    where: { stationId, status: 'IN_PROGRESS', steps: { some: { status: 'CURRENT', stage: 'WEIGH', tareGrossMg: { not: null } } } },
    select: { id: true, operatorId: true },
  });
  if (!b) return;
  const raised = await db().$transaction(async (tx) => {
    const batch = await lockBatch(tx, b.id);
    if (batch.status !== 'IN_PROGRESS') return false;
    const step = activeStep(batch);
    if (!step || step.status !== 'CURRENT' || step.stage !== 'WEIGH' || step.tareGrossMg == null) return false;
    // Already recorded for this over-pour: nothing more until the corrected weight is saved.
    if (await tx.deviation.findFirst({ where: { stepId: step.id, type: 'OVERWEIGHT', resolvedAt: null }, select: { id: true } })) return false;
    const reading = readScale(stationId);
    const snap = toSnapshot(reading);
    const ev = evaluate(snap, step.tareGrossMg, step, scaleSpec(station));
    if (ev.verdict !== 'OVER') return false;
    const actor = { userId: batch.operatorId, role: 'SYSTEM', stationId, sourceDevice: `scale:${station.code}` };
    if (!(await recordOverweight(tx, batch, step, ev, snap.grossMg, 'AUTO_OVERWEIGHT', actor, reading))) return false;
    await tx.batch.update({ where: { id: batch.id }, data: { version: { increment: 1 } } });
    return true;
  });
  if (raised) emitRun(stationId, await buildRun(b.id));
}

export async function submitJob(ctx: Ctx, batchId: string, version?: number) {
  return mutate('BATCH_SUBMIT', ctx, batchId, version, async (tx, b) => {
    if (b.status !== 'AWAITING_SUBMISSION') throw conflict('This job is not ready to submit.', 'NOT_READY');
    // Rule 14: every mandatory step passed and committed.
    const missing = b.steps.filter((s) => s.status !== 'COMPLETED' || s.acceptedNetMg == null);
    if (missing.length) throw conflict('Some ingredients are not complete.', 'STEPS_INCOMPLETE', { seqs: missing.map((s) => s.seq) });
    const open = await tx.deviation.count({ where: { batchId: b.id, resolvedAt: null } });
    if (open) throw conflict('There are problems that a scientist must close first.', 'OPEN_DEVIATIONS', { open });
    const now = new Date();
    await tx.batch.update({ where: { id: b.id }, data: { status: 'SUBMITTED', submittedAt: now, submittedById: ctx.user.id } });
    await tx.supervisorCall.updateMany({ where: { batchId: b.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, data: { status: 'CLOSED', closedAt: now, closedById: ctx.user.id } });
    await audit(tx, { type: 'BATCH_SUBMITTED', outcome: 'SUCCESS', ...actorOf(ctx), batchId: b.id, prevState: 'AWAITING_SUBMISSION', newState: 'SUBMITTED', details: { batchNo: b.batchNo, simulated: b.simulated } });
  });
}

// ─────────────────────────── supervisor at the station ───────────────────────────

export type CallReason = 'CANNOT_FIND' | 'HELP' | 'SCALE_PROBLEM' | 'WRONG_BOTTLE' | 'OVERWEIGHT' | 'VESSEL_CHANGED' | 'NO_JOB' | 'OTHER';

async function raiseCall(tx: Tx, stationId: string, batchId: string | null, seq: number | null, userId: string, reason: CallReason) {
  const existing = await tx.supervisorCall.findFirst({ where: { stationId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } });
  if (existing) return existing;
  return tx.supervisorCall.create({ data: { stationId, batchId, seq, raisedById: userId, reason } });
}

export async function callSupervisor(ctx: Ctx, input: { batchId?: string | null; seq?: number | null; reason: CallReason }) {
  let batchId: string | null = null;
  if (input.batchId) {
    const b = await db().batch.findUnique({ where: { id: input.batchId } });
    if (!b || b.stationId !== ctx.station.id) throw forbidden('This job belongs to another station.', 'WRONG_STATION');
    batchId = b.id;
  }
  const call = await db().$transaction(async (tx) => {
    const c = await raiseCall(tx, ctx.station.id, batchId, input.seq ?? null, ctx.user.id, input.reason);
    await audit(tx, { type: 'SUPERVISOR_CALLED', outcome: 'INFO', ...actorOf(ctx), batchId, details: { reason: input.reason, seq: input.seq ?? null, callId: c.id } });
    return c;
  });
  emitCalls(ctx.station.id);
  if (batchId) emitRun(ctx.station.id, await buildRun(batchId));
  return { id: call.id, status: call.status };
}

export type SupervisorAction = 'ALLOW_REWEIGH' | 'ACCEPT_VESSEL' | 'HOLD_BATCH' | 'RELEASE_HOLD' | 'CLOSE_CALL';

/** A supervisor, physically at the station, signs off a correction with their own credentials (rules 12, 13). */
export async function supervisorAction(ctx: Ctx, batchId: string, token: string, action: SupervisorAction, note: string, version?: number) {
  const signoff = readSignoff(token, ctx.station.id, batchId, action);
  if (!signoff) throw forbidden('Scientist sign-off expired. Please sign in again.', 'SIGNOFF_INVALID');
  const sup = await db().user.findUnique({ where: { id: signoff.by } });
  if (!sup || !sup.active || sup.role !== 'SUPERVISOR') throw forbidden('Scientist sign-off is not valid.', 'SIGNOFF_INVALID');
  const supActor: Actor = { userId: sup.id, role: sup.role, stationId: ctx.station.id, sourceDevice: ctx.device };
  const cleanNote = note.trim();
  if (action !== 'CLOSE_CALL' && cleanNote.length < 3) throw badRequest('Please write what was done.', 'NOTE_REQUIRED');

  const out = await mutate(`SUPERVISOR_${action}`, { ...ctx, user: { ...ctx.user, id: sup.id, role: sup.role } }, batchId, version, async (tx, b) => {
    if (b.stationId !== ctx.station.id) throw forbidden('This job belongs to another station.', 'WRONG_STATION');
    // Spend the token in the same transaction as the action: a refused action leaves it usable,
    // a committed one can never be replayed (not even after a restart).
    const spent = await tx.$executeRaw`INSERT INTO "SignoffUse" ("jti", "action", "batchId", "usedById") VALUES (${signoff.jti}, ${action}, ${batchId}, ${sup.id}) ON CONFLICT ("jti") DO NOTHING`;
    if (!spent) throw forbidden('This scientist sign-off has already been used. Please sign in again.', 'SIGNOFF_USED');
    const step = activeStep(b);
    const now = new Date();
    const resolveDeviations = async (type: 'OVERWEIGHT' | 'VESSEL_CHANGED', resolution: string, resolutionDetails: Prisma.InputJsonObject) => {
      await tx.deviation.updateMany({ where: { stepId: step!.id, type, resolvedAt: null }, data: { resolvedAt: now, resolvedById: sup.id, resolution, resolutionNote: cleanNote, resolutionDetails } });
    };
    const reading = readScale(ctx.station.id);
    const snap = toSnapshot(reading);
    let resolvedWith: Prisma.InputJsonObject | null = null;
    switch (action) {
      case 'ALLOW_REWEIGH':
        if (!step || step.status !== 'ON_HOLD' || step.holdReason !== 'OVERWEIGHT') throw conflict('There is no overweight to resolve.', 'NOTHING_TO_RESOLVE');
        {
          // The excess must actually be gone before weighing may continue, shown by a reading
          // the operator could have had accepted: connected, validated, stable and ≤ acceptHigh.
          const ev = evaluate(snap, step.tareGrossMg, step, scaleSpec(ctx.station));
          if (ev.verdict === 'DISCONNECTED') throw conflict('Scale disconnected. Reconnect it first.', 'SCALE_DISCONNECTED');
          if (ev.verdict === 'NOT_VALIDATED') throw conflict('This scale has not been checked.', 'SCALE_NOT_VALIDATED');
          if (ev.verdict === 'CANNOT_CERTIFY') throw conflict('This scale cannot weigh this amount within tolerance.', 'CANNOT_CERTIFY');
          if (!snap.stable || ev.verdict === 'UNSTABLE') throw conflict('Wait until the scale is stable.', 'SCALE_UNSTABLE');
          if (ev.verdict === 'OVER' || ev.netMg == null || ev.netMg > ev.acceptHighMg) throw conflict('The scale still shows too much. Remove the excess first.', 'STILL_OVER', { netMg: ev.netMg });
          // The record shows what was taken out of a container that also holds earlier ingredients;
          // whether those are affected is the client's process decision.
          const open = await tx.deviation.findFirst({ where: { stepId: step.id, type: 'OVERWEIGHT', resolvedAt: null }, orderBy: { raisedAt: 'desc' } });
          const raised = (open?.details ?? {}) as { grossMg?: number | null; netMg?: number | null };
          const grossBeforeMg = raised.grossMg ?? (raised.netMg != null && step.tareGrossMg != null ? step.tareGrossMg + raised.netMg : null);
          const earlier = earlierInContainer(b, step);
          resolvedWith = {
            grossBeforeMg, grossAfterMg: snap.grossMg, netAfterMg: ev.netMg, removedMg: grossBeforeMg != null && snap.grossMg != null ? grossBeforeMg - snap.grossMg : null,
            containerNo: step.containerNo, earlierInContainer: earlier, earlierIngredientsMayBeAffected: earlier.length > 0,
          };
        }
        await tx.batchStep.update({ where: { id: step.id }, data: { status: 'CURRENT', holdReason: null } });
        await resolveDeviations('OVERWEIGHT', 'EXCESS_REMOVED_REWEIGH', resolvedWith);
        break;
      case 'ACCEPT_VESSEL':
        if (!step || step.status !== 'ON_HOLD' || step.holdReason !== 'VESSEL_CHANGED') throw conflict('There is no vessel problem to resolve.', 'NOTHING_TO_RESOLVE');
        // The waiver is for the weight on the scale now; a later zero is only allowed near it.
        if (!snap.connected || snap.grossMg == null) throw conflict('Scale disconnected. Reconnect it first.', 'SCALE_DISCONNECTED');
        if (!snap.stable) throw conflict('Wait until the scale is stable.', 'SCALE_UNSTABLE');
        if (step.tareGrossMg != null) {
          // Already zeroed (hold raised at recovery): weighing goes on against that zero, so the
          // same container must be back on the scale.
          const { guardMg } = acceptanceWindow(step, scaleSpec(ctx.station));
          if (snap.grossMg < step.tareGrossMg - guardMg) {
            throw conflict('The container on the scale is lighter than when it was zeroed. Put the same container back.', 'VESSEL_STILL_LIGHT', { tareGrossMg: step.tareGrossMg, grossMg: snap.grossMg, guardMg });
          }
        }
        resolvedWith = { acceptedGrossMg: snap.grossMg, tareGrossMg: step.tareGrossMg, source: readingSource(reading) };
        await tx.batchStep.update({ where: { id: step.id }, data: { status: 'CURRENT', holdReason: null } });
        await resolveDeviations('VESSEL_CHANGED', 'VESSEL_WEIGHT_ACCEPTED', resolvedWith);
        break;
      case 'HOLD_BATCH':
        if (!['IN_PROGRESS', 'PAUSED'].includes(b.status)) throw conflict('This job cannot be put on hold now.', 'CANNOT_HOLD');
        await tx.batch.update({ where: { id: b.id }, data: { status: 'ON_HOLD', holdReason: cleanNote } });
        break;
      case 'RELEASE_HOLD':
        if (b.status !== 'ON_HOLD') throw conflict('This job is not on hold.', 'NOT_ON_HOLD');
        await tx.batch.update({ where: { id: b.id }, data: { status: 'IN_PROGRESS', holdReason: null } });
        break;
      case 'CLOSE_CALL':
        break;
    }
    await tx.supervisorCall.updateMany({ where: { stationId: ctx.station.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, data: { status: 'CLOSED', closedAt: now, closedById: sup.id } });
    await audit(tx, {
      type: 'SUPERVISOR_INTERVENTION', outcome: 'SUCCESS', ...supActor, batchId: b.id,
      prevState: action === 'HOLD_BATCH' || action === 'RELEASE_HOLD' ? b.status : step ? stepState(step) : null,
      newState: action === 'HOLD_BATCH' ? 'ON_HOLD' : action === 'RELEASE_HOLD' ? 'IN_PROGRESS' : action === 'CLOSE_CALL' ? null : 'CURRENT/WEIGH',
      details: { action, note: cleanNote, seq: step?.seq ?? null, operatorId: ctx.user.id, supervisorName: sup.name, signoffId: signoff.jti, resolvedWith },
    });
  }, { access: 'none', versionOptional: true }); // SupervisorSignoff.tsx does not send a version yet
  emitCalls(ctx.station.id);
  return out;
}

// ───────────────────── supervisor console: lab ingredients ─────────────────────

const LAB_EDITABLE = ['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'ON_HOLD', 'AWAITING_LAB'];

/** Runs a supervisor console change on a batch and pushes it to the batch's station. */
async function consoleMutate<T>(action: string, sup: SessionUser, device: string, batchId: string, version: number | undefined, fn: (tx: Tx, b: LoadedBatch) => Promise<T>) {
  const found = await db().batch.findUnique({ where: { id: batchId }, include: { station: true } });
  if (!found) throw new AppError(404, 'Job not found.', 'NOT_FOUND');
  const ctx: Ctx = { user: sup, station: found.station, device };
  const out = await mutate(action, ctx, batchId, version, fn, { access: 'none' });
  emitJobs(found.stationId);
  return out;
}

/**
 * The supervisor skips an ingredient that must wait for its lab report. The
 * operator goes on with the others; the skipped one is added after release.
 * Allowed before the operator has set the scale to zero for it.
 */
export async function skipIngredient(sup: SessionUser, device: string, batchId: string, seq: number, note: string, version?: number) {
  const cleanNote = note.trim();
  if (cleanNote.length < 3) throw badRequest('Please write why this ingredient is skipped.', 'NOTE_REQUIRED');
  return consoleMutate('SUPERVISOR_SKIP_INGREDIENT', sup, device, batchId, version, async (tx, b) => {
    if (!LAB_EDITABLE.includes(b.status)) throw conflict('Ingredients can no longer be skipped on this job.', 'CANNOT_SKIP');
    const step = b.steps.find((s) => s.seq === seq);
    if (!step) throw badRequest('Invalid step.', 'BAD_STEP');
    if (step.status === 'SKIPPED') throw conflict('This ingredient is already skipped.', 'ALREADY_SKIPPED');
    if (step.status === 'COMPLETED') throw conflict('This ingredient has already been weighed.', 'ALREADY_DONE');
    if (step.status === 'ON_HOLD') throw conflict('This ingredient is on hold. Resolve it at the station first.', 'STEP_ON_HOLD');
    const wasCurrent = step.status === 'CURRENT';
    if (wasCurrent) {
      if (step.tareGrossMg != null) throw conflict('The operator has already started weighing this ingredient. It cannot be skipped now.', 'ALREADY_WEIGHING');
      if (b.status !== 'IN_PROGRESS' && b.status !== 'PAUSED') throw conflict('Release the job hold first.', 'BATCH_ON_HOLD');
    }
    // Before the first ingredient is started, at least one must be left for the operator.
    if (b.status === 'ASSIGNED' && !b.steps.some((s) => s.id !== step.id && s.status === 'LOCKED')) {
      throw conflict('At least one ingredient must be left for the operator to start with.', 'LAST_INGREDIENT');
    }
    await applySkip(tx, b, step, sup, device, cleanNote);
  });
}

/** The lab report cleared a skipped ingredient: the operator can now add it. */
export async function releaseLabIngredient(sup: SessionUser, device: string, batchId: string, seq: number, note: string, version?: number) {
  const cleanNote = note.trim();
  return consoleMutate('SUPERVISOR_LAB_RELEASE', sup, device, batchId, version, async (tx, b) => {
    if (!LAB_EDITABLE.includes(b.status)) throw conflict('This job can no longer be changed.', 'CANNOT_SKIP');
    const step = b.steps.find((s) => s.seq === seq);
    if (!step) throw badRequest('Invalid step.', 'BAD_STEP');
    if (step.status !== 'SKIPPED') throw conflict('This ingredient is not waiting for the lab.', 'NOT_SKIPPED');
    await applyRelease(tx, b, step, sup, device, cleanNote);
  });
}

// ───────────────────── operator at the station: lab ingredients ─────────────────────

/** Note recorded when the operator sends a bottle for lab test (operators are not asked to type). */
const OPERATOR_SKIP_NOTE = 'Sent for lab test by the operator at the station';

/**
 * The operator sends the bottle in front of them for lab test. Same rule as the
 * scientist's skip: only before the scale was zeroed for it. The job goes on with
 * the next bottle, or waits for the lab when this was the last one.
 */
export async function operatorSkipForLab(ctx: Ctx, batchId: string, seq: number, version?: number) {
  return mutate('OPERATOR_SKIP_INGREDIENT', ctx, batchId, version, async (tx, b) => {
    assertRunning(b);
    const step = activeStep(b);
    if (!step || step.seq !== seq) throw conflict('Ingredients must be done in the set order.', 'NOT_CURRENT_STEP', { currentSeq: step?.seq ?? null });
    if (step.status === 'ON_HOLD') throw conflict('This ingredient is on hold. Call your scientist.', 'STEP_ON_HOLD');
    if (step.tareGrossMg != null) throw conflict('The scale is already zeroed for this ingredient. It cannot go for lab test now.', 'ALREADY_WEIGHING');
    await applySkip(tx, b, step, ctx.user, ctx.device, OPERATOR_SKIP_NOTE);
  });
}

/**
 * The lab bottle has come back: the operator marks it arrived and adds it next.
 * The bottle is still scanned before weighing, so a lot that is not released
 * (quarantine, rejected, expired) is refused there as usual.
 */
export async function operatorLabArrived(ctx: Ctx, batchId: string, seq: number, version?: number) {
  return mutate('OPERATOR_LAB_ARRIVED', ctx, batchId, version, async (tx, b) => {
    if (!['IN_PROGRESS', 'PAUSED', 'AWAITING_LAB'].includes(b.status)) throw conflict('This job can no longer be changed.', 'CANNOT_SKIP');
    const step = b.steps.find((s) => s.seq === seq);
    if (!step) throw badRequest('Invalid step.', 'BAD_STEP');
    if (step.status !== 'SKIPPED') throw conflict('This ingredient is not waiting for the lab.', 'NOT_SKIPPED');
    await applyRelease(tx, b, step, ctx.user, ctx.device, '');
  });
}

/** Skips a step for the lab (by a scientist or the operator) and moves the job on. */
async function applySkip(tx: Tx, b: LoadedBatch, step: BatchStep, by: SessionUser, device: string, note: string) {
  const now = new Date();
  const wasCurrent = step.status === 'CURRENT';
  await tx.batchStep.update({
    where: { id: step.id },
    // Any scan made before the skip is dropped (it stays in the audit trail); the bottle is scanned again when it is added.
    data: { status: 'SKIPPED', stage: 'FIND', startedAt: null, foundAt: null, scannedAt: null, scannedBarcode: null, lotId: null, lotNumber: null, skippedAt: now, skippedById: by.id, skipNote: note, labReleasedAt: null, labReleasedById: null },
  });
  let newBatch: string = b.status;
  if (wasCurrent) {
    const next = nextLocked({ ...b, steps: b.steps.filter((s) => s.id !== step.id) }, step.seq);
    if (next) {
      await tx.batchStep.update({ where: { id: next.id }, data: { status: 'CURRENT', stage: 'FIND', startedAt: now } });
    } else {
      // Nothing else to do now: wait for the lab without holding the station.
      await tx.batch.update({ where: { id: b.id }, data: { status: 'AWAITING_LAB', pausedAt: null } });
      newBatch = 'AWAITING_LAB';
    }
  }
  await audit(tx, {
    type: 'INGREDIENT_SKIPPED', outcome: 'SUCCESS', userId: by.id, role: by.role, stationId: b.stationId, sourceDevice: device, batchId: b.id,
    prevState: `${step.status}/${b.status}`, newState: `SKIPPED/${newBatch}`,
    details: { seq: step.seq, ingredient: step.ingredientCode, ingredientName: step.ingredientName, note, byName: by.name, byRole: by.role },
  });
}

/** Marks a skipped step's lab ingredient as arrived (by a scientist or the operator): it is added next. */
async function applyRelease(tx: Tx, b: LoadedBatch, step: BatchStep, by: SessionUser, device: string, note: string) {
  await tx.batchStep.update({ where: { id: step.id }, data: { status: 'LOCKED', labReleasedAt: new Date(), labReleasedById: by.id } });
  await audit(tx, {
    type: 'LAB_INGREDIENT_RELEASED', outcome: 'SUCCESS', userId: by.id, role: by.role, stationId: b.stationId, sourceDevice: device, batchId: b.id,
    prevState: 'SKIPPED', newState: 'LOCKED',
    details: { seq: step.seq, ingredient: step.ingredientCode, ingredientName: step.ingredientName, note: note || null, byName: by.name, byRole: by.role },
  });
}

// ─────────────────────────────── simulator ───────────────────────────────

/** Audit device-level events from the training simulator that matter (disconnects). */
export async function auditSimAction(ctx: Ctx, a: SimAction) {
  if (a.action === 'connect') {
    await auditNow({ type: a.on ? 'DEVICE_RECONNECTED' : 'DEVICE_DISCONNECTED', outcome: 'INFO', ...actorOf(ctx), details: { device: 'scale', simulated: true } });
  }
}
