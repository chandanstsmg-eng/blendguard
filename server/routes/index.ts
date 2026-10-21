import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db/prisma.js';
import { config } from '../config.js';
import { deviceOf, operatorCtx, requireSupervisor, supervisorActor } from '../middleware/context.js';
import { AppError, forbidden, notFound, unauthenticated } from '../utils/errors.js';
import * as auth from '../services/auth.service.js';
import * as batch from '../services/batch.service.js';
import * as sup from '../services/supervisor.service.js';
import * as admin from '../services/admin.service.js';
import * as imports from '../services/import.service.js';
import * as tts from '../services/tts.service.js';
import * as stationSetup from '../services/station-setup.service.js';
import { revokeSocketAccess } from '../services/realtime.service.js';
import { buildRun, jobsFor } from '../services/run.service.js';
import { bindStation, endSession, toStationInfo } from '../services/session.service.js';
import { hasSimulator, listSerialPorts, readScale, simulate } from '../services/scale.service.js';
import { auditNow } from '../services/audit.service.js';
import { PROCESS_ORDER_FIELDS, type MeResponse, type SimBottle } from '../../shared/types.js';

const api = Router();

// A request whose connection already closed (page refreshed, tab closed, server restarting)
// has no IP; there is nobody left to limit or answer, so it is passed over instead of erroring.
const limitBase = { windowMs: 60_000, standardHeaders: 'draft-8', legacyHeaders: false, skip: (req: { ip?: string }) => !req.ip } as const;
const authLimiter = rateLimit({
  ...limitBase,
  limit: config.isTest ? 10_000 : 30,
  message: { error: 'Too many attempts. Please wait a minute.', code: 'RATE_LIMITED' },
});
const apiLimiter = rateLimit({ ...limitBase, limit: config.isTest ? 100_000 : 1200 });
api.use(apiLimiter);

const operatorCode = z.string().trim().regex(/^\d{3,8}$/, 'operator ID must be numbers only');
const version = z.number().int().nonnegative().optional();
const seqParam = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new AppError(400, 'Invalid step.', 'BAD_STEP');
  return n;
};
const idParam = (v: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(v)) throw notFound('Job');
  return v;
};

api.get('/health', (_req, res) => res.json({ ok: true, app: 'BlendGuard', time: new Date().toISOString() }));

// ─────────────────────────────────── identity ───────────────────────────────────

api.get('/auth/me', (req, res) => {
  const body: MeResponse = { user: req.user ?? null, station: req.station ? toStationInfo(req.station) : null };
  res.json(body);
});

api.post('/auth/webauthn/options', authLimiter, async (req, res) => {
  const body = z.object({ operatorCode: operatorCode.optional() }).parse(req.body ?? {});
  res.json(await auth.loginOptions({ station: req.station ?? null, device: deviceOf(req) }, body.operatorCode));
});

api.post('/auth/webauthn/verify', authLimiter, async (req, res) => {
  const body = z.object({ response: z.any(), modality: z.enum(['fingerprint', 'face']) }).parse(req.body);
  const user = await auth.loginVerify(res, { station: req.station ?? null, device: deviceOf(req) }, body.response, body.modality);
  res.json({ user });
});

api.post('/auth/pin', authLimiter, async (req, res) => {
  const body = z.object({ operatorCode, pin: z.string().regex(/^\d{4,8}$/) }).parse(req.body);
  const user = await auth.loginWithPin(res, { station: req.station ?? null, device: deviceOf(req) }, body.operatorCode, body.pin);
  res.json({ user });
});

api.post('/auth/assisted', authLimiter, async (req, res) => {
  const body = z.object({ operatorCode, username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
  const user = await auth.loginAssisted(res, { station: req.station ?? null, device: deviceOf(req) }, body.operatorCode, body.username, body.password);
  res.json({ user });
});

api.post('/auth/login', authLimiter, async (req, res) => {
  const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200) }).parse(req.body);
  const user = await auth.loginSupervisor(res, { station: req.station ?? null, device: deviceOf(req) }, body.username, body.password);
  res.json({ user });
});

