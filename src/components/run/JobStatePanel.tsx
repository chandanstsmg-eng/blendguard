import { useNavigate } from 'react-router';
import { CircleSlash, Home, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CallSupervisorButton } from '@/components/operator/CallSupervisor';
import { RepeatButton } from '@/components/operator/Voice';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The job is open but there is nothing to do on it here: the supervisor sent
 * it back (rejected / needs correction), or it is not running (not started,
 * or no bottle is current). Always offers a way out: home, or call the supervisor.
 */
export function JobStatePanel({ kind, batchId }: { kind: 'sentBack' | 'notRunning'; batchId: string }) {
  const t = useT();
  const nav = useNavigate();
  const sentBack = kind === 'sentBack';
  const Icon = sentBack ? Undo2 : CircleSlash;
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-5 overflow-y-auto rounded-3xl border-4 p-8 text-center short:gap-3 short:p-5',
        sentBack ? 'border-err bg-err-100' : 'border-line bg-white',
      )}
      role="status"
    >
      <Icon className={cn('size-32 shrink-0 short:size-20', sentBack ? 'text-err' : 'text-blue-300')} strokeWidth={1.8} />
      <div className="font-display text-7xl font-bold uppercase leading-tight text-navy short:text-5xl">{sentBack ? t('run.sentBackTitle') : t('run.notRunningTitle')}</div>
      <div className="max-w-3xl text-3xl font-semibold text-ink short:text-2xl">{sentBack ? t('run.sentBackBody') : t('run.notRunningBody')}</div>
      <div className="mt-4 grid w-full max-w-4xl gap-4 short:mt-1 md:grid-cols-[auto_1fr_1fr]">
        <RepeatButton className="min-h-24 short:min-h-16" />
        <Button variant="navy" size="xl" className="min-h-24 short:min-h-16" onClick={() => nav('/operator')}>
          <Home />
          {t('complete.backHome')}
        </Button>
        <CallSupervisorButton batchId={batchId} size="xl" className="min-h-24 short:min-h-16" reasons={['HELP', 'OTHER']} />
      </div>
    </div>
  );
}
