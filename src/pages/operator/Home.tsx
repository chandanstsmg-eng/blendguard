import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { ArrowRight, ClipboardList, Clock, FlaskConical, Hourglass, Loader2, Play, RotateCcw, Send, StickyNote, TestTubes, UserRound } from 'lucide-react';
import { OperatorHeader, TrainingRibbon } from '@/components/operator/OperatorHeader';
import { DeveloperCredit } from '@/components/Logo';
import { CallBanner, CallSupervisorButton } from '@/components/operator/CallSupervisor';
import { RepeatButton, useSayOnEnter } from '@/components/operator/Voice';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useMe } from '@/hooks/useMe';
import { api, ApiError } from '@/lib/api';
import { feedback } from '@/lib/audio';
import { errorText, useT, type TKey } from '@/lib/i18n';
import { cn, fmtTime } from '@/lib/utils';
import { markOpenedInApp } from './Run';
import type { JobCard, RunState, StepStatus } from '@shared/types';

export function useJobs(history = false) {
  return useQuery({ queryKey: ['jobs', history], queryFn: () => api.get<JobCard[]>(`/operator/jobs${history ? '?history=1' : ''}`), refetchInterval: 30_000 });
}

function greeting(t: ReturnType<typeof useT>) {
  const h = new Date().getHours();
  return t(h < 12 ? 'home.morning' : h < 17 ? 'home.afternoon' : 'home.evening');
}

/**
 * Operator home: the next job and one big button. Batch numbers, formula codes
 * and revisions are for the supervisor's records and are not shown here.
 */
export function OperatorHome() {
  const t = useT();
  const { data: me } = useMe();
  const jobs = useJobs();
  const list = jobs.data ?? [];
  const job = list[0];

  const homeVoice = !job ? 'say.noJob' : job.status === 'AWAITING_LAB' ? (job.labReady ? 'say.labReady' : 'say.waitLab') : 'say.home';
  useSayOnEnter(jobs.isLoading ? null : homeVoice, undefined, jobs.isLoading ? null : `${job?.id ?? 'none'}|${homeVoice}`, 600);

  return (
    <div className="flex h-full flex-col">
      <OperatorHeader />
      <TrainingRibbon />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 p-5 lg:p-8 short:gap-4 short:lg:p-5 tiny:gap-3 tiny:lg:p-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="font-display text-5xl font-bold text-navy short:text-4xl tiny:text-3xl">
              {greeting(t)}, {me?.user?.name.split(' ')[0]}
            </h1>
            <div className="flex items-center gap-3">
              <CallBanner />
              <RepeatButton />
            </div>
          </div>

          {jobs.isLoading ? (
            <div className="grid h-80 place-items-center rounded-3xl bg-white">
              <Loader2 className="size-12 animate-spin text-navy" />
            </div>
          ) : job ? (
            <div className="grid gap-6 short:gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
              <AssignedJob job={job} />
              <div className="flex flex-col gap-4">
                <CallSupervisorButton size="xl" className="min-h-32" reasons={['HELP', 'SCALE_PROBLEM', 'OTHER']} />
                {list.length > 1 && <MyJobsButton count={list.length - 1} />}
              </div>
            </div>
          ) : (
            <NoJob />
          )}
        </div>
        <DeveloperCredit className="mx-auto max-w-6xl justify-end px-5 pb-4 lg:px-8 short:hidden" />
      </main>
    </div>
  );
}

