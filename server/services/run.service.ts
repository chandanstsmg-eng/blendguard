/** Builds the RunState the operator console renders. Read-only. */
import { db } from '../db/prisma.js';
import { notFound } from '../utils/errors.js';
import type { DeviationInfo, JobCard, ProcessOrderHeader, RackInfo, RunState, RunStep } from '../../shared/types.js';
import type { Prisma } from '@prisma/client';

let rackCache: { at: number; racks: Map<string, RackInfo> } | null = null;

export async function racks(): Promise<Map<string, RackInfo>> {
  if (rackCache && Date.now() - rackCache.at < 30_000) return rackCache.racks;
  const rows = await db().rack.findMany({ orderBy: { sortOrder: 'asc' } });
  rackCache = { at: Date.now(), racks: new Map(rows.map((r) => [r.code, { code: r.code, label: r.label, zone: r.zone, rows: r.rows, cols: r.cols }])) };
  return rackCache.racks;
}

export function invalidateRacks() {
  rackCache = null;
}

/** The upload time is in the URL so a replaced photo is never served from a stale cache. */
export const photoUrl = (ingredientId: string, updatedAt: Date) => `/api/ingredients/${ingredientId}/photo?v=${updatedAt.getTime()}`;

const runInclude = {
  formula: true,
  steps: { orderBy: { seq: 'asc' } },
  deviations: { orderBy: { raisedAt: 'asc' }, include: { step: { select: { seq: true } } } },
} satisfies Prisma.BatchInclude;

