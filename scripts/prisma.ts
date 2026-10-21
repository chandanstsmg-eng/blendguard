/**
 * Runs a Prisma CLI command against the built-in database.
 *   npm run prisma -- migrate dev --name add_something
 *   npm run prisma -- studio
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { ensureDatabase } from '../server/db/postgres.js';

await ensureDatabase();
const cli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
const res = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env, cwd: ROOT });
process.exit(res.status ?? 1);
