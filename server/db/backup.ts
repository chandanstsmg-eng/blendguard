/**
 * Database backups.
 *
 * The built-in PostgreSQL ships without pg_dump, so backups are made through the
 * database connection itself: every table is exported row by row as JSON by
 * PostgreSQL (row_to_json), gzip-compressed into one file per backup:
 *
 *   data/backups/blendguard-2026-10-18-0200-daily.json.gz
 *
 * Restoring (scripts/restore-backup.ts) creates the tables with the normal
 * migrations and loads the rows back with json_populate_recordset, so every
 * value (dates, photos, JSON, arrays, enums) round-trips exactly.
 *
 * Backups run every night at BACKUP_HOUR and before the database is upgraded on
 * start-up; old ones are removed after BACKUP_KEEP_DAYS. BACKUP_COPY_TO puts a
 * second copy somewhere else (e.g. a network share), which is what protects the
 * records if this PC's disk fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { config, DATA_DIR } from '../config.js';
import { logger } from '../utils/logger.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BATCH = 2000;
const FORMAT = 'blendguard-backup-1';

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

async function tables(client: PrismaClient) {
  const rows = await client.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name`;
  return rows.map((r) => r.table_name);
}

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/** Writes a full backup and returns its path. `client` defaults to a fresh connection to DATABASE_URL. */
export async function backupNow(reason: string, opts: { client?: PrismaClient; dir?: string } = {}) {
  const client = opts.client ?? new PrismaClient();
  const dir = opts.dir ?? BACKUP_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `blendguard-${stamp()}-${reason}.json.gz`);
  const tmp = `${file}.part`;
  try {
    // One snapshot for the whole backup: work going on meanwhile is either fully in it or not at all.
    await client.$transaction(
      async (tx) => {
        const migrations = await tx.$queryRaw<{ migration_name: string }[]>`
          SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`;
        const names = await tables(tx as unknown as PrismaClient);
        async function* lines() {
          yield JSON.stringify({ format: FORMAT, at: new Date().toISOString(), reason, migrations: migrations.map((m) => m.migration_name) }) + '\n';
          for (const t of names) {
            yield JSON.stringify({ table: t }) + '\n';
            for (let offset = 0; ; offset += BATCH) {
              const rows = await tx.$queryRawUnsafe<{ j: string }[]>(`SELECT row_to_json(t)::text AS j FROM ${q(t)} t ORDER BY ctid LIMIT ${BATCH} OFFSET ${offset}`);
              for (const r of rows) yield r.j + '\n';
              if (rows.length < BATCH) break;
            }
          }
          yield JSON.stringify({ end: true }) + '\n';
        }
        await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(tmp));
      },
      { isolationLevel: 'RepeatableRead', timeout: 30 * 60_000, maxWait: 60_000 },
    );
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
    if (!opts.client) await client.$disconnect();
  }
  if (config.backup.copyTo) {
    try {
      fs.mkdirSync(config.backup.copyTo, { recursive: true });
      fs.copyFileSync(file, path.join(config.backup.copyTo, path.basename(file)));
    } catch (err) {
      logger.error(`Backup made, but copying it to ${config.backup.copyTo} failed`, err);
    }
  }
  return file;
}

/** Removes backups older than BACKUP_KEEP_DAYS (local folder only; the copy folder is left alone). */
export function pruneBackups(dir = BACKUP_DIR, keepDays = config.backup.keepDays) {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - keepDays * 86400_000;
  for (const f of fs.readdirSync(dir)) {
    if (!/^blendguard-.*\.json\.gz$/.test(f)) continue;
    const p = path.join(dir, f);
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
  }
}

export function lastBackup(dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^blendguard-.*\.json\.gz$/.test(f))
    .map((f) => ({ file: f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  return files[0] ?? null;
}

let timer: NodeJS.Timeout | null = null;

/** Nightly backup at BACKUP_HOUR (checked every 10 minutes, so a PC asleep at that time catches up). */
export function scheduleBackups() {
  const tick = async () => {
    const last = lastBackup();
    const now = new Date();
    const dueToday = now.getHours() >= config.backup.hour;
    const doneToday = last && new Date(last.at).toDateString() === now.toDateString() && new Date(last.at).getHours() >= config.backup.hour;
    if (!dueToday || doneToday) return;
    try {
      const file = await backupNow('daily');
      pruneBackups();
      logger.info(`Daily backup saved: ${path.relative(DATA_DIR, file)}`);
    } catch (err) {
      logger.error('Daily backup FAILED', err);
    }
  };
  timer ??= setInterval(() => void tick(), 10 * 60_000);
  void tick();
}

export function stopBackups() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Loads a backup into an EMPTY database that already has the tables (migrations
 * applied). Triggers (immutability, foreign keys) are paused for this session
 * only, so the rows go back exactly as they were.
 */
export async function restoreInto(client: PrismaClient, file: string, onTable?: (t: string, rows: number) => void) {
  if (!fs.existsSync(file)) throw new Error(`Backup file not found: ${file}`);
  let header: { format?: string; migrations?: string[] } | null = null;
  let table: string | null = null;
  let batch: string[] = [];
  let count = 0;
  let ended = false;

  await client.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      const flush = async () => {
        if (!table || !batch.length) return;
        // Only the columns the backup has: columns added by a later update take their defaults.
        const cols = Object.keys(JSON.parse(batch[0]) as object).map(q).join(', ');
        await tx.$executeRawUnsafe(`INSERT INTO ${q(table)} (${cols}) SELECT ${cols} FROM json_populate_recordset(NULL::${q(table)}, $1::json)`, `[${batch.join(',')}]`);
        count += batch.length;
        batch = [];
      };
      // Opened here, right where it is read: lines emitted before the loop starts would be lost.
      const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        if (!header) {
          header = JSON.parse(line);
          if (header?.format !== FORMAT) throw new Error('This file is not a BlendGuard backup.');
          continue;
        }
        if (line.startsWith('{"table":')) {
          await flush();
          if (table) onTable?.(table, count);
          table = (JSON.parse(line) as { table: string }).table;
          count = 0;
          // Rows a migration put in the new database (e.g. default racks) give way to the backup's.
          await tx.$executeRawUnsafe(`DELETE FROM ${q(table)}`);
          continue;
        }
        if (line.startsWith('{"end":')) {
          ended = true;
          break;
        }
        batch.push(line);
        if (batch.length >= BATCH) await flush();
      }
      await flush();
      if (table) onTable?.(table, count);
      if (!ended) throw new Error('The backup file is incomplete (it was cut off). Use an older backup.');

      // Counters (e.g. the audit trail's sequence number) continue after the restored rows.
      const serials = await tx.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`;
      for (const s of serials) {
        await tx.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('${q(s.table_name)}', '${s.column_name}'), COALESCE((SELECT MAX(${q(s.column_name)}) FROM ${q(s.table_name)}), 0) + 1, false)`,
        );
      }
    },
    { timeout: 30 * 60_000, maxWait: 60_000 },
  );
  return header as { migrations?: string[] } | null;
}
