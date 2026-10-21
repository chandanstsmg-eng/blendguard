import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FlaskConical, Info, Search } from 'lucide-react';
import { ingredientColor } from '@/components/visual/Bottle';
import { Badge } from '@/components/ui/badge';
import { cn, fmtDateTime, g } from '@/lib/utils';
import { useAdminFormulas } from './queries';
import type { AdminFormula, FormulaStatus } from './types';
import { Empty, ErrorBox, inputCls, Loading, PageHeader } from './ui';

const STATUS: Record<FormulaStatus, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  APPROVED: { label: 'Approved', tone: 'ok' },
  DRAFT: { label: 'Draft', tone: 'warn' },
  SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
};

export function Formulas() {
  const q = useAdminFormulas();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const s = search.trim().toLowerCase();
    const map = new Map<string, AdminFormula[]>();
    for (const f of q.data ?? []) {
      if (s && !f.code.toLowerCase().includes(s) && !f.perfumeName.toLowerCase().includes(s)) continue;
      map.set(f.code, [...(map.get(f.code) ?? []), f]);
    }
    return [...map.entries()];
  }, [q.data, search]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
      <PageHeader title="Formulas" subtitle="Every perfume recipe and revision on file, with the exact weights operators are given.">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search code or perfume" className={cn(inputCls, 'w-72 pl-10')} />
        </label>
      </PageHeader>
      <div className="grid gap-6 p-8">
        <div className="flex items-start gap-3 rounded-xl border border-blue-300 bg-white p-4 text-sm">
          <Info className="mt-0.5 size-5 shrink-0 text-blue" />
          <div>
            <div className="font-semibold text-navy">Read-only</div>
            <div className="text-muted">Scientists import and approve formulas from Assign job. This list is read-only. Jobs always keep the approved revision they were assigned with.</div>
          </div>
        </div>

        {q.isLoading ? (
          <Loading label="Loading formulas…" />
        ) : q.error ? (
          <ErrorBox error={q.error} />
        ) : groups.length === 0 ? (
          <Empty icon={FlaskConical} title={q.data?.length ? 'No matches' : 'No formulas yet'}>
            {q.data?.length ? 'Try a different search.' : 'Formulas appear here once a scientist imports and approves one.'}
          </Empty>
        ) : (
          groups.map(([code, revs]) => (
            <section key={code} className="overflow-hidden rounded-xl border border-line bg-white">
              <header className="flex flex-wrap items-baseline gap-x-3 border-b border-line px-6 py-4">
                <h2 className="font-display text-2xl font-bold text-navy">{revs[0].perfumeName}</h2>
                <span className="font-mono text-sm font-semibold text-muted">{code}</span>
                <span className="text-sm text-muted">
                  · {revs.length} revision{revs.length === 1 ? '' : 's'}
                </span>
              </header>
              <ul className="divide-y divide-line">
                {revs.map((f) => {
                  const isOpen = open.has(f.id);
                  const st = STATUS[f.status];
                  return (
                    <li key={f.id}>
                      <button onClick={() => toggle(f.id)} className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 text-left hover:bg-mist" aria-expanded={isOpen}>
                        {isOpen ? <ChevronDown className="size-5 text-navy" /> : <ChevronRight className="size-5 text-navy" />}
                        <span className="w-16 font-mono font-bold">rev {f.revision}</span>
                        <Badge tone={st.tone} size="sm">
                          {st.label}
                        </Badge>
                        {f.perfumeName !== revs[0].perfumeName && <span className="font-semibold">{f.perfumeName}</span>}
                        <Meta label="SOP" value={f.sopNumber ?? '—'} />
                        <Meta label="Batch" value={`${g(f.batchSizeMg)} g`} />
                        <Meta label="Ingredients" value={String(f.lines.length)} />
                        <Meta label="Approved" value={f.approvedAt ? `${f.approvedBy ?? '—'}, ${fmtDateTime(f.approvedAt)}` : '—'} />
                        <Meta label="Jobs" value={String(f.batchCount)} />
                      </button>
                      {isOpen && (
                        <div className="overflow-x-auto bg-mist/50 px-6 pb-4 pt-1">
                          <table className="w-full rounded-lg bg-white text-left text-sm">
                            <thead className="text-muted">
                              <tr className="border-b border-line">
                                <th className="px-3 py-2 font-semibold">#</th>
                                <th className="px-3 py-2 font-semibold">Ingredient</th>
                                <th className="px-3 py-2 text-right font-semibold">Target</th>
                                <th className="px-3 py-2 text-right font-semibold">Tolerance</th>
                                <th className="px-3 py-2 font-semibold">Remarks</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-line">
                              {f.lines.map((l) => (
                                <tr key={l.seq}>
                                  <td className="px-3 py-2 font-mono text-muted">{l.seq}</td>
                                  <td className="px-3 py-2">
                                    <span className="flex items-center gap-2">
                                      <span className="size-3.5 shrink-0 rounded-full border border-navy-900/30" style={{ background: ingredientColor(l.code, l.colorHex) }} />
                                      <span className="font-semibold">{l.name}</span>
                                      <span className="font-mono text-xs text-muted">{l.code}</span>
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono font-semibold">{g(l.targetMg)} g</td>
                                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-muted">
                                    −{g(l.tolMinusMg)} / +{g(l.tolPlusMg)} g
                                  </td>
                                  <td className="px-3 py-2 text-muted">{l.remarks ?? ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-sm">
      <span className="text-muted">{label} </span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}