export async function buildRun(batchId: string): Promise<RunState> {
  const b = await db().batch.findUnique({ where: { id: batchId }, include: runInclude });
  if (!b) throw notFound('Job');
  const ingredientIds = [...new Set(b.steps.map((s) => s.ingredientId))];
  const [ingredients, rackMap, call] = await Promise.all([
    // The photo bytes are served separately; only whether one exists is needed here.
    db().ingredient.findMany({ where: { id: { in: ingredientIds } }, omit: { photo: true } }),
    racks(),
    db().supervisorCall.findFirst({ where: { batchId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, orderBy: { createdAt: 'desc' } }),
  ]);
  const ing = new Map(ingredients.map((i) => [i.id, i]));

  const steps: RunStep[] = b.steps.map((s) => {
    const i = ing.get(s.ingredientId);
    const rack = i?.rackCode ? rackMap.get(i.rackCode) : undefined;
    return {
      id: s.id,
      seq: s.seq,
      ingredientCode: s.ingredientCode,
      ingredientName: s.ingredientName,
      targetMg: s.targetMg,
      tolMinusMg: s.tolMinusMg,
      tolPlusMg: s.tolPlusMg,
      remarks: s.remarks,
      storageLocation: s.storageLocation,
      sourceBatch: s.sourceBatch,
      uom: s.uom,
      status: s.status,
      stage: s.stage,
      holdReason: s.holdReason,
      lotTracked: !!i?.lotTracked,
      lotNumber: s.lotNumber,
      containerNo: s.containerNo,
      startedAt: s.startedAt?.toISOString() ?? null,
      tareGrossMg: s.tareGrossMg,
      acceptedNetMg: s.acceptedNetMg,
      acceptedAt: s.acceptedAt?.toISOString() ?? null,
      wrongScans: s.wrongScans,
      skippedAt: s.skippedAt?.toISOString() ?? null,
      skipNote: s.skipNote,
      labReleasedAt: s.labReleasedAt?.toISOString() ?? null,
      location: rack && i?.bin ? { rack, bin: i.bin } : null,
      handling: i?.handling ?? [],
      hazards: i?.hazards ?? [],
      ppe: i?.ppe ?? [],
      colorHex: i?.colorHex ?? null,
      photoUrl: i?.photoUpdatedAt ? photoUrl(i.id, i.photoUpdatedAt) : null,
    };
  });

  const deviations: DeviationInfo[] = b.deviations.map((d) => ({
    id: d.id,
    seq: d.step?.seq ?? null,
    type: d.type,
    // What the resolution was based on (accepted vessel gross, gross before/after removing excess,
    // earlier ingredients in that container) travels with the deviation into the batch record.
    details: { ...((d.details ?? {}) as Record<string, unknown>), ...(d.resolutionDetails ? { resolvedWith: d.resolutionDetails } : {}) },
    raisedAt: d.raisedAt.toISOString(),
    resolvedAt: d.resolvedAt?.toISOString() ?? null,
    resolution: d.resolution,
    resolutionNote: d.resolutionNote,
  }));

  // Last saved by time: a lab ingredient added later can have a lower number than those weighed before it.
  const lastDone = b.steps
    .filter((s) => s.status === 'COMPLETED')
    .reduce<(typeof b.steps)[number] | undefined>((best, s) => (!best || (s.acceptedAt?.getTime() ?? 0) >= (best.acceptedAt?.getTime() ?? 0) ? s : best), undefined);

  return {
    id: b.id,
    batchNo: b.batchNo,
    perfumeName: b.formula.perfumeName,
    formulaCode: b.formula.code,
    revision: b.formula.revision,
    status: b.status,
    holdReason: b.holdReason,
    version: b.version,
    simulated: b.simulated,
    startedAt: b.startedAt?.toISOString() ?? null,
    completedAt: b.completedAt?.toISOString() ?? null,
    submittedAt: b.submittedAt?.toISOString() ?? null,
    instructions: b.instructions,
    processOrder: (b.processOrder as ProcessOrderHeader | null) ?? null,
    batchSizeMg: b.formula.batchSizeMg,
    steps,
    deviations,
    openCall: call ? { id: call.id, status: call.status as 'OPEN' | 'ACKNOWLEDGED', reason: call.reason } : null,
    lastAcceptedGrossMg: lastDone?.acceptedGrossMg ?? null,
    racks: [...rackMap.values()],
  };
}

const ACTIVE = ['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'ON_HOLD', 'AWAITING_SUBMISSION', 'AWAITING_LAB', 'CORRECTION'] as const;
// A job whose lab ingredient has arrived comes before new jobs; one still waiting for the lab goes last.
const statusRank: Record<string, number> = { IN_PROGRESS: 0, PAUSED: 1, ON_HOLD: 2, AWAITING_SUBMISSION: 3, LAB_READY: 3.5, CORRECTION: 4, ASSIGNED: 5, AWAITING_LAB: 6 };
const rankOf = (j: JobCard) => statusRank[j.status === 'AWAITING_LAB' && j.labReady ? 'LAB_READY' : j.status] ?? 9;

/** Jobs for this operator on this station. `history` adds recently submitted ones. */
export async function jobsFor(userId: string, stationId: string, history = false): Promise<JobCard[]> {
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const rows = await db().batch.findMany({
    where: {
      stationId,
      AND: [
        { OR: [{ operatorId: userId }, { backupOperatorId: userId }] },
        history ? { OR: [{ status: { in: [...ACTIVE] } }, { submittedAt: { gte: since } }] } : { status: { in: [...ACTIVE] } },
      ],
    },
    include: { formula: true, steps: { select: { status: true }, orderBy: { seq: 'asc' } } },
    take: 50,
  });
  return rows
    .map((b) => ({
      id: b.id,
      batchNo: b.batchNo,
      perfumeName: b.formula.perfumeName,
      formulaCode: b.formula.code,
      revision: b.formula.revision,
      ingredientCount: b.steps.length,
      completedCount: b.steps.filter((s) => s.status === 'COMPLETED').length,
      skippedCount: b.steps.filter((s) => s.status === 'SKIPPED').length,
      labReady: b.status === 'AWAITING_LAB' && b.steps.some((s) => s.status === 'LOCKED'),
      status: b.status,
      plannedStart: b.plannedStart?.toISOString() ?? null,
      instructions: b.instructions,
      isBackup: b.operatorId !== userId,
      stepStatuses: b.steps.map((s) => s.status),
    }))
    .sort(
      (a, b) =>
        rankOf(a) - rankOf(b) ||
        (a.plannedStart ?? '').localeCompare(b.plannedStart ?? '') ||
        a.batchNo.localeCompare(b.batchNo),
    );
}
