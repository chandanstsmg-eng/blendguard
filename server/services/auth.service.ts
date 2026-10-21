/**
 * Identity verification (spec §3).
 *
 * Fingerprint / face: WebAuthn passkeys held by the station's own biometric
 * hardware (Windows Hello fingerprint reader or camera, or a FIDO2 fingerprint
 * key). The biometric match happens inside the device; BlendGuard only ever
 * receives a signed assertion and stores the credential's PUBLIC key. No
 * fingerprint image, face image or biometric template reaches this server.
 * The server verifies the signature, the one-time challenge, the origin and
 * the "user verified" flag — an animation on screen can never sign anyone in.
 *
 * Fallbacks, each only where the supervisor has enabled it for the station:
 *   - Operator ID + PIN
 *   - Supervisor assistance (supervisor enters their own password)
 */
import type { Response } from 'express';
import type { Station, User } from '@prisma/client';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { db } from '../db/prisma.js';
import { config } from '../config.js';
import { AppError, badRequest, forbidden, unauthenticated } from '../utils/errors.js';
import { signSignoff, verifySecret } from '../utils/crypto.js';
import { audit, auditNow } from './audit.service.js';
import { startSession } from './session.service.js';
import { logger } from '../utils/logger.js';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const CHALLENGE_MS = 2 * 60_000;

interface AuthCtx {
  station: Station | null;
  device: string;
}

function requireStation(ctx: AuthCtx): Station {
  if (!ctx.station) throw forbidden('This computer is not set up as a mixing station.', 'NO_STATION');
  return ctx.station;
}

async function fail(ctx: AuthCtx, user: User | null, method: string, reason: string, identifier?: string | null): Promise<never> {
  let locked = false;
  if (user) {
    // Counted in the database itself, so attempts made at the same moment all count.
    const after = await db().user.update({ where: { id: user.id }, data: { failedAttempts: { increment: 1 } }, select: { failedAttempts: true } });
    locked = after.failedAttempts >= MAX_FAILS;
    if (locked) await db().user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } });
  }
  await auditNow({
    type: 'AUTH_FAILED',
    outcome: 'FAILED',
    userId: user?.id ?? null,
    role: user?.role ?? null,
    stationId: ctx.station?.id ?? null,
    sourceDevice: ctx.device,
    details: { method, reason, identifier: identifier ?? null, lockedOut: locked },
  });
  if (locked) throw new AppError(429, 'Too many attempts. Please ask your scientist.', 'LOCKED');
  throw new AppError(401, 'Not recognised. Please try again.', 'AUTH_FAILED', { reason });
}

function assertNotLocked(user: User) {
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new AppError(429, 'Too many attempts. Please ask your scientist.', 'LOCKED');
  }
}

async function assertOperatorAllowed(ctx: AuthCtx, user: User, method: string) {
  const station = requireStation(ctx);
  if (user.role !== 'OPERATOR' || !user.active) await fail(ctx, user, method, 'NOT_OPERATOR');
  const access = await db().stationAccess.findUnique({ where: { userId_stationId: { userId: user.id, stationId: station.id } } });
  if (!access) {
    await auditNow({ type: 'AUTH_FAILED', outcome: 'REJECTED', userId: user.id, role: user.role, stationId: station.id, sourceDevice: ctx.device, details: { method, reason: 'NO_STATION_ACCESS' } });
    throw forbidden('You are not authorised to work at this station.', 'NO_STATION_ACCESS');
  }
}

async function succeed(res: Response, ctx: AuthCtx, user: User, method: string, details: Record<string, unknown> = {}) {
  await db().$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
    await audit(tx, { type: 'AUTH_SUCCESS', outcome: 'SUCCESS', userId: user.id, role: user.role, stationId: ctx.station?.id ?? null, sourceDevice: ctx.device, details: { method, ...details } });
  });
  return startSession(res, user, method, user.role === 'OPERATOR' ? ctx.station!.id : null);
}

function challengeOf(clientDataJSON: string): string {
  try {
    return JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')).challenge;
  } catch {
    throw badRequest('The sign-in response could not be read.', 'BAD_RESPONSE');
  }
}

async function takeChallenge(challenge: string, purpose: string, stationId: string | null, userId?: string) {
  const row = await db().authChallenge.findUnique({ where: { challenge } });
  if (row) await db().authChallenge.delete({ where: { id: row.id } }).catch(() => {});
  if (!row || row.purpose !== purpose || row.expiresAt < new Date()) return null;
  if (purpose === 'login' && row.stationId !== stationId) return null;
  if (userId && row.userId !== userId) return null;
  return row;
}

