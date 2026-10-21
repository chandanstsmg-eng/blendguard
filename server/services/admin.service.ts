/**
 * Setup screens (scientists): who may sign in, how stations behave, what each
 * ingredient looks like to the operator, and the read-only audit trail.
 */
import type { Prisma, Role } from '@prisma/client';
import { db } from '../db/prisma.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { hashSecret } from '../utils/crypto.js';
import { audit, type Actor } from './audit.service.js';
import { invalidateRacks, photoUrl } from './run.service.js';
import { readScale } from './scale.service.js';
import { toStationInfo } from './session.service.js';
import { scaleSetup } from './station-setup.service.js';
import { revokeSocketAccess } from './realtime.service.js';

// ─────────────────────────────────── users ───────────────────────────────────

export async function listUsers() {
  const users = await db().user.findMany({
    orderBy: [{ role: 'asc' }, { operatorCode: 'asc' }, { username: 'asc' }],
    include: {
      stationAccess: { include: { station: { select: { id: true, code: true } } } },
      credentials: { where: { revokedAt: null }, select: { id: true, label: true, createdAt: true, lastUsedAt: true } },
      sessions: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
    },
  });
  return users.map((u) => ({
    id: u.id,
    role: u.role,
    name: u.name,
    operatorCode: u.operatorCode,
    username: u.username,
    language: u.language,
    active: u.active,
    locked: !!u.lockedUntil && u.lockedUntil.getTime() > Date.now(),
    stationIds: u.stationAccess.map((a) => a.station.id),
    stations: u.stationAccess.map((a) => a.station.code),
    credentials: u.credentials.map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt.toISOString(), lastUsedAt: c.lastUsedAt?.toISOString() ?? null })),
    lastSignIn: u.sessions[0]?.createdAt.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }));
}

export interface NewUser {
  role: Role;
  name: string;
  language: 'en' | 'hi' | 'ml';
  operatorCode?: string | null;
  pin?: string | null;
  username?: string | null;
  password?: string | null;
  stationIds?: string[];
}

function uniqueClash(err: unknown): never {
  if ((err as { code?: string }).code === 'P2002') throw conflict('That Operator ID or username is already in use.', 'DUPLICATE');
  throw err;
}

export async function createUser(actor: Actor, input: NewUser) {
  const isOperator = input.role === 'OPERATOR';
  if (isOperator && (!input.operatorCode || !input.pin)) throw badRequest('An operator needs an Operator ID and a PIN.', 'MISSING_FIELDS');
  if (!isOperator && (!input.username || !input.password)) throw badRequest('A scientist needs a username and a password.', 'MISSING_FIELDS');
  const data: Prisma.UserCreateInput = {
    role: input.role,
    name: input.name.trim(),
    language: input.language,
    ...(isOperator
      ? { operatorCode: input.operatorCode!, pinHash: await hashSecret(input.pin!), stationAccess: { create: (input.stationIds ?? []).map((stationId) => ({ stationId })) } }
      : { username: input.username!.trim().toLowerCase(), passwordHash: await hashSecret(input.password!) }),
  };
  try {
    return await db().$transaction(async (tx) => {
      const u = await tx.user.create({ data });
      await audit(tx, {
        type: 'USER_CREATED', outcome: 'SUCCESS', ...actor,
        details: { userId: u.id, role: u.role, name: u.name, operatorCode: u.operatorCode, username: u.username, stations: input.stationIds ?? [] },
      });
      return { id: u.id };
    });
  } catch (err) {
    uniqueClash(err);
  }
}

export interface UserPatch {
  name?: string;
  language?: 'en' | 'hi' | 'ml';
  active?: boolean;
  stationIds?: string[];
}

export async function updateUser(actor: Actor, userId: string, patch: UserPatch) {
  const before = await db().user.findUnique({ where: { id: userId }, include: { stationAccess: true } });
  if (!before) throw notFound('User');
  if (userId === actor.userId && patch.active === false) throw conflict('You cannot switch off your own account.', 'SELF_CHANGE');
  if (patch.stationIds && before.role !== 'OPERATOR') throw badRequest('Only operators are assigned to stations.', 'NOT_OPERATOR');

  await db().$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        name: patch.name?.trim(),
        language: patch.language,
        active: patch.active,
        ...(patch.active === true ? { failedAttempts: 0, lockedUntil: null } : {}),
      },
    });
    if (patch.stationIds) {
      await tx.stationAccess.deleteMany({ where: { userId } });
      if (patch.stationIds.length) await tx.stationAccess.createMany({ data: patch.stationIds.map((stationId) => ({ userId, stationId })) });
    }
    // Switching an account off ends its open sessions straight away.
    if (patch.active === false) await tx.session.updateMany({ where: { userId, endedAt: null }, data: { endedAt: new Date() } });
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['name', 'language', 'active'] as const) {
      if (patch[k] !== undefined && patch[k] !== before[k]) changed[k] = { from: before[k], to: patch[k] };
    }
    if (patch.stationIds) changed.stations = { from: before.stationAccess.map((a) => a.stationId), to: patch.stationIds };
    await audit(tx, { type: 'USER_UPDATED', outcome: 'SUCCESS', ...actor, details: { userId, name: before.name, changed } });
  });
  if (patch.active === false) revokeSocketAccess({ userId });
}

