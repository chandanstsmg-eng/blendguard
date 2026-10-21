/**
 * A backup restores to exactly the same records: every table, every row, and the
 * audit trail's sequence number carries on where it was.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ROOT } from '../server/config.js';
import { databaseUrl } from '../server/db/postgres.js';
import { backupNow, restoreInto } from '../server/db/backup.js';

const source = new PrismaClient({ datasourceUrl: inject('testDbUrl') });
const restoredName = `blendguard_restoretest_${Date.now()}`;
const restored = new PrismaClient({ datasourceUrl: databaseUrl(restoredName) });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-backup-'));

afterAll(async () => {
  await source.$disconnect();
  await restored.$disconnect();
  const admin = new PrismaClient({ datasourceUrl: databaseUrl('postgres') });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${restoredName}" WITH (FORCE)`).finally(() => admin.$disconnect());
  fs.rmSync(dir, { recursive: true, force: true });
});

const counts = async (c: PrismaClient) => {
  const tables = await c.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY 1`;
  const out: Record<string, number> = {};
  for (const t of tables) out[t.table_name] = Number((await c.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM "${t.table_name}"`))[0].n);
  return out;
};

describe('backup and restore', () => {
  it('restores every row of every table', async () => {
    const file = await backupNow('test', { client: source, dir });
    expect(fs.statSync(file).size).toBeGreaterThan(1000);

    const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
    const m = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl(restoredName) }, encoding: 'utf8' });
    expect(m.status, m.stderr).toBe(0);
    await restoreInto(restored, file);

    const before = await counts(source);
    expect(Object.values(before).some((n) => n > 0)).toBe(true);
    expect(await counts(restored)).toEqual(before);

    // Values come back exactly, including JSON details and timestamps.
    const a = await source.auditEvent.findMany({ orderBy: { seqNo: 'asc' } });
    const b = await restored.auditEvent.findMany({ orderBy: { seqNo: 'asc' } });
    expect(b).toEqual(a);

    // New audit events continue the sequence instead of clashing with restored ones.
    const next = await restored.auditEvent.create({ data: { type: 'TEST', outcome: 'INFO', details: {} } });
    expect(next.seqNo).toBeGreaterThan(a.at(-1)!.seqNo);
  }, 120_000);
});
