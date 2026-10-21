/**
 * Weighing equipment layer.
 *
 * The scale is read by the SERVER, never by the screen. The operator's browser
 * only displays what the server streams; it cannot submit a weight. Accept /
 * tare decisions use the server's own latest reading, so a modified browser
 * cannot fake a measurement.
 *
 * Drivers
 *   SIMULATED  in-process training simulator (this file). Readings are tagged
 *              source=SIMULATED and the batch is marked as a training record.
 *   SERIAL     METTLER TOLEDO scale (MT-SICS) on a COM port of the SERVER PC.
 *   BRIDGE     METTLER TOLEDO scale on a COM port of the STATION PC, read there
 *              by the scale bridge (scripts/scale-bridge.ts), which streams the
 *              readings here over the LAN, signed in with the station's bridge key.
 *
 * A real scale that has not answered recently reports "disconnected", which
 * blocks weighing (rule 7) instead of guessing.
 */
import { EventEmitter } from 'node:events';
import type { Station } from '@prisma/client';
import { db } from '../db/prisma.js';
import { logger } from '../utils/logger.js';
import { emitScale } from './realtime.service.js';
import { SicsScale, type DriverReading } from '../scale/sics-driver.js';
import type { ScaleState } from '../../shared/types.js';
import type { ScaleSnapshot } from '../../shared/weighing.js';

/** Emits 'stable' (stationId) whenever a station's reading settles. */
export const scaleEvents = new EventEmitter();

/** Readings older than this are not used for a decision. */
export const MAX_READING_AGE_MS = 3000;

/** Weight of the simulator's empty mixing vessel. */
const SIM_VESSEL_MG = 412_600;
const SETTLE_MS = 1100;
/** Mixing containers the simulator keeps apart (matches the 1–3 an operator can choose). */
const SIM_CONTAINERS = 3;

interface SimState {
  stationId: string;
  model: string;
  resolutionMg: number;
  connected: boolean;
  vesselOn: boolean;
  /** Which container (1–3) is on the scale. */
  container: number;
  /** What each container holds, index 0 = container 1. */
  contentsMg: number[];
  settleUntil: number;
  timer: NodeJS.Timeout | null;
  persistTimer: NodeJS.Timeout | null;
}

const sims = new Map<string, SimState>();
const modes = new Map<string, { mode: Station['scaleMode']; model: string }>();

const quantize = (mg: number, res: number) => Math.round(mg / res) * res;

const onScale = (s: SimState) => s.contentsMg[s.container - 1];
const setOnScale = (s: SimState, mg: number) => {
  s.contentsMg[s.container - 1] = mg;
};

function simGross(s: SimState) {
  return s.vesselOn ? SIM_VESSEL_MG + onScale(s) : 0;
}

function simSnapshot(s: SimState): ScaleState {
  const now = Date.now();
  const stable = now >= s.settleUntil;
  let gross: number | null = null;
  if (s.connected) {
    const exact = simGross(s);
    // While settling, the display wanders around the true value like a real balance.
    const jitter = stable ? 0 : (Math.random() - 0.5) * Math.min(4000, 200 + exact * 0.002);
    gross = quantize(exact + jitter, s.resolutionMg);
  }
  return { stationId: s.stationId, connected: s.connected, stable: s.connected && stable, grossMg: gross, at: now, mode: 'SIMULATED', model: s.model, vesselOn: s.vesselOn };
}

function pump(s: SimState) {
  if (s.timer) clearTimeout(s.timer);
  const tick = () => {
    const snap = simSnapshot(s);
    emitScale(snap);
    if (!snap.stable && s.connected) {
      s.timer = setTimeout(tick, 150);
    } else {
      s.timer = null;
      if (snap.stable) scaleEvents.emit('stable', s.stationId);
    }
  };
  tick();
}

function persist(s: SimState) {
  if (s.persistTimer) clearTimeout(s.persistTimer);
  s.persistTimer = setTimeout(() => {
    s.persistTimer = null;
    void db()
      .station.update({
        where: { id: s.stationId },
        data: { simGrossMg: s.vesselOn ? onScale(s) : -1, simContainer: s.container, simContentsMg: s.contentsMg },
      })
      .catch(() => {});
  }, 300);
}

// ─────────────────────────────── real scales ───────────────────────────────

/** Latest reading from each real scale (SERIAL driver here, or a bridge). */
const live = new Map<string, DriverReading>();
/** SERIAL drivers running in this process, with the connection they were opened with. */
const serial = new Map<string, { driver: SicsScale; key: string }>();
/** Last weight pushed to the screens, so unchanged readings are not re-sent many times a second. */
const lastSent = new Map<string, { key: string; at: number }>();
/** A real reading this old is shown as "disconnected" on the screens too. */
const LIVE_TIMEOUT_MS = 2500;
let watchdog: NodeJS.Timeout | null = null;