// ─────────────────────────── fingerprint / face (WebAuthn) ───────────────────────────

export async function loginOptions(ctx: AuthCtx, operatorCode?: string) {
  const station = requireStation(ctx);
  if (!station.allowFingerprint && !station.allowFace) throw forbidden('Fingerprint and face sign-in are switched off at this station.', 'METHOD_NOT_ALLOWED');
  let allowCredentials: { id: string; transports?: string[] }[] | undefined;
  if (operatorCode) {
    const user = await db().user.findUnique({ where: { operatorCode }, include: { credentials: { where: { revokedAt: null } } } });
    if (!user || !user.credentials.length) throw new AppError(404, 'No fingerprint or face is registered for this ID. Ask your scientist.', 'NO_CREDENTIAL');
    allowCredentials = user.credentials.map((c) => ({ id: c.id, transports: c.transports }));
  }
  const options = await generateAuthenticationOptions({ rpID: config.webauthn.rpId, userVerification: 'required', allowCredentials, timeout: 60_000 });
  await db().authChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db().authChallenge.create({ data: { challenge: options.challenge, purpose: 'login', stationId: station.id, expiresAt: new Date(Date.now() + CHALLENGE_MS) } });
  return options;
}

export async function loginVerify(res: Response, ctx: AuthCtx, response: AuthenticationResponseJSON, modality: 'fingerprint' | 'face') {
  const station = requireStation(ctx);
  if (modality === 'fingerprint' && !station.allowFingerprint) throw forbidden('Fingerprint sign-in is switched off at this station.', 'METHOD_NOT_ALLOWED');
  if (modality === 'face' && !station.allowFace) throw forbidden('Face sign-in is switched off at this station.', 'METHOD_NOT_ALLOWED');

  const method = modality === 'face' ? 'FACE' : 'FINGERPRINT';
  const cred = await db().webAuthnCredential.findUnique({ where: { id: response.id }, include: { user: true } });
  const ch = await takeChallenge(challengeOf(response.response.clientDataJSON), 'login', station.id);
  if (!cred || cred.revokedAt) return fail(ctx, cred?.user ?? null, method, 'UNKNOWN_CREDENTIAL');
  if (!ch) return fail(ctx, cred.user, method, 'CHALLENGE_EXPIRED');
  assertNotLocked(cred.user);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: config.webauthn.origins,
      expectedRPID: config.webauthn.rpId,
      credential: { id: cred.id, publicKey: new Uint8Array(cred.publicKey), counter: Number(cred.counter), transports: cred.transports as never },
      requireUserVerification: true,
    });
  } catch (err) {
    logger.warn('WebAuthn assertion rejected', err);
    return fail(ctx, cred.user, method, 'SIGNATURE_INVALID');
  }
  const info = verification.authenticationInfo;
  if (!verification.verified || !info.userVerified) return fail(ctx, cred.user, method, 'NOT_VERIFIED');
  // A signature counter that goes backwards suggests a cloned authenticator.
  const stored = Number(cred.counter);
  if ((info.newCounter > 0 || stored > 0) && info.newCounter <= stored) return fail(ctx, cred.user, method, 'COUNTER_REGRESSION');

  await assertOperatorAllowed(ctx, cred.user, method);
  await db().webAuthnCredential.update({ where: { id: cred.id }, data: { counter: BigInt(info.newCounter), lastUsedAt: new Date() } });
  return succeed(res, ctx, cred.user, method, { credential: cred.label });
}

export async function registrationOptions(operatorId: string) {
  const user = await db().user.findUnique({ where: { id: operatorId }, include: { credentials: { where: { revokedAt: null } } } });
  if (!user || user.role !== 'OPERATOR') throw badRequest('Choose an operator.', 'NOT_OPERATOR');
  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpId,
    userName: `operator-${user.operatorCode}`,
    userID: new TextEncoder().encode(user.id),
    userDisplayName: user.name,
    attestationType: 'none',
    excludeCredentials: user.credentials.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: 90_000,
  });
  await db().authChallenge.create({ data: { challenge: options.challenge, purpose: 'register', userId: user.id, expiresAt: new Date(Date.now() + CHALLENGE_MS) } });
  return options;
}

