import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };

/** scrypt hash in the form scrypt$N$r$p$salt$hash */
export async function hashSecret(secret: string) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(secret, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** A fixed hash so unknown accounts take as long to reject as known ones. */
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function verifySecret(secret: string, stored: string | null | undefined) {
  const [algo, N, r, p, salt, hash] = (stored || DUMMY).split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(secret, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return !!stored && crypto.timingSafeEqual(expected, actual);
}

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Short-lived signed supervisor sign-off ("the supervisor entered their
 * password at this station for this batch"). Bound to station and batch so it
 * cannot be replayed elsewhere.
 *
 * Each token carries a random id (jti) so it can be spent exactly once (the
 * caller records the jti in SignoffUse inside the same transaction as the
 * action). `action`, when given at issue, limits the token to that action;
 * when not given, the action it is first used for is the only one it ever
 * performs, because that first use consumes it.
 */
export function signSignoff(data: { by: string; byName: string; stationId: string; batchId: string; action?: string }, minutes = 5) {
  const body = Buffer.from(JSON.stringify({ ...data, jti: crypto.randomUUID(), exp: Date.now() + minutes * 60_000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export interface Signoff {
  by: string;
  byName: string;
  jti: string;
  action: string | null;
  exp: number;
}

export function readSignoff(token: string | null | undefined, stationId: string, batchId: string, action?: string): Signoff | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (typeof d.exp !== 'number' || d.exp < Date.now() || d.stationId !== stationId || d.batchId !== batchId) return null;
    // Tokens without a jti (issued before single-use) cannot be tracked, so they are refused.
    if (typeof d.jti !== 'string' || !d.jti) return null;
    if (d.action != null && action !== undefined && d.action !== action) return null;
    return { by: d.by, byName: d.byName, jti: d.jti, action: d.action ?? null, exp: d.exp };
  } catch {
    return null;
  }
}
