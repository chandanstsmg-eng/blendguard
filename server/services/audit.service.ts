/**
 * Append-only activity trail (spec §14). Each row is also the outbox entry that
 * a future cloud sync can pick up: syncStatus starts as PENDING.
 *
 * Write audit rows inside the same transaction as the change they describe, so
 * an event can never exist without its change or the other way round.
 */
import type { Prisma } from '@prisma/client';
import { db, type Tx } from '../db/prisma.js';
import { logger } from '../utils/logger.js';

export type Outcome = 'SUCCESS' | 'REJECTED' | 'FAILED' | 'INFO';

export interface AuditInput {
  type: string;
  outcome: Outcome;
  userId?: string | null;
  role?: string | null;
  batchId?: string | null;
  stationId?: string | null;
  details?: Record<string, unknown>;
  prevState?: string | null;
  newState?: string | null;
  sourceDevice?: string | null;
}

export interface Actor {
  userId: string | null;
  role: string | null;
  stationId: string | null;
  sourceDevice: string;
}

function row(e: AuditInput): Prisma.AuditEventCreateInput {
  return {
    type: e.type,
    outcome: e.outcome,
    userId: e.userId ?? null,
    role: e.role ?? null,
    batchId: e.batchId ?? null,
    stationId: e.stationId ?? null,
    details: (e.details ?? {}) as Prisma.InputJsonValue,
    prevState: e.prevState ?? null,
    newState: e.newState ?? null,
    sourceDevice: e.sourceDevice ?? null,
  };
}

export async function audit(tx: Tx, e: AuditInput) {
  await tx.auditEvent.create({ data: row(e) });
}

/** For events recorded outside a business transaction (e.g. a rejected request). Never throws. */
export async function auditNow(e: AuditInput) {
  try {
    await db().auditEvent.create({ data: row(e) });
  } catch (err) {
    logger.error(`Could not write audit event ${e.type}`, err);
  }
}

export const fromActor = (a: Actor) => ({ userId: a.userId, role: a.role, stationId: a.stationId, sourceDevice: a.sourceDevice });