api.post('/auth/signoff', authLimiter, async (req, res) => {
  if (!req.user) throw unauthenticated();
  const body = z.object({ username: z.string().min(1).max(60), password: z.string().min(1).max(200), batchId: z.string().uuid() }).parse(req.body);
  res.json(await auth.supervisorSignoff({ station: req.station ?? null, device: deviceOf(req) }, body.username, body.password, body.batchId));
});

api.post('/auth/logout', async (req, res) => {
  if (req.user) await auditNow({ type: 'SIGN_OUT', outcome: 'SUCCESS', userId: req.user.id, role: req.user.role, stationId: req.station?.id ?? null, sourceDevice: deviceOf(req) });
  await endSession(res, req.sessionId);
  if (req.sessionId) revokeSocketAccess({ sessionId: req.sessionId });
  res.json({ ok: true });
});

api.post('/me/language', async (req, res) => {
  if (!req.user) throw unauthenticated();
  const { language } = z.object({ language: z.enum(['en', 'hi', 'ml']) }).parse(req.body);
  await db().user.update({ where: { id: req.user.id }, data: { language } });
  res.json({ ok: true });
});

/** A spoken instruction with a number in it, in a natural voice (see tts.service). */
// Online voice is off unless VOICE_ONLINE=1: spoken phrases contain formula quantities, which
// must not leave the plant. The stations speak from the recorded clips instead (src/lib/audio.ts).
api.get('/tts', async (req, res) => {
  if (!req.user) throw unauthenticated();
  if (process.env.VOICE_ONLINE !== '1') throw notFound('Online voice');
  const q = z.object({ lang: z.enum(['en', 'hi', 'ml']), text: z.string().trim().min(1).max(300) }).parse(req.query);
  const audio = await tts.speech(q.lang, q.text);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type('audio/mpeg').send(audio);
});

// ─────────────────────────────────── operator ───────────────────────────────────

api.get('/operator/jobs', async (req, res) => {
  const ctx = operatorCtx(req);
  res.json(await jobsFor(ctx.user.id, ctx.station.id, req.query.history === '1'));
});

api.get('/batches/:id/run', async (req, res) => {
  const ctx = operatorCtx(req);
  const id = idParam(req.params.id);
  const b = await db().batch.findUnique({ where: { id }, select: { stationId: true, operatorId: true, backupOperatorId: true } });
  if (!b) throw notFound('Job');
  if (b.stationId !== ctx.station.id) throw forbidden('This job belongs to another station.', 'WRONG_STATION');
  if (b.operatorId !== ctx.user.id && b.backupOperatorId !== ctx.user.id) throw forbidden('This job is not assigned to you.', 'NOT_ASSIGNED');
  res.json(await buildRun(id));
});

const withVersion = z.object({ version }).passthrough();

api.post('/batches/:id/start', async (req, res) => {
  const { version } = withVersion.parse(req.body ?? {});
  res.json((await batch.startJob(operatorCtx(req), idParam(req.params.id), version)).run);
});

api.post('/batches/:id/pause', async (req, res) => {
  const { version } = withVersion.parse(req.body ?? {});
  res.json((await batch.pauseJob(operatorCtx(req), idParam(req.params.id), version)).run);
});

api.post('/batches/:id/resume', async (req, res) => {
  const body = z.object({ version, equipmentChecked: z.boolean() }).parse(req.body);
  res.json((await batch.resumeJob(operatorCtx(req), idParam(req.params.id), body.equipmentChecked, body.version)).run);
});

api.post('/batches/:id/recovery-check', async (req, res) => {
  res.json((await batch.confirmRecovery(operatorCtx(req), idParam(req.params.id))).run);
});

api.post('/batches/:id/steps/:seq/found', async (req, res) => {
  const { version } = withVersion.parse(req.body ?? {});
  res.json((await batch.markFound(operatorCtx(req), idParam(req.params.id), seqParam(req.params.seq), version)).run);
});

