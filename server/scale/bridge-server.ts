/**
 * Server end of the scale bridge (BRIDGE stations).
 *
 * The bridge runs on the station PC, reads the scale on its COM port and streams
 * every reading here on the "/bridge" channel. It signs in with the station code
 * and that station's bridge key (created on the Station setup page; only its hash is stored).
 * The server tells the bridge which COM port and settings to use, so the station
 * is configured in one place: Setup → Station setup.
 */
import crypto from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import type { Station } from '@prisma/client';
import { z } from 'zod';
import { db } from '../db/prisma.js';
import { sha256 } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { auditNow } from '../services/audit.service.js';
import { acceptBridgeReading, bridgeGone } from '../services/scale.service.js';

const reading = z.object({
  connected: z.boolean(),
  stable: z.boolean(),
  grossMg: z.number().int().min(-1_000_000_000).max(1_000_000_000).nullable(),
  fault: z.enum(['NO_PORT', 'NO_REPLY', 'OVERLOAD', 'UNDERLOAD', 'BUSY', 'BAD_REPLY']).nullable(),
});

/** One live bridge per station. */
const bridges = new Map<string, Socket>();
const refusedAt = new Map<string, number>();

export const bridgeConfig = (st: Pick<Station, 'code' | 'name' | 'scalePort' | 'scaleBaud' | 'scaleFraming'>) => ({
  station: st.code,
  name: st.name,
  port: st.scalePort,
  baudRate: st.scaleBaud,
  framing: st.scaleFraming,
});

export function attachBridge(io: Server) {
  const nsp = io.of('/bridge');
  nsp.use(async (socket, next) => {
    try {
      const { station: code, key } = (socket.handshake.auth ?? {}) as { station?: unknown; key?: unknown };
      if (typeof code !== 'string' || typeof key !== 'string' || key.length < 20) return next(new Error('Station code and bridge key are required.'));
      const st = await db().station.findUnique({ where: { code: code.trim().toUpperCase() } });
      const ok = !!st?.bridgeKeyHash && crypto.timingSafeEqual(Buffer.from(sha256(key)), Buffer.from(st.bridgeKeyHash));
      if (!st || !ok) {
        // A mis-set bridge retries every few seconds: record each source at most once a minute.
        const who = `${socket.handshake.address}|${code}`;
        if (Date.now() - (refusedAt.get(who) ?? 0) < 60_000) return next(new Error('Wrong station code or bridge key.'));
        refusedAt.set(who, Date.now());
        await auditNow({ type: 'SCALE_BRIDGE_REFUSED', outcome: 'REJECTED', userId: null, role: null, stationId: st?.id ?? null, sourceDevice: `bridge:${socket.handshake.address}`, details: { station: code } });
        return next(new Error('Wrong station code or bridge key.'));
      }
      if (st.scaleMode !== 'BRIDGE') return next(new Error(`Station ${st.code} is not set to use a scale bridge (Setup → Station setup → Scale).`));
      socket.data.stationId = st.id;
      socket.data.stationCode = st.code;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  nsp.on('connection', async (socket) => {
    const stationId = socket.data.stationId as string;
    const code = socket.data.stationCode as string;
    // A second bridge for the same station replaces the first (e.g. the PC was restarted).
    bridges.get(stationId)?.disconnect(true);
    bridges.set(stationId, socket);
    logger.info(`Scale bridge connected for ${code} from ${socket.handshake.address}`);
    await auditNow({ type: 'SCALE_BRIDGE_CONNECTED', outcome: 'INFO', userId: null, role: null, stationId, sourceDevice: `bridge:${socket.handshake.address}`, details: { station: code } });

    const st = await db().station.findUnique({ where: { id: stationId } });
    if (st) socket.emit('config', bridgeConfig(st));

    socket.on('reading', (payload: unknown) => {
      const r = reading.safeParse(payload);
      if (r.success) acceptBridgeReading(stationId, r.data);
    });
    socket.on('disconnect', (why) => {
      if (bridges.get(stationId) !== socket) return;
      bridges.delete(stationId);
      bridgeGone(stationId);
      logger.warn(`Scale bridge for ${code} disconnected (${why})`);
    });
  });
}

/** Sends new settings to a connected bridge (after a scientist changes the station's scale). */
export function pushBridgeConfig(st: Station) {
  const s = bridges.get(st.id);
  if (!s) return;
  if (st.scaleMode !== 'BRIDGE' || !st.bridgeKeyHash) return void s.disconnect(true);
  s.emit('config', bridgeConfig(st));
}

/** Drops the bridge connection, e.g. when its key is replaced. */
export function dropBridge(stationId: string) {
  bridges.get(stationId)?.disconnect(true);
}

export const bridgeOnline = (stationId: string) => bridges.has(stationId);