/** New PIN (operators) or password (scientists). Also clears a lockout. */
export async function resetSecret(actor: Actor, userId: string, secret: string) {
  const u = await db().user.findUnique({ where: { id: userId } });
  if (!u) throw notFound('User');
  const isOperator = u.role === 'OPERATOR';
  if (isOperator && !/^\d{4,8}$/.test(secret)) throw badRequest('A PIN is 4 to 8 numbers.', 'BAD_PIN');
  if (!isOperator && secret.length < 8) throw badRequest('A password needs at least 8 characters.', 'WEAK_PASSWORD');
  const hash = await hashSecret(secret);
  // Someone else's PIN/password reset: whoever was signed in with the old one is signed out.
  // (Changing your own keeps you signed in on this screen.)
  const endOthers = userId !== actor.userId;
  await db().$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { ...(isOperator ? { pinHash: hash } : { passwordHash: hash }), failedAttempts: 0, lockedUntil: null } });
    if (endOthers) await tx.session.updateMany({ where: { userId, endedAt: null }, data: { endedAt: new Date() } });
    await audit(tx, { type: isOperator ? 'PIN_RESET' : 'PASSWORD_RESET', outcome: 'SUCCESS', ...actor, details: { userId, name: u.name, sessionsEnded: endOthers } });
  });
  if (endOthers) revokeSocketAccess({ userId });
}

// ─────────────────────────────────── stations ───────────────────────────────────

export async function listStations() {
  const stations = await db().station.findMany({ orderBy: { code: 'asc' }, include: { _count: { select: { access: true } } } });
  return stations.map((s) => ({
    ...toStationInfo(s),
    ...scaleSetup(s),
    bound: !!s.tokenHash,
    boundAt: s.boundAt?.toISOString() ?? null,
    scaleConnected: readScale(s.id).connected,
    vesselDriftLimitMg: s.vesselDriftLimitMg,
    operatorCount: s._count.access,
  }));
}

// ─────────────────────────────────── ingredients ───────────────────────────────────

export const PPE = ['GLOVES', 'MASK', 'GOGGLES', 'DROPPER', 'SPATULA'] as const;
export const HAZARDS = ['FLAMMABLE', 'IRRITANT', 'ENVIRONMENT', 'TOXIC', 'CORROSIVE'] as const;

export async function listIngredients() {
  const [rows, racks] = await Promise.all([
    db().ingredient.findMany({ orderBy: { code: 'asc' }, omit: { photo: true }, include: { lots: { orderBy: { lotNumber: 'asc' } }, _count: { select: { lines: true } } } }),
    db().rack.findMany({ orderBy: { sortOrder: 'asc' } }),
  ]);
  return {
    racks: racks.map((r) => ({ code: r.code, label: r.label, zone: r.zone, rows: r.rows, cols: r.cols })),
    ingredients: rows.map((i) => ({
      id: i.id,
      code: i.code,
      name: i.name,
      barcode: i.barcode,
      lotTracked: i.lotTracked,
      rackCode: i.rackCode,
      bin: i.bin,
      handling: i.handling,
      hazards: i.hazards,
      ppe: i.ppe,
      colorHex: i.colorHex,
      photoUrl: i.photoUpdatedAt ? photoUrl(i.id, i.photoUpdatedAt) : null,
      formulaCount: i._count.lines,
      lots: i.lots.map((l) => ({ id: l.id, lotNumber: l.lotNumber, barcode: l.barcode, status: l.status, expiresOn: l.expiresOn?.toISOString() ?? null })),
    })),
  };
}

export interface NewIngredient {
  code: string;
  name: string;
  barcode: string;
}

/**
 * Adds an ingredient so formulas and process orders can use it. Colour, photo,
 * shelf location, PPE and hazards are set afterwards in the ingredient editor.
 * The bottle barcode is required: without it the operator could never scan the
 * bottle and the job would stop at that ingredient.
 */
