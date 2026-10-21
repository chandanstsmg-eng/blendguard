/**
 * Built-in local PostgreSQL.
 *
 * The production PC should not need a separately installed database server, so
 * BlendGuard ships PostgreSQL binaries (embedded-postgres packages) and runs a
 * private server from data/pg, started with pg_ctl:
 *   - a crash of the Node process does not stop the database; the next start
 *     adopts the running server;
 *   - PostgreSQL's write-ahead log protects committed steps on power loss.
 *
 * If DATABASE_URL is set in .env, none of this runs and that server is used.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { config, DATA_DIR } from '../config.js';
import { logger } from '../utils/logger.js';

const run = promisify(execFile);
const PG_DIR = path.join(DATA_DIR, 'pg');
const LOG_FILE = path.join(DATA_DIR, 'logs', 'postgres.log');
export const DB_NAME = 'blendguard';

async function binaries(): Promise<{ pg_ctl: string; initdb: string }> {
  const platform = os.platform() === 'win32' ? 'windows' : os.platform();
  const pkg = `@embedded-postgres/${platform}-${os.arch()}`;
  try {
    return await import(pkg);
  } catch {
    throw new Error(`Built-in database is not available for ${os.platform()}-${os.arch()}. Set DATABASE_URL in .env to use your own PostgreSQL.`);
  }
}

async function isRunning(pgCtl: string) {
  try {
    await run(pgCtl, ['status', '-D', PG_DIR], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** The database's own log is appended to by pg_ctl; keep one previous copy once it gets large. */
function rotateDbLog() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 20 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    /* housekeeping only */
  }
}

function startServer(pgCtl: string): Promise<void> {
  rotateDbLog();
  // stdio must be ignored: postgres inherits the handles and would keep the pipe open.
  return new Promise((resolve, reject) => {
    const child = spawn(
      pgCtl,
      ['start', '-D', PG_DIR, '-w', '-t', '90', '-l', LOG_FILE, '-o', `-p ${config.pgPort} -c listen_addresses=localhost`],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      const tail = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-6).join('\n') : '';
      reject(new Error(`Database did not start (pg_ctl exit ${code}).\n${tail}`));
    });
  });
}

export function databaseUrl(name = DB_NAME) {
  if (config.externalDatabaseUrl) return config.externalDatabaseUrl;
  return `postgresql://blendguard:${encodeURIComponent(config.pgPassword)}@localhost:${config.pgPort}/${name}?connection_limit=10`;
}

/** Starts (or adopts) the built-in database and sets DATABASE_URL. */
export async function ensureDatabase(): Promise<string> {
  if (config.externalDatabaseUrl) {
    logger.info('Using external database from DATABASE_URL');
    return config.externalDatabaseUrl;
  }
  if (!config.pgPassword) throw new Error('PG_PASSWORD is missing in .env');

  const { pg_ctl, initdb } = await binaries();
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  if (!fs.existsSync(path.join(PG_DIR, 'PG_VERSION'))) {
    logger.info('Creating the local database for the first time…');
    fs.mkdirSync(PG_DIR, { recursive: true });
    const pwFile = path.join(DATA_DIR, '.pgpass-init');
    fs.writeFileSync(pwFile, config.pgPassword, { mode: 0o600 });
    try {
      await run(initdb, ['-D', PG_DIR, '-U', 'blendguard', `--pwfile=${pwFile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--no-locale'], { windowsHide: true });
    } finally {
      fs.rmSync(pwFile, { force: true });
    }
    fs.appendFileSync(
      path.join(PG_DIR, 'postgresql.conf'),
      "\n# BlendGuard\nshared_buffers = 128MB\nmax_connections = 60\nsynchronous_commit = on\nfsync = on\ntimezone = 'Asia/Kolkata'\nlog_timezone = 'Asia/Kolkata'\n",
    );
  }

  if (await isRunning(pg_ctl)) logger.info('Database already running — reusing it');
  else await startServer(pg_ctl);

  const url = databaseUrl();
  process.env.DATABASE_URL = url;
  return url;
}

export async function stopDatabase() {
  if (config.externalDatabaseUrl) return;
  const { pg_ctl } = await binaries();
  if (!fs.existsSync(path.join(PG_DIR, 'PG_VERSION'))) return;
  if (!(await isRunning(pg_ctl))) return;
  try {
    await run(pg_ctl, ['stop', '-D', PG_DIR, '-m', 'fast', '-w', '-t', '30'], { windowsHide: true });
  } catch (err) {
    logger.warn('Database stop reported a problem', err);
  }
}
