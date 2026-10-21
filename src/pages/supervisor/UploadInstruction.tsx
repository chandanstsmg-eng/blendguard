import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, FileText, FlaskConical, Loader2, RefreshCw, Upload, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api, ApiError } from '@/lib/api';
import { cn, g } from '@/lib/utils';
import { ConfirmDialog, ErrorBox, inputCls } from '../admin/ui';
import { WARN_TEXT } from './labels';
import { PROCESS_ORDER_FIELDS, type ProcessOrderHeader } from '@shared/types';

interface Meta {
  perfumeName: string;
  code: string;
  revision: string;
  sopNumber: string;
}
interface DraftLine {
  row: number;
  seq: string;
  ingredientCode: string;
  description: string | null;
  quantity: string;
  unit: string;
  tolMinus: string;
  tolPlus: string;
  remarks: string | null;
  storageLocation: string | null;
  sourceBatch: string | null;
  labTest: boolean;
}
interface Line extends DraftLine {
  seqNo: number | null;
  ingredientName: string | null;
  targetMg: number | null;
  tolMinusMg: number | null;
  tolPlusMg: number | null;
  errors: string[];
  warnings: string[];
}
interface Preview {
  meta: Meta;
  processOrder: ProcessOrderHeader | null;
  lines: Line[];
  errors: string[];
  warnings: string[];
  batchSizeMg: number;
  ok: boolean;
}
interface Draft {
  meta: Meta;
  processOrder: ProcessOrderHeader | null;
  lines: DraftLine[];
}
export interface ImportedFormula {
  id: string;
  code: string;
  revision: string;
  perfumeName: string;
  /** Lines ticked "goes for lab test" in the upload. */
  labSeqs: number[];
}

const MAX_CSV_BYTES = 200_000;
const MAX_PDF_BYTES = 6 * 1024 * 1024;
const fieldCls = cn(inputCls, 'h-10');
const cellCls = cn(inputCls, 'h-9 rounded-md px-2 font-mono text-sm');

const toDraft = (p: Preview): Draft => ({
  meta: p.meta,
  processOrder: p.processOrder,
  lines: p.lines.map(({ row, seq, ingredientCode, description, quantity, unit, tolMinus, tolPlus, remarks, storageLocation, sourceBatch, labTest }) => ({ row, seq, ingredientCode, description, quantity, unit, tolMinus, tolPlus, remarks, storageLocation, sourceBatch, labTest })),
});

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsDataURL(file);
  });
}

/** Top-right button on Assign job: upload a process order (PDF) or production instruction (CSV), check it, approve it. */
export function UploadButton({ onImported }: { onImported: (f: ImportedFormula) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="navy" size="md" className="h-11 px-5" onClick={() => setOpen(true)}>
        <Upload /> Upload PDF / CSV
      </Button>
      {open && <UploadDialog onClose={() => setOpen(false)} onImported={(f) => (setOpen(false), onImported(f))} />}
    </>
  );
}