api.post('/batches/:id/steps/:seq/scan', async (req, res) => {
  const body = z.object({ version, barcode: z.string().max(200), source: z.enum(['scanner', 'simulator']) }).parse(req.body);
  res.json(await batch.scanBarcode(operatorCtx(req), idParam(req.params.id), seqParam(req.params.seq), body.barcode, body.source, body.version));
});

api.post('/batches/:id/steps/:seq/tare', async (req, res) => {
  const body = z.object({ version, containerNo: z.number({ error: 'Choose container 1, 2 or 3.' }).int().min(1).max(3) }).parse(req.body ?? {});
  res.json(await batch.tareScale(operatorCtx(req), idParam(req.params.id), seqParam(req.params.seq), body.containerNo, body.version));
});

api.post('/batches/:id/steps/:seq/accept', async (req, res) => {
  const { version } = withVersion.parse(req.body ?? {});
  res.json(await batch.acceptWeight(operatorCtx(req), idParam(req.params.id), seqParam(req.params.seq), version));
});

// The operator sends the current bottle for lab test (before zeroing), and marks it arrived when it comes back.
api.post('/batches/:id/steps/:seq/lab-skip', async (req, res) => {
  const { version } = withVersion.parse(req.body ?? {});
  res.json((await batch.operatorSkipForLab(operatorCtx(req), idParam(req.params.id), seqParam(req.params.seq), version)).run);
});

api.post('/batches/:id/steps/:seq/lab-arrived', async (req, res) => {
  const { version } = withVersion.parse(req.body ?? {});
  res.json((await batch.operatorLabArrived(operatorCtx(req), idParam(req.params.id), seqParam(req.params.seq), version)).run);
});

api.post('/batches/:id/submit', async (req, res) => {
  const { version } = withVersion.parse(req.body ?? {});
  res.json((await batch.submitJob(operatorCtx(req), idParam(req.params.id), version)).run);
});

api.post('/batches/:id/supervisor-action', async (req, res) => {
  const body = z
    .object({ version, token: z.string().min(10).max(2000), action: z.enum(['ALLOW_REWEIGH', 'ACCEPT_VESSEL', 'HOLD_BATCH', 'RELEASE_HOLD', 'CLOSE_CALL']), note: z.string().max(500).default('') })
    .parse(req.body);
  res.json((await batch.supervisorAction(operatorCtx(req), idParam(req.params.id), body.token, body.action, body.note, body.version)).run);
});

api.post('/calls', async (req, res) => {
  const body = z
    .object({ batchId: z.string().uuid().nullish(), seq: z.number().int().positive().nullish(), reason: z.enum(['CANNOT_FIND', 'HELP', 'SCALE_PROBLEM', 'WRONG_BOTTLE', 'OVERWEIGHT', 'VESSEL_CHANGED', 'NO_JOB', 'OTHER']) })
    .parse(req.body);
  res.json(await batch.callSupervisor(operatorCtx(req), body));
});

api.get('/station/call', async (req, res) => {
  if (!req.station) return res.json(null);
  const call = await db().supervisorCall.findFirst({ where: { stationId: req.station.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, orderBy: { createdAt: 'desc' } });
  res.json(call ? { id: call.id, status: call.status, reason: call.reason } : null);
});

// ─────────────────────────────── station equipment ───────────────────────────────

api.get('/station/scale', (req, res) => {
  if (!req.station) throw forbidden('This computer is not set up as a mixing station.', 'NO_STATION');
  if (!req.user) throw unauthenticated();
  res.json(readScale(req.station.id));
});

const simAction = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pour'), mg: z.number().int().positive().max(2_000_000) }),
  z.object({ action: z.literal('remove'), mg: z.number().int().positive().max(2_000_000) }),
  z.object({ action: z.literal('vessel'), on: z.boolean() }),
  z.object({ action: z.literal('connect'), on: z.boolean() }),
  z.object({ action: z.literal('empty') }),
]);