function liveState(stationId: string, r: DriverReading | undefined): ScaleState {
  const m = modes.get(stationId);
  const mode = m?.mode ?? 'SERIAL';
  if (!r) return { stationId, connected: false, stable: false, grossMg: null, at: Date.now(), mode, model: m?.model ?? 'Not configured', fault: mode === 'BRIDGE' ? 'NO_BRIDGE' : 'NO_PORT' };
  const fresh = Date.now() - r.at <= LIVE_TIMEOUT_MS;
  return {
    stationId,
    connected: r.connected && fresh,
    stable: r.connected && fresh && r.stable,
    grossMg: fresh ? r.grossMg : null,
    // The time of the reading itself, so a frozen value can never pass the age check.
    at: r.at,
    mode,
    model: m?.model ?? '',
    fault: fresh ? r.fault : mode === 'BRIDGE' ? 'NO_BRIDGE' : 'NO_REPLY',
  };
}

/** A new real reading: keep it, show it, and tell the overweight check when it settles. */
function onLiveReading(stationId: string, r: DriverReading) {
  const prev = live.get(stationId);
  live.set(stationId, r);
  const state = liveState(stationId, r);
  const key = `${state.connected}|${state.stable}|${state.grossMg}|${state.fault}`;
  const sent = lastSent.get(stationId);
  // Changes go out at once; an unchanged weight is repeated once a second so screens know it is live.
  if (!sent || sent.key !== key || r.at - sent.at >= 1000) {
    lastSent.set(stationId, { key, at: r.at });
    emitScale(state);
  }
  const settled = state.stable && state.grossMg != null && (!prev?.stable || prev.grossMg !== r.grossMg || !prev.connected);
  if (settled) scaleEvents.emit('stable', stationId);
}

/** Readings from a station's scale bridge (BRIDGE mode). The time is the server's own receive time. */
export function acceptBridgeReading(stationId: string, r: Omit<DriverReading, 'at'>) {
  if (modes.get(stationId)?.mode !== 'BRIDGE') return;
  onLiveReading(stationId, { ...r, at: Date.now() });
}

/** The bridge for this station went away: show the scale as disconnected straight away. */
export function bridgeGone(stationId: string) {
  if (modes.get(stationId)?.mode !== 'BRIDGE') return;
  live.delete(stationId);
  lastSent.delete(stationId);
  emitScale(liveState(stationId, undefined));
}

function startSerial(st: Station) {
  const key = `${st.scalePort}|${st.scaleBaud}|${st.scaleFraming}`;
  const existing = serial.get(st.id);
  if (existing?.key === key) return;
  stopSerial(st.id);
  if (!st.scalePort) return;
  const driver = new SicsScale({ path: st.scalePort, baudRate: st.scaleBaud, framing: st.scaleFraming });
  let lastErr = '';
  driver.on('reading', (r: DriverReading) => onLiveReading(st.id, r));
  driver.on('port-error', (err: Error) => {
    // A missing or busy COM port is retried every few seconds; log each new reason once.
    if (err.message !== lastErr) logger.warn(`Scale on ${st.code} (${st.scalePort}): ${err.message}`);
    lastErr = err.message;
  });
  driver.on('no-tare', (line: string) => logger.warn(`Scale on ${st.code} does not report its tare (${line}). Lock the scale's TARE key.`));
  driver.start();
  serial.set(st.id, { driver, key });
  logger.info(`Scale on ${st.code}: reading ${st.scalePort} at ${st.scaleBaud} baud (${st.scaleFraming})`);
}

function stopSerial(stationId: string) {
  const s = serial.get(stationId);
  if (!s) return;
  serial.delete(stationId);
  void s.driver.stop();
}

/** Registers every station's driver at startup (and after settings change). */
export async function initScales() {
  const stations = await db().station.findMany();
  for (const st of stations) configureStation(st);
  // Screens learn that a real scale went quiet even when no new reading arrives.
  watchdog ??= setInterval(() => {
    for (const [stationId, r] of live) {
      if (Date.now() - r.at > LIVE_TIMEOUT_MS && lastSent.get(stationId)?.key !== 'stale') {
        lastSent.set(stationId, { key: 'stale', at: Date.now() });
        emitScale(liveState(stationId, r));
      }
    }
  }, 1000);
}

