import { Check, PackageSearch, Scale } from 'lucide-react';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { StepStage } from '@shared/types';

/** Three pictures: take the bottle (find + scan are one screen) → weigh → done. */
const STAGES: { stage: StepStage; icon: typeof Check }[] = [
  { stage: 'FIND', icon: PackageSearch },
  { stage: 'WEIGH', icon: Scale },
  { stage: 'DONE', icon: Check },
];

export function StageTracker({ stage, className }: { stage: StepStage; className?: string }) {
  const t = useT();
  const idx = STAGES.findIndex((s) => s.stage === (stage === 'SCAN' ? 'FIND' : stage));
  return (
    <ol className={cn('flex items-center gap-2', className)} aria-label={t('stage.steps')}>
      {STAGES.map(({ stage: s, icon: Icon }, i) => {
        const state = i < idx ? 'done' : i === idx ? 'now' : 'next';
        return (
          <li key={s} className="flex flex-1 items-center gap-2" aria-current={state === 'now' ? 'step' : undefined}>
            <span
              className={cn(
                'flex h-14 flex-1 items-center justify-center gap-2 rounded-xl px-2 font-display text-2xl font-bold uppercase tracking-wide short:h-12 short:text-xl',
                state === 'done' && 'bg-ok-100 text-ok',
                state === 'now' && 'bg-navy text-white',
                state === 'next' && 'bg-mist text-muted',
              )}
            >
              <span className={cn('grid size-9 place-items-center rounded-full', state === 'now' ? 'bg-orange text-navy-900' : state === 'done' ? 'bg-ok text-white' : 'bg-white')}>
                {state === 'done' ? <Check className="size-6" strokeWidth={3} /> : <Icon className="size-6" />}
              </span>
              <span className="hidden sm:inline">{t(`stage.${s}` as TKey)}</span>
            </span>
            {i < STAGES.length - 1 && <span className={cn('h-1.5 w-4 rounded-full', i < idx ? 'bg-ok' : 'bg-line')} aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}
