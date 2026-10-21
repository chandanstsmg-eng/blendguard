/**
 * Restores a BlendGuard backup (data/backups/*.json.gz) on this computer.
 * BlendGuard must be stopped. Nothing is deleted: the current database is kept
 * under a new name ("blendguard_before_restore_<time>") in case it is needed.
 *
 *   npm run restore-backup -- data/backups/blendguard-2026-10-18-0200-daily.json.gz
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { ROOT, config } from '../server/config.js';
import { DB_NAME, databaseUrl, ensureDatabase } from '../server/db/postgres.js';
import { restoreInto } from '../server/db/backup.js';

const portInUse = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.once('listening', () => s.close(() => resolve(false)));
    s.listen(port, '0.0.0.0');
  });

async function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : '';
  if (!file || !fs.existsSync(file)) {
    console.error('\n  Usage: npm run restore-backup -- <backup file>\n  Backups are in data/backups.\n');
    process.exit(1);
  }
  if (config.externalDatabaseUrl) {
    console.error('\n  restore-backup works with the built-in database only. Restore an external database with its own tools.\n');
    process.exit(1);
  }
  if (await portInUse(config.port)) {
    console.error('\n  BlendGuard is running. Stop it first (Ctrl+C in its window), then run this again.\n');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n  Restore ${path.basename(file)}?\n  The current data is kept as a separate database, not deleted.\n  Type RESTORE to continue: `);
  rl.close();
  if (answer.trim() !== 'RESTORE') return console.log('  Cancelled.\n');

  await ensureDatabase();
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const fresh = `${DB_NAME}_restore_${stamp}`;
  const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  const m = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl(fresh) }, encoding: 'utf8' });
  if (m.status !== 0) {
    console.error(m.stdout, m.stderr);
    process.exit(1);
  }

  const target = new PrismaClient({ datasourceUrl: databaseUrl(fresh) });
  try {
    console.log('');
    await restoreInto(target, file, (t, n) => console.log(`  ${t.padEnd(24)} ${n} rows`));
  } finally {
    await target.$disconnect();
  }

  // Swap: keep the old database under a new name, put the restored one in its place.
  const admin = new PrismaClient({ datasourceUrl: databaseUrl('postgres') });
  try {
    const kept = `${DB_NAME}_before_restore_${stamp}`;
    await admin.$executeRawUnsafe(`ALTER DATABASE "${DB_NAME}" RENAME TO "${kept}"`);
    await admin.$executeRawUnsafe(`ALTER DATABASE "${fresh}" RENAME TO "${DB_NAME}"`);
    console.log(`\n  Restored. The previous data is kept in database "${kept}".\n  Start BlendGuard as usual.\n`);
  } finally {
    await admin.$disconnect();
  }
}

void main().catch((err) => {
  console.error('\n  Restore failed:', err instanceof Error ? err.message : err, '\n  Nothing was changed in the running database.\n');
  process.exit(1);
});
