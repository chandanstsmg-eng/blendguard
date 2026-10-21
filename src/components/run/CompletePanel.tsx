import { useState } from 'react';
import { useNavigate } from 'react-router';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, Home, Hourglass, Loader2, PartyPopper, Send, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CallSupervisorButton } from '@/components/operator/CallSupervisor';
import { RepeatButton } from '@/components/operator/Voice';
import { useMe } from '@/hooks/useMe';
import { feedback } from '@/lib/audio';
import { useT, type TKey } from '@/lib/i18n';
import { downloadWorkReport } from '@/lib/workReport';
import { cn, fmtDuration, fmtTime } from '@/lib/utils';
import type { RunState } from '@shared/types';

/**
 * End of the job: one big green button to send it to the supervisor. The
 * record details (batch, formula, times) are folded away for the supervisor.
 * After sending, the batch is locked.
 */
export function CompletePanel({ run, busy, error, onSubmit }: { run: RunState; busy: boolean; error: string | null; onSubmit: () => void }) {
  const t = useT();
  const nav = useNavigate();
  const { data: me } = useMe();
  const submitted = run.status !== 'AWAITING_SUBMISSION';
  const approved = run.status === 'APPROVED';
  const open = run.deviations.filter((d) => !d.resolvedAt);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const download = async () => {
    setSaving(true);
    try {
      await downloadWorkReport(run, me?.user ?? null, me?.station ?? null);
      feedback('success');
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-5 lg:p-8 short:gap-4 short:p-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn('flex flex-col items-center gap-4 rounded-3xl p-8 text-center text-white short:gap-2 short:p-5', submitted && !approved ? 'bg-navy' : 'bg-ok')}
      >
        <motion.div initial={{ scale: 0.4, rotate: -10 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 220, damping: 12 }}>
          {approved ? (
            <ShieldCheck className="size-32 short:size-20" strokeWidth={1.6} />
          ) : submitted ? (
            <PartyPopper className="size-32 short:size-20" strokeWidth={1.6} />
          ) : (
            <CheckCircle2 className="size-32 short:size-20" strokeWidth={1.8} />
          )}
        </motion.div>
        <div className="font-display text-6xl font-bold uppercase leading-tight short:text-5xl">{approved ? t('complete.approved') : submitted ? t('complete.submitted') : t('complete.title')}</div>
        <div className="text-3xl font-semibold opacity-90 short:text-2xl">{approved ? t('complete.approvedBody') : submitted ? t('complete.thanks') : run.perfumeName}</div>
      </motion.div>

      {run.simulated && (
        <div className="flex items-center gap-3 rounded-2xl bg-warn-100 px-5 py-3 text-xl font-semibold text-[#8a5a00]">
          <AlertTriangle className="size-7" />
          {t('complete.training')}
        </div>
      )}

      {run.deviations.length > 0 && (
        <section className="rounded-3xl border border-line bg-white p-5">
          <h2 className="font-display text-2xl font-bold uppercase text-muted">{t('complete.deviations')}</h2>
          <ul className="mt-3 grid gap-2">
            {run.deviations.map((d) => (
              <li key={d.id} className={cn('flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-xl', d.resolvedAt ? 'bg-ok-100' : 'bg-err-100')}>
                {d.resolvedAt ? <ShieldCheck className="size-8 text-ok" /> : <Hourglass className="size-8 text-err" />}
                <span className="font-semibold">{t(`call.${d.type}` as TKey)}</span>
                <span className="font-mono text-muted">#{d.seq}</span>
                <span className={cn('ml-auto rounded-md px-3 py-1 text-lg font-bold', d.resolvedAt ? 'bg-ok text-white' : 'bg-err text-white')}>
                  {d.resolvedAt ? t('complete.resolved') : t('complete.open')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-2xl bg-err px-5 py-3 text-2xl font-bold text-white">
          {error}
        </p>
      )}

      <div className="mt-auto grid gap-4">
        {submitted ? (
          <Button variant="navy" size="xl" className="min-h-32 w-full text-5xl" onClick={() => nav('/operator')}>
            <Home />
            {t('complete.backHome')}
          </Button>
        ) : open.length > 0 ? (
          <>
            <p className="rounded-2xl bg-warn-100 px-5 py-4 text-center text-2xl font-bold text-[#8a5a00]">{t('complete.waitProblems')}</p>
            <CallSupervisorButton batchId={run.id} size="xl" className="min-h-28" reasons={['HELP']} />
          </>
        ) : (
          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <RepeatButton className="min-h-32" />
            <Button variant="success" size="xl" className="min-h-32 w-full text-5xl [&_svg]:size-12" disabled={busy} onClick={onSubmit}>
              {busy ? <Loader2 className="animate-spin" /> : <Send />}
              {t('complete.submit')}
            </Button>
          </div>
        )}
        {/* Work summary: what was weighed, when it finished and how long it took. */}
        <Button variant="outline" size="lg" className="min-h-20 w-full text-3xl" disabled={saving} onClick={() => void download()}>
          {saving ? <Loader2 className="animate-spin" /> : <Download />}
          {t('complete.download')}
        </Button>
        {saved && (
          <p role="status" className="text-center text-xl font-semibold text-ok">
            {t('complete.downloaded')}
          </p>
        )}
      </div>

      {/* The record, for the scientist. Folded so the operator sees only the button. */}
      <details className="group rounded-2xl border border-line bg-white">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-lg font-semibold text-muted">
          <ChevronDown className="size-5 transition-transform group-open:rotate-180" />
          {t('complete.details')}
        </summary>
        <dl className="grid grid-cols-2 gap-4 border-t border-line p-5 md:grid-cols-4">
          <Item label={t('home.perfume')} value={run.perfumeName} />
          <Item label={t('home.batch')} value={<span className="font-mono">{run.batchNo}</span>} />
          <Item label={t('home.formula')} value={<span className="font-mono">{run.formulaCode} · {t('home.revision')} {run.revision}</span>} />
          <Item label={t('home.ingredients')} value={`${run.steps.filter((s) => s.status === 'COMPLETED').length} / ${run.steps.length}`} />
          <Item label={t('complete.started')} value={fmtTime(run.startedAt)} />
          <Item label={t('complete.finished')} value={fmtTime(run.completedAt)} />
          <Item label={t('complete.duration')} value={fmtDuration(run.startedAt, run.completedAt)} />
          <Item label={t('complete.approval')} value={submitted ? t(`status.${run.status}` as TKey) : t('complete.notSubmitted')} />
        </dl>
      </details>
    </div>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
    </div>
  );
}
