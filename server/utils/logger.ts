/**
 * Minimal logger. Technical details go to the terminal and data/logs/app.log;
 * operators only ever see plain-language messages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
/** Days of log files kept; older ones are removed when a new day's file starts. */
const KEEP_DAYS = 90;

let current = '';
/** One file per day (app-2026-10-18.log), so no log grows without limit. */
function logFile() {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const file = path.join(LOG_DIR, `app-${day}.log`);
  if (file !== current) {
    current = file;
    prune();
  }
  return file;
}

function prune() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (/^app-\d{4}-\d{2}-\d{2}\.log$/.test(f) && fs.statSync(path.join(LOG_DIR, f)).mtimeMs < cutoff) fs.rmSync(path.join(LOG_DIR, f), { force: true });
    }
  } catch {
    /* housekeeping only */
  }
}

function write(level: string, msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${extra ? ' ' + format(extra) : ''}`;
  try {
    fs.appendFileSync(logFile(), line + '\n');
  } catch {
    /* logging must never break the app */
  }
}

function format(v: unknown) {
  if (v instanceof Error) return `${v.message}\n${v.stack ?? ''}`;
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const quiet = () => !!process.env.VITEST;

export const logger = {
  info(msg: string, extra?: unknown) {
    write('INFO', msg, extra);
    if (!quiet()) console.log(`  ${msg}`);
  },
  warn(msg: string, extra?: unknown) {
    write('WARN', msg, extra);
    if (!quiet()) console.warn(`  ! ${msg}`);
  },
  error(msg: string, extra?: unknown) {
    write('ERROR', msg, extra);
    if (!quiet()) console.error(`  x ${msg}`, extra instanceof Error ? extra.message : '');
  },
};