export function configureStation(st: Station) {
  const before = modes.get(st.id)?.mode;
  modes.set(st.id, { mode: st.scaleMode, model: st.scaleModel });
  if (before && before !== st.scaleMode) {
    // Switching driver: forget everything the old one said.
    live.delete(st.id);
    lastSent.delete(st.id);
    if (before === 'SIMULATED') stopSim(st.id);
  }
  if (st.scaleMode === 'SERIAL') startSerial(st);
  else stopSerial(st.id);
  if (st.scaleMode !== 'SIMULATED') return;
  const existing = sims.get(st.id);
  if (existing) {
    existing.resolutionMg = st.scaleResolutionMg;
    existing.model = st.scaleModel;
    return;
  }
  // simGrossMg stores the contents of the container on the scale, or -1 when it was off the scale;
  // simContentsMg holds every container (empty on stations saved before containers were kept apart).
  const container = st.simContainer >= 1 && st.simContainer <= SIM_CONTAINERS ? st.simContainer : 1;
  const contentsMg = Array.from({ length: SIM_CONTAINERS }, (_, i) => Math.max(0, st.simContentsMg[i] ?? 0));
  if (!st.simContentsMg.length) contentsMg[container - 1] = Math.max(0, st.simGrossMg);
  sims.set(st.id, {
    stationId: st.id,
    model: st.scaleModel,
    resolutionMg: st.scaleResolutionMg,
    connected: true,
    vesselOn: st.simGrossMg >= 0,
    container,
    contentsMg,
    settleUntil: 0,
    timer: null,
    persistTimer: null,
  });
}

/** Latest reading for a station, as used for decisions. */
export function readScale(stationId: string): ScaleState {
  const sim = sims.get(stationId);
  if (sim) return simSnapshot(sim);
  return liveState(stationId, live.get(stationId));
}

export function toSnapshot(s: ScaleState): ScaleSnapshot {
  return { connected: s.connected && Date.now() - s.at <= MAX_READING_AGE_MS, stable: s.stable, grossMg: s.grossMg, at: s.at };
}

export const readingSource = (s: ScaleState) => (s.mode === 'SIMULATED' ? 'SIMULATED' : 'SCALE');

export type SimAction =
  | { action: 'pour'; mg: number }
  | { action: 'remove'; mg: number }
  | { action: 'vessel'; on: boolean }
  | { action: 'connect'; on: boolean }
  | { action: 'empty' };

/** Training simulator controls. Returns null if the station has no simulator. */
export function simulate(stationId: string, a: SimAction): ScaleState | null {
  const s = sims.get(stationId);
  if (!s) return null;
  switch (a.action) {
    case 'pour':
      if (!s.vesselOn) break;
      setOnScale(s, onScale(s) + quantize(Math.max(0, Math.min(a.mg, 2_000_000)), s.resolutionMg));
      break;
    case 'remove':
      if (!s.vesselOn) break;
      setOnScale(s, Math.max(0, onScale(s) - quantize(Math.max(0, a.mg), s.resolutionMg)));
      break;
    case 'vessel':
      s.vesselOn = a.on;
      break;
    case 'connect':
      s.connected = a.on;
      break;
    case 'empty':
      setOnScale(s, 0);
      break;
  }
  s.settleUntil = Date.now() + SETTLE_MS;
  persist(s);
  pump(s);
  return simSnapshot(s);
}

/**
 * Training: the operator chose a mixing container, which stands for putting that
 * container on the scale. Each container keeps its own contents, so going back
 * to container 1 after using container 2 shows container 1's weight again.
 * Does nothing on a real scale.
 */
export function simUseContainer(stationId: string, containerNo: number) {
  const s = sims.get(stationId);
  if (!s || containerNo < 1 || containerNo > SIM_CONTAINERS || s.container === containerNo) return;
  s.container = containerNo;
  persist(s);
  pump(s);
}

/** Training: a new job starts with clean, empty containers. Does nothing on a real scale. */
export function simNewJob(stationId: string) {
  const s = sims.get(stationId);
  if (!s) return;
  s.contentsMg.fill(0);
  s.container = 1;
  persist(s);
  pump(s);
}

export function hasSimulator(stationId: string) {
  return sims.has(stationId);
}

function stopSim(stationId: string) {
  const s = sims.get(stationId);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  if (s.persistTimer) clearTimeout(s.persistTimer);
  sims.delete(stationId);
}

export function stopScales() {
  for (const s of sims.values()) {
    if (s.timer) clearTimeout(s.timer);
    if (s.persistTimer) clearTimeout(s.persistTimer);
  }
  for (const id of [...serial.keys()]) stopSerial(id);
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

/** COM ports on the server PC, for choosing a SERIAL scale's port. */
export async function listSerialPorts() {
  const { SerialPort } = await import('serialport');
  const ports = await SerialPort.list();
  return ports.map((p) => ({ path: p.path, label: [p.path, (p as { friendlyName?: string }).friendlyName ?? p.manufacturer].filter(Boolean).join(' — ') }));
}

/** Test hook: make the simulator settle immediately. */
export function settleNow(stationId: string) {
  const s = sims.get(stationId);
  if (s) s.settleUntil = 0;
}
