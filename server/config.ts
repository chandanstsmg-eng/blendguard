import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');

/** Creates .env from .env.example on first run, filling in random secrets. */
function ensureEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) return;
  const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  fs.writeFileSync(envPath, example.replace(/__generate__/g, () => crypto.randomBytes(24).toString('base64url')));
}

ensureEnvFile();
dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

// Shift reports and "today" follow plant time, whatever time zone the server PC is set to.
process.env.TZ = (process.env.PLANT_TIMEZONE ?? '').trim() || 'Asia/Kolkata';

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
const port = int(process.env.PORT, 4300);
const fromRoot = (p: string | undefined) => (p ? path.resolve(ROOT, p) : '');

/**
 * HTTPS: on when a certificate is configured (scripts/make-certificate.ps1 makes one).
 * TLS_PFX (+ TLS_PFX_PASSWORD), or TLS_CERT + TLS_KEY in PEM format.
 */
function tlsOptions() {
  const pfx = fromRoot(process.env.TLS_PFX);
  if (pfx) {
    if (!fs.existsSync(pfx)) throw new Error(`TLS_PFX in .env points to a file that does not exist: ${pfx}`);
    return { pfx: fs.readFileSync(pfx), passphrase: process.env.TLS_PFX_PASSWORD ?? '' };
  }
  const cert = fromRoot(process.env.TLS_CERT);
  const key = fromRoot(process.env.TLS_KEY);
  if (cert || key) {
    if (!cert || !key || !fs.existsSync(cert) || !fs.existsSync(key)) throw new Error('Set both TLS_CERT and TLS_KEY in .env to existing files.');
    return { cert: fs.readFileSync(cert), key: fs.readFileSync(key) };
  }
  return null;
}
const tls = tlsOptions();

export const config = {
  port,
  tls,
  https: !!tls,
  timeZone: process.env.TZ,
  /** Daily database backup: hour of day (plant time) and how many days of backups to keep. */
  backup: {
    hour: int(process.env.BACKUP_HOUR, 2),
    keepDays: int(process.env.BACKUP_KEEP_DAYS, 30),
    /** Optional second folder, e.g. a network share, that every backup is also copied to. */
    copyTo: (process.env.BACKUP_COPY_TO ?? '').trim(),
  },
  pgPort: int(process.env.PG_PORT, 54339),
  pgPassword: process.env.PG_PASSWORD ?? '',
  externalDatabaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET ?? '',
  isProd: !process.argv.includes('--dev') && process.env.NODE_ENV !== 'development',
  isTest: process.env.NODE_ENV === 'test' || !!process.env.VITEST,
  /** Operator sessions: one shift. Supervisor sessions are shorter. */
  operatorSessionHours: 12,
  supervisorSessionHours: 8,
  webauthn: {
    rpId: process.env.WEBAUTHN_RP_ID || 'localhost',
    rpName: 'BlendGuard',
    origins: (process.env.WEBAUTHN_ORIGINS || `${tls ? 'https' : 'http'}://localhost:${port}`).split(',').map((s) => s.trim()).filter(Boolean),
  },
  demo: {
    supervisorPassword: process.env.DEMO_SUPERVISOR_PASSWORD ?? '',
    adminPassword: process.env.DEMO_ADMIN_PASSWORD ?? '',
    operatorPin: process.env.DEMO_OPERATOR_PIN ?? '',
  },
  /**
   * Letterhead printed on batch records and activity logs (COMPANY_* in .env).
   * COMPANY_ADDRESS lines are separated by "|". The fallbacks keep an install
   * whose .env predates these keys printing the same letterhead as before.
   */
  company: {
    name: (process.env.COMPANY_NAME ?? '').trim() || 'Synthite Ind. Pvt. Ltd',
    address: ((process.env.COMPANY_ADDRESS ?? '').trim() || 'Synthite Valley, Kolenchery, Cochin|Kerala 682311, India')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean),
    docNo: (process.env.COMPANY_DOC_NO ?? '').trim() || 'SYN/PRN-001/B',
  },
};

if (!config.sessionSecret || config.sessionSecret.length < 16) {
  throw new Error('SESSION_SECRET in .env is missing or too short.');
}