/** Training simulator only. Refused on stations with a real scale. */
api.post('/station/scale/sim', async (req, res) => {
  const ctx = operatorCtx(req);
  if (ctx.station.scaleMode !== 'SIMULATED' || !hasSimulator(ctx.station.id)) throw forbidden('This station uses a real scale.', 'NOT_TRAINING');
  const a = simAction.parse(req.body);
  const state = simulate(ctx.station.id, a);
  await batch.auditSimAction(ctx, a);
  res.json(state);
});

/** Bottles the training scan simulator can offer for the current step. */
api.get('/batches/:id/sim-bottles', async (req, res) => {
  const ctx = operatorCtx(req);
  if (ctx.station.scaleMode !== 'SIMULATED') return res.json([]);
  const b = await db().batch.findUnique({ where: { id: idParam(req.params.id) }, include: { steps: { orderBy: { seq: 'asc' } } } });
  if (!b || b.stationId !== ctx.station.id) throw notFound('Job');
  const step = b.steps.find((s) => s.status === 'CURRENT');
  if (!step) return res.json([]);
  const ing = await db().ingredient.findUniqueOrThrow({ where: { id: step.ingredientId }, include: { lots: true } });
  const out: SimBottle[] = [];
  const good = ing.lots.find((l) => l.status === 'RELEASED' && (!l.expiresOn || l.expiresOn.getTime() > Date.now()));
  if (ing.lotTracked && good) out.push({ barcode: good.barcode, label: `${ing.name} · lot ${good.lotNumber}`, hint: 'correct' });
  else if (!ing.lotTracked && ing.barcode) out.push({ barcode: ing.barcode, label: ing.name, hint: 'correct' });
  const otherStep = b.steps.find((s) => s.ingredientId !== step.ingredientId && s.seq > step.seq) ?? b.steps.find((s) => s.ingredientId !== step.ingredientId);
  if (otherStep) {
    const other = await db().ingredient.findUnique({ where: { id: otherStep.ingredientId }, include: { lots: true } });
    const code = other?.lotTracked ? other.lots[0]?.barcode : other?.barcode;
    if (other && code) out.push({ barcode: code, label: other.name, hint: 'wrong' });
  }
  for (const l of ing.lots.filter((l) => l.status !== 'RELEASED' || (l.expiresOn && l.expiresOn.getTime() <= Date.now()))) {
    out.push({ barcode: l.barcode, label: `${ing.name} · lot ${l.lotNumber}`, hint: 'lot-problem' });
  }
  res.json(out);
});

/** Bottle photo for the operator screens and the setup screens. */
api.get('/ingredients/:id/photo', async (req, res) => {
  if (!req.user) throw unauthenticated();
  const photo = await admin.ingredientPhoto(idParam(req.params.id));
  // The URL carries the upload time, so a cached copy is never stale.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.type(photo.type).send(photo.bytes);
});

// ───────────────────────── scientist: floor and setup screens ─────────────────────────
// Setting up a PC as a station, unlocking an operator and registering a fingerprint
// are reached from both the floor screens (/supervisor) and the setup screens (/admin).

const staff = Router();

staff.post('/stations/:id/bind', async (req, res) => {
  const actor = supervisorActor(req);
  const id = idParam(req.params.id);
  const st = await db().station.findUnique({ where: { id } });
  if (!st) throw notFound('Station');
  await bindStation(res, id);
  await auditNow({ type: 'STATION_BOUND', outcome: 'SUCCESS', ...actor, stationId: id, details: { station: st.code, ip: req.ip } });
  res.json({ ok: true });
});

staff.post('/operators/:id/webauthn/options', async (req, res) => {
  supervisorActor(req);
  res.json(await auth.registrationOptions(idParam(req.params.id)));
});

