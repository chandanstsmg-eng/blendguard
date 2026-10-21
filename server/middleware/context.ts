import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { SESSION_COOKIE, STATION_COOKIE, loadSession, loadStation } from '../services/session.service.js';
import { AppError, forbidden, unauthenticated } from '../utils/errors.js';
import type { Ctx } from '../services/batch.service.js';
import type { Actor } from '../services/audit.service.js';

/** Attaches the station (from this computer's cookie) and the signed-in user, if any. */
export async function attachContext(req: Request, _res: Response, next: NextFunction) {
  try {
    const station = await loadStation(req.cookies?.[STATION_COOKIE]);
    req.station = station ?? undefined;
    const found = await loadSession(req.cookies?.[SESSION_COOKIE], station?.id ?? null);
    if (found) {
      req.user = found.user;
      req.sessionId = found.sessionId;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * CSRF defence: session cookies are SameSite=Strict, and every state-changing
 * API call must carry a custom header that a cross-site form cannot send.
 */
export function requireAppHeader(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('X-BlendGuard') !== '1') return next(new AppError(403, 'Request refused.', 'CSRF'));
  next();
}

export const deviceOf = (req: Request) => (req.station ? `station:${req.station.code}` : `web:${req.ip ?? 'unknown'}`);

export function operatorCtx(req: Request): Ctx {
  if (!req.user) throw unauthenticated();
  if (!req.station) throw forbidden('This computer is not set up as a mixing station.', 'NO_STATION');
  if (req.user.role !== 'OPERATOR') throw forbidden('Operator sign-in required.', 'NOT_OPERATOR');
  return { user: req.user, station: req.station, device: deviceOf(req) };
}

/**
 * Everything that is not an operator's work is done by a scientist (role
 * SUPERVISOR): running the floor (jobs, calls, holds, scale checks) and setting
 * the system up (users, stations, ingredients, audit trail).
 */
export function supervisorActor(req: Request): Actor {
  if (!req.user) throw unauthenticated();
  if (req.user.role !== 'SUPERVISOR') throw forbidden('Scientist sign-in required.', 'WRONG_ROLE');
  return { userId: req.user.id, role: req.user.role, stationId: req.station?.id ?? null, sourceDevice: deviceOf(req) };
}

export const requireSupervisor: RequestHandler = (req, _res, next) => {
  try {
    supervisorActor(req);
    next();
  } catch (e) {
    next(e);
  }
};
