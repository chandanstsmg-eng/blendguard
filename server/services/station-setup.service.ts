/**
 * Set-up of stations and their scales: adding a station, choosing how its
 * scale is connected, and issuing the key its scale bridge signs in with.
 *
 * Anything that changes what the scale measures (driver, port, resolution,
 * uncertainty) cancels the current scale check, so a supervisor must check the
 * scale again with a reference weight before anyone can weigh on it.
 */
import type { ScaleMode, Station } from '@prisma/client';
import { db } from '../db/prisma.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { audit, type Actor } from './audit.service.js';
import { configureStation, readScale } from './scale.service.js';
import { emitStation } from './realtime.service.js';
import { bridgeOnline, dropBridge, pushBridgeConfig } from '../scale/bridge-server.js';
import { toStationInfo } from './session.service.js';

const ACTIVE = ['IN_PROGRESS', 'PAUSED', 'ON_HOLD'] as const;

export interface ScaleSettings {
  scaleMode: ScaleMode;
  scaleModel: string;
  scalePort: string | null;
  scaleBaud: number;
  scaleFraming: string;
  scaleResolutionMg: number;
  scaleUncertaintyMg: number;
  vesselDriftLimitMg: number;
}

/** Fields whose change means the scale must be checked again before use. */
const MEASURING: (keyof ScaleSettings)[] = ['scaleMode', 'scalePort', 'scaleBaud', 'scaleFraming', 'scaleResolutionMg', 'scaleUncertaintyMg'];

export function scaleSetup(s: Station) {
  const r = readScale(s.id);
  return {
    scalePort: s.scalePort,
    scaleBaud: s.scaleBaud,
    scaleFraming: s.scaleFraming,
    bridgeKeySet: !!s.bridgeKeyHash,
    bridgeOnline: bridgeOnline(s.id),
    scaleFault: r.fault ?? null,
    scaleGrossMg: r.connected ? r.grossMg : null,
    scaleStable: r.stable,
  };
}

async function assertIdle(stationId: string, what: string) {
  const busy = await db().batch.findFirst({ where: { stationId, status: { in: [...ACTIVE] } }, select: { batchNo: true } });
  if (busy) throw conflict(`Job ${busy.batchNo} is running on this station. Finish or pause it elsewhere before changing ${what}.`, 'JOB_ACTIVE');
}

export async function updateScaleSettings(actor: Actor, stationId: string, patch: Partial<ScaleSettings>) {
  const before = await db().station.findUnique({ where: { id: stationId } });
  if (!before) throw notFound('Station');
  const next = { ...before, ...patch };
  if (next.scaleMode !== 'SIMULATED' && !next.scalePort) throw badRequest('Enter the COM port the scale is connected to (for example COM3).', 'PORT_REQUIRED');
  if (next.scaleUncertaintyMg < next.scaleResolutionMg) {
    throw badRequest('The measurement uncertainty cannot be smaller than one scale division. Use the value from the calibration certificate.', 'BAD_UNCERTAINTY');
  }
  const changed = Object.fromEntries(
    Object.entries(patch)
      .filter(([k, v]) => (before as Record<string, unknown>)[k] !== v)
      .map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k], to: v }]),
  );
  if (!Object.keys(changed).length) return before;
  await assertIdle(stationId, 'the scale');
  const recheck = MEASURING.some((k) => k in changed);

  const after = await db().$transaction(async (tx) => {
    const s = await tx.station.update({
      where: { id: stationId },
      data: { ...patch, ...(recheck ? { scaleValidatedUntil: null } : {}) },
    });
    await audit(tx, {
      type: 'SCALE_SETTINGS_CHANGED', outcome: 'SUCCESS', ...actor, stationId,
      details: { station: s.code, changed, scaleCheckCancelled: recheck && !!before.scaleValidatedUntil },
    });
    return s;
  });
  configureStation(after);
  pushBridgeConfig(after);
  emitStation(stationId);
  return after;
}

/** A new bridge key for the station. Shown once; the old key stops working at once. */
export async function createBridgeKey(actor: Actor, stationId: string) {
  const st = await db().station.findUnique({ where: { id: stationId } });
  if (!st) throw notFound('Station');
  const key = randomToken();
  await db().$transaction(async (tx) => {
    await tx.station.update({ where: { id: stationId }, data: { bridgeKeyHash: sha256(key) } });
    await audit(tx, { type: 'SCALE_BRIDGE_KEY_CREATED', outcome: 'SUCCESS', ...actor, stationId, details: { station: st.code, replaced: !!st.bridgeKeyHash } });
  });
  dropBridge(stationId);
  return { key, station: st.code };
}

export async function createStation(actor: Actor, input: { code: string; name: string }) {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (await db().station.findUnique({ where: { code } })) throw conflict(`Station ${code} already exists.`, 'DUPLICATE');
  const st = await db().$transaction(async (tx) => {
    // A new station starts on PIN sign-in and with no scale: nothing can be weighed
    // until a scientist sets up its scale and checks it.
    const s = await tx.station.create({
      data: {
        code, name,
        allowFingerprint: false, allowFace: false, allowPin: true, allowAssisted: true,
        scaleMode: 'BRIDGE', scaleModel: 'METTLER TOLEDO (MT-SICS)', scaleResolutionMg: 10, scaleUncertaintyMg: 20,
      },
    });
    await audit(tx, { type: 'STATION_CREATED', outcome: 'SUCCESS', ...actor, stationId: s.id, details: { station: code, name } });
    return s;
  });
  configureStation(st);
  return toStationInfo(st);
}