function UploadDialog({ onClose, onImported }: { onClose: () => void; onImported: (f: ImportedFormula) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; kind: 'csv' | 'pdf'; csv?: string; pdf?: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const loaded = (p: Preview) => {
    setDraft(toDraft(p));
    setDirty(false);
  };
  const preview = useMutation({
    mutationFn: (f: NonNullable<typeof file>) =>
      f.kind === 'pdf' ? api.post<Preview>('/supervisor/formulas/import/pdf', { fileName: f.name, pdf: f.pdf }) : api.post<Preview>('/supervisor/formulas/import/preview', { fileName: f.name, csv: f.csv }),
    onSuccess: loaded,
  });
  const check = useMutation({
    mutationFn: (d: Draft) => api.post<Preview>('/supervisor/formulas/import/check', { draft: d }),
    onSuccess: loaded,
  });
  const approve = useMutation({
    mutationFn: () => api.post<ImportedFormula>('/supervisor/formulas/import', { fileName: file!.name, draft, csv: file!.csv, pdf: file!.pdf }),
    onSuccess: onImported,
  });

  const pick = async (f: File | undefined) => {
    setReadError(null);
    approve.reset();
    check.reset();
    if (!f) return;
    const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
    const isCsv = /\.(csv|txt)$/i.test(f.name);
    if (!isPdf && !isCsv) return setReadError('Choose a process order PDF, or a .csv file (Excel: File → Save As → CSV).');
    if (f.size > (isPdf ? MAX_PDF_BYTES : MAX_CSV_BYTES)) return setReadError(isPdf ? 'The PDF is too large (over 6 MB).' : 'The file is too large (over 200 KB).');
    const next = isPdf ? { name: f.name, kind: 'pdf' as const, pdf: await base64(f) } : { name: f.name, kind: 'csv' as const, csv: await f.text() };
    setFile(next);
    setDraft(null);
    preview.mutate(next);
  };

  // The last answer from the server, from either the first read or a re-check.
  const p = check.data ?? preview.data;
  const lineErrors = p?.lines.filter((l) => l.errors.length).length ?? 0;
  const err = (preview.error ?? check.error ?? approve.error) as ApiError | null;
  const busy = preview.isPending || check.isPending || approve.isPending;

  const edit = (fn: (d: Draft) => Draft) => {
    if (!draft) return;
    setDraft(fn(draft));
    setDirty(true);
  };
  const setLine = (i: number, patch: Partial<DraftLine>) => edit((d) => ({ ...d, lines: d.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));
  // A lab tick changes nothing the server checks, so it does not ask for "Check again".
  const setLab = (i: number, labTest: boolean) => draft && setDraft({ ...draft, lines: draft.lines.map((l, k) => (k === i ? { ...l, labTest } : l)) });
  const fromPdf = !!draft?.processOrder;
  const labCount = draft?.lines.filter((l) => l.labTest).length ?? 0;
  const needsCheck = dirty;
  // Leaving after a file was read (and maybe corrected) asks first, so the work is not lost by a stray click.
  const [confirmLeave, setConfirmLeave] = useState(false);
  const requestClose = () => (draft ? setConfirmLeave(true) : onClose());

  return (
    <Dialog open onOpenChange={(v) => !v && requestClose()}>
      <DialogContent className="w-[min(1240px,calc(100vw-32px))]">
        <DialogTitle>Upload process order</DialogTitle>
        <DialogDescription>Process order PDF (printed from SAP) or a CSV. Check what was read, correct anything wrong, tick the ingredients that go for lab test, then approve.</DialogDescription>

        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed border-blue-300 bg-mist/60 p-4">
          {file?.kind === 'pdf' ? <FileText className="size-8 text-navy" /> : <FileSpreadsheet className="size-8 text-navy" />}
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{file ? file.name : 'No file chosen'}</div>
            <div className="text-sm text-muted">
              PDF: the PROCESS ORDER sheet with its MATERIAL INPUT table (not a scanned photo). CSV: Seq, Ingredient Code, Quantity, Unit, Tolerance Minus, Tolerance Plus, Remarks, Lab Test.{' '}
              <a href="/api/supervisor/formulas/import/template.csv" className="font-semibold text-navy underline">
                CSV template
              </a>
            </div>
          </div>
          <input ref={fileRef} type="file" accept=".pdf,application/pdf,.csv,text/csv" className="hidden" onChange={(e) => void pick(e.target.files?.[0]).finally(() => (e.target.value = ''))} />
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
            {preview.isPending ? <Loader2 className="animate-spin" /> : <Upload />} {file ? 'Choose another file' : 'Choose PDF or CSV'}
          </Button>
        </div>
        {readError && <ErrorBox className="mt-3" error={new Error(readError)} />}

        {p && draft && (
          <div className="mt-5 grid gap-4">
            {draft.processOrder && (
              <section className="rounded-xl border border-line p-4">
                <h3 className="mb-3 font-display text-lg font-bold text-navy">Process order as read from the PDF (correct it if needed)</h3>
                <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                  {PROCESS_ORDER_FIELDS.map((f) => (
                    <label key={f.key} className="grid gap-1 text-xs">
                      <span className="font-semibold text-muted">{f.label}</span>
                      <input
                        value={draft.processOrder![f.key]}
                        maxLength={80}
                        onChange={(e) => edit((d) => ({ ...d, processOrder: { ...d.processOrder!, [f.key]: e.target.value } }))}
                        className={cn(fieldCls, 'h-9 text-sm')}
                      />
                    </label>
                  ))}
                </div>
              </section>
            )}

            <div className="grid gap-3 md:grid-cols-4">
              {(
                [
                  ['perfumeName', fromPdf ? 'Product name' : 'Perfume name'],
                  ['code', fromPdf ? 'Formula code (material no.)' : 'Formula code'],
                  ['revision', fromPdf ? 'Revision (process order no.)' : 'Revision'],
                  ['sopNumber', 'SOP number (optional)'],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="grid gap-1 text-sm">
                  <span className="font-semibold">{label}</span>
                  <input
                    value={draft.meta[k]}
                    onChange={(e) => edit((d) => ({ ...d, meta: { ...d.meta, [k]: e.target.value } }))}
                    maxLength={k === 'revision' ? 20 : k === 'code' ? 40 : 80}
                    className={fieldCls}
                  />
                </label>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="text-muted">Ingredients </span>
                <b>{draft.lines.length}</b>
              </span>
              <span>
                <span className="text-muted">Total batch </span>
                <b>{g(p.batchSizeMg)} g</b>
              </span>
              <span className={cn('flex items-center gap-1', WARN_TEXT)}>
                <FlaskConical className="size-4" /> <b>{labCount}</b> for lab test
              </span>
              <span className={cn('font-semibold', p.ok && !needsCheck ? 'text-ok' : 'text-err')}>
                {needsCheck ? 'Changed. Press “Check again”.' : p.ok ? 'Ready to approve' : `${p.errors.length + lineErrors} problem${p.errors.length + lineErrors === 1 ? '' : 's'} to fix`}
              </span>
            </div>

            {(p.errors.length > 0 || p.warnings.length > 0) && (
              <ul className="grid gap-1.5">
                {p.errors.map((e) => (
                  <li key={e} className="flex items-start gap-2 rounded-lg bg-err-100 px-3 py-2 text-sm font-semibold text-err">
                    <XCircle className="mt-0.5 size-4 shrink-0" /> {e}
                  </li>
                ))}
                {p.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-2 rounded-lg bg-warn-100 px-3 py-2 text-sm font-semibold text-[#8a5a00]">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}

            <div className="max-h-[46vh] overflow-auto rounded-xl border border-line">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 bg-mist text-muted">
                  <tr>
                    {['#', 'Lab test', 'Material code', 'Ingredient', 'Storage loc.', 'Batch', 'Req qty', 'UoM', 'Tolerance − / +', 'Check'].map((h) => (
                      <th key={h} className="whitespace-nowrap px-2 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {draft.lines.map((d, i) => {
                    const l = p.lines.find((x) => x.row === d.row);
                    return (
                      <tr key={d.row} className={cn('align-top', d.labTest ? 'bg-warn-100/60' : l?.errors.length ? 'bg-err-100/50' : '')}>
                        <td className="px-2 py-2 font-mono text-muted">{i + 1}</td>
                        <td className="px-2 py-2">
                          <label className={cn('flex cursor-pointer items-center gap-1.5 whitespace-nowrap font-semibold', WARN_TEXT)}>
                            <input type="checkbox" className="size-5 accent-[#8a5a00]" checked={d.labTest} onChange={(e) => setLab(i, e.target.checked)} />
                            Lab
                          </label>
                        </td>
                        <td className="w-36 px-2 py-2">
                          <input value={d.ingredientCode} maxLength={40} onChange={(e) => setLine(i, { ingredientCode: e.target.value.toUpperCase() })} className={cellCls} />
                        </td>
                        <td className="min-w-48 px-2 py-2">
                          <div className="font-semibold">{l?.ingredientName ?? <span className="text-err">Not in ingredient list</span>}</div>
                          {d.description && <div className="text-xs text-muted">PDF: {d.description}</div>}
                        </td>
                        <td className="w-24 px-2 py-2">
                          <input value={d.storageLocation ?? ''} maxLength={40} onChange={(e) => setLine(i, { storageLocation: e.target.value || null })} className={cellCls} />
                        </td>
                        <td className="w-32 px-2 py-2">
                          <input value={d.sourceBatch ?? ''} maxLength={40} onChange={(e) => setLine(i, { sourceBatch: e.target.value || null })} className={cellCls} />
                        </td>
                        <td className="w-28 px-2 py-2">
                          <input value={d.quantity} maxLength={30} inputMode="decimal" onChange={(e) => setLine(i, { quantity: e.target.value })} className={cn(cellCls, 'text-right')} />
                        </td>
                        <td className="w-20 px-2 py-2">
                          <select value={d.unit.toUpperCase()} onChange={(e) => setLine(i, { unit: e.target.value })} className={cellCls}>
                            {['KG', 'G', 'MG', ...(['KG', 'G', 'MG'].includes(d.unit.toUpperCase()) ? [] : [d.unit.toUpperCase()])].map((u) => (
                              <option key={u}>{u}</option>
                            ))}
                          </select>
                        </td>
                        <td className="w-48 px-2 py-2">
                          <div className="flex gap-1">
                            <input value={d.tolMinus} maxLength={30} aria-label="Tolerance minus" onChange={(e) => setLine(i, { tolMinus: e.target.value })} className={cn(cellCls, 'text-right')} />
                            <input value={d.tolPlus} maxLength={30} aria-label="Tolerance plus" onChange={(e) => setLine(i, { tolPlus: e.target.value })} className={cn(cellCls, 'text-right')} />
                          </div>
                          {l?.tolMinusMg != null && l.tolPlusMg != null && <div className="mt-0.5 text-xs text-muted">−{g(l.tolMinusMg)} / +{g(l.tolPlusMg)} g</div>}
                        </td>
                        <td className="min-w-40 px-2 py-2">
                          {l && l.errors.length === 0 && l.warnings.length === 0 && <CheckCircle2 className="size-5 text-ok" />}
                          {l?.errors.map((e) => (
                            <div key={e} className="font-semibold text-err">
                              {e}
                            </div>
                          ))}
                          {l?.warnings.map((w) => (
                            <div key={w} className={WARN_TEXT}>
                              {w}
                            </div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              <b>Lab test:</b> ticked ingredients start as <i>skipped</i>. The operator weighs everything else; the job then waits until you press <i>Lab ingredient arrived</i>, and the operator adds it at the end. Tolerance is in the line&apos;s unit (default ±1%).
            </p>
          </div>
        )}

        {err && <ErrorBox className="mt-4" error={err} />}

        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          <Button variant="ghost" onClick={requestClose}>
            Cancel
          </Button>
          {needsCheck ? (
            <Button variant="outline" onClick={() => draft && check.mutate(draft)} disabled={busy}>
              {check.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again
            </Button>
          ) : (
            <Button variant="primary" className="h-11 px-5" disabled={!p?.ok || busy} onClick={() => approve.mutate()}>
              {approve.isPending ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} Approve &amp; use for a job
            </Button>
          )}
        </div>
        <p className="mt-3 text-right text-xs text-muted">Approving is recorded under your name with the original file. It then appears in the formula list, selected for this job.</p>
        <ConfirmDialog
          open={confirmLeave}
          title="Discard this upload?"
          description={`${file?.name ?? 'The file'} has not been approved.${dirty || labCount ? ' Your corrections and lab ticks will be lost.' : ''}`}
          confirmLabel="Discard"
          onConfirm={() => {
            setConfirmLeave(false);
            onClose();
          }}
          onClose={() => setConfirmLeave(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