export async function createIngredient(actor: Actor, input: NewIngredient) {
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  const barcode = input.barcode.trim();
  // Codes are matched without regard to case on formula import, so "rm-1001" counts as RM-1001.
  if (await db().ingredient.findFirst({ where: { code: { equals: code, mode: 'insensitive' } }, select: { id: true } })) {
    throw conflict(`An ingredient with code ${code} already exists.`, 'DUPLICATE');
  }
  // A scanned barcode must point at exactly one bottle, whether it is printed on a lot or on the ingredient.
  const [ingClash, lotClash] = await Promise.all([
    db().ingredient.findUnique({ where: { barcode }, select: { code: true } }),
    db().ingredientLot.findUnique({ where: { barcode }, select: { lotNumber: true, ingredient: { select: { code: true } } } }),
  ]);
  if (ingClash) throw conflict(`Barcode ${barcode} is already used by ${ingClash.code}.`, 'DUPLICATE');
  if (lotClash) throw conflict(`Barcode ${barcode} is already used by lot ${lotClash.lotNumber} of ${lotClash.ingredient.code}.`, 'DUPLICATE');
  try {
    return await db().$transaction(async (tx) => {
      const i = await tx.ingredient.create({ data: { code, name, barcode, lotTracked: false, handling: [], hazards: [], ppe: [] } });
      await audit(tx, { type: 'INGREDIENT_CREATED', outcome: 'SUCCESS', ...actor, details: { ingredientId: i.id, ingredient: code, name, barcode } });
      return { id: i.id };
    });
  } catch (err) {
    // Two people adding the same code or barcode at the same moment.
    if ((err as { code?: string }).code === 'P2002') throw conflict('That code or barcode is already in use.', 'DUPLICATE');
    throw err;
  }
}

export interface IngredientPatch {
  colorHex?: string | null;
  rackCode?: string | null;
  bin?: number | null;
  ppe?: string[];
  hazards?: string[];
  handling?: string[];
}

export async function updateIngredient(actor: Actor, id: string, patch: IngredientPatch) {
  const before = await db().ingredient.findUnique({ where: { id }, omit: { photo: true } });
  if (!before) throw notFound('Ingredient');
  const rackCode = patch.rackCode === undefined ? before.rackCode : patch.rackCode;
  const bin = patch.bin === undefined ? before.bin : patch.bin;
  if ((rackCode == null) !== (bin == null)) throw badRequest('Set both the rack and the bin, or neither.', 'BAD_LOCATION');
  if (rackCode != null && bin != null) {
    const rack = await db().rack.findUnique({ where: { code: rackCode } });
    if (!rack) throw badRequest('That rack does not exist.', 'BAD_LOCATION');
    if (bin < 1 || bin > rack.rows * rack.cols) throw badRequest(`Rack ${rack.code} has bins 1 to ${rack.rows * rack.cols}.`, 'BAD_LOCATION');
  }
  await db().$transaction(async (tx) => {
    await tx.ingredient.update({ where: { id }, data: patch });
    const changed = Object.fromEntries(
      Object.entries(patch)
        .filter(([k, v]) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify(v))
        .map(([k, v]) => [k, { from: (before as Record<string, unknown>)[k], to: v }]),
    );
    await audit(tx, { type: 'INGREDIENT_UPDATED', outcome: 'SUCCESS', ...actor, details: { ingredient: before.code, changed } });
  });
  invalidateRacks();
}

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTO_BYTES = 1_500_000;

/** `dataBase64` null removes the photo. */
export async function setIngredientPhoto(actor: Actor, id: string, type: string | null, dataBase64: string | null) {
  const ing = await db().ingredient.findUnique({ where: { id }, select: { code: true } });
  if (!ing) throw notFound('Ingredient');
  let bytes: Buffer<ArrayBuffer> | null = null;
  if (dataBase64 != null) {
    if (!type || !PHOTO_TYPES.includes(type)) throw badRequest('Use a JPEG, PNG or WebP photo.', 'BAD_PHOTO');
    bytes = Buffer.from(dataBase64, 'base64');
    if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) throw badRequest('The photo is too large (1.5 MB at most).', 'BAD_PHOTO');
  }
  await db().$transaction(async (tx) => {
    await tx.ingredient.update({
      where: { id },
      data: bytes ? { photo: bytes, photoType: type, photoUpdatedAt: new Date() } : { photo: null, photoType: null, photoUpdatedAt: null },
    });
    await audit(tx, { type: bytes ? 'INGREDIENT_PHOTO_SET' : 'INGREDIENT_PHOTO_REMOVED', outcome: 'SUCCESS', ...actor, details: { ingredient: ing.code, bytes: bytes?.length ?? 0 } });
  });
}

