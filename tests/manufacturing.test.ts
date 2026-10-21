/**
 * The non-negotiable manufacturing rules (spec §15), exercised through the
 * real HTTP API against a real PostgreSQL database.
 */
import { beforeAll, describe, expect, inject, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { RunState, SimBottle } from '../shared/types.js';
import { config } from '../server/config.js';

process.env.DATABASE_URL = inject('testDbUrl');

const H = { 'X-BlendGuard': '1' };
let app: Express;
let settleNow: (id: string) => void;
let checkOverweight: (id: string) => Promise<void>;
let prisma: import('@prisma/client').PrismaClient;
let st1: { id: string };
let op: ReturnType<typeof request.agent>;
let oudId: string;
const PIN = config.demo.operatorPin;
const SUP_PW = config.demo.supervisorPassword;

const send = (a: ReturnType<typeof request.agent>, url: string, body: object) => a.post(`/api${url}`).set(H).send(body);
/** Job changes must carry the version the screen showed (as the operator screen sends it); tests that do not care get the current one. */
const post = (a: ReturnType<typeof request.agent>, url: string, body: object = {}) => {
  const id = /^\/(?:supervisor\/)?batches\/([0-9a-f-]{36})\//.exec(url)?.[1];
  if (!id || 'version' in body) return send(a, url, body);
  const res = prisma.batch.findUnique({ where: { id }, select: { version: true } }).then((b) => ({ req: send(a, url, { version: b?.version, ...body }) })); // wrapped: a returned request would be sent and resolved here
  return {
    expect: (status: number) => res.then(({ req }) => req.expect(status) as PromiseLike<request.Response>),
    then: <R>(ok: (r: request.Response) => R, err?: (e: unknown) => R) => res.then(({ req }) => req as PromiseLike<request.Response>).then(ok, err),
  };
};
const run = async (id = oudId): Promise<RunState> => (await op.get(`/api/batches/${id}/run`).expect(200)).body;
const current = (r: RunState) => r.steps.find((s) => s.status === 'CURRENT' || s.status === 'ON_HOLD')!;

async function sim(body: object) {
  await post(op, '/station/scale/sim', body).expect(200);
  settleNow(st1.id);
}

async function bottles(id = oudId): Promise<SimBottle[]> {
  return (await op.get(`/api/batches/${id}/sim-bottles`).expect(200)).body;
}

/** Runs the current step the right way: found → correct scan → zero → pour exact → accept. */
async function completeStep(id = oudId, containerNo = 1) {
  const r = await run(id);
  const s = current(r);
  await post(op, `/batches/${id}/steps/${s.seq}/found`).expect(200);
  const good = (await bottles(id)).find((b) => b.hint === 'correct')!;
  const scan = await post(op, `/batches/${id}/steps/${s.seq}/scan`, { barcode: good.barcode, source: 'simulator' }).expect(200);
  expect(scan.body.ok).toBe(true);
  const tare = await post(op, `/batches/${id}/steps/${s.seq}/tare`, { containerNo }).expect(200);
  expect(tare.body.ok).toBe(true);
  await sim({ action: 'pour', mg: s.targetMg });
  const acc = await post(op, `/batches/${id}/steps/${s.seq}/accept`).expect(200);
  expect(acc.body.ok).toBe(true);
  return acc.body.run as RunState;
}

beforeAll(async () => {
  const { createApp } = await import('../server/app.js');
  const scale = await import('../server/services/scale.service.js');
  const batch = await import('../server/services/batch.service.js');
  const { db } = await import('../server/db/prisma.js');
  prisma = db();
  settleNow = scale.settleNow;
  checkOverweight = batch.checkOverweight;
  app = await createApp({ serveClient: false });
  await scale.initScales();
  st1 = (await prisma.station.findUniqueOrThrow({ where: { code: 'ST-01' } }))!;

  // A supervisor sets this "computer" up as station ST-01, then signs out.
  op = request.agent(app);
  await post(op, '/auth/login', { username: 'scientist', password: SUP_PW }).expect(200);
  await post(op, `/supervisor/stations/${st1.id}/bind`).expect(200);
  await post(op, '/auth/logout').expect(200);
});

describe('identity and access (rules 1, 2)', () => {
  it('refuses state changes without the app header (CSRF)', async () => {
    await op.post('/api/auth/pin').send({ operatorCode: '1001', pin: PIN }).expect(403);
  });

  it('refuses the operator screens before authentication', async () => {
    const r = await op.get('/api/operator/jobs').expect(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  it('refuses an operator with no access to this station', async () => {
    const r = await post(op, '/auth/pin', { operatorCode: '1003', pin: PIN }).expect(403);
    expect(r.body.code).toBe('NO_STATION_ACCESS');
  });

  it('locks an account after five wrong PINs', async () => {
    for (let i = 0; i < 4; i++) await post(op, '/auth/pin', { operatorCode: '1004', pin: '0000' }).expect(401);
    const r = await post(op, '/auth/pin', { operatorCode: '1004', pin: '0000' }).expect(429);
    expect(r.body.code).toBe('LOCKED');
    await post(op, '/auth/pin', { operatorCode: '1004', pin: PIN }).expect(429);
    const fails = await prisma.auditEvent.count({ where: { type: 'AUTH_FAILED' } });
    expect(fails).toBeGreaterThanOrEqual(5);
  });

  it('refuses a biometric assertion that was never signed by an enrolled device', async () => {
    const opts = await post(op, '/auth/webauthn/options').expect(200);
    expect(opts.body.userVerification).toBe('required');
    const fake = { id: 'AAAAAAAAAAAAAAAAAAAAAA', rawId: 'AAAAAAAAAAAAAAAAAAAAAA', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: opts.body.challenge })).toString('base64url'), authenticatorData: '', signature: '' } };
    const r = await post(op, '/auth/webauthn/verify', { response: fake, modality: 'fingerprint' }).expect(401);
    expect(r.body.code).toBe('AUTH_FAILED');
  });

  it('signs in the assigned operator and lists their jobs, earliest planned start first', async () => {
    await post(op, '/auth/pin', { operatorCode: '1001', pin: PIN }).expect(200);
    const jobs = (await op.get('/api/operator/jobs').expect(200)).body;
    expect(jobs.map((j: { perfumeName: string }) => j.perfumeName)).toEqual(['Oud Royale', 'Citrus Veil']);
    expect(jobs[0]).toMatchObject({ revision: 'C', ingredientCount: 12, status: 'ASSIGNED' });
    expect(jobs[0]).not.toHaveProperty('priority');
    oudId = jobs[0].id;
  });
});

