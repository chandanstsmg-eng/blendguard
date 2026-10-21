/**
 * Supervisor approval of submitted batches, the scale check read from the
 * scale, the letterhead route and the full audit export, through the real HTTP
 * API against a real PostgreSQL database.
 *
 * The batches here are created directly in the SUBMITTED state on station
 * ST-03 for operator 1003, so these tests never touch the jobs the
 * manufacturing tests run on ST-01.
 */
import { beforeAll, describe, expect, inject, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { config } from '../server/config.js';

process.env.DATABASE_URL = inject('testDbUrl');

const H = { 'X-BlendGuard': '1' };
const APPROVER_PW = 'Approver@2026-test';
type Agent = ReturnType<typeof request.agent>;

let app: Express;
let prisma: import('@prisma/client').PrismaClient;
let sup: Agent;
let adm: Agent;
let approverId: string;
let n = 0;

const post = (a: Agent, url: string, body: object = {}) => a.post(`/api${url}`).set(H).send(body);

/** A batch the operator has sent, with every ingredient weighed. */
async function submittedBatch(opts: { simulated?: boolean; openProblem?: boolean } = {}) {
  const formula = await prisma.formula.findFirstOrThrow({ where: { code: 'F-1187', status: 'APPROVED' }, include: { lines: { orderBy: { seq: 'asc' }, include: { ingredient: true } } } });
  const station = await prisma.station.findUniqueOrThrow({ where: { code: 'ST-03' } });
  const operator = await prisma.user.findFirstOrThrow({ where: { operatorCode: '1003' } });
  const assigner = await prisma.user.findFirstOrThrow({ where: { username: 'scientist' } });
  const now = new Date();
  const b = await prisma.batch.create({
    data: {
      batchNo: `T-APPR-${Date.now()}-${++n}`,
      formulaId: formula.id,
      stationId: station.id,
      operatorId: operator.id,
      assignedById: assigner.id,
      status: 'SUBMITTED',
      simulated: !!opts.simulated,
      startedAt: new Date(now.getTime() - 3600_000),
      completedAt: now,
      submittedAt: now,
      submittedById: operator.id,
      steps: {
        create: formula.lines.map((l) => ({
          seq: l.seq,
          ingredientId: l.ingredientId,
          ingredientCode: l.ingredient.code,
          ingredientName: l.ingredient.name,
          targetMg: l.targetMg,
          tolMinusMg: l.tolMinusMg,
          tolPlusMg: l.tolPlusMg,
          status: 'COMPLETED' as const,
          stage: 'DONE' as const,
          acceptedNetMg: l.targetMg,
          acceptedAt: now,
          completedById: operator.id,
        })),
      },
    },
  });
  if (opts.openProblem) await prisma.deviation.create({ data: { batchId: b.id, type: 'OTHER', details: {}, raisedById: operator.id } });
  return b;
}

beforeAll(async () => {
  const { createApp } = await import('../server/app.js');
  const scale = await import('../server/services/scale.service.js');
  const { db } = await import('../server/db/prisma.js');
  const { hashSecret } = await import('../server/utils/crypto.js');
  prisma = db();
  app = await createApp({ serveClient: false });
  await scale.initScales();
  // A supervisor of our own, so wrong-password tests never lock the demo account others use.
  const u = await prisma.user.create({ data: { username: `approver${Date.now()}`, name: 'Ravi Menon', role: 'SUPERVISOR', passwordHash: await hashSecret(APPROVER_PW) } });
  approverId = u.id;
  sup = request.agent(app);
  adm = request.agent(app);
  await post(sup, '/auth/login', { username: u.username!, password: APPROVER_PW }).expect(200);
  await post(adm, '/auth/login', { username: 'scientist2', password: config.demo.adminPassword }).expect(200);
});

describe('batch approval', () => {
  it('is for signed-in scientists only', async () => {
    const b = await submittedBatch();
    const r = await post(request.agent(app), `/supervisor/batches/${b.id}/decision`, { decision: 'APPROVE', password: APPROVER_PW }).expect(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SUBMITTED');
  });

  it('needs the supervisor’s own password, and records a wrong one', async () => {
    const b = await submittedBatch();
    const r = await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'APPROVE', password: 'not-my-password' }).expect(403);
    expect(r.body.code).toBe('WRONG_PASSWORD');
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SUBMITTED');
    const failed = await prisma.auditEvent.findFirst({ where: { batchId: b.id, type: 'AUTH_FAILED' } });
    expect(failed?.details).toMatchObject({ reason: 'WRONG_PASSWORD' });
  });

  it('approves a submitted batch, records who and when, and audits it', async () => {
    const b = await submittedBatch();
    const r = await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'APPROVE', password: APPROVER_PW, note: 'Checked against the process order', version: b.version }).expect(200);
    expect(r.body.status).toBe('APPROVED');
    const after = await prisma.batch.findUniqueOrThrow({ where: { id: b.id } });
    expect(after).toMatchObject({ status: 'APPROVED', approvedById: approverId, approvalNote: 'Checked against the process order', rejectedAt: null, version: b.version + 1 });
    expect(after.approvedAt).not.toBeNull();
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { batchId: b.id, type: 'BATCH_APPROVED', outcome: 'SUCCESS' } });
    expect(ev).toMatchObject({ userId: approverId, role: 'SUPERVISOR', prevState: 'SUBMITTED', newState: 'APPROVED' });
    expect(ev.details).toMatchObject({ batchNo: b.batchNo, passwordConfirmed: true });
    // The supervisor's batch view and the report carry the decision.
    const d = (await sup.get(`/api/supervisor/batches/${b.id}`).expect(200)).body;
    expect(d.decision).toMatchObject({ kind: 'APPROVED', by: 'Ravi Menon', note: 'Checked against the process order' });
    // Decided once only.
    expect((await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'REJECT', password: APPROVER_PW, note: 'Changed my mind' }).expect(409)).body.code).toBe('NOT_SUBMITTED');
  });

  it('refuses a stale screen', async () => {
    const b = await submittedBatch();
    expect((await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'APPROVE', password: APPROVER_PW, version: b.version + 5 }).expect(409)).body.code).toBe('STALE');
  });

  it('needs a reason to reject, and stores it', async () => {
    const b = await submittedBatch();
    expect((await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'REJECT', password: APPROVER_PW, note: ' ' }).expect(400)).body.code).toBe('REASON_REQUIRED');
    await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'REJECT', password: APPROVER_PW, note: 'Wrong lot of bergamot at #2' }).expect(200);
    const after = await prisma.batch.findUniqueOrThrow({ where: { id: b.id } });
    expect(after).toMatchObject({ status: 'REJECTED', rejectedById: approverId, rejectReason: 'Wrong lot of bergamot at #2', approvedAt: null });
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { batchId: b.id, type: 'BATCH_REJECTED', outcome: 'SUCCESS' } });
    expect(ev.details).toMatchObject({ note: 'Wrong lot of bergamot at #2' });
  });

  it('never approves a training record as production (it may still be rejected)', async () => {
    const b = await submittedBatch({ simulated: true });
    expect((await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'APPROVE', password: APPROVER_PW }).expect(409)).body.code).toBe('TRAINING_RECORD');
    const refused = await prisma.auditEvent.findFirstOrThrow({ where: { batchId: b.id, type: 'BATCH_APPROVED', outcome: 'REJECTED' } });
    expect(refused.details).toMatchObject({ reason: 'TRAINING_RECORD' });
    await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'REJECT', password: APPROVER_PW, note: 'Training run only' }).expect(200);
  });

  it('does not approve while a problem is still open', async () => {
    const b = await submittedBatch({ openProblem: true });
    expect((await post(sup, `/supervisor/batches/${b.id}/decision`, { decision: 'APPROVE', password: APPROVER_PW }).expect(409)).body.code).toBe('OPEN_PROBLEM');
  });

  it('counts pending approvals over every job, not only the newest rows', async () => {
    const b = await submittedBatch();
    const o = (await sup.get('/api/supervisor/overview').expect(200)).body;
    const pending = await prisma.batch.count({ where: { status: 'SUBMITTED' } });
    expect(o.counts.SUBMITTED).toBe(pending);
    expect(o.batches.some((x: { id: string }) => x.id === b.id)).toBe(true);
  });
});

