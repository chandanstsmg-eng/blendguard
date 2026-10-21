/**
 * Starts everything with one command:
 *   local database → migrations → demo data (first run) → screens + API + live updates on one port.
 *
 *   npm start      production build (builds the screens first if needed)
 *   npm run dev    live-reload while editing the code
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, config } from './config.js';
import { ensureDatabase, stopDatabase } from './db/postgres.js';
import { db, disconnect } from './db/prisma.js';
import { logger } from './utils/logger.js';

const dev = !config.isProd;
const t0 = Date.now();

function banner(lines: string[]) {
  const w = Math.max(...lines.map((l) => l.length)) + 4;
  console.log('\n  ┌' + '─'.repeat(w) + '┐');
  for (const l of lines) console.log('  │  ' + l.padEnd(w - 2) + '│');
  console.log('  └' + '─'.repeat(w) + '┘\n');
}

function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

function alreadyRunning(port: number) {
  // Our own server on this PC: its certificate is for the LAN name, so it is not checked here.
  const get = config.https ? https.get : http.get;
  return new Promise<boolean>((resolve) => {
    const req = get(`${config.https ? 'https' : 'http'}://localhost:${port}/api/health`, { timeout: 1500, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('"BlendGuard"')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

function runPrisma(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
    const child = spawn(process.execPath, [cli, ...args], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`prisma ${args.join(' ')} failed:\n${out}`))));
  });
}

function newestMtime(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

async function ensureClientBuild() {
  const stamp = path.join(ROOT, 'dist', '.build-stamp');
  const sources = Math.max(newestMtime(path.join(ROOT, 'src')), newestMtime(path.join(ROOT, 'shared')), newestMtime(path.join(ROOT, 'public')), fs.statSync(path.join(ROOT, 'index.html')).mtimeMs);
  if (fs.existsSync(stamp) && fs.statSync(stamp).mtimeMs >= sources) return;
  logger.info('Preparing the screens (first start or after an update)…');
  const { build } = await import('vite');
  await build({ root: ROOT, logLevel: 'warn' });
  fs.writeFileSync(stamp, new Date().toISOString());
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
}

async function main() {
  console.log(`\n  BlendGuard — starting${dev ? ' (developer mode)' : ''}…`);

  if (!(await portFree(config.port))) {
    if (await alreadyRunning(config.port)) {
      banner(['BlendGuard is already running.', `Open  ${config.https ? 'https' : 'http'}://localhost:${config.port}`]);
      return;
    }
    banner([`Port ${config.port} is being used by another program.`, 'Close that program, or change PORT in the .env file', '(for example PORT=4400) and run the command again.']);
    process.exitCode = 1;
    return;
  }

  await ensureDatabase();
  logger.info('Database ready');
  const { backupNow, lastBackup, pruneBackups, scheduleBackups, stopBackups } = await import('./db/backup.js');
  // A copy of the records before the database structure may be changed by an update.
  const recent = lastBackup();
  if (!recent || Date.now() - recent.at > 3600_000) {
    try {
      await backupNow('before-start');
      pruneBackups();
    } catch (err) {
      // First start (no tables yet) or an unreadable database: the migration below will say more.
      logger.warn('Backup before start skipped', err instanceof Error ? err.message : err);
    }
  }
  await runPrisma(['migrate', 'deploy']);

  if ((await db().user.count()) === 0) {
    // Demo data only where asked for (training PCs, development). A live plant starts empty
    // with one scientist account, who then adds the real stations, users and ingredients.
    const demo = process.env.SEED_DEMO === '1' || (dev && process.env.SEED_DEMO !== '0');
    if (demo) {
      logger.info('Loading demo data (first start only)…');
      const { seed } = await import('../prisma/seed.js');
      await seed();
    } else {
      const { createFirstAdmin } = await import('./db/first-admin.js');
      await createFirstAdmin();
    }
  }

  if (!dev) await ensureClientBuild();

  const { createApp } = await import('./app.js');
  const { attachRealtime, closeRealtime, realtimeServer } = await import('./services/realtime.service.js');
  const { attachBridge } = await import('./scale/bridge-server.js');
  const { initScales, scaleEvents, stopScales } = await import('./services/scale.service.js');
  const { checkOverweight } = await import('./services/batch.service.js');

  const app = await createApp({ dev });
  const server = config.tls ? https.createServer(config.tls, app) : http.createServer(app);
  attachRealtime(server);
  attachBridge(realtimeServer()!);
  await initScales();
  scaleEvents.on('stable', (stationId: string) => void checkOverweight(stationId).catch((err) => logger.error('Overweight check failed', err)));
  if (!dev) scheduleBackups();

  server.listen(config.port, '0.0.0.0');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  const scheme = config.https ? 'https' : 'http';
  const host = os.hostname().toLowerCase();
  const lan = lanAddresses();
  banner([
    `BlendGuard is running   (ready in ${((Date.now() - t0) / 1000).toFixed(1)} s)`,
    '',
    `On this computer:   ${scheme}://localhost:${config.port}`,
    ...(config.https ? [`On the plant LAN:   ${scheme}://${host}:${config.port}`] : lan.slice(0, 2).map((ip) => `On the plant LAN:   ${scheme}://${ip}:${config.port}`)),
    '',
    config.https ? 'Secure connection (HTTPS) is on.' : 'HTTPS is off: fingerprint and face sign-in work only on this PC.',
    'Press Ctrl+C to stop. Data stays in the data folder.',
  ]);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n  Stopping (${signal})…`);
    stopBackups();
    stopScales();
    closeRealtime();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r(null)));
    await disconnect();
    await stopDatabase();
    console.log('  Stopped safely.\n');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('Ctrl+C'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('window closed'));
}

// A programming error must not leave a half-working server behind: log it and exit, so the
// launcher (or the Windows start-up task) starts a clean one. Weighing state is in the database.
process.on('uncaughtException', (err) => {
  logger.error('Unexpected error, restarting', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => logger.error('Unhandled promise rejection', err));

main().catch(async (err) => {
  logger.error('Could not start', err);
  console.error('\n  BlendGuard could not start. Details:\n');
  console.error('  ' + String(err?.message ?? err).split('\n').join('\n  '));
  console.error('\n  Full log: data/logs (today\'s app-<date>.log)\n');
  await disconnect().catch(() => {});
  process.exit(1);
});
