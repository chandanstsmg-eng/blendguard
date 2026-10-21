import { useNavigate } from 'react-router';
import { AlertTriangle, ArrowLeft, ChevronRight, Clock, Loader2, Lock, RotateCcw } from 'lucide-react';
import { OperatorHeader, TrainingRibbon } from '@/components/operator/OperatorHeader';
import { Button } from '@/components/ui/button';
import { useJobs, StatusPill, STEP_BAR } from './Home';
import { errorText, useT } from '@/lib/i18n';
import type { ApiError } from '@/lib/api';
import { cn, fmtTime } from '@/lib/utils';
import { markOpenedInApp } from './Run';

const OPENABLE = new Set(['IN_PROGRESS', 'PAUSED', 'ON_HOLD', 'AWAITING_SUBMISSION', 'AWAITING_LAB']);

/** Every job for this operator here: perfume, how far along, and a lock on the ones that must wait. */
export function MyJobs() {
  const t = useT();
  const nav = useNavigate();
  const jobs = useJobs(true);

  return (
    <div className="flex h-full flex-col">
      <OperatorHeader />
      <TrainingRibbon />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl p-5 lg:p-8 short:lg:p-5">
          <div className="mb-6 flex items-center gap-4 short:mb-4">
            <Button variant="outline" size="xl" className="min-h-20 short:min-h-16" onClick={() => nav('/operator')}>
              <ArrowLeft />
              {t('back')}
            </Button>
            <h1 className="font-display text-5xl font-bold text-navy short:text-4xl">{t('jobs.title')}</h1>
          </div>
          {jobs.isLoading && (
            <div className="grid h-60 place-items-center rounded-3xl bg-white" role="status" aria-label={t('scan.checking')}>
              <Loader2 className="size-12 animate-spin text-navy" />
            </div>
          )}
          {jobs.isError && (
            <div role="alert" className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl bg-err-100 px-5 py-4 text-2xl font-semibold text-err">
              <AlertTriangle className="size-8 shrink-0" />
              <span className="min-w-0 flex-1">{errorText(t.lang, (jobs.error as ApiError).code, '')}</span>
              <Button variant="outline" size="lg" disabled={jobs.isFetching} onClick={() => void jobs.refetch()}>
                {jobs.isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                {t('splash.retry')}
              </Button>
            </div>
          )}
          <ul className="grid gap-4">
            {(jobs.data ?? []).map((j, i) => {
              const canOpen = OPENABLE.has(j.status) || (j.status === 'ASSIGNED' && i === 0);
              return (
                <li key={j.id}>
                  <button
                    disabled={!canOpen}
                    onClick={() => (markOpenedInApp(j.id), nav(j.status === 'ASSIGNED' ? '/operator' : `/operator/run/${j.id}`))}
                    className={cn('flex w-full items-center gap-5 rounded-3xl border-2 bg-white p-5 text-left shadow-sm', canOpen ? 'border-navy hover:bg-mist' : 'cursor-default border-line opacity-70')}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="break-words font-display text-4xl font-bold text-navy">{j.perfumeName}</span>
                      </div>
                      <div className="mt-3 flex h-4 max-w-xl gap-1" aria-hidden>
                        {j.stepStatuses.map((st, n) => (
                          <span key={n} className={cn('flex-1 rounded', STEP_BAR[st])} />
                        ))}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xl text-muted">
                        <span>{t('home.progress', { done: j.completedCount, total: j.ingredientCount })}</span>
                        {j.skippedCount > 0 && <span className="font-semibold text-[#8a5a00]">{t('lab.homeNote', { n: j.skippedCount })}</span>}
                        {j.labReady && <span className="font-semibold text-ok">{t('lab.readyTitle')}</span>}
                        {j.plannedStart && (
                          <span className="flex items-center gap-1.5">
                            <Clock className="size-5" /> {fmtTime(j.plannedStart)}
                          </span>
                        )}
                      </div>
                    </div>
                    <StatusPill status={j.status} />
                    {canOpen ? <ChevronRight className="size-12 text-navy" /> : <Lock className="size-10 text-muted" />}
                  </button>
                </li>
              );
            })}
            {jobs.data?.length === 0 && <li className="rounded-3xl bg-white p-10 text-center text-3xl text-muted">{t('home.noJob')}</li>}
          </ul>
        </div>
      </main>
    </div>
  );
}