describe('daily scale check reads the scale itself', () => {
  it('needs the zero first, and refuses a disconnected scale', async () => {
    const st3 = await prisma.station.findUniqueOrThrow({ where: { code: 'ST-03' } });
    expect((await post(sup, `/supervisor/stations/${st3.id}/validate-scale`, { referenceMg: 200_000, observedMg: 200_000 }).expect(409)).body.code).toBe('ZERO_NEEDED');
    expect((await post(sup, `/supervisor/stations/${st3.id}/scale-zero`).expect(409)).body.code).toBe('SCALE_DISCONNECTED');
  });

  it('records a simulated check on a training station from two readings', async () => {
    const st2 = await prisma.station.findUniqueOrThrow({ where: { code: 'ST-02' } });
    const z = (await post(sup, `/supervisor/stations/${st2.id}/scale-zero`).expect(200)).body;
    expect(typeof z.zeroMg).toBe('number');
    const r = (await post(sup, `/supervisor/stations/${st2.id}/validate-scale`, { referenceMg: 200_000, note: 'Test weight set W-1' }).expect(200)).body;
    expect(r).toMatchObject({ pass: true, simulated: true, observedMg: 200_000 });
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { stationId: st2.id, type: 'SCALE_VALIDATION' }, orderBy: { seqNo: 'desc' } });
    expect(ev.details).toMatchObject({ source: 'SIMULATED', zeroMg: z.zeroMg, referenceMg: 200_000 });
    // The zero is used once.
    expect((await post(sup, `/supervisor/stations/${st2.id}/validate-scale`, { referenceMg: 200_000 }).expect(409)).body.code).toBe('ZERO_NEEDED');
  });
});

describe('letterhead and audit export', () => {
  it('serves the configured letterhead to signed-in users only', async () => {
    const c = (await sup.get('/api/company').expect(200)).body;
    expect(c).toEqual(config.company);
    expect(c.name).toBeTruthy();
    await request(app).get('/api/company').expect(401);
  });

  it('exports every matching audit event as CSV, for signed-in scientists', async () => {
    const total = await prisma.auditEvent.count({ where: { type: 'BATCH_APPROVED' } });
    const r = await adm.get('/api/admin/audit.csv?type=BATCH_APPROVED').expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('seqNo,at,type,outcome,user,role,station,batchNo,prevState,newState,sourceDevice,details');
    expect(lines.length - 1).toBe(total);
    await sup.get('/api/admin/audit.csv').expect(200);
    await request.agent(app).get('/api/admin/audit.csv').expect(401);
  });
});
