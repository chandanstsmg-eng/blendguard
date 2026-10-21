/** Plain-English labels shared by the supervisor console pages. One name per thing. */
import type { BatchStatus, ScaleFault } from '@shared/types';
import type { DeviationType, Overview } from './types';

export const REASON: Record<string, string> = {
  CANNOT_FIND: 'Cannot find the bottle',
  WRONG_BOTTLE: 'Bottle or label looks wrong',
  SCALE_PROBLEM: 'Problem with the scale',
  HELP: 'Needs help',
  OVERWEIGHT: 'Too much poured: sign-off needed',
  VESSEL_CHANGED: 'Container weight changed: sign-off needed',
  NO_JOB: 'No job assigned',
  OTHER: 'Other',
};

export const STATUS_LABEL: Record<BatchStatus, string> = {
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In progress',
  PAUSED: 'Paused',
  ON_HOLD: 'On hold',
  AWAITING_SUBMISSION: 'Done, not sent yet',
  AWAITING_LAB: 'Waiting for lab',
  SUBMITTED: 'Pending approval',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CORRECTION: 'Sent back for correction',
};

export function statusTone(s: BatchStatus) {
  if (s === 'IN_PROGRESS' || s === 'APPROVED') return 'ok' as const;
  if (s === 'PAUSED' || s === 'ON_HOLD' || s === 'CORRECTION' || s === 'AWAITING_LAB') return 'warn' as const;
  if (s === 'REJECTED') return 'err' as const;
  if (s === 'SUBMITTED' || s === 'UNDER_REVIEW' || s === 'AWAITING_SUBMISSION') return 'orange' as const;
  return 'neutral' as const;
}

export const DEVIATION_LABEL: Record<DeviationType, string> = {
  OVERWEIGHT: 'Too much poured',
  VESSEL_CHANGED: 'Container weight changed',
  OTHER: 'Other problem',
};

export const RESOLUTION_LABEL: Record<string, string> = {
  EXCESS_REMOVED_REWEIGH: 'Excess removed, re-weighed',
  EXCESS_REMOVED_BY_OPERATOR: 'Excess taken out by the operator, correct weight saved',
  VESSEL_WEIGHT_ACCEPTED: 'Container weight accepted',
};

export const STAGE_LABEL: Record<string, string> = { FIND: 'Finding', SCAN: 'Scanning', WEIGH: 'Weighing', DONE: 'Done' };

export const LANGUAGE_LABEL: Record<string, string> = { en: 'English', hi: 'Hindi', ml: 'Malayalam' };

/** Why a real scale gives no weight. Same wording as the Station setup page. */
export const SCALE_FAULT_TEXT: Record<ScaleFault, string> = {
  NO_PORT: 'Cannot open the COM port. Check the cable and the port number.',
  NO_BRIDGE: 'Scale bridge not running on the station PC.',
  NO_REPLY: 'Scale not answering. Check it is switched on and set to MT-SICS.',
  OVERLOAD: 'Weight is over the scale’s range.',
  UNDERLOAD: 'Reading below zero. Is the weighing pan in place?',
  BUSY: 'Scale is busy (zeroing or adjusting).',
  BAD_REPLY: 'Unexpected reply. Check the scale’s interface is set to MT-SICS and the baud rate matches.',
};

/** Short form for chips on the floor monitor. */
export const SCALE_FAULT_SHORT: Record<ScaleFault, string> = {
  NO_PORT: 'COM port not available',
  NO_BRIDGE: 'Scale bridge not running',
  NO_REPLY: 'Scale not answering',
  OVERLOAD: 'Over the scale’s range',
  UNDERLOAD: 'Reading below zero',
  BUSY: 'Scale busy',
  BAD_REPLY: 'Unexpected scale reply',
};

/** Warning text colour used on white and pale-amber backgrounds across the consoles. */
export const WARN_TEXT = 'text-[#8a5a00]';

type Current = NonNullable<Overview['stations'][number]['current']>;

/** True when the job or its current ingredient is held for a supervisor. */
export function isHeld(c: Current | null | undefined) {
  return !!c && (c.stepStatus === 'ON_HOLD' || c.status === 'ON_HOLD');
}

/** Why a station is held, in plain English. */
export function holdLabel(c: Current) {
  if (c.stepStatus === 'ON_HOLD') {
    if (c.holdReason === 'OVERWEIGHT') return 'Too much poured';
    if (c.holdReason === 'VESSEL_CHANGED') return 'Container weight changed';
  }
  return c.holdReason ? `Job on hold: ${c.holdReason}` : 'Job on hold';
}

/** Calls nobody has closed yet (open or answered). The sidebar badge and every count use this. */
export const openCallCount = (o: Pick<Overview, 'calls'> | undefined) => o?.calls.length ?? 0;

/** Live stopwatch: seconds as "m:ss" (or "h:mm:ss" past an hour). Only for timers that tick on screen. */
export function mss(totalSec: number | null | undefined) {
  if (totalSec == null || !Number.isFinite(totalSec)) return '—';
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
