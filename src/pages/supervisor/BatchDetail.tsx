import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileText, FlaskConical, Loader2, PackageCheck, ShieldCheck, SkipForward, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useMe } from '@/hooks/useMe';
import { api, ApiError } from '@/lib/api';
import { cn, fmtDateTime, pad2, qtyInUnit } from '@/lib/utils';
import { describeDeviation, downloadWorkReport, openWorkReport, type ReportExtras } from '@/lib/workReport';
import { ConfirmDialog, ErrorBox, Field, inputCls } from '../admin/ui';
import { DEVIATION_LABEL, RESOLUTION_LABEL, STAGE_LABEL, STATUS_LABEL, WARN_TEXT, statusTone } from './labels';
import type { BatchDetail as Detail } from './types';
import type { RunStep } from '@shared/types';

/** Jobs where ingredients can still be skipped for the lab or released. */
const LAB_EDITABLE = new Set(['ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'ON_HOLD', 'AWAITING_LAB']);
/** Jobs the operator has sent: the final report is ready. */
const REPORT_READY = new Set(['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CORRECTION']);

const STEP_LABEL: Record<RunStep['status'], string> = {
  LOCKED: 'To do',
  CURRENT: 'Operator is on it',
  COMPLETED: 'Weighed',
  ON_HOLD: 'On hold',
  SKIPPED: 'Skipped, waiting for lab',
};

/** "400.00 G": a quantity in the line's own unit, to the scale's resolution. */
const qty = (mg: number, s: RunStep, res: number) => `${qtyInUnit(mg, s.uom, res)} ${(s.uom ?? 'G').toUpperCase()}`;

/**
 * One job: every ingredient with its state. The supervisor skips an ingredient
 * that must wait for its lab report, releases it when the lab ingredient
 * arrives, opens the final report once the operator has sent the job, and
 * approves or rejects it with their password.
 */
export function BatchDetail({ batchId, onClose }: { batchId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['batch', batchId], queryFn: () => api.get<Detail>(`/supervisor/batches/${batchId}`), enabled: !!batchId, refetchInterval: 15_000 });
  const [action, setAction] = useState<{ kind: 'skip' | 'release'; step: RunStep } | null>(null);
  const [note, setNote] = useState('');
  const [deciding, setDeciding] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [password, setPassword] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['batch', batchId] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };

  const act = useMutation({
    mutationFn: ({ kind, step }: { kind: 'skip' | 'release'; step: RunStep }) =>
      api.post(`/supervisor/batches/${batchId}/steps/${step.seq}/${kind === 'skip' ? 'skip' : 'lab-release'}`, { note, version: q.data?.run.version }),
    onSuccess: () => {
      setAction(null);
      setNote('');
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STALE') void q.refetch();
    },
  });

  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => api.post(`/supervisor/batches/${batchId}/decision`, { decision, password, note: decisionNote, version: q.data?.run.version }),
    onSuccess: () => {
      closeDecision();
      refresh();
    },
    onError: (e) => {
      setPassword('');
      if (e instanceof ApiError && e.code === 'STALE') void q.refetch();
    },
  });

  function submitDecision() {
    if (!deciding) return;
    if (deciding === 'REJECT' && decisionNote.trim().length < 3) return setFormErr('Write why the batch is rejected (at least 3 characters).');
    if (!password) return setFormErr('Enter your password to confirm.');
    setFormErr(null);
    decide.mutate(deciding);
  }

  function closeDecision() {
    setDeciding(null);
    setPassword('');
    setDecisionNote('');
    setFormErr(null);
    decide.reset();
  }

  const d = q.data;
  const r = d?.run;
  const res = d?.station.scaleResolutionMg ?? 10;
  const editable = !!r && LAB_EDITABLE.has(r.status);
  const extras: ReportExtras | undefined = d
    ? { heading: 'Final batch report', lab: d.lab, submittedBy: d.submittedBy, assignedBy: d.assignedBy, assignedAt: d.assignedAt, scale: d.scale, decision: d.decision, resolvedBy: d.resolvedBy }
    : undefined;
  const openReport = () => d && void openWorkReport(d.run, d.operator, d.station, extras);
  const err = act.error as ApiError | null;

  // Who may approve: a supervisor who did not work on the batch; never a training record or one with an open problem.
  const pending = r?.status === 'SUBMITTED';
  const ownBatch = !!me?.user && !!d?.workerIds.includes(me.user.id);
  const openProblems = r?.deviations.filter((x) => !x.resolvedAt).length ?? 0;
  const approveBlock = !r ? null : r.simulated ? 'Training record: weighed on the training simulator, so it cannot be approved as production.' : openProblems ? 'A problem on this batch is still open.' : null;

  return (
    <Dialog
      open={!!batchId}
      onOpenChange={(v) => {
        if (!v) {
          setAction(null);
          setNote('');
          act.reset();
          closeDecision();
          onClose();
        }
      }}
    >
      <DialogContent className="w-[min(1040px,calc(100vw-32px))]">
        {!r || !d ? (
          <>
            <DialogTitle>Job</DialogTitle>
            <div className="grid h-40 place-items-center">{q.isError ? <ErrorBox error={q.error} /> : <Loader2 className="size-8 animate-spin text-navy" />}</div>
          </>
        ) : (
          <>
            <DialogTitle className="flex flex-wrap items-center gap-3 pr-8">
              {r.perfumeName}
              <Badge tone={statusTone(r.status)}>{STATUS_LABEL[r.status]}</Badge>
              {r.simulated && (
                <Badge tone="warn">
                  <FlaskConical /> Training record
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              <span className="font-mono">{r.batchNo}</span> · {r.formulaCode} rev {r.revision} · {d.operator.name} · {d.station.name}
            </DialogDescription>

            {r.status === 'AWAITING_LAB' && (
              <p className={cn('mt-4 flex items-start gap-2 rounded-lg border border-warn bg-warn-100 px-4 py-3', WARN_TEXT)}>
                <FlaskConical className="mt-0.5 size-5 shrink-0" />
                <span>
                  Every other ingredient is weighed. The job is waiting for the lab ingredient{r.steps.filter((s) => s.status === 'SKIPPED').length > 1 ? 's' : ''}. When it arrives, the operator presses <b>Arrived</b> at the station, or you
                  press <b>Lab ingredient arrived</b> here. The operator then adds it and sends the job to you.
                </span>
              </p>
            )}
            {d.decision ? (
              <div className={cn('mt-4 flex items-start gap-2 rounded-lg border px-4 py-3', d.decision.kind === 'APPROVED' ? 'border-ok bg-ok-100 text-ok' : 'border-err bg-err-100 text-err')}>
                {d.decision.kind === 'APPROVED' ? <ShieldCheck className="mt-0.5 size-5 shrink-0" /> : <XCircle className="mt-0.5 size-5 shrink-0" />}
                <div>
                  <div className="font-semibold">
                    {d.decision.kind === 'APPROVED' ? 'Approved' : 'Rejected'} by {d.decision.by ?? 'a scientist'} on {fmtDateTime(d.decision.at)}.
                  </div>
                  {d.decision.note && <div className="text-ink">{d.decision.kind === 'APPROVED' ? 'Note' : 'Reason'}: {d.decision.note}</div>}
                </div>
              </div>
            ) : (
              REPORT_READY.has(r.status) && (
                <p className="mt-4 flex items-center gap-2 rounded-lg border border-ok bg-ok-100 px-4 py-3 text-ok">
                  <CheckCircle2 className="size-5 shrink-0" />
                  <span className="font-semibold">
                    Sent by the operator {fmtDateTime(r.submittedAt)}
                    {d.submittedBy ? ` (${d.submittedBy})` : ''}. The final report is ready{pending ? ' for your review' : ''}.
                  </span>
                </p>
              )
            )}

            <div className="mt-4 overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-left text-sm">
                <thead className="bg-mist text-muted">
                  <tr>
                    {['#', 'Ingredient', 'Required', 'Weighed', 'State', ''].map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {r.steps.map((s) => {
                    const canSkip = editable && (s.status === 'LOCKED' || (s.status === 'CURRENT' && s.tareGrossMg == null && r.status !== 'ON_HOLD'));
                    const canRelease = editable && s.status === 'SKIPPED';
                    return (
                      <tr key={s.id} className={cn('align-top', s.status === 'SKIPPED' && 'bg-warn-100/60', s.status === 'CURRENT' && 'bg-orange-100/50')}>
                        <td className="px-3 py-2 font-mono text-muted">{pad2(s.seq)}</td>
                        <td className="px-3 py-2">
                          <div className="font-semibold">{s.ingredientName}</div>
                          <div className="font-mono text-xs text-muted">
                            {s.ingredientCode}
                            {s.lotNumber ? ` · lot ${s.lotNumber}` : ''}
                          </div>
                          {s.skippedAt && (
                            <div className={cn('mt-1 text-xs', WARN_TEXT)}>
                              Skipped {fmtDateTime(s.skippedAt)}
                              {d.lab[s.seq]?.skippedBy ? ` by ${d.lab[s.seq].skippedBy}` : ''}
                              {s.skipNote ? `: “${s.skipNote}”` : ''}
                              {s.labReleasedAt && (
                                <>
                                  <br />
                                  Lab ingredient arrived {fmtDateTime(s.labReleasedAt)}
                                  {d.lab[s.seq]?.releasedBy ? ` (${d.lab[s.seq].releasedBy})` : ''}
                                </>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular">
                          {qty(s.targetMg, s, res)}
                          <div className="text-xs text-muted">
                            −{qtyInUnit(s.tolMinusMg, s.uom, res)} / +{qtyInUnit(s.tolPlusMg, s.uom, res)}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 tabular font-semibold">
                          {s.acceptedNetMg != null ? qty(s.acceptedNetMg, s, res) : '—'}
                          {s.acceptedAt && <div className="text-xs font-normal text-muted">{fmtDateTime(s.acceptedAt)}</div>}
                        </td>
                        <td className="px-3 py-2">
                          <Badge size="sm" tone={s.status === 'COMPLETED' ? 'ok' : s.status === 'SKIPPED' ? 'warn' : s.status === 'ON_HOLD' ? 'err' : s.status === 'CURRENT' ? 'orange' : 'neutral'}>
                            {s.status === 'CURRENT' ? `${STEP_LABEL.CURRENT} · ${STAGE_LABEL[s.stage] ?? s.stage}` : s.status === 'LOCKED' && s.labReleasedAt ? 'Lab ingredient ready' : STEP_LABEL[s.status]}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {canSkip && (
                            <Button size="sm" variant="outline" onClick={() => (act.reset(), setNote(''), setAction({ kind: 'skip', step: s }))}>
                              <SkipForward /> Skip for lab
                            </Button>
                          )}
                          {canRelease && (
                            <Button size="sm" variant="success" onClick={() => (act.reset(), setNote(''), setAction({ kind: 'release', step: s }))}>
                              <PackageCheck /> Lab ingredient arrived
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {r.deviations.length > 0 && (
              <section className="mt-4 rounded-xl border border-line">
                <h3 className="border-b border-line px-4 py-2 font-display text-lg font-bold text-navy">Problems</h3>
                <ul className="divide-y divide-line">
                  {r.deviations.map((x) => {
                    const t = describeDeviation(x, r.steps, res);
                    const s = r.steps.find((st) => st.seq === x.seq);
                    return (
                      <li key={x.id} className="grid gap-1 px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge size="sm" tone={x.resolvedAt ? 'ok' : 'err'}>
                            {x.resolvedAt ? 'Resolved' : 'Open'}
                          </Badge>
                          <span className="font-semibold">
                            {DEVIATION_LABEL[x.type] ?? x.type}
                            {s ? ` at #${s.seq} ${s.ingredientName}` : ''}
                          </span>
                          <span className="text-muted">{fmtDateTime(x.raisedAt)}</span>
                        </div>
                        {t.problem && <div className="text-ink">{t.problem}</div>}
                        {x.resolvedAt && (
                          <div className="text-muted">
                            {x.resolution ? `${RESOLUTION_LABEL[x.resolution] ?? x.resolution}` : 'Resolved'}
                            {d.resolvedBy[x.id] ? ` by ${d.resolvedBy[x.id]}` : ''} on {fmtDateTime(x.resolvedAt)}.{x.resolutionNote ? ` Note: “${x.resolutionNote}”` : ''}
                          </div>
                        )}
                        {t.resolution && <div className={cn(t.resolution.includes('may be affected') ? cn('font-semibold', WARN_TEXT) : 'text-ink')}>{t.resolution}</div>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {action && (
              <section className="mt-4 rounded-xl border-2 border-navy bg-mist p-4">
                <h3 className="font-display text-xl font-bold text-navy">
                  {action.kind === 'skip' ? 'Skip' : 'Release'} #{action.step.seq} {action.step.ingredientName}
                </h3>
                <p className="mt-1 text-sm text-muted">
                  {action.kind === 'skip'
                    ? 'The operator goes on with the other ingredients and sees this one as skipped. When everything else is done, the job waits for the lab ingredient.'
                    : 'The operator will be asked to add this ingredient. If the job is waiting for the lab, it appears on their screen with a CONTINUE button.'}
                </p>
                <Field label={action.kind === 'skip' ? 'Reason (required, saved in the batch record)' : 'Note (optional, e.g. lab report number)'} className="mt-3">
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder={action.kind === 'skip' ? 'e.g. Waiting for lab report on this lot' : 'e.g. Lab report LR-1043 passed'}
                    className={cn(inputCls, 'h-auto py-2')}
                  />
                </Field>
                {err && <ErrorBox error={err} className="mt-3" />}
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setAction(null)}>
                    Cancel
                  </Button>
                  <Button variant={action.kind === 'skip' ? 'navy' : 'success'} disabled={act.isPending || (action.kind === 'skip' && note.trim().length < 3)} onClick={() => act.mutate(action)}>
                    {act.isPending && <Loader2 className="animate-spin" />}
                    {action.kind === 'skip' ? 'Skip ingredient' : 'Lab ingredient arrived'}
                  </Button>
                </div>
              </section>
            )}

            {pending && (
              <section className="mt-4 rounded-xl border border-line bg-white p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-display text-lg font-bold text-navy">Your review</h3>
                    <p className="text-sm text-muted">
                      {ownBatch
                        ? 'You worked on this batch, so another scientist must review it.'
                        : approveBlock ?? 'Check the weights and the final report, then approve or reject. You confirm with your password.'}
                    </p>
                  </div>
                  <Button variant="outline" className="border-err text-err hover:bg-err-100" disabled={ownBatch} onClick={() => setDeciding('REJECT')}>
                    <XCircle /> Reject…
                  </Button>
                  <Button variant="success" disabled={ownBatch || !!approveBlock} onClick={() => setDeciding('APPROVE')} title={approveBlock ?? undefined}>
                    <ShieldCheck /> Approve…
                  </Button>
                </div>
              </section>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
              {!REPORT_READY.has(r.status) && <span className="mr-auto text-sm text-muted">The final report is ready once the operator sends the job.</span>}
              <Button variant="outline" onClick={openReport}>
                <FileText /> {REPORT_READY.has(r.status) ? 'Open final report (PDF)' : 'Preview report (PDF)'}
              </Button>
              <Button variant={REPORT_READY.has(r.status) ? 'navy' : 'outline'} onClick={() => void downloadWorkReport(d.run, d.operator, d.station, extras)}>
                <Download /> Download PDF
              </Button>
            </div>

            <ConfirmDialog
              open={!!deciding}
              title={deciding === 'APPROVE' ? `Approve batch ${r.batchNo}?` : `Reject batch ${r.batchNo}?`}
              description={
                deciding === 'APPROVE'
                  ? `${r.perfumeName}, weighed by ${d.operator.name}. Approving releases it as a production record under your name. It cannot be undone.`
                  : `${r.perfumeName}, weighed by ${d.operator.name}. The reason is saved in the batch record under your name. It cannot be undone.`
              }
              confirmLabel={deciding === 'APPROVE' ? 'Approve batch' : 'Reject batch'}
              tone={deciding === 'APPROVE' ? 'navy' : 'danger'}
              pending={decide.isPending}
              error={formErr ? new Error(formErr) : decide.error}
              onClose={closeDecision}
              onConfirm={submitDecision}
            >
              <form
                className="mt-4 grid gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitDecision();
                }}
              >
                <Field label={deciding === 'REJECT' ? 'Reason for rejecting (required)' : 'Note (optional)'} hint={deciding === 'REJECT' ? 'At least 3 characters. The operator and auditors see it.' : undefined}>
                  <textarea
                    value={decisionNote}
                    onChange={(e) => setDecisionNote(e.target.value)}
                    rows={2}
                    maxLength={500}
                    autoFocus
                    placeholder={deciding === 'REJECT' ? 'e.g. Wrong lot of bergamot used at #8' : 'e.g. Checked against process order'}
                    className={cn(inputCls, 'h-auto py-2')}
                  />
                </Field>
                <Field label="Your password" hint={`Signed in as ${me?.user?.name ?? 'scientist'}.`}>
                  <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} className={inputCls} />
                </Field>
                <button type="submit" hidden />
              </form>
            </ConfirmDialog>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