staff.post('/operators/:id/webauthn/verify', async (req, res) => {
  const actor = supervisorActor(req);
  const body = z.object({ response: z.any(), label: z.string().max(60).default('') }).parse(req.body);
  await auth.registrationVerify({ id: actor.userId!, role: actor.role! }, { station: req.station ?? null, device: deviceOf(req) }, idParam(req.params.id), body.response, body.label);
  res.json({ ok: true });
});

staff.post('/operators/:id/unlock', async (req, res) => {
  await sup.unlockUser(supervisorActor(req), idParam(req.params.id));
  res.json({ ok: true });
});

staff.post('/credentials/:id/revoke', async (req, res) => {
  const id = String(req.params.id);
  if (!/^[A-Za-z0-9_-]{8,512}$/.test(id)) throw notFound('Registered device');
  await sup.revokeCredential(supervisorActor(req), id);
  res.json({ ok: true });
});

api.use('/supervisor', staff);
api.use('/admin', staff);

/** The plant's letterhead for batch records and printed logs (COMPANY_* in .env). */
api.get('/company', (req, res) => {
  if (!req.user) throw unauthenticated();
  res.json(config.company);
});

// ─────────────────────────────────── supervisor ───────────────────────────────────

const svr = Router();
svr.use(requireSupervisor);

svr.get('/overview', async (_req, res) => res.json(await sup.overview()));

svr.get('/report', async (req, res) => {
  const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  res.json(await sup.shiftReport(date));
});

