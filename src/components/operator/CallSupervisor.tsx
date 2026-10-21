import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BellRing, CheckCircle2, CircleHelp, ClipboardX, Hand, LifeBuoy, Loader2, PackageSearch, Scale, TriangleAlert, UserRoundCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { feedback } from '@/lib/audio';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Reason = 'CANNOT_FIND' | 'WRONG_BOTTLE' | 'SCALE_PROBLEM' | 'HELP' | 'NO_JOB' | 'OTHER';

/** A picture for every reason, so it can be chosen without reading. */
const REASON_ICON: Record<Reason, typeof Hand> = {
  CANNOT_FIND: PackageSearch,
  WRONG_BOTTLE: TriangleAlert,
  SCALE_PROBLEM: Scale,
  HELP: LifeBuoy,
  NO_JOB: ClipboardX,
  OTHER: CircleHelp,
};

export function useOpenCall() {
  return useQuery({ queryKey: ['call'], queryFn: () => api.get<{ id: string; status: 'OPEN' | 'ACKNOWLEDGED'; reason: string } | null>('/station/call'), refetchInterval: 20_000 });
}

/** Big "CALL SUPERVISOR" button with a reason picker. Shows the call status once raised. */
export function CallSupervisorButton({
  batchId,
  seq,
  reasons = ['CANNOT_FIND', 'WRONG_BOTTLE', 'SCALE_PROBLEM', 'HELP', 'OTHER'],
  size = 'lg',
  className,
}: {
  batchId?: string | null;
  seq?: number | null;
  reasons?: Reason[];
  size?: 'lg' | 'xl';
  className?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const call = useOpenCall();
  const raise = useMutation({
    mutationFn: (reason: Reason) => api.post('/calls', { batchId: batchId ?? null, seq: seq ?? null, reason }),
    onError: () => feedback('error'),
    onSuccess: () => {
      feedback('warning', 'say.supervisorCalled');
      void qc.invalidateQueries({ queryKey: ['call'] });
      setOpen(false);
    },
  });

  const active = call.data;
  return (
    <>
      <Button
        variant={active ? 'navy' : 'outline'}
        size={size}
        // Longer states ("Supervisor called. Stay here.") wrap into two even lines instead of one long and one short.
        className={cn('w-full text-balance leading-tight', className)}
        onClick={() => (active ? undefined : setOpen(true))}
        aria-live="polite"
      >
        {active ? active.status === 'ACKNOWLEDGED' ? <UserRoundCheck /> : <BellRing className="animate-pulse" /> : <Hand />}
        {active ? (active.status === 'ACKNOWLEDGED' ? t('home.callAck') : t('home.callSent')) : t('callSupervisor')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) raise.reset();
        }}
      >
        <DialogContent className="w-[min(820px,calc(100vw-32px))]">
          <DialogTitle className="flex items-center gap-3 text-4xl">
            <BellRing className="size-10 text-orange-600" />
            {t('call.why')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('call.title')}</DialogDescription>
          {/* A failed call is shown at the top, big and red: the operator must not think help is coming. */}
          {raise.isError && (
            <p role="alert" className="mt-5 flex items-center gap-3 rounded-xl bg-err px-5 py-3 text-2xl font-bold text-white">
              <AlertTriangle className="size-8 shrink-0" />
              {t('call.failed')}
            </p>
          )}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {reasons.map((r) => {
              const Icon = REASON_ICON[r];
              return (
                <button
                  key={r}
                  disabled={raise.isPending}
                  onClick={() => raise.mutate(r)}
                  className="flex min-h-36 flex-col items-center justify-center gap-3 rounded-2xl border-4 border-navy bg-white p-4 text-center font-display text-3xl font-bold leading-tight text-navy shadow-[0_4px_0_0_#17394C] hover:bg-mist active:translate-y-0.5 disabled:opacity-50"
                >
                  {raise.isPending && raise.variables === r ? <Loader2 className="size-14 animate-spin text-orange-600" /> : <Icon className="size-14 text-orange-600" />}
                  {t(`call.${r}` as TKey)}
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CallBanner() {
  const t = useT();
  const call = useOpenCall();
  if (!call.data) return null;
  const ack = call.data.status === 'ACKNOWLEDGED';
  return (
    <div className={cn('flex items-center gap-3 rounded-xl px-5 py-3 text-lg font-semibold', ack ? 'bg-ok-100 text-ok' : 'bg-warn-100 text-[#8a5a00]')} role="status">
      {ack ? <CheckCircle2 className="size-7" /> : <BellRing className="size-7 animate-pulse" />}
      {ack ? t('home.callAck') : t('home.callSent')}
    </div>
  );
}
