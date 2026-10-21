import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FlaskConical, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { cn, g, qtyInUnit } from '@/lib/utils';
import { ErrorBox, Field, inputCls } from '../admin/ui';
import { PageHeader, useOverview } from './Console';
import { WARN_TEXT } from './labels';
import { UploadButton, type ImportedFormula } from './UploadInstruction';
import { PROCESS_ORDER_FIELDS, type ProcessOrderHeader } from '@shared/types';

interface FormulaDetail {
  id: string;
  code: string;
  revision: string;
  perfumeName: string;
  batchSizeMg: number;
  processOrder: ProcessOrderHeader | null;
  lines: { seq: number; code: string; name: string; targetMg: number; uom: string | null; storageLocation: string | null; sourceBatch: string | null; labTest: boolean }[];
}

/** 0.40000 KG / 25.00 G: the quantity in the unit the process order used, to the scale's resolution. */
const qty = (mg: number, uom: string | null, resolutionMg: number) => `${qtyInUnit(mg, uom, resolutionMg)} ${(uom ?? 'G').toUpperCase()}`;

const schema = z
  .object({
    formulaId: z.string().min(1, 'Choose an approved formula'),
    operatorId: z.string().min(1, 'Choose an operator'),
    stationId: z.string().min(1, 'Choose a station'),
    backupOperatorId: z.string(),
    plannedStart: z.string(),
    instructions: z.string().max(500),
  })
  .refine((v) => !v.backupOperatorId || v.backupOperatorId !== v.operatorId, { path: ['backupOperatorId'], message: 'Backup must be a different person' });
type Form = z.infer<typeof schema>;