export async function ingredientPhoto(id: string) {
  const ing = await db().ingredient.findUnique({ where: { id }, select: { photo: true, photoType: true } });
  if (!ing?.photo || !ing.photoType) throw notFound('Photo');
  return { bytes: Buffer.from(ing.photo), type: ing.photoType };
}

// ─────────────────────────────────── formulas ───────────────────────────────────

/** Read-only here: supervisors import and approve formulas (supervisor console → Assign job). */
export async function listFormulas() {
  const rows = await db().formula.findMany({
    orderBy: [{ code: 'asc' }, { revision: 'desc' }],
    include: { lines: { orderBy: { seq: 'asc' }, include: { ingredient: { select: { code: true, name: true, colorHex: true } } } }, _count: { select: { batches: true } } },
  });
  const approvers = await db().user.findMany({ where: { id: { in: rows.map((f) => f.approvedById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const nameOf = new Map(approvers.map((u) => [u.id, u.name]));
  return rows.map((f) => ({
    id: f.id,
    code: f.code,
    revision: f.revision,
    perfumeName: f.perfumeName,
    status: f.status,
    sopNumber: f.sopNumber,
    batchSizeMg: f.batchSizeMg,
    approvedBy: f.approvedById ? (nameOf.get(f.approvedById) ?? null) : null,
    approvedAt: f.approvedAt?.toISOString() ?? null,
    batchCount: f._count.batches,
    lines: f.lines.map((l) => ({ seq: l.seq, code: l.ingredient.code, name: l.ingredient.name, colorHex: l.ingredient.colorHex, targetMg: l.targetMg, tolMinusMg: l.tolMinusMg, tolPlusMg: l.tolPlusMg, remarks: l.remarks })),
  }));
}

// ─────────────────────────────────── audit trail ───────────────────────────────────

export interface AuditQuery {
  type?: string;
  outcome?: string;
  userId?: string;
  stationId?: string;
  batchNo?: string;
  from?: string;
  to?: string;
  /** Return events older than this sequence number (paging). */
  before?: string;
  limit: number;
}

export async function auditTrail(q: AuditQuery) {
  let batchId: string | undefined;
  if (q.batchNo) {
    const b = await db().batch.findUnique({ where: { batchNo: q.batchNo.trim() }, select: { id: true } });
    if (!b) return { events: [], next: null, types: await auditTypes() };
    batchId = b.id;
  }
  const where: Prisma.AuditEventWhereInput = {
    type: q.type || undefined,
    outcome: q.outcome || undefined,
    userId: q.userId || undefined,
    stationId: q.stationId || undefined,
    batchId,
    at: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
    seqNo: q.before ? { lt: BigInt(q.before) } : undefined,
  };
  const rows = await db().auditEvent.findMany({ where, orderBy: { seqNo: 'desc' }, take: q.limit + 1 });
  const page = rows.slice(0, q.limit);
  const [users, stations, batches] = await Promise.all([
    db().user.findMany({ where: { id: { in: [...new Set(page.map((e) => e.userId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
    db().station.findMany({ where: { id: { in: [...new Set(page.map((e) => e.stationId).filter((x): x is string => !!x))] } }, select: { id: true, code: true } }),
    db().batch.findMany({ where: { id: { in: [...new Set(page.map((e) => e.batchId).filter((x): x is string => !!x))] } }, select: { id: true, batchNo: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const stationCode = new Map(stations.map((s) => [s.id, s.code]));
  const batchNo = new Map(batches.map((b) => [b.id, b.batchNo]));
  return {
    events: page.map((e) => ({
      seqNo: e.seqNo.toString(),
      at: e.at.toISOString(),
      type: e.type,
      outcome: e.outcome,
      user: e.userId ? (userName.get(e.userId) ?? e.userId) : null,
      role: e.role,
      station: e.stationId ? (stationCode.get(e.stationId) ?? null) : null,
      batchNo: e.batchId ? (batchNo.get(e.batchId) ?? null) : null,
      prevState: e.prevState,
      newState: e.newState,
      sourceDevice: e.sourceDevice,
      details: e.details,
    })),
    next: rows.length > q.limit ? page[page.length - 1].seqNo.toString() : null,
    types: await auditTypes(),
  };
}

async function auditTypes() {
  const rows = await db().auditEvent.findMany({ distinct: ['type'], select: { type: true }, orderBy: { type: 'asc' } });
  return rows.map((r) => r.type);
}
