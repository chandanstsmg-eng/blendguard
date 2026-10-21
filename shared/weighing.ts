/**
 * Weight acceptance rules. One implementation, used by the server (which makes
 * the decision) and by the screen (which only mirrors it for live feedback).
 *
 * All values are whole milligrams, so there is no floating-point rounding
 * anywhere in an acceptance decision.
 *
 * Acceptance window (guard-banded, ILAC-G8 style "simple acceptance" with guard band):
 *
 *   lowLimit  = target - tolMinus          highLimit = target + tolPlus
 *   acceptLow = lowLimit  + guard          acceptHigh = highLimit - guard
 *
 * where guard = the scale's expanded measurement uncertainty (never less than
 * one display division), and both limits are snapped inwards to whole scale
 * divisions (see acceptanceWindow). A reading is only accepted when it is stable and
 * inside [acceptLow, acceptHigh], so measurement uncertainty can never carry an
 * out-of-tolerance quantity into an accepted result. If the guard band leaves
 * no window at all, the scale is not good enough for this line and the step
 * cannot be certified.
 */

export type Verdict =
  | 'DISCONNECTED'
  | 'NOT_VALIDATED'
  | 'CANNOT_CERTIFY'
  | 'NOT_TARED'
  | 'UNSTABLE'
  | 'UNDER'
  | 'OK'
  | 'OVER';

export interface ScaleSnapshot {
  connected: boolean;
  stable: boolean;
  /** Gross reading in mg as reported by the scale (already at its resolution). */
  grossMg: number | null;
  /** When this reading was taken (ms epoch). */
  at: number;
}

export interface LineSpec {
  targetMg: number;
  tolMinusMg: number;
  tolPlusMg: number;
}

export interface ScaleSpec {
  resolutionMg: number;
  uncertaintyMg: number;
  validated: boolean;
}

export interface Evaluation {
  verdict: Verdict;
  netMg: number | null;
  /** target - net. Positive = still to add. */
  remainingMg: number | null;
  acceptLowMg: number;
  acceptHighMg: number;
  lowLimitMg: number;
  highLimitMg: number;
  guardMg: number;
}

/**
 * The scale only ever shows multiples of its division, so the window is snapped
 * inwards to them: acceptLow up, acceptHigh down. Otherwise a window such as
 * 2342–2348 mg on a 10 mg scale looks open but no reading can ever land in it.
 * `certifiable` is false when no reachable reading is left.
 */
export function acceptanceWindow(line: LineSpec, scale: Pick<ScaleSpec, 'resolutionMg' | 'uncertaintyMg'>) {
  const res = Number.isInteger(scale.resolutionMg) && scale.resolutionMg > 0 ? scale.resolutionMg : 1;
  const guardMg = Math.max(scale.uncertaintyMg, res);
  const lowLimitMg = line.targetMg - line.tolMinusMg;
  const highLimitMg = line.targetMg + line.tolPlusMg;
  const acceptLowMg = Math.ceil((lowLimitMg + guardMg) / res) * res;
  const acceptHighMg = Math.floor((highLimitMg - guardMg) / res) * res;
  return { guardMg, lowLimitMg, highLimitMg, acceptLowMg, acceptHighMg, certifiable: acceptLowMg <= acceptHighMg };
}

export function evaluate(reading: ScaleSnapshot, tareGrossMg: number | null, line: LineSpec, scale: ScaleSpec): Evaluation {
  const w = acceptanceWindow(line, scale);
  const netMg = reading.grossMg != null && tareGrossMg != null ? reading.grossMg - tareGrossMg : null;
  const base = { ...w, netMg, remainingMg: netMg != null ? line.targetMg - netMg : null };

  if (!reading.connected || reading.grossMg == null) return { ...base, verdict: 'DISCONNECTED' };
  if (!scale.validated) return { ...base, verdict: 'NOT_VALIDATED' };
  if (!w.certifiable) return { ...base, verdict: 'CANNOT_CERTIFY' };
  if (tareGrossMg == null) return { ...base, verdict: 'NOT_TARED' };
  if (!reading.stable) return { ...base, verdict: 'UNSTABLE' };
  if (netMg! < w.acceptLowMg) return { ...base, verdict: 'UNDER' };
  if (netMg! > w.acceptHighMg) return { ...base, verdict: 'OVER' };
  return { ...base, verdict: 'OK' };
}

/** Number of decimals that matches a scale division, e.g. 10 mg → 2 (0.01 g). */
export function decimalsFor(resolutionMg: number) {
  if (resolutionMg >= 1000) return 0;
  if (resolutionMg >= 100) return 1;
  if (resolutionMg >= 10) return 2;
  return 3;
}

/** Formats mg as grams. Pure display: never used in decisions. */
export function grams(mg: number, decimals = 2) {
  const sign = mg < 0 ? '-' : '';
  const abs = Math.abs(mg);
  const whole = Math.floor(abs / 1000);
  const frac = abs % 1000;
  if (decimals === 0) return `${sign}${whole}`;
  // Truncate toward zero instead of rounding, so a display never shows a value the scale did not report.
  const fracStr = String(frac).padStart(3, '0').slice(0, decimals);
  return `${sign}${whole}.${fracStr}`;
}

/** A simulated reading from the scale is never treated as a production measurement. */
export const isSimulatedSource = (source: string) => source === 'SIMULATED';
