import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CalendarDays, CheckCircle2, CircleAlert, FileBarChart, Printer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn, fmtDuration, fmtLongDay as longDate, fmtSeconds, fmtTime, localToday } from '@/lib/utils';
import { ErrorBox, inputCls } from '../admin/ui';
import { PageHeader } from './Console';
import { Letterhead } from './Letterhead';
import { DEVIATION_LABEL, RESOLUTION_LABEL, STATUS_LABEL, WARN_TEXT, statusTone } from './labels';
import type { ShiftReport as Report } from './types';

/** One day on the floor, ready to print for the shift hand-over. */
export function ShiftReport() {
  const today = localToday();
  const [date, setDate] = useState(today);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['supervisor-report', date],
    queryFn: () => api.get<Report>(`/supervisor/report?date=${date}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
  });

  const empty = data && data.batches.length === 0 && data.deviations.length === 0 && data.totals.calls === 0;

  return (
    <div className="print:bg-white">
      <PageHeader title="Shift report" subtitle={longDate(date)}>
        <div className="no-print flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-muted">Day</span>
            <span className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} className={cn(inputCls, 'w-auto pl-9')} />
            </span>
          </label>
          {date !== today && (
            <Button variant="ghost" onClick={() => setDate(today)}>
              Today
            </Button>
          )}
          <Button variant="navy" onClick={() => window.print()} disabled={!data || !!empty}>
            <Printer /> Print
          </Button>
        </div>
      </PageHeader>

      <Letterhead title="Shift report">
        <div>{longDate(date)}</div>
      </Letterhead>

      <div className="grid gap-6 p-8 print:gap-4 print:p-0 print:pt-4">
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border border-line bg-white" />
            ))}
          </div>
        ) : isError ? (
          <ErrorBox error={error} />
        ) : !data ? null : empty ? (
          <div className="grid place-items-center rounded-xl border border-dashed border-line bg-white px-6 py-16 text-center">
            <FileBarChart className="mb-3 size-10 text-muted" />
            <div className="font-display text-2xl font-bold text-navy">Nothing happened on this day</div>
            <p className="mt-1 text-muted">No jobs were started or finished, and nobody called for help. Pick another day above.</p>
          </div>
        ) : (
          <>
            <Totals t={data.totals} />
            <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] print:grid-cols-1">
              <IngredientsChart ops={data.operators} />
              <OperatorsTable ops={data.operators} />
            </div>
            <JobsTable batches={data.batches} />
            <ProblemsTable rows={data.deviations} />
            <p className="hidden text-xs text-muted print:block">Printed {new Date().toLocaleString('en-IN')} from BlendGuard</p>
          </>
        )}
      </div>
    </div>
  );
}

function Totals({ t }: { t: Report['totals'] }) {
  const tiles: { label: string; value: string | number; note?: string; warn?: boolean }[] = [
    { label: 'Jobs started', value: t.jobsStarted },
    { label: 'Jobs finished', value: t.jobsFinished },
    { label: 'Jobs submitted', value: t.jobsSubmitted },
    { label: 'Ingredients weighed', value: t.ingredients },
    { label: 'Problems', value: t.problems, note: t.problemsOpen ? `${t.problemsOpen} still open` : t.problems ? 'all resolved' : undefined, warn: t.problemsOpen > 0 },
    { label: 'Calls for help', value: t.calls },
    { label: 'Avg. call response', value: t.avgCallResponseSec == null ? '—' : fmtSeconds(t.avgCallResponseSec) },
    { label: 'Wrong scans', value: t.wrongScans, warn: t.wrongScans > 0 },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 print:grid-cols-4">
      {tiles.map((x) => (
        <div key={x.label} className={cn('rounded-xl border bg-white p-4 break-inside-avoid', x.warn ? 'border-warn' : 'border-line')}>
          <div className="text-sm text-muted">{x.label}</div>
          <div className={cn('font-display text-4xl font-bold tabular', x.warn ? WARN_TEXT : 'text-navy')}>{x.value}</div>
          {x.note && <div className="text-xs text-muted">{x.note}</div>}
        </div>
      ))}
    </div>
  );
}

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('overflow-hidden rounded-xl border border-line bg-white break-inside-avoid', className)}>
      <h2 className="border-b border-line px-5 py-3 font-display text-xl font-bold text-navy">{title}</h2>
      {children}
    </section>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={cn('px-4 py-2 font-semibold', right && 'text-right')}>{children}</th>;
}

function EmptyRow({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-4 py-8 text-center text-muted">
        {text}
      </td>
    </tr>
  );
}

function IngredientsChart({ ops }: { ops: Report['operators'] }) {
  const rows = ops.map((o) => ({ name: o.name.split(' ')[0], full: o.name, ingredients: o.ingredients }));
  return (
    <Section title="Ingredients weighed per operator">
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-muted">No ingredients were weighed.</p>
      ) : (
        <div className="h-72 px-3 py-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 20, left: 8 }} barCategoryGap="28%">
              <CartesianGrid vertical={false} stroke="#e3e8ea" />
              <XAxis dataKey="name" tickLine={false} axisLine={{ stroke: '#d9dfe2' }} tick={{ fill: '#27343d', fontSize: 13 }} label={{ value: 'Operator', position: 'insideBottom', offset: -12, fill: '#5b6b75', fontSize: 12 }} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#5b6b75', fontSize: 12 }} width={44} label={{ value: 'Ingredients', angle: -90, position: 'insideLeft', offset: 4, fill: '#5b6b75', fontSize: 12, style: { textAnchor: 'middle' } }} />
              <Tooltip
                cursor={{ fill: '#eef1f2' }}
                formatter={(v) => [v as number, 'Ingredients']}
                labelFormatter={(_l, p) => (p?.[0]?.payload as { full?: string } | undefined)?.full ?? ''}
                contentStyle={{ borderRadius: 8, border: '1px solid #d9dfe2', fontSize: 13 }}
              />
              <Bar dataKey="ingredients" fill="#17394c" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false} label={{ position: 'top', fill: '#27343d', fontSize: 12 }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Section>
  );
}

function OperatorsTable({ ops }: { ops: Report['operators'] }) {
  return (
    <Section title="Operators">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-mist text-muted">
            <tr>
              <Th>Operator</Th>
              <Th right>Jobs</Th>
              <Th right>Finished</Th>
              <Th right>Ingredients</Th>
              <Th right>Avg. per ingredient</Th>
              <Th right>Wrong scans</Th>
              <Th right>Problems</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {ops.length === 0 && <EmptyRow cols={7} text="No operator worked on a job this day." />}
            {ops.map((o) => (
              <tr key={o.operatorId}>
                <td className="px-4 py-2.5">
                  <div className="font-semibold">{o.name}</div>
                  {o.operatorCode && <div className="font-mono text-xs text-muted">{o.operatorCode}</div>}
                </td>
                <td className="px-4 py-2.5 text-right tabular">{o.jobs}</td>
                <td className="px-4 py-2.5 text-right tabular">{o.jobsFinished}</td>
                <td className="px-4 py-2.5 text-right font-semibold tabular">{o.ingredients}</td>
                <td className="px-4 py-2.5 text-right tabular">{fmtSeconds(o.avgSecPerIngredient)}</td>
                <td className={cn('px-4 py-2.5 text-right tabular', o.wrongScans > 0 && cn('font-semibold', WARN_TEXT))}>{o.wrongScans}</td>
                <td className={cn('px-4 py-2.5 text-right tabular', o.problems > 0 && 'font-semibold text-err')}>{o.problems}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function JobsTable({ batches }: { batches: Report['batches'] }) {
  return (
    <Section title="Jobs">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-mist text-muted">
            <tr>
              <Th>Batch</Th>
              <Th>Perfume</Th>
              <Th>Formula</Th>
              <Th>Operator</Th>
              <Th>Station</Th>
              <Th right>Progress</Th>
              <Th>Started</Th>
              <Th>Finished</Th>
              <Th right>Time</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {batches.length === 0 && <EmptyRow cols={10} text="No jobs were started or finished this day." />}
            {batches.map((b) => (
              <tr key={b.id}>
                <td className="px-4 py-2.5 font-mono font-semibold">{b.batchNo}</td>
                <td className="px-4 py-2.5">
                  {b.perfumeName}
                  {b.simulated && <span className={cn('ml-2 text-xs font-bold', WARN_TEXT)}>TRAINING</span>}
                </td>
                <td className="px-4 py-2.5 font-mono">{b.formula}</td>
                <td className="px-4 py-2.5">{b.operator}</td>
                <td className="px-4 py-2.5">{b.station}</td>
                <td className="px-4 py-2.5 text-right tabular">
                  {b.done}/{b.total}
                </td>
                <td className="px-4 py-2.5 text-muted">{fmtTime(b.startedAt)}</td>
                <td className="px-4 py-2.5 text-muted">{fmtTime(b.completedAt)}</td>
                <td className="px-4 py-2.5 text-right tabular">{fmtDuration(b.startedAt, b.completedAt)}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone(b.status)} size="sm">
                    {STATUS_LABEL[b.status]}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function ProblemsTable({ rows }: { rows: Report['deviations'] }) {
  return (
    <Section title="Problems">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-mist text-muted">
            <tr>
              <Th>Time</Th>
              <Th>Problem</Th>
              <Th>Batch</Th>
              <Th>Station</Th>
              <Th>Operator</Th>
              <Th>Ingredient</Th>
              <Th>State</Th>
              <Th>Resolution</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.length === 0 && <EmptyRow cols={8} text="No problems were raised. Good shift." />}
            {rows.map((d) => (
              <tr key={d.id} className="align-top">
                <td className="px-4 py-2.5 text-muted">{fmtTime(d.raisedAt)}</td>
                <td className="px-4 py-2.5 font-semibold">{DEVIATION_LABEL[d.type] ?? d.type}</td>
                <td className="px-4 py-2.5 font-mono">{d.batchNo}</td>
                <td className="px-4 py-2.5">{d.station}</td>
                <td className="px-4 py-2.5">{d.operator}</td>
                <td className="px-4 py-2.5">{d.seq ? `#${d.seq} ${d.ingredient ?? ''}` : '—'}</td>
                <td className="px-4 py-2.5">
                  {d.resolvedAt ? (
                    <Badge tone="ok" size="sm">
                      <CheckCircle2 /> Resolved {fmtTime(d.resolvedAt)}
                    </Badge>
                  ) : (
                    <Badge tone="err" size="sm">
                      <CircleAlert /> Open
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {d.resolution ? <div>{RESOLUTION_LABEL[d.resolution] ?? d.resolution}</div> : !d.note && <span className="text-muted">—</span>}
                  {d.note && <div className="text-muted">“{d.note}”</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