function AssignedJob({ job }: { job: JobCard }) {
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const start = useMutation({
    // The job card carries no version: read the current one (React Query's copy if fresh) so the server can refuse a stale start.
    mutationFn: async () => {
      const current = await qc.fetchQuery({ queryKey: ['run', job.id], queryFn: () => api.get<RunState>(`/batches/${job.id}/run`), staleTime: 0 });
      return api.post<RunState>(`/batches/${job.id}/start`, { version: current.version });
    },
    onSuccess: (run) => {
      feedback('success');
      qc.setQueryData(['run', run.id], run);
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      markOpenedInApp(job.id);
      nav(`/operator/run/${job.id}`);
    },
    onError: () => feedback('error'),
  });

  const started = job.status !== 'ASSIGNED';
  const err = start.error as ApiError | null;
  // The button always says what pressing it does; the job's state is the badge in the title bar.
  const action =
    job.status === 'ASSIGNED'
      ? { label: t('home.startJob'), icon: <Play className="fill-current" />, variant: 'primary' as const }
      : job.status === 'AWAITING_SUBMISSION'
        ? { label: t('complete.submit'), icon: <Send />, variant: 'success' as const }
        : job.status === 'IN_PROGRESS' || job.status === 'PAUSED'
          ? { label: t('home.resumeJob'), icon: <RotateCcw />, variant: 'primary' as const }
          : job.status === 'AWAITING_LAB' && job.labReady
            ? { label: t('lab.continue'), icon: <Play className="fill-current" />, variant: 'primary' as const }
            : { label: t('home.openJob'), icon: <ArrowRight />, variant: 'navy' as const };

  return (
    <section className="overflow-hidden rounded-3xl border border-line bg-white shadow-sm" aria-labelledby="assigned">
      <div className="flex items-center justify-between gap-3 bg-navy px-6 py-4 text-white">
        <h2 id="assigned" className="flex items-center gap-3 font-display text-3xl font-bold">
          <FlaskConical className="size-8 text-orange" />
          {t('home.assignedJob')}
        </h2>
        <div className="flex flex-wrap justify-end gap-2">
          {started && <StatusPill status={job.status} />}
          {job.isBackup && (
            <Badge tone="neutral" size="lg">
              <UserRound /> {t('home.backup')}
            </Badge>
          )}
        </div>
      </div>
      <div className="p-6 short:py-4 tiny:py-3">
        <div className="font-display text-6xl font-bold leading-tight text-navy lg:text-7xl short:lg:text-6xl tiny:lg:text-5xl">{job.perfumeName}</div>

        <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-3 text-2xl font-semibold text-ink">
          <span className="flex items-center gap-2">
            <FlaskConical className="size-7 text-orange-600" />
            {started ? t('home.progress', { done: job.completedCount, total: job.ingredientCount }) : t('home.bottles', { n: job.ingredientCount })}
          </span>
          {job.plannedStart && (
            <span className="flex items-center gap-2 text-muted">
              <Clock className="size-7" />
              {fmtTime(job.plannedStart)}
            </span>
          )}
          {job.skippedCount > 0 && (
            <span className="flex items-center gap-2 rounded-xl bg-warn-100 px-3 py-1 text-[#8a5a00]">
              <TestTubes className="size-7" />
              {t('lab.homeNote', { n: job.skippedCount })}
            </span>
          )}
        </div>
        <div className="mt-4 flex h-6 gap-1" aria-hidden>
          {job.stepStatuses.map((st, i) => (
            <span key={i} className={cn('flex-1 rounded-md', STEP_BAR[st])} />
          ))}
        </div>

        {job.instructions && (
          <div className="mt-6 flex items-start gap-4 rounded-2xl border-l-8 border-orange bg-orange-100 px-5 py-4 short:mt-4 short:py-2 tiny:mt-3">
            <StickyNote className="mt-1 size-8 shrink-0 text-orange-600" />
            <div>
              <div className="text-sm font-bold text-[#8a4a12]">{t('home.instructions')}</div>
              <p className="mt-1 text-2xl text-ink">{job.instructions}</p>
            </div>
          </div>
        )}
        {err && (
          <p role="alert" className="mt-5 rounded-xl bg-err px-4 py-3 text-2xl font-bold text-white">
            {errorText(t.lang, err.code, err.message)}
          </p>
        )}
        <Button
          size="xl"
          variant={action.variant}
          className="mt-7 min-h-36 w-full text-6xl short:mt-5 short:min-h-24 short:text-5xl tiny:mt-3 tiny:min-h-20 [&_svg]:size-14"
          disabled={start.isPending}
          onClick={() => (job.status === 'ASSIGNED' || job.labReady ? start.mutate() : (markOpenedInApp(job.id), nav(`/operator/run/${job.id}`)))}
        >
          {start.isPending ? <Loader2 className="animate-spin" /> : action.icon}
          {action.label}
        </Button>
      </div>
    </section>
  );
}

/** Progress bar colours, the same as the bar on the job screen. */
export const STEP_BAR: Record<StepStatus, string> = { COMPLETED: 'bg-ok', CURRENT: 'bg-orange', ON_HOLD: 'bg-err', SKIPPED: 'bg-warn', LOCKED: 'bg-mist' };

export function StatusPill({ status }: { status: JobCard['status'] }) {
  const t = useT();
  const tone = status === 'ASSIGNED' ? 'navy' : status === 'IN_PROGRESS' || status === 'AWAITING_SUBMISSION' ? 'ok' : status === 'PAUSED' || status === 'ON_HOLD' || status === 'AWAITING_LAB' ? 'warn' : status === 'REJECTED' ? 'err' : 'neutral';
  return (
    <Badge tone={tone} size="lg">
      {t(`status.${status}` as TKey)}
    </Badge>
  );
}

function MyJobsButton({ count }: { count: number }) {
  const t = useT();
  const nav = useNavigate();
  return (
    <Button variant="navy" size="xl" className="min-h-28 justify-between" onClick={() => nav('/operator/jobs')}>
      <span className="flex items-center gap-3">
        <ClipboardList />
        {t('home.myJobs')}
      </span>
      <span className="grid size-14 place-items-center rounded-full bg-orange font-mono text-3xl text-navy-900">{count}</span>
    </Button>
  );
}

function NoJob() {
  const t = useT();
  return (
    <section className="flex flex-col items-center rounded-3xl border-4 border-dashed border-line bg-white px-8 py-14 text-center">
      <Hourglass className="size-28 text-blue-300" strokeWidth={1.4} />
      <h2 className="mt-6 font-display text-6xl font-bold text-navy">{t('home.noJob')}</h2>
      <p className="mt-3 max-w-xl text-3xl text-muted">{t('home.noJobHint')}</p>
      <div className="mt-10 w-full max-w-lg">
        <CallSupervisorButton size="xl" className="min-h-28" reasons={['NO_JOB', 'HELP', 'OTHER']} />
      </div>
    </section>
  );
}
