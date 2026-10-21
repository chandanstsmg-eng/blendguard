/**
 * The audit log as CSV: every event that matches the filters, not only the
 * rows loaded on screen. Read in pages by sequence number and written out as
 * it goes, so a long export never holds the whole log in memory.
 */
import type { Prisma } from '@prisma/client';
import { db } from '../db/prisma.js';

export interface AuditExportQuery {
  type?: string;
  outcome?: string;
  userId?: string;
  stationId?: string;
  batchNo?: string;
  from?: string;
  to?: string;
}

const PAGE = 2000;
/** A safety stop; the plant's whole history is far below this. */
export const MAX_EXPORT_ROWS = 500_000;

const HEAD = ['seqNo', 'at', 'type', 'outcome', 'user', 'role', 'station', 'batchNo', 'prevState', 'newState', 'sourceDevice', 'details'];

function cell(v: unknown) {
  const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // A leading = + - @ would run as a formula in Excel; prefix it so it stays text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Writes the CSV through `write` (a byte-order mark first, so Excel reads Hindi / Malayalam). Returns the row count. */
export async function exportAuditCsv(q: AuditExportQuery, write: (chunk: string) => void): Promise<number> {
  let batchId: string | undefined;
  write('﻿' + HEAD.join(',') + '\r\n');
  if (q.batchNo) {
    const b = await db().batch.findUnique({ where: { batchNo: q.batchNo.trim() }, select: { id: true } });
    if (!b) return 0;
    batchId = b.id;
  }
  const where: Prisma.AuditEventWhereInput = {
    type: q.type || undefined,
    outcome: q.outcome || undefined,
    userId: q.userId || undefined,
    stationId: q.stationId || undefined,
    batchId,
    at: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
  };

  const userName = new Map<string, string>();
  const stationCode = new Map<string, string>();
  const batchNo = new Map<string, string>();
  let before: bigint | undefined;
  let total = 0;
  for (;;) {
    const rows = await db().auditEvent.findMany({ where: { ...where, seqNo: before !== undefined ? { lt: before } : undefined }, orderBy: { seqNo: 'desc' }, take: PAGE });
    if (!rows.length) break;
    const missing = <T extends string | null>(ids: T[], known: Map<string, string>) => [...new Set(ids.filter((x): x is NonNullable<T> => !!x && !known.has(x)))];
    const [users, stations, batches] = await Promise.all([
      db().user.findMany({ where: { id: { in: missing(rows.map((e) => e.userId), userName) } }, select: { id: true, name: true } }),
      db().station.findMany({ where: { id: { in: missing(rows.map((e) => e.stationId), stationCode) } }, select: { id: true, code: true } }),
      db().batch.findMany({ where: { id: { in: missing(rows.map((e) => e.batchId), batchNo) } }, select: { id: true, batchNo: true } }),
    ]);
    for (const u of users) userName.set(u.id, u.name);
    for (const s of stations) stationCode.set(s.id, s.code);
    for (const b of batches) batchNo.set(b.id, b.batchNo);

    let chunk = '';
    for (const e of rows) {
      chunk +=
        [
          e.seqNo.toString(),
          e.at.toISOString(),
          e.type,
          e.outcome,
          e.userId ? (userName.get(e.userId) ?? e.userId) : '',
          e.role,
          e.stationId ? (stationCode.get(e.stationId) ?? '') : '',
          e.batchId ? (batchNo.get(e.batchId) ?? '') : '',
          e.prevState,
          e.newState,
          e.sourceDevice,
          e.details,
        ]
          .map(cell)
          .join(',') + '\r\n';
    }
    write(chunk);
    total += rows.length;
    before = rows[rows.length - 1].seqNo;
    if (rows.length < PAGE || total >= MAX_EXPORT_ROWS) break;
  }
  return total;
}
