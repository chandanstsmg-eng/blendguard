/**
 * Makes a backup now (BlendGuard may be running).  npm run backup
 * Nightly backups happen by themselves; this is for before maintenance.
 */
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { ensureDatabase } from '../server/db/postgres.js';
import { backupNow } from '../server/db/backup.js';

await ensureDatabase();
const file = await backupNow('manual');
console.log(`\n  Backup saved: ${path.relative(ROOT, file)}\n`);
