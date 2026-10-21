/**
 * Socket.IO push channel. The server is the only source of truth; sockets just
 * tell screens that something changed (and stream live scale readings).
 *
 * Rooms:
 *   station:<id>   everything on one mixing station (run state, scale, jobs)
 *   supervisors    calls, submissions, station status
 */
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { parse as parseCookie } from './cookies.js';
import { STATION_COOKIE, SESSION_COOKIE, loadSession, loadStation } from './session.service.js';
import { logger } from '../utils/logger.js';
import type { RunState, ScaleState } from '../../shared/types.js';

let io: Server | null = null;

export function attachRealtime(server: HttpServer) {
  io = new Server(server, { path: '/socket.io', serveClient: false, cors: { origin: false } });
  io.on('connection', async (socket) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
      const station = await loadStation(cookies[STATION_COOKIE]);
      const session = await loadSession(cookies[SESSION_COOKIE], station?.id ?? null);
      if (station) await socket.join(`station:${station.id}`);
      if (session && session.user.role !== 'OPERATOR') await socket.join('supervisors');
      if (session) {
        socket.data.sessionId = session.sessionId;
        socket.data.userId = session.user.id;
      }
      socket.emit('hello', { station: station?.code ?? null, user: session?.user.id ?? null });
    } catch (err) {
      logger.warn('Socket handshake failed', err);
      socket.disconnect(true);
    }
  });
}

/**
 * Live connections keep the rooms they joined when they opened. When a session
 * ends (sign-out, password reset, account switched off) its connections stop
 * receiving supervisor updates at once. The station room stays: it belongs to
 * the station PC, not to the person.
 */
export function revokeSocketAccess(match: { sessionId?: string; userId?: string }) {
  if (!io) return;
  for (const s of io.of('/').sockets.values()) {
    if ((match.sessionId && s.data.sessionId === match.sessionId) || (match.userId && s.data.userId === match.userId)) {
      void s.leave('supervisors');
      s.data.sessionId = undefined;
      s.data.userId = undefined;
    }
  }
}

/** The Socket.IO server, for other live channels (the scale bridge). */
export const realtimeServer = () => io;

export function closeRealtime() {
  io?.close();
  io = null;
}

export function emitRun(stationId: string, run: RunState) {
  io?.to(`station:${stationId}`).emit('run', run);
  io?.to('supervisors').emit('station-changed', { stationId, batchId: run.id });
}

const lastFloorScale = new Map<string, number>();

export function emitScale(state: ScaleState) {
  io?.to(`station:${state.stationId}`).emit('scale', state);
  // The supervisors' floor monitor shows every station's live weight; a few updates a second is plenty.
  const now = Date.now();
  if (now - (lastFloorScale.get(state.stationId) ?? 0) >= 400) {
    lastFloorScale.set(state.stationId, now);
    io?.to('supervisors').emit('floor-scale', state);
  }
}

export function emitJobs(stationId: string) {
  io?.to(`station:${stationId}`).emit('jobs-changed');
  io?.to('supervisors').emit('station-changed', { stationId });
}

export function emitCalls(stationId: string) {
  io?.to('supervisors').emit('calls-changed', { stationId });
  io?.to(`station:${stationId}`).emit('calls-changed');
}

export function emitStation(stationId: string) {
  io?.to(`station:${stationId}`).emit('station-changed');
  io?.to('supervisors').emit('station-changed', { stationId });
}
