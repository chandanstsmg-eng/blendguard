/**
 * METTLER TOLEDO MT-SICS (Standard Interface Command Set), the language spoken by
 * Mettler Toledo balances and weighing terminals over RS-232 / RS-485 / USB.
 *
 * We only ever READ the scale. BlendGuard keeps its own tare (the container
 * weight recorded when the operator presses SET TO 0), so it never sends
 * T / Z / TAC commands that would change what the scale reports.
 *
 *   SI  → "S S      123.45 g"   stable weight      (S S = stable)
 *         "S D      123.47 g"   weight still moving (S D = dynamic)
 *         "S +" / "S -"         over / under the scale's range
 *         "S I"                 scale busy (e.g. zeroing at power-up)
 *   TA  → "TA A       12.34 g"  tare stored in the scale itself
 *
 * SI returns the NET weight on the scale's display. If someone presses the
 * scale's own TARE key, net drops to 0 while the real weight is unchanged, so we
 * also read TA and use gross = net + scale tare. Pressing TARE on the scale
 * therefore cannot hide an over-pour.
 */

export type SicsReply =
  | { kind: 'weight'; stable: boolean; mg: number }
  | { kind: 'tare'; mg: number }
  | { kind: 'overload' }
  | { kind: 'underload' }
  | { kind: 'busy' }
  | { kind: 'error'; detail: string }
  | { kind: 'ignored' };

const UNIT_MG: Record<string, number> = { mg: 1, g: 1000, kg: 1_000_000 };

/**
 * "123.45" + "g" → 123450 (mg), using string arithmetic only, so no binary
 * floating point is ever involved. Returns null when the value cannot be
 * represented in whole milligrams (e.g. a 0.1 mg analytical balance) or the
 * unit is not a mass unit we accept.
 */
export function toMg(value: string, unit: string): number | null {
  const factor = UNIT_MG[unit];
  if (!factor) return null;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return null;
  const [, sign, whole, frac = ''] = m;
  const places = Math.log10(factor); // 0, 3 or 6 decimals fit in whole mg
  if (frac.length > places && /[1-9]/.test(frac.slice(places))) return null;
  const mg = Number(whole) * factor + (places ? Number(frac.slice(0, places).padEnd(places, '0')) : 0);
  if (!Number.isSafeInteger(mg)) return null;
  return sign === '-' ? -mg : mg;
}

/** Parses one line from the scale (without the CR LF). */
export function parseSics(line: string): SicsReply {
  const t = line.trim();
  if (!t) return { kind: 'ignored' };
  // Weight: "S S     123.45 g" / "SI S ..." (some terminals echo SI) / "S D ..."
  let m = /^(?:S|SI)\s+([SD])\s+([+-]?\s*\d+(?:\.\d+)?)\s+(\S+)$/.exec(t);
  if (m) {
    const mg = toMg(m[2].replace(/\s+/g, ''), m[3]);
    if (mg == null) return { kind: 'error', detail: `Unsupported weight "${m[2]} ${m[3]}"` };
    return { kind: 'weight', stable: m[1] === 'S', mg };
  }
  m = /^TA\s+A\s+([+-]?\s*\d+(?:\.\d+)?)\s+(\S+)$/.exec(t);
  if (m) {
    const mg = toMg(m[1].replace(/\s+/g, ''), m[2]);
    return mg == null ? { kind: 'error', detail: `Unsupported tare "${m[1]} ${m[2]}"` } : { kind: 'tare', mg };
  }
  if (/^(?:S|SI)\s+\+$/.test(t)) return { kind: 'overload' };
  if (/^(?:S|SI)\s+-$/.test(t)) return { kind: 'underload' };
  if (/^(?:S|SI|TA)\s+I$/.test(t)) return { kind: 'busy' };
  // ES syntax error, ET transmission error, EL logical error; "TA L" = tare not available.
  if (/^E[STL]$/.test(t) || /^(?:S|SI|TA)\s+[LI]$/.test(t)) return { kind: 'error', detail: t };
  return { kind: 'ignored' };
}
