import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { decimalsFor, grams } from '@shared/weighing';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Grams with the decimals the station's scale actually resolves. */
export function g(mg: number, resolutionMg = 10) {
  return grams(mg, decimalsFor(resolutionMg));
}

/** mg in a unit of `unitMg` milligrams, truncated (never rounded up) to `decimals` places. */
function inUnits(mg: number, unitMg: number, decimals: number) {
  const sign = mg < 0 ? '-' : '';
  const abs = Math.abs(mg);
  const whole = Math.floor(abs / unitMg);
  if (decimals <= 0) return `${sign}${whole}`;
  const digits = String(unitMg).length - 1;
  const frac = String(abs % unitMg).padStart(digits, '0').slice(0, decimals).padEnd(decimals, '0');
  return `${sign}${whole}.${frac}`;
}

/**
 * A quantity in the unit its line uses (process order UoM), with as many
 * decimals as the scale resolves in that unit: at 0.01 g a KG line shows
 * 0.40012 KG, never a value rounded to the gram.
 */
export function qtyInUnit(mg: number, uom: string | null | undefined, resolutionMg = 10) {
  const u = (uom ?? 'G').toUpperCase();
  const d = decimalsFor(resolutionMg);
  if (u === 'KG') return inUnits(mg, 1_000_000, Math.min(6, d + 3));
  if (u === 'MG') return String(mg);
  return inUnits(mg, 1000, d);
}

const sameYear = (d: Date) => d.getFullYear() === new Date().getFullYear();

/** 10:42 am */
export function fmtTime(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

/** 18 Oct, 10:42 am, with the year added when it is not this year. */
export function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', ...(sameYear(d) ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hour12: true });
}

/** 18 Oct 2026 */
export function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Saturday, 18 October 2026, from a YYYY-MM-DD plant day. */
export function fmtLongDay(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Today as YYYY-MM-DD in local (plant) time. */
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * One duration format for every screen and report: "45 s", "3 min 05 s",
 * "1 h 04 min". `seconds: false` drops the seconds below an hour ("3 min").
 */
export function fmtSeconds(totalSec: number | null | undefined, opts: { seconds?: boolean } = {}) {
  if (totalSec == null || !Number.isFinite(totalSec)) return '—';
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${pad2(m)} min`;
  if (opts.seconds === false) return `${m} min`;
  if (m) return `${m} min ${pad2(sec)} s`;
  return `${sec} s`;
}

/** Time between two moments, in the same format as fmtSeconds. */
export function fmtDuration(fromIso: string | null, toIso: string | null, opts: { seconds?: boolean } = { seconds: false }) {
  if (!fromIso || !toIso) return '—';
  return fmtSeconds((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000, opts);
}

export const pad2 = (n: number) => String(n).padStart(2, '0');
