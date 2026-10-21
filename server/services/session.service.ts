/**
 * Sessions and station identity.
 *
 * - A station computer is identified by a long random token in an httpOnly
 *   cookie, issued when a supervisor sets that computer up as a station.
 * - An operator session is bound to the station it was opened on and is
 *   refused anywhere else (rule 2: authorised stations only).
 * - Scientist sessions are not bound to a station.
 */
import type { Response } from 'express';
import type { Station, User } from '@prisma/client';
import { db } from '../db/prisma.js';
import { config } from '../config.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import type { Lang, SessionUser, StationInfo } from '../../shared/types.js';

export const SESSION_COOKIE = 'bg_session';
export const STATION_COOKIE = 'bg_station';

// Secure cookies once the server runs on HTTPS, so they are never sent in clear text.
const cookieBase = { httpOnly: true, sameSite: 'strict' as const, secure: config.https, path: '/' };

export function toSessionUser(u: User, method: string): SessionUser {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    operatorCode: u.operatorCode,
    username: u.username,
    language: (['en', 'hi', 'ml'].includes(u.language) ? u.language : 'en') as Lang,
    method,
  };
}

export function scaleValidated(s: Pick<Station, 'scaleValidatedUntil'>) {
  return !!s.scaleValidatedUntil && s.scaleValidatedUntil.getTime() > Date.now();
}

export function toStationInfo(s: Station): StationInfo {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    allowFingerprint: s.allowFingerprint,
    allowFace: s.allowFace,
    allowPin: s.allowPin,
    allowAssisted: s.allowAssisted,
    defaultLanguage: s.defaultLanguage as Lang,
    audioEnabled: s.audioEnabled,
    audioVolume: s.audioVolume,
    allowPause: s.allowPause,
    autoAccept: s.autoAccept,
    idleMinutes: s.idleMinutes,
    scaleMode: s.scaleMode,
    scaleModel: s.scaleModel,
    scaleResolutionMg: s.scaleResolutionMg,
    scaleUncertaintyMg: s.scaleUncertaintyMg,
    scaleValidatedUntil: s.scaleValidatedUntil?.toISOString() ?? null,
    scaleValidated: scaleValidated(s),
  };
}

export async function loadStation(token: string | undefined): Promise<Station | null> {
  if (!token) return null;
  return db().station.findUnique({ where: { tokenHash: sha256(token) } });
}

export async function loadSession(token: string | undefined, stationId: string | null): Promise<{ user: SessionUser; sessionId: string } | null> {
  if (!token) return null;
  const id = sha256(token);
  const s = await db().session.findUnique({ where: { id }, include: { user: true } });
  if (!s || s.endedAt || s.expiresAt < new Date() || !s.user.active) return null;
  if (s.user.role === 'OPERATOR' && s.stationId !== stationId) return null;
  if (Date.now() - s.lastSeenAt.getTime() > 60_000) {
    await db().session.update({ where: { id }, data: { lastSeenAt: new Date() } });
  }
  return { user: toSessionUser(s.user, s.method), sessionId: id };
}

export async function startSession(res: Response, user: User, method: string, stationId: string | null) {
  const token = randomToken();
  const hours = user.role === 'OPERATOR' ? config.operatorSessionHours : config.supervisorSessionHours;
  await db().session.create({
    data: { id: sha256(token), userId: user.id, method, stationId, expiresAt: new Date(Date.now() + hours * 3600_000) },
  });
  res.cookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: hours * 3600_000 });
  return toSessionUser(user, method);
}

export async function endSession(res: Response, sessionId: string | undefined) {
  if (sessionId) await db().session.updateMany({ where: { id: sessionId, endedAt: null }, data: { endedAt: new Date() } });
  res.clearCookie(SESSION_COOKIE, cookieBase);
}

/** Issues a fresh station token for this computer. Any computer previously bound to the station loses it. */
export async function bindStation(res: Response, stationId: string) {
  const token = randomToken();
  await db().station.update({ where: { id: stationId }, data: { tokenHash: sha256(token), boundAt: new Date() } });
  res.cookie(STATION_COOKIE, token, { ...cookieBase, maxAge: 5 * 365 * 24 * 3600_000 });
}