describe('strict sequence (rules 3, 4, 9, 10)', () => {
  it('does nothing before the job is started', async () => {
    const r = await post(op, `/batches/${oudId}/steps/1/found`).expect(409);
    expect(r.body.code).toBe('NOT_IN_PROGRESS');
  });

  it('starts the job with only step 1 unlocked', async () => {
    const r: RunState = (await post(op, `/batches/${oudId}/start`).expect(200)).body;
    expect(r.status).toBe('IN_PROGRESS');
    expect(r.steps.filter((s) => s.status === 'CURRENT').map((s) => s.seq)).toEqual([1]);
    expect(r.steps.slice(1).every((s) => s.status === 'LOCKED')).toBe(true);
  });

  it('refuses a future ingredient and out-of-order stages', async () => {
    expect((await post(op, `/batches/${oudId}/steps/2/found`).expect(409)).body.code).toBe('NOT_CURRENT_STEP');
    expect((await post(op, `/batches/${oudId}/steps/2/scan`, { barcode: 'RM1002', source: 'scanner' }).expect(409)).body.code).toBe('NOT_CURRENT_STEP');
    expect((await post(op, `/batches/${oudId}/steps/1/tare`, { containerNo: 1 }).expect(409)).body.code).toBe('WRONG_STAGE');
    expect((await post(op, `/batches/${oudId}/steps/1/accept`).expect(409)).body.code).toBe('WRONG_STAGE');
  });

  it('refuses a stale screen', async () => {
    const r = await run();
    expect((await post(op, `/batches/${oudId}/steps/1/found`, { version: r.version - 1 }).expect(409)).body.code).toBe('STALE');
  });

  it('does not allow a second job on the station while one is running', async () => {
    const jobs = (await op.get('/api/operator/jobs').expect(200)).body;
    const citrus = jobs.find((j: { perfumeName: string }) => j.perfumeName === 'Citrus Veil');
    expect((await post(op, `/batches/${citrus.id}/start`).expect(409)).body.code).toBe('OTHER_JOB_ACTIVE');
  });
});

describe('scan verification (rules 5, 6, 11)', () => {
  it('rejects and records a wrong ingredient, then accepts the right one straight from FIND', async () => {
    // No separate "I found it" tap: scanning the right bottle is the proof it was found.
    const wrong = await post(op, `/batches/${oudId}/steps/1/scan`, { barcode: 'RM1002', source: 'scanner' }).expect(200);
    expect(wrong.body).toMatchObject({ ok: false, reason: 'WRONG_INGREDIENT', scannedName: 'Hedione' });
    expect(current(wrong.body.run)).toMatchObject({ stage: 'FIND', wrongScans: 1 });
    const unknown = await post(op, `/batches/${oudId}/steps/1/scan`, { barcode: 'NOPE-123', source: 'scanner' }).expect(200);
    expect(unknown.body.reason).toBe('UNKNOWN_BARCODE');
    const ok = await post(op, `/batches/${oudId}/steps/1/scan`, { barcode: 'RM1001', source: 'scanner' }).expect(200);
    expect(ok.body.ok).toBe(true);
    expect(current(ok.body.run).stage).toBe('WEIGH');
    const step = await prisma.batchStep.findFirstOrThrow({ where: { batchId: oudId, seq: 1 } });
    expect(step.foundAt).not.toBeNull();
    expect(step.scannedAt).not.toBeNull();
    // Wrong ingredient + unknown barcode, plus the earlier scan for a future ingredient.
    const rejected = await prisma.auditEvent.count({ where: { batchId: oudId, type: 'BARCODE_SCAN', outcome: 'REJECTED' } });
    expect(rejected).toBe(3);
  });
});

