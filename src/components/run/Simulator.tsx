import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, FlaskConical, Plug, ScanBarcode, Unplug } from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn, g } from '@/lib/utils';
import type { RunStep, ScaleState, SimBottle } from '@shared/types';

/**
 * TRAINING ONLY. Shown only on stations whose scale is the simulator. Stands
 * in for the physical scale and barcode scanner so the full workflow can be
 * practised. Every reading it produces is tagged SIMULATED by the server and
 * the batch is marked as a training record.
 */
export function Simulator({ batchId, step, scale, onScan }: { batchId: string; step: RunStep; scale: ScaleState | null; onScan: (barcode: string) => void }) {
  const t = useT();
  // Starts folded on shorter screens so the bottle list keeps most of the column; one tap opens it.
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerHeight > 900);
  const picking = step.stage === 'FIND' || step.stage === 'SCAN';
  const bottles = useQuery({
    queryKey: ['sim-bottles', batchId, step.seq],
    queryFn: () => api.get<SimBottle[]>(`/batches/${batchId}/sim-bottles`),
    enabled: picking,
  });
  const sim = (body: object) => void api.post('/station/scale/sim', body).catch(() => {});
  const net = scale?.grossMg != null && step.tareGrossMg != null ? scale.grossMg - step.tareGrossMg : null;
  const remaining = net != null ? step.targetMg - net : null;

  return (
    // Sits at the bottom of the bottle-list column (not floating over it), so the list is never hidden.
    <section className={cn('no-print m-2 flex min-h-0 shrink-0 flex-col rounded-2xl border-2 border-dashed border-warn bg-[#fffaf0]', open && 'max-h-[60%]')} aria-label={t('sim.title')}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex h-12 w-full shrink-0 items-center gap-2 px-3 text-left text-base font-bold text-[#8a5a00]">
        <FlaskConical className="size-5" />
        {t('sim.title')}
        <span className="ml-auto">{open ? <ChevronDown className="size-5" /> : <ChevronUp className="size-5" />}</span>
      </button>
      {open && (
        <div className="grid min-h-0 gap-3 overflow-y-auto border-t border-warn/40 p-3 text-base">
          {picking && (
            <div>
              <div className="mb-1 font-semibold text-muted">{t('sim.scanBottle')}</div>
              <div className="grid gap-1.5">
                {(bottles.data ?? []).map((b) => (
                  <button
                    key={b.barcode}
                    onClick={() => onScan(b.barcode)}
                    className={cn('flex min-h-12 items-center gap-2 rounded-lg border-2 px-2 py-2 text-left font-medium hover:bg-white', b.hint === 'correct' ? 'border-ok/60' : 'border-err/50')}
                  >
                    <ScanBarcode className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{b.label}</span>
                    <span className={cn('text-sm font-bold', b.hint === 'correct' ? 'text-ok' : 'text-err')}>{b.hint === 'correct' ? t('sim.right') : b.hint === 'wrong' ? t('sim.wrong') : t('sim.badLot')}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="mb-1 flex items-center justify-between font-semibold text-muted">
              <span>{t('sim.scale')}</span>
              <span className="font-mono text-ink">{scale?.connected ? `${g(scale.grossMg ?? 0)} g` : t('sim.off')}</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <SimBtn onClick={() => sim({ action: 'vessel', on: !scale?.vesselOn })}>{scale?.vesselOn ? t('sim.liftVessel') : t('sim.placeVessel')}</SimBtn>
              <SimBtn onClick={() => sim({ action: 'connect', on: !scale?.connected })}>
                {scale?.connected ? (
                  <>
                    <Unplug className="size-4" /> {t('sim.unplug')}
                  </>
                ) : (
                  <>
                    <Plug className="size-4" /> {t('sim.plugIn')}
                  </>
                )}
              </SimBtn>
            </div>
            {step.stage === 'WEIGH' && step.tareGrossMg != null && (
              <>
                <div className="mb-1 mt-2 font-semibold text-muted">{t('sim.pour')}</div>
                <div className="grid grid-cols-4 gap-1.5">
                  {[50_000, 10_000, 1_000, 100].map((mg) => (
                    <SimBtn key={mg} onClick={() => sim({ action: 'pour', mg })}>
                      +{mg >= 1000 ? mg / 1000 : (mg / 1000).toFixed(1)}
                    </SimBtn>
                  ))}
                  <SimBtn onClick={() => sim({ action: 'pour', mg: 10 })}>+0.01</SimBtn>
                  <SimBtn onClick={() => sim({ action: 'remove', mg: 100 })}>−0.1</SimBtn>
                  <SimBtn onClick={() => sim({ action: 'remove', mg: 1000 })}>−1</SimBtn>
                  <SimBtn className="border-ok text-ok" disabled={remaining == null || remaining <= 0} onClick={() => remaining && sim({ action: 'pour', mg: remaining })}>
                    {t('sim.exact')}
                  </SimBtn>
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <SimBtn disabled={remaining == null || remaining <= 0} onClick={() => remaining && sim({ action: 'pour', mg: Math.round((remaining * 0.97) / 10) * 10 })}>
                    {t('sim.pour97')}
                  </SimBtn>
                  <SimBtn className="border-err text-err" onClick={() => sim({ action: 'pour', mg: Math.round(step.targetMg * 0.03 + 600) })}>
                    {t('sim.overpour')}
                  </SimBtn>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SimBtn({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn('flex min-h-12 items-center justify-center gap-1 rounded-lg border-2 border-line bg-white px-1 font-semibold text-ink hover:border-navy disabled:opacity-40', className)}
      {...props}
    />
  );
}
