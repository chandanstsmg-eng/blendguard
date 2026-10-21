import { useEffect, useRef } from 'react';
import { Beaker, Check, FlaskConical, PauseCircle } from 'lucide-react';
import { ingredientColor, inkOn } from '@/components/visual/Bottle';
import { useT } from '@/lib/i18n';
import { cn, pad2 } from '@/lib/utils';
import type { RunStep } from '@shared/types';

/**
 * Left panel: every bottle in the job as a coloured number, top to bottom.
 * Read-only: the operator cannot pick a step; only the current one is lit.
 * Bottles the supervisor skipped for the lab report are marked in amber.
 */
export function SequenceList({ steps }: { steps: RunStep[] }) {
  const t = useT();
  const currentRef = useRef<HTMLLIElement>(null);
  const currentSeq = steps.find((s) => s.status === 'CURRENT' || s.status === 'ON_HOLD')?.seq;

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentSeq]);

  return (
    <nav aria-label={t('run.sequence')} className="flex min-h-0 flex-1 flex-col bg-white">
      <h2 className="shrink-0 border-b border-line px-5 py-3 font-display text-lg font-bold uppercase text-muted">{t('run.sequence')}</h2>
      <ol className="min-h-0 flex-1 overflow-y-auto p-2">
        {steps.map((s) => {
          const current = s.status === 'CURRENT';
          const hold = s.status === 'ON_HOLD';
          const done = s.status === 'COMPLETED';
          const skipped = s.status === 'SKIPPED';
          const color = ingredientColor(s.ingredientCode, s.colorHex);
          return (
            <li
              key={s.id}
              ref={current || hold ? currentRef : undefined}
              aria-current={current || hold ? 'step' : undefined}
              className={cn(
                'mb-1.5 flex items-center gap-3 rounded-xl px-2.5 py-2',
                current && 'bg-navy text-white shadow-[inset_6px_0_0_0_#D98236]',
                hold && 'bg-err text-white',
                done && 'text-muted',
                s.status === 'LOCKED' && 'text-muted opacity-70',
                skipped && 'border-2 border-dashed border-warn bg-warn-100 text-[#8a5a00]',
              )}
              title={skipped ? t('lab.skippedHint') : undefined}
            >
              <span
                className={cn('grid size-12 shrink-0 place-items-center rounded-lg border-2 font-mono text-lg font-bold', done ? 'border-ok bg-ok text-white' : skipped ? 'border-warn bg-white text-[#8a5a00]' : 'border-navy-900/30')}
                style={done || skipped ? undefined : { background: color, color: inkOn(color) }}
                aria-hidden
              >
                {done ? <Check className="size-7" strokeWidth={3} /> : hold ? <PauseCircle className="size-7" /> : skipped ? <FlaskConical className="size-7" /> : pad2(s.seq)}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span lang="en" className={cn('line-clamp-2 break-words hyphens-auto', current || hold ? 'text-lg font-bold' : 'font-semibold', done && 'line-through decoration-2')}>{s.ingredientName}</span>
                {skipped && <span className="block truncate text-sm font-bold uppercase">{t('step.SKIPPED')}</span>}
              </span>
              {s.containerNo != null && (
                <span className={cn('flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 font-mono text-sm font-bold', current || hold ? 'bg-white/20' : 'bg-mist text-navy')} title={t('container.n', { n: s.containerNo })}>
                  <Beaker className="size-3.5" aria-hidden />
                  {s.containerNo}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
