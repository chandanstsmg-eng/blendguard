/**
 * Integration tests run against a brand-new database ("blendguard_test_<time>")
 * on the same built-in PostgreSQL. Real data is never touched, and the test
 * database is dropped afterwards.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import { PrismaClient } from '@prisma/client';
import { ROOT } from '../server/config.js';
import { databaseUrl, ensureDatabase } from '../server/db/postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    testDbUrl: string;
  }
}

export default async function setup(project: TestProject) {
  await ensureDatabase();
  const name = `blendguard_test_${Date.now()}`;
  const url = databaseUrl(name);
  const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  // `migrate deploy` creates the new database and applies migrations; it never deletes anything.
  const r = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Could not prepare the test database:\n${r.stdout}\n${r.stderr}`);

  process.env.DATABASE_URL = url;
  const { seed } = await import('../prisma/seed.js');
  await seed({ quiet: true });
  const { disconnect } = await import('../server/db/prisma.js');
  await disconnect();
  project.provide('testDbUrl', url);

  return async () => {
    const admin = new PrismaClient({ datasourceUrl: databaseUrl('postgres') });
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect();
    }
  };
}
