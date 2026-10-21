/** Shapes exchanged between the server and the screens. */
import type { Verdict } from './weighing.js';

/** SUPERVISOR is shown as "Scientist" everywhere on screen. */
export type Role = 'OPERATOR' | 'SUPERVISOR';
export type Lang = 'en' | 'hi' | 'ml';

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  operatorCode: string | null;
  username: string | null;
  language: Lang;
  method: string;
}

export interface StationInfo {
  id: string;
  code: string;
  name: string;
  allowFingerprint: boolean;
  allowFace: boolean;
  allowPin: boolean;
  allowAssisted: boolean;
  defaultLanguage: Lang;
  audioEnabled: boolean;
  audioVolume: number;
  allowPause: boolean;
  autoAccept: boolean;
  idleMinutes: number;
  scaleMode: 'SIMULATED' | 'SERIAL' | 'BRIDGE';
  scaleModel: string;
  scaleResolutionMg: number;
  scaleUncertaintyMg: number;
  scaleValidatedUntil: string | null;
  scaleValidated: boolean;
}

export interface MeResponse {
  user: SessionUser | null;
  station: StationInfo | null;
}

export type BatchStatus =
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'PAUSED'
  | 'ON_HOLD'
  | 'AWAITING_SUBMISSION'
  | 'AWAITING_LAB'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'REJECTED'
  | 'CORRECTION';

export type StepStatus = 'LOCKED' | 'CURRENT' | 'COMPLETED' | 'ON_HOLD' | 'SKIPPED';
export type StepStage = 'FIND' | 'SCAN' | 'WEIGH' | 'DONE';

export interface JobCard {
  id: string;
  batchNo: string;
  perfumeName: string;
  formulaCode: string;
  revision: string;
  ingredientCount: number;
  completedCount: number;
  /** Ingredients skipped by the supervisor, waiting for the lab report. */
  skippedCount: number;
  /** Waiting for the lab, and the supervisor has released a lab ingredient: the operator can continue. */
  labReady: boolean;
  status: BatchStatus;
  plannedStart: string | null;
  instructions: string | null;
  isBackup: boolean;
  /** Each bottle's status in sequence order, for the progress bar (skipped bottles can be anywhere). */
  stepStatuses: StepStatus[];
}

/** Header of an SAP-style process order (as printed on the PROCESS ORDER sheet). Empty string when not given. */
export interface ProcessOrderHeader {
  processOrder: string;
  plant: string;
  resource: string;
  startDate: string;
  finishDate: string;
  material: string;
  materialDescription: string;
  batch: string;
  orderQuantity: string;
  orderUom: string;
  saleOrder: string;
  inspectionLot: string;
  reservation: string;
  orderType: string;
  planDeliveryDate: string;
}

export const PROCESS_ORDER_FIELDS: { key: keyof ProcessOrderHeader; label: string }[] = [
  { key: 'processOrder', label: 'Process Order' },
  { key: 'plant', label: 'Plant' },
  { key: 'resource', label: 'Resource' },
  { key: 'startDate', label: 'Start Date' },
  { key: 'finishDate', label: 'Finish Date' },
  { key: 'material', label: 'Material' },
  { key: 'materialDescription', label: 'Material description' },
  { key: 'batch', label: 'Batch' },
  { key: 'orderQuantity', label: 'Order Quantity' },
  { key: 'orderUom', label: 'Order UoM' },
  { key: 'saleOrder', label: 'Sale Order' },
  { key: 'inspectionLot', label: 'Inspection Lot' },
  { key: 'reservation', label: 'Reservation' },
  { key: 'orderType', label: 'Order Type' },
  { key: 'planDeliveryDate', label: 'Plan Delivery Date' },
];

export function emptyProcessOrder(): ProcessOrderHeader {
  return Object.fromEntries(PROCESS_ORDER_FIELDS.map((f) => [f.key, ''])) as unknown as ProcessOrderHeader;
}