svr.get('/activity', async (req, res) => {
  const q = z.object({ operatorId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  res.json(await sup.operatorActivity(q.operatorId, q.date));
});

// Revision holds the process order number when the formula came from one (up to 20 characters).
const importMeta = z.object({ perfumeName: z.string().max(80), code: z.string().max(40), revision: z.string().max(20), sopNumber: z.string().max(40) });
const importFile = z.object({ fileName: z.string().min(1).max(200), csv: z.string().min(1).max(200_000) });

svr.post('/formulas/import/preview', async (req, res) => {
  const body = importFile.extend({ meta: importMeta.partial().optional() }).parse(req.body);
  res.json(await imports.previewImport(body.csv, body.meta));
});

const MAX_PDF_BYTES = 6 * 1024 * 1024;
const pdfBase64 = z.string().min(8).max(Math.ceil((MAX_PDF_BYTES * 4) / 3) + 8, 'The PDF is too large (over 6 MB).');
const decodePdf = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const processOrder = z.object(Object.fromEntries(PROCESS_ORDER_FIELDS.map((f) => [f.key, z.string().max(80).default('')]))).nullable();
const draftLine = z.object({
  row: z.number().int().min(0).max(100_000),
  seq: z.string().max(10),
  ingredientCode: z.string().max(40),
  description: z.string().max(200).nullable(),
  quantity: z.string().max(30),
  unit: z.string().max(10),
  tolMinus: z.string().max(30),
  tolPlus: z.string().max(30),
  remarks: z.string().max(200).nullable(),
  storageLocation: z.string().max(40).nullable(),
  sourceBatch: z.string().max(40).nullable(),
  labTest: z.boolean(),
});
const draft = z.object({ meta: importMeta, processOrder, lines: z.array(draftLine).max(300) });

/** A PROCESS ORDER PDF: read it and show what was found. */
svr.post('/formulas/import/pdf', async (req, res) => {
  const body = z.object({ fileName: z.string().min(1).max(200), pdf: pdfBase64 }).parse(req.body);
  res.json(await imports.previewPdf(decodePdf(body.pdf)));
});

/** Check again after the supervisor corrected the preview (header, lines, lab ticks). */
svr.post('/formulas/import/check', async (req, res) => {
  const body = z.object({ draft }).parse(req.body);
  res.json(await imports.checkDraft(body.draft as imports.Draft));
});

svr.post('/formulas/import', async (req, res) => {
  const actor = supervisorActor(req);
  // A checked draft (PDF, or CSV with on-screen changes such as lab ticks)…
  if (req.body?.draft) {
    const body = z.object({ fileName: z.string().min(1).max(200), draft, csv: z.string().max(200_000).optional(), pdf: pdfBase64.optional() }).parse(req.body);
    const p = await imports.checkDraft(body.draft as imports.Draft);
    return res.json(await imports.approveDraft(actor, body.fileName, p, { csv: body.csv, pdf: body.pdf ? decodePdf(body.pdf) : undefined }));
  }
  // …or the CSV exactly as uploaded.
  const body = importFile.extend({ meta: importMeta }).parse(req.body);
  res.json(await imports.approveImport(actor, body.fileName, body.csv, body.meta));
});

/** One approved formula's lines, for choosing which ingredients go for lab test when assigning. */
svr.get('/formulas/:id', async (req, res) => {
  res.json(await sup.formulaDetail(idParam(req.params.id)));
});

svr.get('/formulas/import/template.csv', (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="production-instruction-template.csv"');
  res.type('text/csv').send(imports.TEMPLATE_CSV);
});

svr.post('/jobs', async (req, res) => {
  const body = z
    .object({
      formulaId: z.string().uuid(),
      operatorId: z.string().uuid(),
      stationId: z.string().uuid(),
      backupOperatorId: z.string().uuid().nullish(),
      plannedStart: z.string().datetime({ offset: true }).nullish(),
      instructions: z.string().max(500).nullish(),
      /** Ingredients that go for lab test: skipped from the start, added at the end. */
      labSeqs: z.array(z.number().int().min(1).max(500)).max(300).default([]),
    })
    .parse(req.body);
  res.json(await sup.assignJob(supervisorActor(req), body));
});

svr.get('/batches/:id', async (req, res) => {
  res.json(await sup.batchDetail(idParam(req.params.id)));
});

// Ingredients waiting for a lab report: skip now, release when the lab ingredient arrives.
svr.post('/batches/:id/steps/:seq/skip', async (req, res) => {
  supervisorActor(req);
  const body = z.object({ version, note: z.string().max(500).default('') }).parse(req.body ?? {});
  res.json((await batch.skipIngredient(req.user!, deviceOf(req), idParam(req.params.id), seqParam(req.params.seq), body.note, body.version)).run);
});

svr.post('/batches/:id/steps/:seq/lab-release', async (req, res) => {
  supervisorActor(req);
  const body = z.object({ version, note: z.string().max(500).default('') }).parse(req.body ?? {});
  res.json((await batch.releaseLabIngredient(req.user!, deviceOf(req), idParam(req.params.id), seqParam(req.params.seq), body.note, body.version)).run);
});

svr.post('/calls/:id/:status', async (req, res) => {
  const status = req.params.status === 'ack' ? 'ACKNOWLEDGED' : req.params.status === 'close' ? 'CLOSED' : null;
  if (!status) throw notFound('Action');
  await sup.setCallStatus(supervisorActor(req), idParam(req.params.id), status);
  res.json({ ok: true });
});

// Approve or reject a batch the operator has sent, signed with the supervisor's own password.
svr.post('/batches/:id/decision', async (req, res) => {
  const body = z
    .object({ version, decision: z.enum(['APPROVE', 'REJECT']), password: z.string().min(1, 'Enter your password').max(200), note: z.string().max(500).default('') })
    .parse(req.body);
  res.json(await sup.decideBatch(supervisorActor(req), idParam(req.params.id), body));
});

// Daily scale check, read from the scale itself: 1) zero with the pan empty, 2) the reference weight.
svr.post('/stations/:id/scale-zero', async (req, res) => {
  res.json(await sup.readScaleZero(supervisorActor(req), idParam(req.params.id)));
});

svr.post('/stations/:id/validate-scale', async (req, res) => {
  const body = z.object({ referenceMg: z.number().int().positive().max(100_000_000), note: z.string().max(300).default('') }).parse(req.body);
  res.json(await sup.validateScale(supervisorActor(req), idParam(req.params.id), body.referenceMg, body.note));
});

api.use('/supervisor', svr);

// ──────────────────── scientist: setup (users, stations, ingredients, audit) ────────────────────
// Kept under /api/admin; there is no separate administrator role any more.

const adm = Router();
adm.use(requireSupervisor);

const lang = z.enum(['en', 'hi', 'ml']);
const name = z.string().trim().min(2).max(80);

adm.get('/users', async (_req, res) => res.json(await admin.listUsers()));

adm.post('/users', async (req, res) => {
  const body = z
    .object({
      role: z.enum(['OPERATOR', 'SUPERVISOR']),
      name,
      language: lang.default('en'),
      operatorCode: operatorCode.nullish(),
      pin: z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 numbers').nullish(),
      username: z.string().trim().regex(/^[a-zA-Z0-9._-]{3,40}$/, 'username: 3–40 letters, numbers, dot, dash').nullish(),
      password: z.string().min(8, 'password: at least 8 characters').max(200).nullish(),
      stationIds: z.array(z.string().uuid()).max(50).default([]),
    })
    .parse(req.body);
  res.json(await admin.createUser(supervisorActor(req), body));
});

adm.patch('/users/:id', async (req, res) => {
  const body = z
    .object({ name, language: lang, active: z.boolean(), stationIds: z.array(z.string().uuid()).max(50) })
    .partial()
    .strict()
    .parse(req.body);
  await admin.updateUser(supervisorActor(req), idParam(req.params.id), body);
  res.json({ ok: true });
});

adm.post('/users/:id/secret', async (req, res) => {
  const { secret } = z.object({ secret: z.string().min(4).max(200) }).parse(req.body);
  await admin.resetSecret(supervisorActor(req), idParam(req.params.id), secret);
  res.json({ ok: true });
});

adm.get('/stations', async (_req, res) => res.json(await admin.listStations()));

adm.post('/stations', async (req, res) => {
  const body = z
    .object({
      code: z.string().trim().regex(/^[A-Za-z0-9-]{2,12}$/, 'Code: 2 to 12 letters, numbers or dashes (e.g. ST-04)'),
      name: z.string().trim().min(2, 'Enter a name').max(60),
    })
    .strict()
    .parse(req.body);
  res.json(await stationSetup.createStation(supervisorActor(req), body));
});

/** COM ports on the server PC (for a scale plugged into the server itself). */
adm.get('/serial-ports', async (_req, res) => {
  res.json(await listSerialPorts().catch(() => []));
});

adm.put('/stations/:id/scale', async (req, res) => {
  const body = z
    .object({
      scaleMode: z.enum(['SIMULATED', 'SERIAL', 'BRIDGE']),
      scaleModel: z.string().trim().min(1, 'Enter the scale model').max(80),
      scalePort: z.string().trim().regex(/^(COM\d{1,3}|\/dev\/[\w/.-]+)$/i, 'Port: for example COM3').nullable(),
      scaleBaud: z.union([z.literal(1200), z.literal(2400), z.literal(4800), z.literal(9600), z.literal(19200), z.literal(38400), z.literal(57600), z.literal(115200)]),
      scaleFraming: z.enum(['8N1', '7E1', '7O1', '8E1', '8O1', '7N2', '8N2']),
      scaleResolutionMg: z.number().int().min(1).max(10_000),
      scaleUncertaintyMg: z.number().int().min(1).max(100_000),
      vesselDriftLimitMg: z.number().int().min(0).max(100_000),
    })
    .partial()
    .strict()
    .parse(req.body);
  if (body.scalePort && /^com/i.test(body.scalePort)) body.scalePort = body.scalePort.toUpperCase();
  await stationSetup.updateScaleSettings(supervisorActor(req), idParam(req.params.id), body);
  res.json({ ok: true });
});

adm.post('/stations/:id/bridge-key', async (req, res) => {
  res.json(await stationSetup.createBridgeKey(supervisorActor(req), idParam(req.params.id)));
});

adm.patch('/stations/:id', async (req, res) => {
  const body = z
    .object({
      allowFingerprint: z.boolean(),
      allowFace: z.boolean(),
      allowPin: z.boolean(),
      allowAssisted: z.boolean(),
      defaultLanguage: lang,
      audioEnabled: z.boolean(),
      audioVolume: z.number().int().min(0).max(100),
      allowPause: z.boolean(),
      autoAccept: z.boolean(),
      idleMinutes: z.number().int().min(0).max(240),
    })
    .partial()
    .strict()
    .parse(req.body);
  res.json(await sup.updateStation(supervisorActor(req), idParam(req.params.id), body));
});

adm.get('/ingredients', async (_req, res) => res.json(await admin.listIngredients()));

adm.post('/ingredients', async (req, res) => {
  const body = z
    .object({
      code: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'Code: up to 40 letters, numbers, dot, dash or underscore (e.g. RM-1016)'),
      name: z.string().trim().min(1, 'Enter the ingredient name').max(80, 'Name: at most 80 characters'),
      // Same rule the scan screen uses, so every saved barcode can actually be scanned.
      barcode: z.string().trim().min(1, 'Enter the barcode on the bottle').max(128).regex(/^[\x20-\x7E]+$/, 'Barcode: letters, numbers and symbols only'),
    })
    .strict()
    .parse(req.body);
  res.json(await admin.createIngredient(supervisorActor(req), body));
});

adm.patch('/ingredients/:id', async (req, res) => {
  const body = z
    .object({
      colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
      rackCode: z.string().max(10).nullable(),
      bin: z.number().int().positive().max(999).nullable(),
      ppe: z.array(z.enum(admin.PPE)).max(admin.PPE.length),
      hazards: z.array(z.enum(admin.HAZARDS)).max(admin.HAZARDS.length),
      handling: z.array(z.string().trim().min(1).max(200)).max(10),
    })
    .partial()
    .strict()
    .parse(req.body);
  await admin.updateIngredient(supervisorActor(req), idParam(req.params.id), body);
  res.json({ ok: true });
});

adm.put('/ingredients/:id/photo', async (req, res) => {
  const body = z.object({ type: z.string().max(40).nullable(), data: z.string().max(2_100_000).nullable() }).parse(req.body);
  await admin.setIngredientPhoto(supervisorActor(req), idParam(req.params.id), body.type, body.data);
  res.json({ ok: true });
});

adm.get('/formulas', async (_req, res) => res.json(await admin.listFormulas()));

adm.get('/audit', async (req, res) => {
  const q = z
    .object({
      type: z.string().max(60).optional(),
      outcome: z.enum(['SUCCESS', 'REJECTED', 'FAILED', 'INFO']).optional(),
      userId: z.string().uuid().optional(),
      stationId: z.string().uuid().optional(),
      batchNo: z.string().max(40).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      before: z.string().regex(/^\d+$/).optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
    })
    .parse(req.query);
  res.json(await admin.auditTrail(q));
});

/** Every audit event matching the filters, as CSV (not only the rows loaded on screen). */
adm.get('/audit.csv', async (req, res) => {
  const q = z
    .object({
      type: z.string().max(60).optional(),
      outcome: z.enum(['SUCCESS', 'REJECTED', 'FAILED', 'INFO']).optional(),
      userId: z.string().uuid().optional(),
      stationId: z.string().uuid().optional(),
      batchNo: z.string().max(40).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    })
    .parse(req.query);
  const { exportAuditCsv } = await import('../services/audit-export.service.js');
  const actor = supervisorActor(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="blendguard-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  const rows = await exportAuditCsv(q, (chunk) => res.write(chunk));
  res.end();
  await auditNow({ type: 'AUDIT_EXPORTED', outcome: 'SUCCESS', ...actor, details: { rows, filters: q } });
});

api.use('/admin', adm);

api.use((_req, _res, next) => next(new AppError(404, 'Not found.', 'NOT_FOUND')));

export default api;