export async function registrationVerify(supervisor: { id: string; role: string }, ctx: AuthCtx, operatorId: string, response: RegistrationResponseJSON, label: string) {
  const ch = await takeChallenge(challengeOf(response.response.clientDataJSON), 'register', null, operatorId);
  if (!ch) throw badRequest('Registration took too long. Please try again.', 'CHALLENGE_EXPIRED');
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: config.webauthn.origins, expectedRPID: config.webauthn.rpId, requireUserVerification: true });
  } catch (err) {
    logger.warn('WebAuthn registration rejected', err);
    throw badRequest('The device did not confirm the fingerprint or face. Please try again.', 'REGISTRATION_FAILED');
  }
  if (!v.verified) throw badRequest('The device did not confirm the fingerprint or face. Please try again.', 'REGISTRATION_FAILED');
  const { credential, aaguid, credentialDeviceType } = v.registrationInfo;
  await db().$transaction(async (tx) => {
    await tx.webAuthnCredential.create({
      data: {
        id: credential.id,
        userId: operatorId,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        aaguid,
        deviceType: credentialDeviceType,
        label: label.trim().slice(0, 60) || 'Station biometric',
        stationId: ctx.station?.id ?? null,
        enrolledById: supervisor.id,
      },
    });
    await audit(tx, { type: 'CREDENTIAL_ENROLLED', outcome: 'SUCCESS', userId: supervisor.id, role: supervisor.role, stationId: ctx.station?.id ?? null, sourceDevice: ctx.device, details: { operatorId, label, aaguid } });
  });
}

// ─────────────────────────────── fallbacks ───────────────────────────────

export async function loginWithPin(res: Response, ctx: AuthCtx, operatorCode: string, pin: string) {
  const station = requireStation(ctx);
  if (!station.allowPin) throw forbidden('Operator ID sign-in is not allowed at this station. Use fingerprint or ask your scientist.', 'METHOD_NOT_ALLOWED');
  const user = await db().user.findUnique({ where: { operatorCode } });
  if (user) assertNotLocked(user);
  const ok = await verifySecret(pin, user?.pinHash);
  if (!user || !ok) return fail(ctx, user, 'PIN', 'WRONG_PIN', operatorCode);
  await assertOperatorAllowed(ctx, user, 'PIN');
  return succeed(res, ctx, user, 'PIN');
}

/** Checks a scientist's password (sign-in, assisting an operator, signing off a hold at the station). */
async function verifySupervisor(ctx: AuthCtx, username: string, password: string, purpose: string) {
  const sup = await db().user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (sup) assertNotLocked(sup);
  const ok = await verifySecret(password, sup?.passwordHash);
  if (!sup || !ok || !sup.active || sup.role !== 'SUPERVISOR') return fail(ctx, sup, purpose, 'WRONG_PASSWORD', username);
  await db().user.update({ where: { id: sup.id }, data: { failedAttempts: 0, lockedUntil: null } });
  return sup;
}

export async function loginAssisted(res: Response, ctx: AuthCtx, operatorCode: string, username: string, password: string) {
  const station = requireStation(ctx);
  if (!station.allowAssisted) throw forbidden('Scientist-assisted sign-in is not allowed at this station.', 'METHOD_NOT_ALLOWED');
  const sup = await verifySupervisor(ctx, username, password, 'ASSISTED');
  const user = await db().user.findUnique({ where: { operatorCode } });
  if (!user) throw new AppError(404, 'No operator has that ID.', 'UNKNOWN_OPERATOR');
  await assertOperatorAllowed(ctx, user, 'ASSISTED');
  return succeed(res, ctx, user, 'ASSISTED', { assistedBy: sup.id, assistedByName: sup.name });
}

export async function loginSupervisor(res: Response, ctx: AuthCtx, username: string, password: string) {
  const sup = await verifySupervisor(ctx, username, password, 'PASSWORD');
  return succeed(res, ctx, sup, 'PASSWORD');
}

/** Supervisor signs off a correction at the station; returns a short-lived token bound to station + batch. */
export async function supervisorSignoff(ctx: AuthCtx, username: string, password: string, batchId: string) {
  const station = requireStation(ctx);
  const sup = await verifySupervisor(ctx, username, password, 'SIGNOFF');
  await auditNow({ type: 'SUPERVISOR_SIGNOFF', outcome: 'SUCCESS', userId: sup.id, role: sup.role, stationId: station.id, batchId, sourceDevice: ctx.device, details: {} });
  return { token: signSignoff({ by: sup.id, byName: sup.name, stationId: station.id, batchId }), name: sup.name };
}

export function requireUser<T>(u: T | undefined): T {
  if (!u) throw unauthenticated();
  return u;
}
