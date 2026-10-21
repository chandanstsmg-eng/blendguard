import type { BatchStatus, RunState, ScaleFault, StationInfo } from '@shared/types';

export interface Overview {
  /** Jobs per status across every job (the job list itself holds only the newest `jobRows`). */
  counts: Partial<Record<BatchStatus, number>>;
  /** Jobs waiting for the lab whose lab ingredient has been released. */
  labReadyCount: number;
  jobRows: number;
  stations: (StationInfo & {
    bound: boolean;
    scaleConnected: boolean;
    scaleFault: ScaleFault | null;
    current: {
      batchId: string;
      batchNo: string;
      perfumeName: string;
      operator: string;
      status: BatchStatus;
      done: number;
      total: number;
      stepSeq: number | null;
      stepStage: string | null;
      stepStatus: string | null;
      ingredient: string | null;
      /** 'OVERWEIGHT' | 'VESSEL_CHANGED' on a step hold; free-text note when the whole job is on hold. */
      holdReason: string | null;
      targetMg: number | null;
      tolMinusMg: number | null;
      tolPlusMg: number | null;
      tareGrossMg: number | null;
      stepStartedAt: string | null;
      startedAt: string | null;
    } | null;
    scaleGrossMg: number | null;
    scaleStable: boolean;
  })[];
  calls: { id: string; stationCode: string; stationName: string; batchId: string | null; seq: number | null; reason: string; status: 'OPEN' | 'ACKNOWLEDGED'; raisedBy: string; createdAt: string }[];
  batches: {
    id: string;
    batchNo: string;
    perfumeName: string;
    formula: string;
    operator: string;
    station: string;
    status: BatchStatus;
    simulated: boolean;
    done: number;
    total: number;
    /** Ingredients skipped until their lab report. */
    skipped: number;
    /** Waiting for the lab and a lab ingredient has been released. */
    labReady: boolean;
    assignedAt: string;
    submittedAt: string | null;
    /** Not one of the newest rows: listed only because it waits for the lab or for approval. */
    older: boolean;
  }[];
  operators:{ id: string; operatorCode: string; name: string; active: boolean; locked: boolean; stations: string[]; credentials: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[] }[];
  formulas: { id: string; code: string; revision: string; perfumeName: string; lines: number; batchSizeMg: number }[];
}

export interface OperatorActivity {
  date: string;
  operator: { id: string; name: string; operatorCode: string | null };
  summary: {
    firstSignIn: string | null;
    lastSignOut: string | null;
    firstActivity: string | null;
    lastActivity: string | null;
    signIns: number;
    jobsStarted: number;
    jobsSubmitted: number;
    ingredients: number;
    wrongScans: number;
    problems: number;
    pausedSec: number;
  };
  jobs: {
    id: string;
    batchNo: string;
    perfumeName: string;
    formula: string;
    station: string;
    status: BatchStatus;
    simulated: boolean;
    done: number;
    total: number;
    startedAt: string | null;
    completedAt: string | null;
    submittedAt: string | null;
  }[];
  events: { id: string; at: string; type: string; outcome: string; batchNo: string | null; station: string | null; by: string | null; details: Record<string, unknown> }[];
}

export type DeviationType ='OVERWEIGHT' | 'VESSEL_CHANGED' | 'OTHER';

export interface ShiftReport {
  date: string;
  totals: {
    jobsStarted: number;
    jobsFinished: number;
    jobsSubmitted: number;
    ingredients: number;
    problems: number;
    problemsOpen: number;
    calls: number;
    avgCallResponseSec: number | null;
    wrongScans: number;
  };
  operators: {
    operatorId: string;
    name: string;
    operatorCode: string | null;
    jobs: number;
    jobsFinished: number;
    ingredients: number;
    wrongScans: number;
    problems: number;
    avgSecPerIngredient: number | null;
  }[];
  batches: {
    id: string;
    batchNo: string;
    perfumeName: string;
    formula: string;
    operator: string;
    station: string;
    status: BatchStatus;
    simulated: boolean;
    done: number;
    total: number;
    startedAt: string | null;
    completedAt: string | null;
    minutes: number | null;
  }[];
  deviations: {
    id: string;
    batchNo: string;
    station: string;
    operator: string;
    seq: number | null;
    ingredient: string | null;
    type: DeviationType;
    raisedAt: string;
    resolvedAt: string | null;
    resolution: string | null;
    note: string | null;
  }[];
}

/** One job for the supervisor (GET /supervisor/batches/:id). */
export interface BatchDetail {
  run: RunState;
  operator: { id: string; name: string; operatorCode: string | null };
  station: { code: string; name: string; scaleResolutionMg: number };
  /** People who worked on the batch; they may not approve it. */
  workerIds: string[];
  assignedBy: string | null;
  assignedAt: string;
  submittedBy: string | null;
  scale: { model: string; checkedAt: string | null; checkedBy: string | null; validUntil: string | null };
  decision: { kind: 'APPROVED' | 'REJECTED'; by: string | null; at: string; note: string | null } | null;
  /** Who resolved each problem, by deviation id. */
  resolvedBy: Record<string, string | null>;
  /** Who skipped / released each lab ingredient, by step number. */
  lab: Record<number, { skippedBy: string | null; releasedBy: string | null }>;
}
