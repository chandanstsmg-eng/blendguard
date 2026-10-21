import { useNavigate } from 'react-router';
import { motion } from 'framer-motion';
import { CheckCircle2, FlaskConical, Home, Loader2, PackageCheck, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CallSupervisorButton } from '@/components/operator/CallSupervisor';
import { RepeatButton } from '@/components/operator/Voice';
import { IngredientPicture } from '@/components/visual/Bottle';
import { useT } from '@/lib/i18n';
import { cn, pad2 } from '@/lib/utils';
import type { RunState } from '@shared/types';

/**
 * Every bottle the operator could do is done; one or more went for lab test.
 * The job waits here (the station is free for other jobs). When a lab bottle
 * comes back, the operator presses ARRIVED next to it (or the scientist marks
 * it at the desk), then one big button continues.
 */
export function LabWaitPanel({ run, busy, error, onContinue, onArrived }: { run: RunState; busy: boolean; error: string | null; onContinue: () => void; onArrived: (seq: number) => void }) {
  const t = useT();
  const nav = useNavigate();
  const waiting = run.steps.filter((s) => s.status === 'SKIPPED');
  const ready = run.steps.filter((s) => s.status === 'LOCKED');
  const done = run.steps.filter((s) => s.status === 'COMPLETED').length;
  const isReady = ready.length > 0;
  const row = (s: RunState['steps'][number], arrived: boolean) => (
    <li key={s.id} className={cn('flex items-center gap-4 rounded-xl px-4 py-3 text-2xl', arrived ? 'bg-ok-100' : 'bg-warn-100')}>
      <IngredientPicture code={s.ingredientCode} name={s.ingredientName} colorHex={s.colorHex} photoUrl={s.photoUrl} className="size-14 border-2" />
      <span className="font-mono text-muted">{pad2(s.seq)}</span>
      <span className="min-w-0 flex-1 truncate font-semibold">{s.ingredientName}</span>
      {arrived ? (
        <span className="rounded-md bg-ok px-3 py-1 text-lg font-bold text-white">{t('lab.arrived')}</span>
      ) : (
        <Button variant="success" size="lg" className="min-h-16 shrink-0 px-5 text-2xl short:min-h-14" disabled={busy} onClick={() => onArrived(s.seq)}>
          <PackageCheck />
          {t('lab.markArrived')}
        </Button>
      )}
    </li>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 p-5 lg:p-8 short:gap-4 short:p-4">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn('flex flex-col items-center gap-4 rounded-3xl p-8 text-center short:gap-2 short:p-5', isReady ? 'bg-ok text-white' : 'border-4 border-warn bg-warn-100 text-navy')}
        role="status"
      >
        {isReady ? <CheckCircle2 className="size-28 short:size-20" strokeWidth={1.8} /> : <FlaskConical className="size-28 text-[#8a5a00] short:size-20" strokeWidth={1.6} />}
        <div className="font-display text-6xl font-bold uppercase leading-tight short:text-5xl">{isReady ? t('lab.readyTitle') : t('lab.title')}</div>
        <div className="text-3xl font-semibold short:text-2xl">{isReady ? t('lab.readyBody') : t('lab.body')}</div>
        <div className="text-2xl font-semibold opacity-80">{t('run.progress', { done, total: run.steps.length })}</div>
      </motion.div>

      {ready.length > 0 && (
        <section className="rounded-3xl border border-line bg-white p-5">
          <h2 className="font-display text-2xl font-bold uppercase text-muted">{t('lab.readyList')}</h2>
          <ul className="mt-3 grid gap-2">{ready.map((s) => row(s, true))}</ul>
        </section>
      )}
      {waiting.length > 0 && (
        <section className="rounded-3xl border border-line bg-white p-5">
          <h2 className="font-display text-2xl font-bold uppercase text-muted">{t('lab.waiting')}</h2>
          <ul className="mt-3 grid gap-2">{waiting.map((s) => row(s, false))}</ul>
        </section>
      )}

      {error && (
        <p role="alert" className="rounded-2xl bg-err px-5 py-3 text-2xl font-bold text-white">
          {error}
        </p>
      )}

      <div className="mt-auto grid gap-4">
        {isReady ? (
          <div className="grid gap-4 md:grid-cols-[auto_1fr]">
            <RepeatButton className="min-h-32 short:min-h-24" />
            <Button variant="primary" size="xl" className="min-h-32 w-full text-5xl short:min-h-24 [&_svg]:size-12" disabled={busy} onClick={onContinue}>
              {busy ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
              {t('lab.continue')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <Button variant="navy" size="xl" className="min-h-28 w-full text-4xl short:min-h-20" onClick={() => nav('/operator')}>
              <Home />
              {t('complete.backHome')}
            </Button>
            <CallSupervisorButton batchId={run.id} size="xl" className="min-h-28 short:min-h-20" reasons={['HELP', 'OTHER']} />
          </div>
        )}
      </div>
    </div>
  );
}
