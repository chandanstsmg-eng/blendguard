import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Download, History, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn, fmtDuration, fmtLongDay as longDate, fmtSeconds, fmtTime, g, localToday } from '@/lib/utils';
import { ErrorBox, inputCls } from '../admin/ui';
import { PageHeader, useOverview } from './Console';
import { Letterhead } from './Letterhead';
import { DEVIATION_LABEL, REASON, STATUS_LABEL, WARN_TEXT, statusTone } from './labels';
import type { OperatorActivity } from './types';

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

type Ev = OperatorActivity['events'][number];
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const grams = (v: unknown) => (num(v) == null ? '—' : `${g(num(v)!)} g`);
const step = (d: Record<string, unknown>) => (d.seq != null ? `#${d.seq}${d.ingredient ? ` ${d.ingredient}` : ''}` : '');

const SCAN_REASON: Record<string, string> = {
  WRONG_INGREDIENT: 'wrong bottle',
  UNKNOWN_BARCODE: 'unknown barcode',
  LOT_REQUIRED: 'lot label needed',
  LOT_QUARANTINE: 'lot in quarantine',
  LOT_REJECTED: 'lot rejected',
  LOT_EXPIRED: 'lot expired',
};

/** What a supervisor's sign-off at the station removed or accepted, in plain words. */
function resolvedText(v: unknown) {
  if (!v || typeof v !== 'object') return '';
  const r = v as Record<string, unknown>;
  const out: string[] = [];
  if (num(r.removedMg) != null) out.push(`removed ${grams(r.removedMg)}${num(r.grossBeforeMg) != null && num(r.grossAfterMg) != null ? ` (gross ${grams(r.grossBeforeMg)} → ${grams(r.grossAfterMg)})` : ''}`);
  if (num(r.acceptedGrossMg) != null) out.push(`container weight accepted at ${grams(r.acceptedGrossMg)} gross`);
  const earlier = Array.isArray(r.earlierInContainer) ? (r.earlierInContainer as { seq?: number; ingredient?: string }[]) : [];
  if (r.earlierIngredientsMayBeAffected && earlier.length) out.push(`earlier ingredients in this container may be affected: ${earlier.map((e) => e.ingredient ?? `#${e.seq}`).join(', ')}`);
  return out.join('; ');
}

/** One audit event in plain words: [what happened, extra detail]. */
function describe(e: Ev): [string, string] {
  const d = e.details ?? {};
  switch (e.type) {
    case 'AUTH_SUCCESS':
      return ['Signed in', `${String(d.method ?? '').toLowerCase()}`];
    case 'AUTH_FAILED':
      return ['Sign-in failed', String(d.reason ?? d.method ?? '')];
    case 'SIGN_OUT':
      return ['Signed out', ''];
    case 'JOB_STARTED':
      return e.outcome === 'SUCCESS' ? ['Started job', String(d.formula ?? '')] : ['Start refused', String(d.message ?? '')];
    case 'JOB_PAUSED':
      return ['Paused job', step(d)];
    case 'JOB_RESUMED':
      return ['Resumed job', d.pausedMinutes != null ? `after ${d.pausedMinutes} min, equipment checked` : 'equipment checked'];
    case 'JOB_RECOVERY_CHECK':
      return ['Equipment check after restart', step(d)];
    case 'INGREDIENT_LOCATED':
      return ['Found bottle', step(d)];
    case 'BARCODE_SCAN':
      return e.outcome === 'SUCCESS'
        ? ['Scanned correct bottle', `${step({ seq: d.seq, ingredient: d.expected })}${d.lot ? ` · lot ${d.lot}` : ''}`]
        : ['Wrong scan', `${step({ seq: d.seq, ingredient: d.expected })} · ${SCAN_REASON[String(d.reason)] ?? String(d.reason ?? d.code ?? '')}${d.scanned ? ` (scanned ${d.scanned})` : ''}`];
    case 'SCALE_ZEROED':
      return [d.containerNo != null ? `Container ${d.containerNo} selected, scale set to 0` : 'Scale set to 0', `${step(d)} · container weighs ${grams(d.tareGrossMg)}`];
    case 'SCALE_ZERO':
      return ['Set to 0 refused', String(d.message ?? '')];
    case 'WEIGHT_ACCEPTED':
      return ['Weight saved', `${step(d)} · ${grams(d.netMg)} of ${grams(d.targetMg)}${d.lot ? ` · lot ${d.lot}` : ''}`];
    case 'WEIGHT_REJECTED':
      return ['Weight not accepted', `${step(d)} · ${String(d.verdict ?? '').toLowerCase()} ${num(d.netMg) != null ? `(${grams(d.netMg)})` : ''}`];
    case 'WEIGHT_OVER':
      return [DEVIATION_LABEL.OVERWEIGHT, `${step(d)} · ${grams(d.netMg)} of ${grams(d.targetMg)}`];
    case 'OVERWEIGHT_CORRECTED': {
      const rw = (d.resolvedWith ?? {}) as Record<string, unknown>;
      return ['Took the extra out', `${step(d)}${num(rw.removedMg) != null ? ` · removed ${grams(rw.removedMg)}` : ''}${rw.earlierIngredientsMayBeAffected ? ' · earlier ingredients in this container may be affected' : ''}`];
    }
    case 'VESSEL_CHANGED':
      return [`${DEVIATION_LABEL.VESSEL_CHANGED}: step held`, `${step(d)}${d.containerNo != null ? ` · container ${d.containerNo}` : ''} · expected ${grams(d.expectedGrossMg)}, found ${grams(d.foundGrossMg)}${num(d.limitMg) != null ? `, allowed ±${grams(d.limitMg)}` : ''}`];
    case 'ALL_INGREDIENTS_COMPLETED':
      return ['All ingredients done', `${d.steps ?? ''} ingredients`];
    case 'BATCH_SUBMITTED':
      return ['Sent job to scientist', ''];
    case 'INGREDIENT_SKIPPED':
      return [d.byRole === 'OPERATOR' ? 'Sent ingredient for lab test' : 'Scientist skipped ingredient for lab', `${step(d)}${d.note && d.byRole !== 'OPERATOR' ? `: “${d.note}”` : ''}`];
    case 'LAB_INGREDIENT_RELEASED':
      return [d.byRole === 'OPERATOR' ? 'Marked lab ingredient arrived' : 'Scientist marked lab ingredient arrived', `${step(d)}${d.note ? `: “${d.note}”` : ''}`];
    case 'WAITING_FOR_LAB':
      return ['Other ingredients done, waiting for lab', Array.isArray(d.skipped) ? (d.skipped as { seq: number; ingredient: string }[]).map((s) => `#${s.seq} ${s.ingredient}`).join(', ') : ''];
    case 'LAB_INGREDIENT_STARTED':
      return ['Continued with lab ingredient', step(d)];
    case 'SUPERVISOR_CALLED':
      return ['Called scientist', REASON[String(d.reason)] ?? String(d.reason ?? '')];
    case 'SUPERVISOR_CALL_ACKNOWLEDGED':
      return ['Scientist answered call', REASON[String(d.reason)] ?? ''];
    case 'SUPERVISOR_CALL_CLOSED':
      return ['Scientist closed call', REASON[String(d.reason)] ?? ''];
    case 'SUPERVISOR_SIGNOFF':
      return ['Scientist signed in at station', ''];
    case 'SUPERVISOR_INTERVENTION':
      return ['Scientist action', [`${String(d.action ?? '').replace(/_/g, ' ').toLowerCase()}${d.note ? `: “${d.note}”` : ''}`, resolvedText(d.resolvedWith)].filter(Boolean).join(' · ')];
    case 'JOB_ASSIGNED':
      return ['Job assigned', String(d.formula ?? '')];
    case 'BATCH_APPROVED':
      return e.outcome === 'SUCCESS' ? ['Scientist approved the batch', d.note ? `“${d.note}”` : ''] : ['Approval refused', String(d.message ?? '')];
    case 'BATCH_REJECTED':
      return e.outcome === 'SUCCESS' ? ['Scientist rejected the batch', d.note ? `“${d.note}”` : ''] : ['Rejection refused', String(d.message ?? '')];
    case 'DEVICE_DISCONNECTED':
      return ['Scale disconnected', ''];
    case 'DEVICE_RECONNECTED':
      return ['Scale reconnected', ''];
    default:
      return [e.type.charAt(0) + e.type.slice(1).toLowerCase().replace(/_/g, ' '), String(d.message ?? '')];
  }
}

function exportCsv(a: OperatorActivity) {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Time', 'Event', 'Detail', 'Job', 'Station', 'By', 'Outcome'].join(',')];
  for (const e of a.events) {
    const [what, detail] = describe(e);
    lines.push([new Date(e.at).toLocaleString('en-IN'), what, detail, e.batchNo, e.station, e.by ?? a.operator.name, e.outcome].map(q).join(','));
  }
  const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `Activity-${a.operator.operatorCode ?? a.operator.name}-${a.date}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One operator's day, from first sign-in to sign-out, ready to print. */
export function ActivityLog() {
  const today = localToday();
  const { data: overview } = useOverview();
  const [operatorId, setOperatorId] = useState('');
  const [date, setDate] = useState(today);
  const q = useQuery({
    queryKey: ['supervisor-activity', operatorId, date],
    queryFn: () => api.get<OperatorActivity>(`/supervisor/activity?operatorId=${operatorId}&date=${date}`),
    enabled: !!operatorId && /^\d{4}-\d{2}-\d{2}$/.test(date),
  });
  const a = q.data;
  const empty = a && a.events.length === 0;

  return (
    <div className="print:bg-white">
      <PageHeader title="Operator activity log" subtitle={a ? `${a.operator.name} · ${longDate(date)}` : 'Everything an operator did on a day, from sign-in to sign-out.'}>
        <div className="no-print flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-muted">Operator</span>
            <select value={operatorId} onChange={(e) => setOperatorId(e.target.value)} className={cn(inputCls, 'w-auto min-w-56')}>
              <option value="">Choose…</option>
              {overview?.operators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.operatorCode})
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-muted">Day</span>
            <span className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className={cn(inputCls, 'w-auto pl-9')} />
            </span>
          </label>
          <Button variant="outline" onClick={() => a && exportCsv(a)} disabled={!a || !!empty}>
            <Download /> CSV
          </Button>
          <Button variant="navy" onClick={() => window.print()} disabled={!a || !!empty}>
            <Printer /> Print
          </Button>
        </div>
      </PageHeader>

      {/* Letterhead on paper only. */}
      <Letterhead title="Operator activity log">
        {a && (
          <div>
            {a.operator.name} (ID {a.operator.operatorCode}) · {longDate(date)}
          </div>
        )}
      </Letterhead>

      <div className="grid gap-6 p-8 print:gap-4 print:p-0 print:pt-4">
        {!operatorId ? (
          <Placeholder title="Choose an operator" text="Pick an operator and a day above to see every step they took." />
        ) : q.isLoading ? (
          <div className="h-40 animate-pulse rounded-xl border border-line bg-white" />
        ) : q.isError ? (
          <ErrorBox error={q.error} />
        ) : !a ? null : empty ? (
          <Placeholder title="No activity on this day" text={`${a.operator.name} did not sign in or work on a job on ${longDate(date)}.`} />
        ) : (
          <>
            <Summary a={a} />
            <Jobs jobs={a.jobs} />
            <Timeline a={a} />
            <div className="hidden grid-cols-2 gap-16 pt-10 text-sm text-muted print:grid">
              <div className="border-t border-ink pt-1">Operator signature</div>
              <div className="border-t border-ink pt-1">Scientist signature</div>
            </div>
            <p className="hidden text-xs text-muted print:block">Printed {new Date().toLocaleString('en-IN')} · From the append-only audit trail in BlendGuard</p>
          </>
        )}
      </div>
    </div>
  );
}

function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-line bg-white px-6 py-16 text-center">
      <History className="mb-3 size-10 text-muted" />
      <div className="font-display text-2xl font-bold text-navy">{title}</div>
      <p className="mt-1 text-muted">{text}</p>
    </div>
  );
}

function Summary({ a }: { a: OperatorActivity }) {
  const s = a.summary;
  const tiles: { label: string; value: string | number; note?: string; warn?: boolean }[] = [
    { label: 'Started work', value: fmtTime(s.firstSignIn ?? s.firstActivity), note: s.firstSignIn ? 'first sign-in' : 'first action' },
    { label: 'Finished work', value: fmtTime(s.lastSignOut ?? s.lastActivity), note: s.lastSignOut ? 'last sign-out' : 'last action (no sign-out)' },
    { label: 'Time at station', value: fmtDuration(s.firstSignIn ?? s.firstActivity, s.lastSignOut ?? s.lastActivity) },
    { label: 'Paused', value: s.pausedSec ? fmtSeconds(s.pausedSec) : 'Not paused' },
    { label: 'Jobs started', value: s.jobsStarted },
    { label: 'Jobs sent to scientist', value: s.jobsSubmitted },
    { label: 'Ingredients weighed', value: s.ingredients },
    { label: 'Wrong scans / problems', value: `${s.wrongScans} / ${s.problems}`, warn: s.wrongScans + s.problems > 0 },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 print:grid-cols-4">
      {tiles.map((x) => (
        <div key={x.label} className={cn('rounded-xl border bg-white p-4 break-inside-avoid', x.warn ? 'border-warn' : 'border-line')}>
          <div className="text-sm text-muted">{x.label}</div>
          <div className={cn('font-display text-3xl font-bold tabular', x.warn ? WARN_TEXT : 'text-navy')}>{x.value}</div>
          {x.note && <div className="text-xs text-muted">{x.note}</div>}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white">
      <h2 className="border-b border-line px-5 py-3 font-display text-xl font-bold text-navy">{title}</h2>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

const th = 'px-4 py-2 font-semibold';
const td = 'px-4 py-2';

function Jobs({ jobs }: { jobs: OperatorActivity['jobs'] }) {
  return (
    <Section title="Jobs worked on">
      <table className="w-full text-left text-sm">
        <thead className="bg-mist text-muted">
          <tr>
            {['Batch', 'Perfume', 'Station', 'Progress', 'Started', 'Completed', 'Time taken', 'Status'].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {jobs.length === 0 && (
            <tr>
              <td colSpan={8} className="px-4 py-6 text-center text-muted">
                No job activity. Signed in only.
              </td>
            </tr>
          )}
          {jobs.map((j) => (
            <tr key={j.id}>
              <td className={cn(td, 'font-mono font-semibold')}>{j.batchNo}</td>
              <td className={td}>
                {j.perfumeName}
                <div className="font-mono text-xs text-muted">{j.formula}</div>
                {j.simulated && <span className={cn('text-xs font-bold', WARN_TEXT)}>TRAINING</span>}
              </td>
              <td className={td}>{j.station}</td>
              <td className={cn(td, 'tabular')}>
                {j.done}/{j.total}
              </td>
              <td className={cn(td, 'text-muted')}>{fmtTime(j.startedAt)}</td>
              <td className={cn(td, 'text-muted')}>{fmtTime(j.completedAt)}</td>
              <td className={cn(td, 'tabular')}>{fmtDuration(j.startedAt, j.completedAt, { seconds: true })}</td>
              <td className={td}>
                <Badge tone={statusTone(j.status)} size="sm">
                  {STATUS_LABEL[j.status]}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Timeline({ a }: { a: OperatorActivity }) {
  return (
    <Section title={`Step-by-step log (${a.events.length} entries)`}>
      <table className="w-full text-left text-sm">
        <thead className="bg-mist text-muted">
          <tr>
            {['Time', 'What happened', 'Detail', 'Job', 'Station', 'By'].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {a.events.map((e) => {
            const [what, detail] = describe(e);
            const bad = e.outcome === 'REJECTED' || e.outcome === 'FAILED';
            return (
              <tr key={e.id} className={cn('align-top break-inside-avoid', bad && 'bg-err-100/50', e.type === 'AUTH_SUCCESS' || e.type === 'SIGN_OUT' ? 'bg-mist/60 font-semibold' : '')}>
                <td className={cn(td, 'whitespace-nowrap font-mono text-xs tabular text-muted')}>{clock(e.at)}</td>
                <td className={cn(td, 'font-semibold', bad && 'text-err')}>{what}</td>
                <td className={cn(td, 'text-muted')}>{detail}</td>
                <td className={cn(td, 'whitespace-nowrap font-mono text-xs')}>{e.batchNo ?? ''}</td>
                <td className={td}>{e.station ?? ''}</td>
                <td className={td}>{e.by ?? <span className="text-muted">operator</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}
