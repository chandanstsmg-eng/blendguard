/**
 * Deletes ALL BlendGuard data on this computer and reloads the demo data.
 * For training / demo installs only. Refuses to run while BlendGuard is running.
 *
 *   npm run reset-demo
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { PrismaClient } from '@prisma/client';
import { ROOT, config } from '../server/config.js';
import { DB_NAME, databaseUrl, ensureDatabase } from '../server/db/postgres.js';
import { backupNow } from '../server/db/backup.js';

if (config.externalDatabaseUrl) {
  console.error('\n  reset-demo only works with the built-in database. Refusing to touch DATABASE_URL.\n');
  process.exit(1);
}
// The port, not an HTTP request, decides: that also works when the server runs on HTTPS.
const running = await new Promise<boolean>((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(true));
  s.once('listening', () => s.close(() => resolve(false)));
  s.listen(config.port, '0.0.0.0');
});
if (running) {
  console.error('\n  BlendGuard is running. Stop it first (Ctrl+C in its window), then run reset-demo again.\n');
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('\n  This DELETES every job, record and user on this computer and loads demo data.\n  A backup is saved first. Type DELETE to continue: ');
rl.close();
if (answer.trim() !== 'DELETE') {
  console.log('  Cancelled.\n');
  process.exit(0);
}

await ensureDatabase();
try {
  const file = await backupNow('before-reset', { client: new PrismaClient({ datasourceUrl: databaseUrl() }) });
  console.log(`  Backup saved: ${path.relative(ROOT, file)}`);
} catch {
  /* nothing to back up yet (first install) */
}
const admin = new PrismaClient({ datasourceUrl: databaseUrl('postgres') });
try {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
} finally {
  await admin.$disconnect();
}
const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const m = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl() }, encoding: 'utf8' });
if (m.status !== 0) {
  console.error(m.stdout, m.stderr);
  process.exit(1);
}
process.env.DATABASE_URL = databaseUrl();
const { seed } = await import('../prisma/seed.js');
await seed();
const { disconnect } = await import('../server/db/prisma.js');
await disconnect();
console.log('  Demo data reset. Start BlendGuard with: npm start\n');