export function AssignJob() {
  const { data } = useOverview();
  const qc = useQueryClient();
  const [done, setDone] = useState<{ batchNo: string; summary: string } | null>(null);
  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { formulaId: '', operatorId: '', stationId: '', backupOperatorId: '', plannedStart: '', instructions: '' },
  });
  const { register, handleSubmit, watch, formState, reset, setValue } = form;
  const [imported, setImported] = useState<ImportedFormula | null>(null);
  const onImported = async (f: ImportedFormula) => {
    await qc.invalidateQueries({ queryKey: ['overview'] });
    setDone(null);
    setImported(f);
    setValue('formulaId', f.id, { shouldValidate: true });
  };
  const operatorId = watch('operatorId');
  const stationId = watch('stationId');
  const formulaId = watch('formulaId');
  const operator = data?.operators.find((o) => o.id === operatorId);
  const stations = (data?.stations ?? []).filter((s) => !operator || operator.stations.includes(s.code));
  const backups = (data?.operators ?? []).filter((o) => o.id !== operatorId && (!stationId || o.stations.includes(data?.stations.find((s) => s.id === stationId)?.code ?? '')));
  // Quantities show the decimals of the chosen station's scale (0.01 g until a station is chosen).
  const resolutionMg = data?.stations.find((s) => s.id === stationId)?.scaleResolutionMg ?? 10;

  const formula = useQuery({ queryKey: ['formula', formulaId], queryFn: () => api.get<FormulaDetail>(`/supervisor/formulas/${formulaId}`), enabled: !!formulaId });
  // Ingredients that go for lab test: pre-ticked from the upload, changeable here.
  const [lab, setLab] = useState<Set<number>>(new Set());
  useEffect(() => {
    setLab(new Set(formula.data?.lines.filter((l) => l.labTest).map((l) => l.seq) ?? []));
  }, [formula.data]);
  const allLab = !!formula.data && formula.data.lines.length > 0 && formula.data.lines.every((l) => lab.has(l.seq));
  const toggle = (seq: number, on: boolean) => {
    const next = new Set(lab);
    if (on) next.add(seq);
    else next.delete(seq);
    setLab(next);
  };

  const assign = useMutation({
    mutationFn: (v: Form) =>
      api.post<{ id: string; batchNo: string }>('/supervisor/jobs', {
        ...v,
        backupOperatorId: v.backupOperatorId || null,
        plannedStart: v.plannedStart ? new Date(v.plannedStart).toISOString() : null,
        instructions: v.instructions || null,
        labSeqs: [...lab],
      }),
    onSuccess: (r, v) => {
      const f = data?.formulas.find((x) => x.id === v.formulaId);
      const st = data?.stations.find((x) => x.id === v.stationId);
      const labNote = lab.size ? ` · ${lab.size} ingredient${lab.size > 1 ? 's' : ''} for lab test` : '';
      setDone({ batchNo: r.batchNo, summary: `${f?.perfumeName} (${f?.code} rev ${f?.revision}) → ${operator?.name} at ${st?.name}${labNote}` });
      reset();
      setImported(null);
      setLab(new Set());
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const err = assign.error as ApiError | null;

  return (
    <>
      <PageHeader title="Assign job" subtitle="Pick a formula or upload a process order, choose who mixes it and where.">
        <UploadButton onImported={(f) => void onImported(f)} />
      </PageHeader>
      <div className="grid gap-6 p-8 xl:grid-cols-[minmax(0,760px)_1fr]">
        <form onSubmit={handleSubmit((v) => assign.mutate(v))} className="grid gap-5 rounded-xl border border-line bg-white p-6">
          {imported && !done && (
            <div className="flex items-start gap-3 rounded-lg border border-blue-300 bg-mist p-4 text-navy" role="status">
              <CheckCircle2 className="mt-0.5 size-6 shrink-0" />
              <div>
                <div className="font-bold">
                  {imported.perfumeName} ({imported.code} rev {imported.revision}) approved and selected
                  {imported.labSeqs.length ? `, ${imported.labSeqs.length} ingredient${imported.labSeqs.length > 1 ? 's' : ''} ticked for lab test` : ''}.
                </div>
                <div className="text-ink">Now choose the operator and station.</div>
              </div>
            </div>
          )}
          {done && (
            <div className="flex items-start gap-3 rounded-lg bg-ok-100 p-4 text-ok" role="status">
              <CheckCircle2 className="mt-0.5 size-6 shrink-0" />
              <div>
                <div className="font-bold">Job {done.batchNo} assigned.</div>
                <div className="text-ink">{done.summary}. It&apos;s on their screen now.</div>
              </div>
            </div>
          )}
          <Field label="Approved formula / process order" error={formState.errors.formulaId?.message}>
            <select {...register('formulaId')} className={inputCls}>
              <option value="">Choose…</option>
              {data?.formulas.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.perfumeName} · {f.code} rev {f.revision} · {f.lines} ingredients · {g(f.batchSizeMg)} g
                </option>
              ))}
            </select>
          </Field>

          {formulaId && (
            <section className="grid gap-3 rounded-lg border border-line p-4">
              {formula.isLoading && <Loader2 className="size-6 animate-spin text-navy" />}
              {formula.data?.processOrder && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-mist p-3 text-sm sm:grid-cols-3">
                  {PROCESS_ORDER_FIELDS.filter((f) => formula.data!.processOrder![f.key]).map((f) => (
                    <div key={f.key}>
                      <dt className="text-xs text-muted">{f.label}</dt>
                      <dd className="font-semibold">{formula.data!.processOrder![f.key]}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {formula.data && (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="font-semibold text-ink">Ingredients: tick those that go for lab test</h3>
                    <span className={cn('flex items-center gap-1 text-sm font-semibold', WARN_TEXT)}>
                      <FlaskConical className="size-4" /> {lab.size} for lab test
                    </span>
                  </div>
                  <div className="max-h-72 overflow-auto rounded-lg border border-line">
                    <table className="w-full text-left text-sm">
                      <thead className="sticky top-0 bg-mist text-muted">
                        <tr>
                          {['#', 'Lab test', 'Material', 'Ingredient', 'Batch', 'Req qty'].map((h) => (
                            <th key={h} className="px-3 py-1.5 font-semibold">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {formula.data.lines.map((l) => (
                          <tr key={l.seq} className={lab.has(l.seq) ? 'bg-warn-100/60' : ''}>
                            <td className="px-3 py-1.5 font-mono text-muted">{l.seq}</td>
                            <td className="px-3 py-1.5">
                              <input type="checkbox" className="size-5 accent-[#8a5a00]" aria-label={`${l.name} goes for lab test`} checked={lab.has(l.seq)} onChange={(e) => toggle(l.seq, e.target.checked)} />
                            </td>
                            <td className="px-3 py-1.5 font-mono text-xs">{l.code}</td>
                            <td className="px-3 py-1.5 font-semibold">{l.name}</td>
                            <td className="px-3 py-1.5 font-mono text-xs text-muted">{l.sourceBatch ?? '—'}</td>
                            <td className="whitespace-nowrap px-3 py-1.5 font-mono">{qty(l.targetMg, l.uom, resolutionMg)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {allLab && <p className="text-sm font-semibold text-err">At least one ingredient must not go for lab test, so the operator can start.</p>}
                  <p className="text-xs text-muted">Ticked ingredients start as skipped. The operator does the rest; the job then waits for the lab. When a lab ingredient arrives, the operator marks it arrived at the station (or you do, from Jobs &amp; calls).</p>
                </>
              )}
            </section>
          )}

          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Operator" error={formState.errors.operatorId?.message}>
              <select {...register('operatorId')} className={inputCls}>
                <option value="">Choose…</option>
                {data?.operators
                  .filter((o) => o.active)
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.operatorCode})
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Station" error={formState.errors.stationId?.message} hint={operator ? `Stations ${operator.name.split(' ')[0]} is authorised for` : undefined}>
              <select {...register('stationId')} className={inputCls}>
                <option value="">Choose…</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Backup operator (optional)" error={formState.errors.backupOperatorId?.message}>
              <select {...register('backupOperatorId')} className={inputCls}>
                <option value="">None</option>
                {backups.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.operatorCode})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Planned start (optional)">
              <input type="datetime-local" {...register('plannedStart')} className={inputCls} />
            </Field>
          </div>
          <Field label="Instructions for the operator (optional)" error={formState.errors.instructions?.message}>
            <textarea rows={3} {...register('instructions')} className={inputCls + ' h-auto py-2'} placeholder="e.g. Use the 2 L stainless container." />
          </Field>
          {err && <ErrorBox error={err} />}
          <Button type="submit" variant="primary" size="md" className="h-12 justify-self-start px-6 text-lg" disabled={assign.isPending || allLab}>
            Assign job
          </Button>
        </form>
        <aside className="h-fit rounded-xl border border-line bg-white p-6 text-sm text-muted">
          <h2 className="font-display text-lg font-bold text-navy">Before you hit assign</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <b>Upload PDF / CSV</b> reads a process order printed from SAP (or a CSV). Check what was read, correct it, tick the lab-test ingredients, approve.
            </li>
            <li>Only <b>approved</b> revisions show up. The job locks in that revision, so editing the formula later won&apos;t touch it.</li>
            <li>The station list only shows stations the operator is cleared for. The job lands on their screen straight away.</li>
            <li>One job per station at a time. The operator&apos;s list is in order of planned start time.</li>
          </ul>
        </aside>
      </div>
    </>
  );
}