describe('weighing (rules 7, 8, 10, 11, 17)', () => {
  it('needs a container choice and the vessel on a stable scale before zeroing', async () => {
    await post(op, `/batches/${oudId}/steps/1/tare`).expect(400);
    await post(op, `/batches/${oudId}/steps/1/tare`, { containerNo: 4 }).expect(400);
    expect((await post(op, `/batches/${oudId}/steps/1/tare`, { containerNo: 1 }).expect(409)).body.code).toBe('NO_VESSEL');
    await sim({ action: 'vessel', on: true });
    const t = await post(op, `/batches/${oudId}/steps/1/tare`, { containerNo: 1 }).expect(200);
    expect(t.body.ok).toBe(true);
    expect(current(t.body.run).tareGrossMg).toBe(412_600);
  });

  it('records the chosen container with the zero and locks it', async () => {
    expect(current(await run())).toMatchObject({ seq: 1, containerNo: 1 });
    // Zeroing again (e.g. to switch container) is refused…
    expect((await post(op, `/batches/${oudId}/steps/1/tare`, { containerNo: 2 }).expect(409)).body.code).toBe('ALREADY_TARED');
    // …and the database itself refuses a change.
    await expect(prisma.$executeRawUnsafe(`UPDATE "BatchStep" SET "containerNo" = 2 WHERE "batchId" = '${oudId}' AND seq = 1`)).rejects.toThrow(/container/);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { batchId: oudId, type: 'SCALE_ZEROED' } });
    expect(ev.details).toMatchObject({ seq: 1, containerNo: 1 });
  });

  it('records an underweight attempt and does not unlock step 2', async () => {
    await sim({ action: 'pour', mg: 218_500 });
    const r = await post(op, `/batches/${oudId}/steps/1/accept`).expect(200);
    expect(r.body).toMatchObject({ ok: false, verdict: 'UNDER', netMg: 218_500 });
    expect(r.body.run.steps[1].status).toBe('LOCKED');
  });

  it('refuses an unstable reading', async () => {
    await post(op, '/station/scale/sim', { action: 'pour', mg: 1_500 }).expect(200); // not settled
    const r = await post(op, `/batches/${oudId}/steps/1/accept`).expect(200);
    expect(r.body).toMatchObject({ ok: false, verdict: 'UNSTABLE' });
    settleNow(st1.id);
  });

  it('accepts a correct weight and unlocks step 2 in the same commit', async () => {
    const r = await post(op, `/batches/${oudId}/steps/1/accept`).expect(200);
    expect(r.body).toMatchObject({ ok: true, netMg: 220_000 });
    const [s1, s2] = r.body.run.steps;
    expect(s1).toMatchObject({ status: 'COMPLETED', acceptedNetMg: 220_000 });
    expect(s2).toMatchObject({ status: 'CURRENT', stage: 'FIND' });
    const readings = await prisma.weightReading.findMany({ where: { batchId: oudId }, orderBy: { createdAt: 'asc' } });
    expect(readings.map((x) => `${x.purpose}:${x.verdict}`)).toEqual(['TARE:OK', 'ACCEPT_ATTEMPT:UNDER', 'ACCEPT_ATTEMPT:UNSTABLE', 'ACCEPTED:OK']);
    expect(readings.every((x) => x.source === 'SIMULATED')).toBe(true);
  });

  it('does not let anyone edit or delete measurements or audit events, even in SQL', async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE "WeightReading" SET "netMg" = 1 WHERE "batchId" = '${oudId}'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "WeightReading" WHERE "batchId" = '${oudId}'`)).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "BatchStep" SET "acceptedNetMg" = 1 WHERE "batchId" = '${oudId}' AND seq = 1`)).rejects.toThrow(/cannot be changed/);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent"`)).rejects.toThrow(/cannot be deleted/);
    await expect(prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET outcome = 'SUCCESS'`)).rejects.toThrow(/cannot be edited/);
    // Sync bookkeeping is the one thing that may change.
    await prisma.$executeRawUnsafe(`UPDATE "AuditEvent" SET "syncStatus" = 'PENDING'`);
  });

  it('records too much poured without holding the step or calling anyone', async () => {
    await post(op, `/batches/${oudId}/steps/2/found`).expect(200);
    await post(op, `/batches/${oudId}/steps/2/scan`, { barcode: 'RM1002', source: 'scanner' }).expect(200);
    await post(op, `/batches/${oudId}/steps/2/tare`, { containerNo: 1 }).expect(200);
    await sim({ action: 'pour', mg: 161_000 });
    await checkOverweight(st1.id); // what the scale's "stable" event triggers
    await checkOverweight(st1.id); // settling again while still over does not record it twice
    const r = await run();
    expect(current(r)).toMatchObject({ seq: 2, status: 'CURRENT', stage: 'WEIGH' });
    expect(r.deviations).toHaveLength(1);
    expect(r.deviations[0]).toMatchObject({ type: 'OVERWEIGHT', resolvedAt: null });
    expect(r.openCall).toBeNull();
    // Saving while still too much is refused (and recorded), the step stays open.
    expect((await post(op, `/batches/${oudId}/steps/2/accept`).expect(200)).body).toMatchObject({ ok: false, verdict: 'OVER' });
    expect((await post(op, `/batches/${oudId}/submit`).expect(409)).body.code).toBe('NOT_READY');
  });

  it('lets the operator take the extra out and save the correct weight, closing the problem', async () => {
    await sim({ action: 'remove', mg: 1_000 });
    const res = (await post(op, `/batches/${oudId}/steps/2/accept`).expect(200)).body;
    expect(res.ok).toBe(true);
    const r: RunState = res.run;
    expect(current(r).seq).toBe(3);
    expect(r.deviations[0]).toMatchObject({ resolution: 'EXCESS_REMOVED_BY_OPERATOR' });
    expect(r.deviations[0].resolvedAt).not.toBeNull();
    expect(r.deviations[0].details.resolvedWith).toMatchObject({ removedMg: 1_000, containerNo: 1 });
    const closed = await prisma.auditEvent.findFirstOrThrow({ where: { batchId: oudId, type: 'OVERWEIGHT_CORRECTED' } });
    expect(closed.role).toBe('OPERATOR');
  });

  it('stops when the vessel weight changed between ingredients', async () => {
    await post(op, `/batches/${oudId}/steps/3/found`).expect(200);
    await post(op, `/batches/${oudId}/steps/3/scan`, { barcode: 'RM1003', source: 'scanner' }).expect(200);
    await sim({ action: 'remove', mg: 50_000 }); // spill / wrong vessel
    const t = await post(op, `/batches/${oudId}/steps/3/tare`, { containerNo: 1 }).expect(200);
    expect(t.body).toMatchObject({ ok: false, code: 'VESSEL_CHANGED' });
    expect(current(t.body.run)).toMatchObject({ status: 'ON_HOLD', holdReason: 'VESSEL_CHANGED' });
    expect(t.body.run.openCall?.reason).toBe('VESSEL_CHANGED');
    // Released only by a scientist at the station, with their own password and a note.
    const bad = await post(op, '/auth/signoff', { username: 'scientist', password: 'wrong', batchId: oudId }).expect(401);
    expect(bad.body.code).toBe('AUTH_FAILED');
    const { token } = (await post(op, '/auth/signoff', { username: 'scientist', password: SUP_PW, batchId: oudId }).expect(200)).body;
    expect((await post(op, `/batches/${oudId}/supervisor-action`, { token, action: 'ACCEPT_VESSEL', note: '' }).expect(400)).body.code).toBe('NOTE_REQUIRED');
    expect((await post(op, `/batches/${oudId}/supervisor-action`, { token: token + 'x', action: 'ACCEPT_VESSEL', note: 'x' }).expect(403)).body.code).toBe('SIGNOFF_INVALID');
    await post(op, `/batches/${oudId}/supervisor-action`, { token, action: 'ACCEPT_VESSEL', note: 'Checked: spill wiped, batch quality accepted by QA' }).expect(200);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { batchId: oudId, type: 'SUPERVISOR_INTERVENTION' } });
    expect(ev.role).toBe('SUPERVISOR');
    expect((await post(op, `/batches/${oudId}/steps/3/tare`, { containerNo: 1 }).expect(200)).body.ok).toBe(true);
    await sim({ action: 'pour', mg: 25_000 });
    expect((await post(op, `/batches/${oudId}/steps/3/accept`).expect(200)).body.ok).toBe(true);
  });
});

describe('lots (rule 6)', () => {
  it('runs steps 4–7 normally, moving between containers without a false "container moved"', async () => {
    const before = await prisma.deviation.count({ where: { batchId: oudId, type: 'VESSEL_CHANGED' } });
    // 2 and 3 are new; then back to 2, and back to 1 (last used for step 3).
    for (const containerNo of [2, 3, 2, 1]) await completeStep(oudId, containerNo);
    expect(await prisma.deviation.count({ where: { batchId: oudId, type: 'VESSEL_CHANGED' } })).toBe(before);
    expect(current(await run()).seq).toBe(8);
  });

  it('rejects a quarantined lot of the right ingredient', async () => {
    await post(op, `/batches/${oudId}/steps/8/found`).expect(200);
    const q = await post(op, `/batches/${oudId}/steps/8/scan`, { barcode: 'RM1008-BG-2407Q', source: 'scanner' }).expect(200);
    expect(q.body).toMatchObject({ ok: false, reason: 'LOT_QUARANTINE' });
    const good = await post(op, `/batches/${oudId}/steps/8/scan`, { barcode: 'RM1008-BG-2409A', source: 'scanner' }).expect(200);
    expect(good.body).toMatchObject({ ok: true, lotNumber: 'BG-2409A' });
    await post(op, `/batches/${oudId}/steps/8/tare`, { containerNo: 1 }).expect(200);
    await sim({ action: 'pour', mg: 180_000 });
    await post(op, `/batches/${oudId}/steps/8/accept`).expect(200);
  });

  it('rejects an expired lot', async () => {
    await completeStep(); // 9
    await post(op, `/batches/${oudId}/steps/10/found`).expect(200);
    const x = await post(op, `/batches/${oudId}/steps/10/scan`, { barcode: 'RM1010-OUD-2311', source: 'scanner' }).expect(200);
    expect(x.body).toMatchObject({ ok: false, reason: 'LOT_EXPIRED' });
    const lotless = await post(op, `/batches/${oudId}/steps/10/scan`, { barcode: 'RM1010', source: 'scanner' }).expect(200);
    expect(lotless.body.reason).toBe('UNKNOWN_BARCODE');
  });
});

describe('pause, completion and submission (rules 14, 15)', () => {
  it('pauses and only resumes after the equipment check', async () => {
    const v = (await run()).version;
    expect((await post(op, `/batches/${oudId}/pause`, { version: v }).expect(200)).body.status).toBe('PAUSED');
    expect((await post(op, `/batches/${oudId}/steps/10/scan`, { barcode: 'RM1010-OUD-2402', source: 'scanner' }).expect(409)).body.code).toBe('PAUSED');
    expect((await post(op, `/batches/${oudId}/resume`, { equipmentChecked: false }).expect(400)).body.code).toBe('EQUIPMENT_CHECK_REQUIRED');
    expect((await post(op, `/batches/${oudId}/resume`, { equipmentChecked: true }).expect(200)).body.status).toBe('IN_PROGRESS');
  });

  it('completes every ingredient and waits for submission', async () => {
    await post(op, `/batches/${oudId}/steps/10/scan`, { barcode: 'RM1010-OUD-2402', source: 'scanner' }).expect(200);
    await post(op, `/batches/${oudId}/steps/10/tare`, { containerNo: 1 }).expect(200);
    await sim({ action: 'pour', mg: 12_000 });
    await post(op, `/batches/${oudId}/steps/10/accept`).expect(200);
    await completeStep(); // 11
    const last = await completeStep(); // 12
    expect(last.status).toBe('AWAITING_SUBMISSION');
    expect(last.simulated).toBe(true);
    expect(last.steps.every((s) => s.status === 'COMPLETED')).toBe(true);
  });

  it('submits and then locks the batch against routine changes', async () => {
    const r: RunState = (await post(op, `/batches/${oudId}/submit`).expect(200)).body;
    expect(r.status).toBe('SUBMITTED');
    expect((await post(op, `/batches/${oudId}/submit`).expect(409)).body.code).toBe('NOT_READY');
    expect((await post(op, `/batches/${oudId}/pause`).expect(409)).body.code).toBe('NOT_IN_PROGRESS');
    const types = (await prisma.auditEvent.findMany({ where: { batchId: oudId }, select: { type: true } })).map((e) => e.type);
    for (const t of ['JOB_STARTED', 'INGREDIENT_LOCATED', 'BARCODE_SCAN', 'SCALE_ZEROED', 'WEIGHT_REJECTED', 'WEIGHT_ACCEPTED', 'WEIGHT_OVER', 'SUPERVISOR_INTERVENTION', 'VESSEL_CHANGED', 'JOB_PAUSED', 'JOB_RESUMED', 'ALL_INGREDIENTS_COMPLETED', 'BATCH_SUBMITTED']) {
      expect(types, t).toContain(t);
    }
  });

  it('keeps another operator out of a job that is not theirs', async () => {
    const other = request.agent(app);
    // Same station computer: copy the station cookie by binding again as supervisor would.
    await post(other, '/auth/login', { username: 'scientist', password: SUP_PW }).expect(200);
    await post(other, `/supervisor/stations/${st1.id}/bind`).expect(200);
    await post(other, '/auth/logout').expect(200);
    await post(other, '/auth/pin', { operatorCode: '1002', pin: PIN }).expect(200);
    const jobs = (await other.get('/api/operator/jobs').expect(200)).body;
    expect(jobs).toEqual([]);
    expect((await other.get(`/api/batches/${oudId}/run`).expect(403)).body.code).toBe('NOT_ASSIGNED');
  });
});

describe('setup by scientists (no separate administrator role)', () => {
  const ADMIN_PW = config.demo.adminPassword;
  // The demo "scientist2" account is the second scientist.
  let adm: ReturnType<typeof request.agent>;
  // 1x1 transparent PNG.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  beforeAll(async () => {
    adm = request.agent(app);
    await post(adm, '/auth/login', { username: 'scientist2', password: ADMIN_PW }).expect(200);
  });

  it('gives a scientist both the floor and the setup screens, and nobody else', async () => {
    await adm.get('/api/supervisor/overview').expect(200);
    const users = (await adm.get('/api/admin/users').expect(200)).body as { role: string }[];
    expect(new Set(users.map((u) => u.role))).toEqual(new Set(['OPERATOR', 'SUPERVISOR']));
    expect(JSON.stringify(users)).not.toMatch(/scrypt\$/); // no PIN / password hashes leave the server
    expect((await request.agent(app).get('/api/admin/users').expect(401)).body.code).toBe('UNAUTHENTICATED');
    // The administrator role is gone: it cannot be given to a new account.
    await post(adm, '/admin/users', { role: 'ADMIN', name: 'Old Admin', username: 'oldadmin', password: 'Password@123' }).expect(400);
  });

  it('lets a scientist add an operator, and refuses a duplicate ID', async () => {
    const body = { role: 'OPERATOR', name: 'Ravi Test', language: 'ml', operatorCode: '1099', pin: '2468', stationIds: [st1.id] };
    await post(adm, '/admin/users', body).expect(200);
    expect((await post(adm, '/admin/users', body).expect(409)).body.code).toBe('DUPLICATE');
    const created = await prisma.auditEvent.count({ where: { type: 'USER_CREATED' } });
    expect(created).toBe(1);
  });

  it('does not let a scientist switch off their own account', async () => {
    const me = (await adm.get('/api/auth/me').expect(200)).body;
    const r = await adm.patch(`/api/admin/users/${me.user.id}`).set(H).send({ active: false }).expect(409);
    expect(r.body.code).toBe('SELF_CHANGE');
  });

  it('lets any scientist sign an operator in on the floor, but never an operator', async () => {
    const floor = request.agent(app);
    await post(floor, '/auth/login', { username: 'scientist', password: SUP_PW }).expect(200);
    await post(floor, `/supervisor/stations/${st1.id}/bind`).expect(200);
    await post(floor, '/auth/logout').expect(200);
    await post(floor, '/auth/assisted', { operatorCode: '1099', username: 'scientist2', password: ADMIN_PW }).expect(200);
    await post(floor, '/auth/logout').expect(200);
    await post(floor, '/auth/pin', { operatorCode: '1099', pin: '2468' }).expect(200);
    expect((await floor.get('/api/supervisor/overview').expect(403)).body.code).toBe('WRONG_ROLE');
  });

  it('sets the colour, place and photo operators see for an ingredient', async () => {
    const { ingredients } = (await adm.get('/api/admin/ingredients').expect(200)).body as { ingredients: { id: string; code: string }[] };
    const ing = ingredients.find((i) => i.code === 'RM-1015')!;
    expect((await adm.patch(`/api/admin/ingredients/${ing.id}`).set(H).send({ rackCode: 'C', bin: 99 }).expect(400)).body.code).toBe('BAD_LOCATION');
    await adm.patch(`/api/admin/ingredients/${ing.id}`).set(H).send({ colorHex: '#123abc', rackCode: 'C', bin: 12, ppe: ['GLOVES', 'GOGGLES'] }).expect(200);
    await adm.put(`/api/admin/ingredients/${ing.id}/photo`).set(H).send({ type: 'image/png', data: PNG }).expect(200);
    const after = ((await adm.get('/api/admin/ingredients').expect(200)).body.ingredients as { code: string; colorHex: string; ppe: string[]; photoUrl: string }[]).find((i) => i.code === 'RM-1015')!;
    expect(after).toMatchObject({ colorHex: '#123abc', ppe: ['GLOVES', 'GOGGLES'] });
    const photo = await adm.get(after.photoUrl).expect(200);
    expect(photo.headers['content-type']).toBe('image/png');
    await request(app).get(after.photoUrl).expect(401); // not without signing in
  });

  it('adds a new ingredient, refusing a code or barcode that is already in use', async () => {
    const r = (await post(adm, '/admin/ingredients', { code: 'rm-2001', name: 'Geraniol', barcode: 'GER-2001' }).expect(200)).body as { id: string };
    const { ingredients } = (await adm.get('/api/admin/ingredients').expect(200)).body as { ingredients: { id: string; code: string; name: string; barcode: string; lotTracked: boolean }[] };
    expect(ingredients.find((i) => i.id === r.id)).toMatchObject({ code: 'RM-2001', name: 'Geraniol', barcode: 'GER-2001', lotTracked: false });
    expect((await post(adm, '/admin/ingredients', { code: 'RM-2001', name: 'Again', barcode: 'GER-9999' }).expect(409)).body.code).toBe('DUPLICATE');
    expect((await post(adm, '/admin/ingredients', { code: 'RM-2002', name: 'Clash', barcode: 'RM1002' }).expect(409)).body.code).toBe('DUPLICATE');
    await post(adm, '/admin/ingredients', { code: 'RM 2003', name: 'Bad code', barcode: 'X1' }).expect(400);
    await post(adm, '/admin/ingredients', { code: 'RM-2004', name: 'No barcode', barcode: '' }).expect(400);
  });

  it('keeps every setup change in the audit trail', async () => {
    const trail = (await adm.get('/api/admin/audit?limit=50').expect(200)).body as { events: { type: string }[] };
    const types = trail.events.map((e) => e.type);
    for (const t of ['USER_CREATED', 'INGREDIENT_CREATED', 'INGREDIENT_UPDATED', 'INGREDIENT_PHOTO_SET']) expect(types, t).toContain(t);
  });

  it('gives scientists a shift report for the day', async () => {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = (await adm.get(`/api/supervisor/report?date=${date}`).expect(200)).body;
    expect(r.totals.jobsSubmitted).toBeGreaterThanOrEqual(1);
    expect(r.totals.problems).toBeGreaterThanOrEqual(2); // overweight + vessel changed
    expect(r.operators[0]).toMatchObject({ name: 'Suresh Kumar', ingredients: 12 });
  });
});

describe('supervisor upload and operator activity log', () => {
  let sup: ReturnType<typeof request.agent>;
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const CSV = ['Perfume Name,Test Musk', 'Formula Code,FR-TEST-1', 'Revision,A', 'Seq,Ingredient Code,Quantity,Unit,Tolerance Minus,Tolerance Plus,Remarks', '1,RM-1001,12.5,g,0.1,0.1,', '2,rm-1002,0.25,kg,0.0005,0.0005,"Pour slowly, then stir"'].join('\n');

  beforeAll(async () => {
    sup = request.agent(app);
    await post(sup, '/auth/login', { username: 'scientist', password: SUP_PW }).expect(200);
  });

  it('flags problems in an uploaded production instruction before approval', async () => {
    const bad = 'Perfume Name,X\nSeq,Ingredient Code,Quantity,Unit,Tolerance Minus,Tolerance Plus\n1,RM-9999,abc,lb,1,1\n1,RM-1001,10,g,,\n';
    const p = (await post(sup, '/supervisor/formulas/import/preview', { fileName: 'bad.csv', csv: bad }).expect(200)).body;
    expect(p.ok).toBe(false);
    expect(p.errors.join(' ')).toMatch(/Formula code is missing/);
    const [l1, l2] = p.lines;
    expect(l1.errors.join(' ')).toMatch(/not in the ingredient list/);
    expect(l1.errors.join(' ')).toMatch(/Unit "lb"/);
    expect(l2.errors.join(' ')).toMatch(/appears twice/);
    expect(l2.errors.join(' ')).toMatch(/Tolerance is missing/);
    await post(sup, '/supervisor/formulas/import', { fileName: 'bad.csv', csv: bad, meta: { perfumeName: 'X', code: 'FR-X', revision: 'A', sopNumber: '' } }).expect(400);
  });

  it('converts units exactly and creates an approved, assignable formula', async () => {
    const p = (await post(sup, '/supervisor/formulas/import/preview', { fileName: 'musk.csv', csv: CSV }).expect(200)).body;
    expect(p.ok).toBe(true);
    expect(p.lines.map((l: { targetMg: number; tolMinusMg: number; ingredientCode: string; remarks: string | null }) => [l.ingredientCode, l.targetMg, l.tolMinusMg, l.remarks])).toEqual([
      ['RM-1001', 12_500, 100, null],
      ['RM-1002', 250_000, 500, 'Pour slowly, then stir'],
    ]);
    const f = (await post(sup, '/supervisor/formulas/import', { fileName: 'musk.csv', csv: CSV, meta: p.meta }).expect(200)).body;
    const saved = await prisma.formula.findUniqueOrThrow({ where: { id: f.id }, include: { lines: true } });
    expect(saved).toMatchObject({ status: 'APPROVED', sourceFileName: 'musk.csv', batchSizeMg: 262_500 });
    expect(saved.sourceFile).toBe(CSV);
    const ov = (await sup.get('/api/supervisor/overview').expect(200)).body;
    expect(ov.formulas.map((x: { id: string }) => x.id)).toContain(f.id);
    // The same revision cannot be uploaded twice.
    expect((await post(sup, '/supervisor/formulas/import/preview', { fileName: 'musk.csv', csv: CSV }).expect(200)).body.ok).toBe(false);
  });

  it('shows an operator\'s whole day, sign-in to sign-out, including the containers used', async () => {
    const suresh = await prisma.user.findFirstOrThrow({ where: { operatorCode: '1001' } });
    const a = (await sup.get(`/api/supervisor/activity?operatorId=${suresh.id}&date=${today()}`).expect(200)).body;
    const types = a.events.map((e: { type: string }) => e.type);
    for (const t of ['AUTH_SUCCESS', 'JOB_STARTED', 'BARCODE_SCAN', 'SCALE_ZEROED', 'WEIGHT_ACCEPTED', 'JOB_PAUSED', 'JOB_RESUMED', 'BATCH_SUBMITTED']) expect(types, t).toContain(t);
    // The automatic overweight hold is shown as done by the system, not the operator.
    expect(a.events.find((e: { type: string }) => e.type === 'WEIGHT_OVER').by).toBe('SYSTEM');
    expect(a.events.find((e: { type: string }) => e.type === 'SCALE_ZEROED').details.containerNo).toBe(1);
    expect(a.summary.ingredients).toBe(12);
    expect(a.jobs.some((j: { status: string }) => j.status === 'SUBMITTED')).toBe(true);
    await request(app).get(`/api/supervisor/activity?operatorId=${suresh.id}&date=${today()}`).expect(401);
  });
});

describe('ingredients skipped for the lab report', () => {
  let sup: ReturnType<typeof request.agent>;
  let citrusId: string;
  const job = async () => ((await op.get('/api/operator/jobs').expect(200)).body as { id: string; status: string; skippedCount: number; labReady: boolean }[]).find((j) => j.id === citrusId)!;
  const skip = (seq: number, note = 'Waiting for lab report on this lot') => post(sup, `/supervisor/batches/${citrusId}/steps/${seq}/skip`, { note });
  const release = (seq: number) => post(sup, `/supervisor/batches/${citrusId}/steps/${seq}/lab-release`, { note: 'Lab report passed' });
  async function finishAvailable() {
    let r = await run(citrusId);
    while (r.status === 'IN_PROGRESS') r = await completeStep(citrusId);
    return r;
  }

  beforeAll(async () => {
    sup = request.agent(app);
    await post(sup, '/auth/login', { username: 'scientist', password: SUP_PW }).expect(200);
    // Earlier tests re-linked the station computer; link it again and sign the operator back in.
    await post(op, '/auth/login', { username: 'scientist', password: SUP_PW }).expect(200);
    await post(op, `/supervisor/stations/${st1.id}/bind`).expect(200);
    await post(op, '/auth/logout').expect(200);
    await post(op, '/auth/pin', { operatorCode: '1001', pin: PIN }).expect(200);
    const jobs = (await op.get('/api/operator/jobs').expect(200)).body;
    citrusId = jobs.find((j: { perfumeName: string }) => j.perfumeName === 'Citrus Veil').id;
  });

  it('only lets a supervisor skip, and needs a reason', async () => {
    expect((await post(op, `/supervisor/batches/${citrusId}/steps/2/skip`, { note: 'x lab' }).expect(403)).body.code).toBe('WRONG_ROLE');
    expect((await skip(2, '').expect(400)).body.code).toBe('NOTE_REQUIRED');
  });

  it('skips an ingredient before the job starts; the operator sees it as skipped', async () => {
    const r: RunState = (await skip(2).expect(200)).body;
    expect(r.steps.find((s) => s.seq === 2)).toMatchObject({ status: 'SKIPPED', skipNote: 'Waiting for lab report on this lot' });
    expect((await run(citrusId)).steps.find((s) => s.seq === 2)!.status).toBe('SKIPPED');
    expect(await job()).toMatchObject({ status: 'ASSIGNED', skippedCount: 1 });
  });

  it('passes over the skipped ingredient while the operator works', async () => {
    await post(op, `/batches/${citrusId}/start`).expect(200);
    const r = await completeStep(citrusId); // 1
    expect(current(r).seq).toBe(3);
    expect((await post(op, `/batches/${citrusId}/steps/2/found`).expect(409)).body.code).toBe('NOT_CURRENT_STEP');
  });

  it('can skip the current ingredient before the scale is zeroed, but not after', async () => {
    const r: RunState = (await skip(3).expect(200)).body;
    expect(current(r).seq).toBe(4);
    const s = current(r);
    await post(op, `/batches/${citrusId}/steps/${s.seq}/found`).expect(200);
    const good = (await bottles(citrusId)).find((b) => b.hint === 'correct')!;
    await post(op, `/batches/${citrusId}/steps/${s.seq}/scan`, { barcode: good.barcode, source: 'simulator' }).expect(200);
    await post(op, `/batches/${citrusId}/steps/${s.seq}/tare`, { containerNo: 1 }).expect(200);
    expect((await skip(s.seq).expect(409)).body.code).toBe('ALREADY_WEIGHING');
    await sim({ action: 'pour', mg: s.targetMg });
    await post(op, `/batches/${citrusId}/steps/${s.seq}/accept`).expect(200);
  });

  it('waits for the lab once everything else is done, without holding the station', async () => {
    const r = await finishAvailable();
    expect(r.status).toBe('AWAITING_LAB');
    expect(r.steps.filter((s) => s.status === 'SKIPPED').map((s) => s.seq)).toEqual([2, 3]);
    expect(r.steps.filter((s) => s.status !== 'SKIPPED').every((s) => s.status === 'COMPLETED')).toBe(true);
    expect(await job()).toMatchObject({ status: 'AWAITING_LAB', skippedCount: 2, labReady: false });
    expect((await post(op, `/batches/${citrusId}/submit`).expect(409)).body.code).toBe('NOT_READY');
    expect((await post(op, `/batches/${citrusId}/start`).expect(409)).body.code).toBe('LAB_NOT_READY');
    const ov = (await sup.get('/api/supervisor/overview').expect(200)).body;
    expect(ov.stations.find((s: { id: string }) => s.id === st1.id).current).toBeNull();
  });

  it('continues when the supervisor releases a lab ingredient, then waits again for the next', async () => {
    await release(2).expect(200);
    expect(await job()).toMatchObject({ status: 'AWAITING_LAB', labReady: true, skippedCount: 1 });
    const started: RunState = (await post(op, `/batches/${citrusId}/start`).expect(200)).body;
    expect(started.status).toBe('IN_PROGRESS');
    expect(current(started).seq).toBe(2);
    const r = await completeStep(citrusId);
    expect(r.status).toBe('AWAITING_LAB');
    expect((await release(2).expect(409)).body.code).toBe('NOT_SKIPPED');
  });

  it('completes after the last lab ingredient and sends the final report to the supervisor', async () => {
    await release(3).expect(200);
    await post(op, `/batches/${citrusId}/start`).expect(200);
    const r = await completeStep(citrusId);
    expect(r.status).toBe('AWAITING_SUBMISSION');
    expect(r.steps.every((s) => s.status === 'COMPLETED')).toBe(true);
    expect((await post(op, `/batches/${citrusId}/submit`).expect(200)).body.status).toBe('SUBMITTED');
    expect((await skip(5).expect(409)).body.code).toBe('CANNOT_SKIP');

    const d = (await sup.get(`/api/supervisor/batches/${citrusId}`).expect(200)).body;
    expect(d.run.status).toBe('SUBMITTED');
    expect(d.submittedBy).toBe('Suresh Kumar');
    expect(d.lab['2']).toMatchObject({ skippedBy: expect.any(String), releasedBy: expect.any(String) });
    expect(d.run.steps.find((s: { seq: number }) => s.seq === 3).labReleasedAt).not.toBeNull();
    const types = (await prisma.auditEvent.findMany({ where: { batchId: citrusId }, select: { type: true } })).map((e) => e.type);
    // Adding lab ingredients out of order must not look like a moved container.
    expect(await prisma.deviation.count({ where: { batchId: citrusId } })).toBe(0);
    for (const t of ['INGREDIENT_SKIPPED', 'WAITING_FOR_LAB', 'LAB_INGREDIENT_RELEASED', 'LAB_INGREDIENT_STARTED', 'ALL_INGREDIENTS_COMPLETED', 'BATCH_SUBMITTED']) expect(types, t).toContain(t);
  });
});

describe('process order PDF upload with lab-test ingredients', () => {
  let sup: ReturnType<typeof request.agent>;
  let pdf: string;

  beforeAll(async () => {
    sup = request.agent(app);
    await post(sup, '/auth/login', { username: 'scientist', password: SUP_PW }).expect(200);
    const { makeSampleOrder } = await import('../scripts/make-sample-order.js');
    pdf = Buffer.from(await makeSampleOrder()).toString('base64');
  });

  it('reads the process order header and the MATERIAL INPUT table', async () => {
    const p = (await post(sup, '/supervisor/formulas/import/pdf', { fileName: 'order.pdf', pdf }).expect(200)).body;
    expect(p.processOrder).toMatchObject({ processOrder: '1369327', plant: 'K104', material: '4410000145', materialDescription: 'OTTO ROSE 029 A', batch: '4413760375', orderQuantity: '1.250', orderUom: 'KG', saleOrder: '1200048049', reservation: '69750575', orderType: 'ZP29', startDate: '06.10.2026', planDeliveryDate: '15.09.2026' });
    expect(p.meta).toMatchObject({ code: '4410000145', revision: '1369327', perfumeName: 'OTTO ROSE 029 A' });
    expect(p.lines.map((l: { ingredientCode: string; targetMg: number; tolMinusMg: number; storageLocation: string; sourceBatch: string }) => [l.ingredientCode, l.targetMg, l.tolMinusMg, l.storageLocation, l.sourceBatch])).toEqual([
      ['RM-1001', 400_000, 4_000, '1000', '4413700121'],
      ['RM-1002', 300_000, 3_000, '1000', '4413700187'],
      ['RM-1007', 25_000, 250, '1010', '4413700340'],
      ['RM-1014', 150_000, 1_500, '1000', '4413700412'],
      ['RM-1004', 200_000, 2_000, '1010', '4413700455'],
      ['RM-1006', 75_000, 750, '1020', '4413700498'],
      ['RM-1011', 100_000, 1_000, '1000', '4413700533'],
    ]);
    expect(p.ok).toBe(true);
  });

  it('refuses a file that is not a PDF, and blocks material codes that are not in the ingredient list', async () => {
    expect((await post(sup, '/supervisor/formulas/import/pdf', { fileName: 'x.pdf', pdf: Buffer.from('hello world').toString('base64') }).expect(400)).body.code).toBe('PDF_UNREADABLE');
    const p = (await post(sup, '/supervisor/formulas/import/pdf', { fileName: 'order.pdf', pdf }).expect(200)).body;
    const draft = { meta: p.meta, processOrder: p.processOrder, lines: p.lines.map(({ errors, warnings, seqNo, ingredientName, targetMg, tolMinusMg, tolPlusMg, ...l }: Record<string, unknown>) => l) };
    draft.lines[0].ingredientCode = '4499999999';
    const c = (await post(sup, '/supervisor/formulas/import/check', { draft }).expect(200)).body;
    expect(c.ok).toBe(false);
    expect(c.lines[0].errors.join(' ')).toMatch(/not in the ingredient list/);
  });

  it('approves with a lab-test tick, and a job assigned from it starts with that ingredient skipped', async () => {
    const p = (await post(sup, '/supervisor/formulas/import/pdf', { fileName: 'order.pdf', pdf }).expect(200)).body;
    const draft = { meta: p.meta, processOrder: p.processOrder, lines: p.lines.map(({ errors, warnings, seqNo, ingredientName, targetMg, tolMinusMg, tolPlusMg, ...l }: Record<string, unknown>) => l) };
    draft.lines[2].labTest = true;
    const f = (await post(sup, '/supervisor/formulas/import', { fileName: 'order.pdf', draft, pdf }).expect(200)).body;
    expect(f).toMatchObject({ code: '4410000145', revision: '1369327', labSeqs: [3] });
    // The same process order cannot be uploaded twice.
    expect((await post(sup, '/supervisor/formulas/import/pdf', { fileName: 'order.pdf', pdf }).expect(200)).body.ok).toBe(false);

    const detail = (await sup.get(`/api/supervisor/formulas/${f.id}`).expect(200)).body;
    expect(detail.processOrder.processOrder).toBe('1369327');
    expect(detail.lines.filter((l: { labTest: boolean }) => l.labTest).map((l: { code: string }) => l.code)).toEqual(['RM-1007']);

    const st2 = await prisma.station.findUniqueOrThrow({ where: { code: 'ST-02' } });
    const lakshmi = await prisma.user.findFirstOrThrow({ where: { operatorCode: '1002' } });
    expect((await post(sup, '/supervisor/jobs', { formulaId: f.id, operatorId: lakshmi.id, stationId: st2.id, labSeqs: [1, 2, 3, 4, 5, 6, 7] }).expect(400)).body.code).toBe('LAST_INGREDIENT');
    const job = (await post(sup, '/supervisor/jobs', { formulaId: f.id, operatorId: lakshmi.id, stationId: st2.id, labSeqs: [3] }).expect(200)).body;
    const steps = await prisma.batchStep.findMany({ where: { batchId: job.id }, orderBy: { seq: 'asc' } });
    expect(steps.map((s) => s.status)).toEqual(['LOCKED', 'LOCKED', 'SKIPPED', 'LOCKED', 'LOCKED', 'LOCKED', 'LOCKED']);
    expect(steps[2]).toMatchObject({ uom: 'G', sourceBatch: '4413700340', storageLocation: '1010' });
    const b = await prisma.batch.findUniqueOrThrow({ where: { id: job.id } });
    expect((b.processOrder as { processOrder: string }).processOrder).toBe('1369327');
    const d = (await sup.get(`/api/supervisor/batches/${job.id}`).expect(200)).body;
    expect(d.run.processOrder.material).toBe('4410000145');
  });
});

describe('the operator sends a bottle for lab test and marks it arrived', () => {
  let sci: ReturnType<typeof request.agent>;
  let jobId: string;

  beforeAll(async () => {
    sci = request.agent(app);
    await post(sci, '/auth/login', { username: 'scientist', password: SUP_PW }).expect(200);
    const formula = await prisma.formula.findFirstOrThrow({ where: { code: 'F-1187', status: 'APPROVED' } });
    const suresh = await prisma.user.findFirstOrThrow({ where: { operatorCode: '1001' } });
    jobId = (await post(sci, '/supervisor/jobs', { formulaId: formula.id, operatorId: suresh.id, stationId: st1.id }).expect(200)).body.id;
    await post(op, `/batches/${jobId}/start`).expect(200);
  });

  it('skips only the bottle in front of them, and only before set to zero', async () => {
    const r: RunState = (await post(op, `/batches/${jobId}/steps/1/lab-skip`).expect(200)).body;
    expect(r.steps.find((s) => s.seq === 1)).toMatchObject({ status: 'SKIPPED' });
    expect(current(r).seq).toBe(2);
    expect((await post(op, `/batches/${jobId}/steps/3/lab-skip`).expect(409)).body.code).toBe('NOT_CURRENT_STEP');

    const s = current(r);
    await post(op, `/batches/${jobId}/steps/${s.seq}/found`).expect(200);
    const good = (await bottles(jobId)).find((b) => b.hint === 'correct')!;
    await post(op, `/batches/${jobId}/steps/${s.seq}/scan`, { barcode: good.barcode, source: 'simulator' }).expect(200);
    await post(op, `/batches/${jobId}/steps/${s.seq}/tare`, { containerNo: 1 }).expect(200);
    expect((await post(op, `/batches/${jobId}/steps/${s.seq}/lab-skip`).expect(409)).body.code).toBe('ALREADY_WEIGHING');
    await sim({ action: 'pour', mg: s.targetMg });
    await post(op, `/batches/${jobId}/steps/${s.seq}/accept`).expect(200);

    const skipped = await prisma.auditEvent.findFirstOrThrow({ where: { batchId: jobId, type: 'INGREDIENT_SKIPPED' } });
    expect(skipped).toMatchObject({ role: 'OPERATOR', outcome: 'SUCCESS' });
  });

  it('marks the lab bottle arrived, adds it, and the record says who did what', async () => {
    let r = await run(jobId);
    while (r.status === 'IN_PROGRESS') r = await completeStep(jobId);
    expect(r.status).toBe('AWAITING_LAB');
    expect((await post(op, `/batches/${jobId}/steps/2/lab-arrived`).expect(409)).body.code).toBe('NOT_SKIPPED');

    r = (await post(op, `/batches/${jobId}/steps/1/lab-arrived`).expect(200)).body;
    expect(r.steps.find((s) => s.seq === 1)).toMatchObject({ status: 'LOCKED' });
    expect(current((await post(op, `/batches/${jobId}/start`).expect(200)).body).seq).toBe(1);
    r = await completeStep(jobId);
    expect(r.status).toBe('AWAITING_SUBMISSION');

    const d = (await sci.get(`/api/supervisor/batches/${jobId}`).expect(200)).body;
    expect(d.lab['1']).toEqual({ skippedBy: 'Suresh Kumar', releasedBy: 'Suresh Kumar' });
  });
});
