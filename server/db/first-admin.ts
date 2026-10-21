/**
 * First start of a live (non-demo) install: one scientist account with a
 * random password, shown once in the start window and written to
 * data/FIRST-SIGN-IN.txt. The scientist signs in, gives themself a new
 * password (Setup → Users), and then adds the real stations, users and ingredients.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { db } from './prisma.js';
import { hashSecret } from '../utils/crypto.js';
import { auditNow } from '../services/audit.service.js';
import { logger } from '../utils/logger.js';

/** 12 characters, no look-alikes (0/O, 1/l/I), so it can be typed from a printout. */
function readablePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(12), (b) => chars[b % chars.length]).join('');
}

export async function createFirstAdmin() {
  const password = readablePassword();
  const user = await db().user.create({
    data: { role: 'SUPERVISOR', name: 'Scientist', username: 'scientist', language: 'en', passwordHash: await hashSecret(password) },
  });
  await auditNow({ type: 'USER_CREATED', outcome: 'SUCCESS', userId: null, role: null, sourceDevice: 'first-start', details: { userId: user.id, role: 'SUPERVISOR', username: 'scientist', firstStart: true } });
  const file = path.join(DATA_DIR, 'FIRST-SIGN-IN.txt');
  fs.writeFileSync(
    file,
    [
      'BlendGuard: first scientist sign-in',
      '',
      '  Username: scientist',
      `  Password: ${password}`,
      '',
      'Sign in on the server PC, then straight away:',
      '  1. Setup > Users: give "scientist" a new password (Reset password).',
      '  2. Create the real scientists and operators.',
      '  3. Setup > Station setup: add each station and set up its scale.',
      '  4. Setup > Ingredients: add the ingredients.',
      '',
      'Then delete this file.',
      '',
    ].join('\r\n'),
  );
  logger.info(`First start: scientist account "scientist" created. Password in ${path.relative(path.dirname(DATA_DIR), file)}`);
  console.log(`\n  First sign-in:  username  scientist   password  ${password}\n  (also saved in data\\FIRST-SIGN-IN.txt; change it after signing in)\n`);
}
