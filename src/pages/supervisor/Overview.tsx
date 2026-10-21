import { useState } from 'react';
import { AlertTriangle, BellRing, CheckCircle2, ChevronRight, CircleDot, FileCheck2, FlaskConical, RefreshCw, Scale, TestTubes, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn, fmtDateTime, fmtTime } from '@/lib/utils';
import { ErrorBox } from '../admin/ui';
import { PageHeader, useOverview } from './Console';
import { BatchDetail } from './BatchDetail';
import { useCallActions } from './callActions';
import { REASON, SCALE_FAULT_SHORT, STATUS_LABEL, WARN_TEXT, openCallCount, statusTone } from './labels';
import type { BatchStatus } from '@shared/types';

const today = () => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export function Overview() {
  const { data, isLoading, isError, error, refetch, isFetching } = useOverview();
  const calls = useCallActions();
  const [openBatch, setOpenBatch] = useState<string | null>(null);

  if (!data) {
    return (
      <>
        <PageHeader title="Jobs & calls" subtitle={isLoading ? 'Loading…' : today()} />
        {isError && (
          <div className="grid justify-items-start gap-3 p-8">
            <ErrorBox error={error} />
            <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              <RefreshCw className={cn(isFetching && 'animate-spin')} /> Try again
            </Button>
          </div>
        )}
      </>
    );
  }

  const count = (s: BatchStatus[]) => s.reduce((n, k) => n + (data.counts[k] ?? 0), 0);
  const waitingLab = data.batches.filter((b) => b.status === 'AWAITING_LAB');
  const pendingApproval = data.batches.filter((b) => b.status === 'SUBMITTED' || b.status === 'UNDER_REVIEW').sort((x, y) => (x.submittedAt ?? '').localeCompare(y.submittedAt ?? ''));
  const latest = data.batches.filter((b) => !b.older);
  const alerts = data.stations.filter((s) => !s.scaleConnected || !s.scaleValidated).length;
  const callCount = openCallCount(data);
  const jumpTo = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const tiles: { label: string; value: number; warn?: boolean; onClick?: () => void }[] = [
    { label: 'Jobs assigned', value: count(['ASSIGNED']) },
    { label: 'In progress', value: count(['IN_PROGRESS', 'PAUSED']) },
    { label: 'On hold', value: count(['ON_HOLD']), warn: count(['ON_HOLD']) > 0 },
    { label: 'Done, not sent yet', value: count(['AWAITING_SUBMISSION']) },
    { label: 'Waiting for lab', value: count(['AWAITING_LAB']), warn: data.labReadyCount > 0, onClick: waitingLab.length ? jumpTo('waiting-lab') : undefined },
    { label: 'Pending approval', value: count(['SUBMITTED', 'UNDER_REVIEW']), warn: count(['SUBMITTED', 'UNDER_REVIEW']) > 0, onClick: pendingApproval.length ? jumpTo('pending-approval') : undefined },
    { label: 'Active stations', value: data.stations.filter((s) => s.current).length },
    { label: 'Equipment alerts', value: alerts, warn: alerts > 0 },
    { label: 'Open calls', value: callCount, warn: callCount > 0, onClick: callCount ? jumpTo('open-calls') : undefined },
  ];

  return (
    <>
      <PageHeader title="Jobs & calls" subtitle={today()} />
      <div className="grid gap-6 p-8">
        {isError && <ErrorBox error={new Error('Could not refresh. The figures below may be out of date.')} />}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {tiles.map((t) => {
            const body = (
              <>
                <div className="text-sm text-muted">{t.label}</div>
                <div className={cn('font-display text-4xl font-bold tabular', t.warn ? WARN_TEXT : 'text-navy')}>{t.value}</div>
              </>
            );
            const cls = cn('rounded-xl border bg-white p-4 text-left', t.warn ? 'border-warn' : 'border-line');
            return t.onClick ? (
              <button key={t.label} onClick={t.onClick} className={cn(cls, 'group transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange/50')}>
                {body}
                <div className="mt-1 flex items-center gap-0.5 text-xs font-semibold text-navy group-hover:underline">
                  Show list <ChevronRight className="size-3.5" />
                </div>
              </button>
            ) : (
              <div key={t.label} className={cls}>
                {body}
              </div>
            );
          })}
        </div>

        {calls.error && <ErrorBox error={calls.error} />}
        {data.calls.length > 0 && (
          <section id="open-calls" className="scroll-mt-4 rounded-xl border-2 border-warn bg-white">
            <h2 className="flex items-center gap-2 border-b border-line px-5 py-3 font-display text-xl font-bold text-navy">
              <BellRing className={cn('size-5', WARN_TEXT)} /> Someone needs you
            </h2>
            <ul className="divide-y divide-line">
              {data.calls.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                  <Badge tone={c.status === 'OPEN' ? 'warn' : 'ok'}>{c.status === 'OPEN' ? 'Open' : 'On the way'}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">
                      {c.stationName} · {REASON[c.reason] ?? c.reason}
                      {c.seq ? ` · ingredient #${c.seq}` : ''}
                    </div>
                    <div className="text-sm text-muted">
                      {c.raisedBy} · {fmtTime(c.createdAt)}
                    </div>
                  </div>
                  {c.status === 'OPEN' && (
                    <Button size="sm" variant="navy" disabled={calls.busy} onClick={() => calls.acknowledge(c)}>
                      I&apos;m on my way
                    </Button>
                  )}
                  <Button size="sm" variant="outline" disabled={calls.busy} onClick={() => calls.requestClose(c)}>
                    Close…
                  </Button>
                </li>
              ))}
            </ul>
            <p className="border-t border-line px-5 py-2 text-sm text-muted">Holds for too much poured or a changed container weight are cleared at the station, with Scientist sign-off.</p>
          </section>
        )}

        {waitingLab.length > 0 && (
          <section id="waiting-lab" className="scroll-mt-4 rounded-xl border-2 border-warn bg-white">
            <h2 className="flex items-center gap-2 border-b border-line px-5 py-3 font-display text-xl font-bold text-navy">
              <TestTubes className={cn('size-5', WARN_TEXT)} /> Waiting for lab ingredient
            </h2>
            <ul className="divide-y divide-line">
              {waitingLab.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                  <Badge tone={b.labReady ? 'ok' : 'warn'}>{b.labReady ? 'Released, operator to add' : `${b.skipped} waiting`}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">
                      {b.perfumeName} · <span className="font-mono">{b.batchNo}</span>
                    </div>
                    <div className="text-sm text-muted">
                      {b.operator} · {b.station} · {b.done}/{b.total} weighed
                    </div>
                  </div>
                  <Button size="sm" variant={b.labReady ? 'outline' : 'success'} onClick={() => setOpenBatch(b.id)}>
                    {b.labReady ? 'Open' : 'Lab ingredient arrived…'}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {pendingApproval.length > 0 && (
          <section id="pending-approval" className="scroll-mt-4 rounded-xl border-2 border-orange bg-white">
            <h2 className="flex items-center gap-2 border-b border-line px-5 py-3 font-display text-xl font-bold text-navy">
              <FileCheck2 className="size-5 text-orange-600" /> Pending approval
              <span className="ml-1 rounded-full bg-orange-100 px-2.5 text-base text-navy">{pendingApproval.length}</span>
            </h2>
            <ul className="divide-y divide-line">
              {pendingApproval.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">
                      {b.perfumeName} · <span className="font-mono">{b.batchNo}</span>
                      {b.simulated && (
                        <Badge tone="warn" size="sm" className="ml-2 align-middle">
                          <FlaskConical /> Training record
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted">
                      {b.operator} · {b.station} · sent {fmtDateTime(b.submittedAt)}
                    </div>
                  </div>
                  <Button size="sm" variant="navy" onClick={() => setOpenBatch(b.id)}>
                    Review <ChevronRight />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h2 className="mb-3 font-display text-xl font-bold text-navy">On the floor</h2>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {data.stations.map((s) => (
              <article key={s.id} className="min-w-0 rounded-xl border border-line bg-white p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-display text-2xl font-bold text-navy">{s.name}</div>
                    <div className="text-sm text-muted">
                      {s.code} · {s.bound ? 'PC linked' : 'No PC linked'}
                    </div>
                  </div>
                  {s.scaleMode === 'SIMULATED' && (
                    <Badge tone="warn" size="sm">
                      <FlaskConical /> Training
                    </Badge>
                  )}
                </div>
                {s.current ? (
                  <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
                    <dt className="text-muted">Operator</dt>
                    <dd className="font-semibold">{s.current.operator}</dd>
                    <dt className="text-muted">Perfume</dt>
                    <dd className="font-semibold">{s.current.perfumeName}</dd>
                    <dt className="text-muted">Progress</dt>
                    <dd className="font-semibold">
                      {s.current.done}/{s.current.total} ingredients
                    </dd>
                    <dt className="text-muted">Status</dt>
                    <dd className="font-semibold">
                      {s.current.stepStatus === 'ON_HOLD' ? (
                        <span className="text-err">On hold at #{s.current.stepSeq}</span>
                      ) : s.current.status === 'IN_PROGRESS' ? (
                        `${s.current.stepStage === 'WEIGH' ? 'Weighing' : s.current.stepStage === 'SCAN' ? 'Scanning' : 'Finding'} #${s.current.stepSeq}`
                      ) : (
                        STATUS_LABEL[s.current.status]
                      )}
                    </dd>
                  </dl>
                ) : (
                  <p className="mt-4 flex items-center gap-2 text-muted">
                    <CircleDot className="size-4" /> Idle
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3 text-sm">
                  <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold', s.scaleConnected ? 'bg-ok-100 text-ok' : 'bg-err-100 text-err')}>
                    {s.scaleConnected ? <Scale className="size-4" /> : <Unplug className="size-4" />}
                    {s.scaleConnected ? 'Scale connected' : s.scaleFault ? SCALE_FAULT_SHORT[s.scaleFault] : 'Scale disconnected'}
                  </span>
                  <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold', s.scaleValidated ? 'bg-mist text-ink' : 'bg-err-100 text-err')}>
                    {s.scaleValidated ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
                    {s.scaleValidated ? `Checked until ${fmtDateTime(s.scaleValidatedUntil)}` : 'Scale check due'}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-line bg-white">
          <h2 className="flex flex-wrap items-baseline gap-x-3 border-b border-line px-5 py-3 font-display text-xl font-bold text-navy">
            Latest jobs
            <span className="font-sans text-sm font-normal text-muted">The {data.jobRows} most recently assigned. The counts above cover every job.</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-mist text-muted">
                <tr>
                  {['Batch', 'Perfume', 'Formula', 'Operator', 'Station', 'Progress', 'Status', 'Assigned', ''].map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-4 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {latest.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-muted">
                      No jobs yet. Use Assign job to send one to a station.
                    </td>
                  </tr>
                )}
                {latest.map((b) => (
                  <tr key={b.id} className="cursor-pointer hover:bg-mist/60" onClick={() => setOpenBatch(b.id)}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono font-semibold">{b.batchNo}</td>
                    <td className="px-4 py-2.5">
                      {b.perfumeName}
                      {b.simulated && <span className={cn('ml-2 text-xs font-bold', WARN_TEXT)}>TRAINING</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono">{b.formula}</td>
                    <td className="px-4 py-2.5">{b.operator}</td>
                    <td className="px-4 py-2.5">{b.station}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 tabular">
                      {b.done}/{b.total}
                      {b.skipped > 0 && <span className={cn('ml-2 text-xs font-bold', WARN_TEXT)}>{b.skipped} lab</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={statusTone(b.status)} size="sm">
                        {STATUS_LABEL[b.status]}
                      </Badge>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{fmtDateTime(b.assignedAt)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Button size="sm" variant="ghost" aria-label={`Open ${b.batchNo}`} onClick={() => setOpenBatch(b.id)}>
                        Open <ChevronRight />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      {calls.dialog}
      <BatchDetail batchId={openBatch} onClose={() => setOpenBatch(null)} />
    </>
  );
}
