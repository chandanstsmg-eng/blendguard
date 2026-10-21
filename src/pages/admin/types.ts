/** Response shapes for the /api/admin endpoints (see server/services/admin.service.ts). */
import type { Lang, Role, StationInfo } from '@shared/types';

export type { Lang, Role };

export interface AdminCredential {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface AdminUser {
  id: string;
  role: Role;
  name: string;
  operatorCode: string | null;
  username: string | null;
  language: Lang;
  active: boolean;
  locked: boolean;
  stationIds: string[];
  stations: string[];
  credentials: AdminCredential[];
  lastSignIn: string | null;
  createdAt: string;
}

export interface NewUserBody {
  role: Role;
  name: string;
  language: Lang;
  operatorCode?: string;
  pin?: string;
  username?: string;
  password?: string;
  stationIds?: string[];
}

export interface UserPatchBody {
  name?: string;
  language?: Lang;
  active?: boolean;
  stationIds?: string[];
}

export interface AdminStation extends StationInfo {
  bound: boolean;
  boundAt: string | null;
  scaleConnected: boolean;
  vesselDriftLimitMg: number;
  operatorCount: number;
}

export type StationPatchBody = Partial<
  Pick<StationInfo, 'allowFingerprint' | 'allowFace' | 'allowPin' | 'allowAssisted' | 'defaultLanguage' | 'audioEnabled' | 'audioVolume' | 'allowPause' | 'autoAccept' | 'idleMinutes'>
>;

export const PPE = ['GLOVES', 'MASK', 'GOGGLES', 'DROPPER', 'SPATULA'] as const;
export const HAZARDS = ['FLAMMABLE', 'IRRITANT', 'ENVIRONMENT', 'TOXIC', 'CORROSIVE'] as const;
export type Ppe = (typeof PPE)[number];
export type Hazard = (typeof HAZARDS)[number];

export type LotStatus = 'RELEASED' | 'QUARANTINE' | 'REJECTED';

export interface AdminLot {
  id: string;
  lotNumber: string;
  barcode: string;
  status: LotStatus;
  expiresOn: string | null;
}

export interface AdminRack {
  code: string;
  label: string;
  zone: string;
  rows: number;
  cols: number;
}

export interface AdminIngredient {
  id: string;
  code: string;
  name: string;
  barcode: string | null;
  lotTracked: boolean;
  rackCode: string | null;
  bin: number | null;
  handling: string[];
  hazards: string[];
  ppe: string[];
  colorHex: string | null;
  photoUrl: string | null;
  formulaCount: number;
  lots: AdminLot[];
}

export interface AdminIngredients {
  racks: AdminRack[];
  ingredients: AdminIngredient[];
}

export interface NewIngredientBody {
  code: string;
  name: string;
  barcode: string;
}

export interface IngredientPatchBody {
  colorHex?: string | null;
  rackCode?: string | null;
  bin?: number | null;
  ppe?: Ppe[];
  hazards?: Hazard[];
  handling?: string[];
}

export type FormulaStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED';

export interface AdminFormulaLine {
  seq: number;
  code: string;
  name: string;
  colorHex: string | null;
  targetMg: number;
  tolMinusMg: number;
  tolPlusMg: number;
  remarks: string | null;
}

export interface AdminFormula {
  id: string;
  code: string;
  revision: string;
  perfumeName: string;
  status: FormulaStatus;
  sopNumber: string | null;
  batchSizeMg: number;
  approvedBy: string | null;
  approvedAt: string | null;
  batchCount: number;
  lines: AdminFormulaLine[];
}

export type AuditOutcome = 'SUCCESS' | 'REJECTED' | 'FAILED' | 'INFO';
export const AUDIT_OUTCOMES: AuditOutcome[] = ['SUCCESS', 'REJECTED', 'FAILED', 'INFO'];

export interface AuditEventRow {
  seqNo: string;
  at: string;
  type: string;
  outcome: string;
  user: string | null;
  role: string | null;
  station: string | null;
  batchNo: string | null;
  prevState: string | null;
  newState: string | null;
  sourceDevice: string | null;
  details: unknown;
}

export interface AuditPage {
  events: AuditEventRow[];
  next: string | null;
  types: string[];
}
