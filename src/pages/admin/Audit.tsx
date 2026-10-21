import { Fragment, useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronRight, Download, Loader2, Lock, RotateCcw, ScrollText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { AUDIT_OUTCOMES, type AuditPage } from './types';
import { Empty, ErrorBox, Field, inputCls, Loading, PageHeader } from './ui';

interface Filters {
  type: string;
  outcome: string;
  batchNo: string;
  from: string;
  to: string;
}
const EMPTY: Filters = { type: '', outcome: '', batchNo: '', from: '', to: '' };

const outcomeTone = (o: string) => (o === 'SUCCESS' ? ('ok' as const) : o === 'REJECTED' ? ('warn' as const) : o === 'FAILED' ? ('err' as const) : ('neutral' as const));
const prettyType = (t: string) => t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ');
const fmtStamp = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

function filterParams(f: Filters) {
  const p = new URLSearchParams();
  if (f.type) p.set('type', f.type);
  if (f.outcome) p.set('outcome', f.outcome);
  if (f.batchNo.trim()) p.set('batchNo', f.batchNo.trim());
  // Date inputs are local calendar days: from = start of that day, to = end of that day.
  if (f.from) p.set('from', new Date(`${f.from}T00:00:00`).toISOString());
  if (f.to) p.set('to', new Date(`${f.to}T23:59:59.999`).toISOString());
  return p;
}

function buildQuery(f: Filters, before?: string) {
  const p = filterParams(f);
  if (before) p.set('before', before);
  p.set('limit', '100');
  return p.toString();
}

/** Every event matching the filters, exported by the server (not only the rows loaded here). */
function exportCsv(f: Filters) {
  const a = document.createElement('a');
  a.href = `/api/admin/audit.csv?${filterParams(f).toString()}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function Audit() {
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [types, setTypes] = useState<string[]>([]);

  const q = useInfiniteQuery({
    queryKey: ['admin', 'audit', filters],
    queryFn: ({ pageParam }) => api.get<AuditPage>(`/admin/audit?${buildQuery(filters, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];
  const pageTypes = q.data?.pages[0]?.types;
  useEffect(() => {
    if (pageTypes?.length) setTypes(pageTypes);
  }, [pageTypes]);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(filters);
  const anyFilter = JSON.stringify(filters) !== JSON.stringify(EMPTY);
  const dateErr = draft.from && draft.to && draft.from > draft.to ? '"From" is after "To".' : undefined;

  return (
    <>
      <PageHeader title="Audit trail" subtitle="Every sign-in, weighing, approval and setting change, newest first.">
        <Button variant="outline" size="md" disabled={!events.length} onClick={() => exportCsv(filters)} title="Every event that matches the filters, not only the rows shown">
          <Download /> Export CSV
        </Button>
      </PageHeader>
      <div className="grid gap-4 p-8">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Lock className="size-4" /> This record is append-only: entries can never be edited or deleted, by anyone.
        </p>

        <form
          className="grid gap-4 rounded-xl border border-line bg-white p-5 md:grid-cols-3 xl:grid-cols-[1.4fr_1fr_1fr_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dateErr) {
              setFilters(draft);
              setExpanded(null);
            }
          }}
        >
          <Field label="Event">
            <select value={draft.type} onChange={set('type')} className={inputCls}>
              <option value="">All events</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {prettyType(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Outcome">
            <select value={draft.outcome} onChange={set('outcome')} className={inputCls}>
              <option value="">Any</option>
              {AUDIT_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {prettyType(o)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Batch no.">
            <input value={draft.batchNo} onChange={set('batchNo')} maxLength={40} placeholder="e.g. B-2026-0042" className={cn(inputCls, 'font-mono')} />
          </Field>
          <Field label="From" error={dateErr}>
            <input type="date" value={draft.from} onChange={set('from')} className={inputCls} />
          </Field>
          <Field label="To">
            <input type="date" value={draft.to} onChange={set('to')} className={inputCls} />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit" variant={dirty ? 'primary' : 'navy'} size="md" disabled={!!dateErr}>
              Apply
            </Button>
            {(anyFilter || dirty) && (
              <Button
                type="button"
                variant="ghost"
                size="md"
                title="Clear filters"
                onClick={() => {
                  setDraft(EMPTY);
                  setFilters(EMPTY);
                }}
              >
                <RotateCcw />
              </Button>
            )}
          </div>
        </form>

        {q.isLoading ? (
          <Loading label="Loading audit log…" />
        ) : q.error && !q.data ? (
          <ErrorBox error={q.error} />
        ) : events.length === 0 ? (
          <Empty icon={ScrollText} title="No events found">
            {anyFilter ? 'Nothing matches these filters. Try widening the dates or clearing a filter.' : 'Events will appear here as people use BlendGuard.'}
          </Empty>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-line bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-mist text-muted">
                  <tr>
                    {['', 'Time', 'Event', 'Outcome', 'Who', 'Station', 'Batch', 'Change'].map((h, i) => (
                      <th key={i} className="whitespace-nowrap px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {events.map((e) => {
                    const isOpen = expanded === e.seqNo;
                    return (
                      <Fragment key={e.seqNo}>
                        <tr className={cn('cursor-pointer align-top hover:bg-mist', isOpen && 'bg-mist')} onClick={() => setExpanded(isOpen ? null : e.seqNo)}>
                          <td className="py-1 pl-1.5 text-navy">
                            <button
                              type="button"
                              aria-expanded={isOpen}
                              aria-label={`${isOpen ? 'Hide' : 'Show'} details of event #${e.seqNo}`}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setExpanded(isOpen ? null : e.seqNo);
                              }}
                              className="grid size-8 place-items-center rounded-md hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange/50"
                            >
                              {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                            </button>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmtStamp(e.at)}</td>
                          <td className="px-3 py-2 font-semibold">{prettyType(e.type)}</td>
                          <td className="px-3 py-2">
                            <Badge tone={outcomeTone(e.outcome)} size="sm">
                              {prettyType(e.outcome)}
                            </Badge>
                          </td>
                          <td className="px-3 py-2">
                            {e.user ?? <span className="text-muted">System</span>}
                            {e.role && <div className="text-xs text-muted">{prettyType(e.role)}</div>}
                          </td>
                          <td className="px-3 py-2 font-mono">{e.station ?? '—'}</td>
                          <td className="px-3 py-2 font-mono">{e.batchNo ?? '—'}</td>
                          <td className="px-3 py-2">
                            {e.prevState || e.newState ? (
                              <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold">
                                {e.prevState ?? '—'} <ArrowRight className="size-3 text-muted" /> {e.newState ?? '—'}
                              </span>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-mist">
                            <td />
                            <td colSpan={7} className="px-3 pb-4">
                              <div className="mb-2 flex flex-wrap gap-x-6 text-xs text-muted">
                                <span>
                                  Sequence <span className="font-mono font-semibold text-ink">#{e.seqNo}</span>
                                </span>
                                {e.sourceDevice && (
                                  <span>
                                    Device <span className="font-mono text-ink">{e.sourceDevice}</span>
                                  </span>
                                )}
                              </div>
                              <pre className="max-h-80 overflow-auto rounded-lg bg-navy-900 p-4 font-mono text-xs leading-relaxed text-[#d7e6ee]">{JSON.stringify(e.details, null, 2)}</pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted">
                Showing {events.length} event{events.length === 1 ? '' : 's'}
                {!q.hasNextPage && '. That is everything.'}
              </span>
              {q.hasNextPage && (
                <Button variant="outline" size="md" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  {q.isFetchingNextPage && <Loader2 className="animate-spin" />} Load older
                </Button>
              )}
            </div>
            {q.isFetchNextPageError && <ErrorBox error={q.error} />}
          </>
        )}
      </div>
    </>
  );
}