export interface RackInfo {
  code: string;
  label: string;
  zone: string;
  rows: number;
  cols: number;
}

export interface RunStep {
  id: string;
  seq: number;
  ingredientCode: string;
  ingredientName: string;
  targetMg: number;
  tolMinusMg: number;
  tolPlusMg: number;
  remarks: string | null;
  /** From the process order (when the job came from one). */
  storageLocation: string | null;
  sourceBatch: string | null;
  uom: string | null;
  status: StepStatus;
  stage: StepStage;
  holdReason: string | null;
  lotTracked: boolean;
  lotNumber: string | null;
  /** Mixing container (1–3) recorded when the scale was set to zero; null before that. */
  containerNo: number | null;
  startedAt: string | null;
  tareGrossMg: number | null;
  acceptedNetMg: number | null;
  acceptedAt: string | null;
  wrongScans: number;
  /** Set when a supervisor skipped this ingredient until the lab report. */
  skippedAt: string | null;
  skipNote: string | null;
  /** Set when the supervisor confirmed the lab ingredient arrived. */
  labReleasedAt: string | null;
  location: { rack: RackInfo; bin: number } | null;
  handling: string[];
  hazards: string[];
  ppe: string[];
  /** Bottle cap / sticker colour (#RRGGBB) or null when not set. */
  colorHex: string | null;
  /** URL of the bottle photo, or null when no photo has been uploaded. */
  photoUrl: string | null;
}

export interface DeviationInfo {
  id: string;
  seq: number | null;
  type: 'OVERWEIGHT' | 'VESSEL_CHANGED' | 'OTHER';
  details: Record<string, unknown>;
  raisedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  resolutionNote: string | null;
}

export interface RunState {
  id: string;
  batchNo: string;
  perfumeName: string;
  formulaCode: string;
  revision: string;
  status: BatchStatus;
  holdReason: string | null;
  version: number;
  simulated: boolean;
  startedAt: string | null;
  completedAt: string | null;
  submittedAt: string | null;
  instructions: string | null;
  /** Header of the process order the job came from, or null. */
  processOrder: ProcessOrderHeader | null;
  batchSizeMg: number;
  steps: RunStep[];
  deviations: DeviationInfo[];
  openCall: { id: string; status: 'OPEN' | 'ACKNOWLEDGED'; reason: string } | null;
  /** Gross weight accepted at the end of the previous ingredient (vessel continuity check). */
  lastAcceptedGrossMg: number | null;
  /** All racks on the floor, for the location map. */
  racks: RackInfo[];
}

export interface ScaleState {
  stationId: string;
  connected: boolean;
  stable: boolean;
  grossMg: number | null;
  at: number;
  mode: 'SIMULATED' | 'SERIAL' | 'BRIDGE';
  model: string;
  vesselOn?: boolean;
  /** Why a real scale gives no usable weight: no COM port / bridge, no answer, out of range, busy. */
  fault?: ScaleFault | null;
}

export type ScaleFault = 'NO_PORT' | 'NO_BRIDGE' | 'NO_REPLY' | 'OVERLOAD' | 'UNDERLOAD' | 'BUSY' | 'BAD_REPLY';

export type ScanResult =
  | { ok: true; lotNumber: string | null; run: RunState }
  | {
      ok: false;
      reason: 'WRONG_INGREDIENT' | 'UNKNOWN_BARCODE' | 'LOT_REQUIRED' | 'LOT_QUARANTINE' | 'LOT_REJECTED' | 'LOT_EXPIRED' | 'WRONG_LOT';
      scannedName: string | null;
      /** WRONG_LOT: the material batch the process order asks for. */
      expectedLot?: string | null;
      run: RunState;
    };

export type AcceptResult = { ok: true; netMg: number; run: RunState } | { ok: false; verdict: Verdict; netMg: number | null; run: RunState };

/** A barcode the training simulator can "scan" (simulation mode only). */
export interface SimBottle {
  barcode: string;
  label: string;
  hint: 'correct' | 'wrong' | 'lot-problem';
}
