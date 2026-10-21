import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, FlaskConical, Loader2, Lock, MonitorCheck, RefreshCw, Scale, ShieldAlert, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { resetSocket, useFloorScaleStore } from '@/lib/socket';
import { useMe } from '@/hooks/useMe';
import { cn, fmtDateTime, fmtTime, g } from '@/lib/utils';
import { ConfirmDialog, ErrorBox, Field, inputCls } from '../admin/ui';
import { PageHeader, useOverview } from './Console';
import { LANGUAGE_LABEL, SCALE_FAULT_TEXT } from './labels';
import type { Overview } from './types';

type Station = Overview['stations'][number];

export function Stations() {
  const { data, isLoading, isError, error, refetch, isFetching } = useOverview();
  return (
    <>
      <PageHeader title="Scale checks" subtitle="The daily scale check for each station, and which computer works as which station." />
      <div className="grid gap-6 p-8 2xl:grid-cols-2">
        {isLoading && [0, 1].map((i) => <div key={i} className="h-80 animate-pulse rounded-xl border border-line bg-white" />)}
        {!data && isError && (
          <div className="grid justify-items-start gap-3 2xl:col-span-2">
            <ErrorBox error={error} />
            <Button variant="outline" disabled={isFetching} onClick={() => void refetch()}>
              <RefreshCw className={cn(isFetching && 'animate-spin')} /> Try again
            </Button>
          </div>
        )}
        {data && data.stations.length === 0 && (
          <p className="rounded-xl border border-dashed border-line bg-white p-10 text-center text-muted 2xl:col-span-2">No stations are set up yet. Add one under Setup → Station setup.</p>
        )}
        {data?.stations.map((s) => <StationCard key={s.id} s={s} />)}
      </div>
    </>
  );
}

/** Same names as the Station setup page. */
function SettingsSummary({ s }: { s: Station }) {
  const signIn = [s.allowFingerprint && 'Fingerprint', s.allowFace && 'Face', s.allowPin && 'Operator ID + PIN', s.allowAssisted && 'Scientist-assisted'].filter(Boolean).join(', ') || 'None';
  const rows: [string, React.ReactNode][] = [
    ['Sign-in methods', signIn],
    ['Default language', LANGUAGE_LABEL[s.defaultLanguage] ?? s.defaultLanguage],
    ['Save weight automatically', <OnOff key="a" on={s.autoAccept} />],
    ['Operators may pause a job', <OnOff key="p" on={s.allowPause} />],
    ['Sound cues', <OnOff key="s" on={s.audioEnabled} />],
    ['Sign operator out when idle', s.idleMinutes ? `After ${s.idleMinutes} min` : 'Never'],
  ];
  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Station settings</h3>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 rounded-lg bg-mist px-4 py-3 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="font-semibold break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 flex items-center gap-1.5 text-sm text-muted">
        <Lock className="size-4" /> Changed under Setup → Station setup.
      </p>
    </section>
  );
}

function OnOff({ on }: { on: boolean }) {
  return <span className={on ? 'text-ok' : 'text-muted'}>{on ? 'On' : 'Off'}</span>;
}

function StationCard({ s }: { s: Station }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const here = me?.station?.id === s.id;
  const [confirmBind, setConfirmBind] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['overview'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
  const bind = useMutation({
    mutationFn: () => api.post(`/supervisor/stations/${s.id}/bind`),
    onSuccess: () => {
      setConfirmBind(false);
      resetSocket();
      refresh();
    },
  });

  return (
    <article className="@container min-w-0 rounded-xl border border-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-bold text-navy">{s.name}</h2>
          <div className="text-sm text-muted">
            {s.code} · {s.scaleModel}
          </div>
        </div>
        {here ? (
          <Badge tone="ok" size="lg">
            <MonitorCheck /> This computer
          </Badge>
        ) : (
          <Button size="sm" variant="outline" onClick={() => (bind.reset(), setConfirmBind(true))}>
            <MonitorCheck /> Use this computer as {s.code}
          </Button>
        )}
      </header>
      <div className="grid gap-6 p-6 @3xl:grid-cols-2">
        <SettingsSummary s={s} />
        <ScaleCheck s={s} onDone={refresh} />
      </div>
      <ConfirmDialog
        open={confirmBind}
        title={`Use this computer as ${s.code}?`}
        description={`This computer becomes ${s.name}. Any other computer set up as ${s.code} stops working as that station.`}
        confirmLabel={`Set up as ${s.code}`}
        tone="navy"
        pending={bind.isPending}
        error={bind.error}
        onConfirm={() => bind.mutate()}
        onClose={() => setConfirmBind(false)}
      />
    </article>
  );
}

type CheckResult = { pass: boolean; errorMg: number; observedMg: number; simulated: boolean };

/**
 * The daily check, read from the scale itself: 1) empty pan, read the zero;
 * 2) put the reference weight on, check. Nothing typed here is a weight
 * except the reference weight's nominal value from its certificate.
 */
function ScaleCheck({ s, onDone }: { s: Station; onDone: () => void }) {
  const live = useFloorScaleStore((x) => x.byStation[s.id]);
  const connected = live ? live.connected : s.scaleConnected;
  const gross = live ? (live.connected ? live.grossMg : null) : s.scaleGrossMg;
  const stable = live ? live.stable : s.scaleStable;
  const fault = connected ? null : live ? (live.fault ?? null) : s.scaleFault;
  const sim = s.scaleMode === 'SIMULATED';

  const [ref, setRef] = useState('200.00');
  const [note, setNote] = useState('');
  const [zero, setZero] = useState<{ zeroMg: number; at: string } | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const refMg = Math.round(Number(ref) * 1000);
  const refOk = Number.isFinite(refMg) && refMg > 0 && refMg <= 100_000_000;

  const readZero = useMutation({
    mutationFn: () => api.post<{ zeroMg: number; at: string }>(`/supervisor/stations/${s.id}/scale-zero`),
    onSuccess: (z) => {
      setZero(z);
      setResult(null);
      check.reset();
    },
  });
  const check = useMutation({
    mutationFn: () => api.post<CheckResult>(`/supervisor/stations/${s.id}/validate-scale`, { referenceMg: refMg, note }),
    onSuccess: (r) => {
      setResult(r);
      setZero(null);
      onDone();
    },
  });

  return (
    <section className="min-w-0">
      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Daily scale check</h3>
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <span className={cn('inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold', s.scaleValidated ? 'bg-ok-100 text-ok' : 'bg-err-100 text-err')}>
          {s.scaleValidated ? <CheckCircle2 className="size-4 shrink-0" /> : <ShieldAlert className="size-4 shrink-0" />}
          {s.scaleValidated ? `Valid until ${fmtDateTime(s.scaleValidatedUntil)}` : 'Check due. Weighing is blocked.'}
        </span>
      </div>

      {/* Live reading, straight from the scale */}
      <div className={cn('mb-3 flex items-center justify-between gap-3 rounded-lg px-4 py-3', connected ? 'bg-navy text-white' : 'bg-err-100 text-err')} aria-live="polite">
        <div className="min-w-0">
          <div className={cn('text-xs font-semibold uppercase tracking-wide', connected ? 'text-blue-300' : '')}>Scale reads now</div>
          <div className="font-mono text-3xl font-bold tabular">{connected && gross != null ? `${g(gross, s.scaleResolutionMg)} g` : 'No reading'}</div>
          {!connected && fault && <div className="mt-1 text-sm font-semibold">{SCALE_FAULT_TEXT[fault]}</div>}
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold', !connected ? '' : stable ? 'text-[#bfe8cf]' : 'text-white/70')}>
          {!connected ? (
            <>
              <Unplug className="size-4" /> Disconnected
            </>
          ) : stable ? (
            <>
              <Scale className="size-4" /> Steady
            </>
          ) : (
            <>
              <Loader2 className="size-4 animate-spin" /> Settling
            </>
          )}
        </span>
      </div>

      {sim && (
        <p className="mb-3 flex items-start gap-2 text-sm text-muted">
          <FlaskConical className="mt-0.5 size-4 shrink-0" /> Training simulator: there is no pan, so the simulator adds the reference weight itself. The check is recorded as simulated.
        </p>
      )}

      <ol className="grid gap-3">
        <li className={cn('rounded-lg border p-3', zero ? 'border-ok bg-ok-100/40' : 'border-line')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="font-semibold">1. Empty the scale, then read the zero</div>
              <div className="text-sm text-muted">{zero ? `Zero read at ${fmtTime(zero.at)}: ${g(zero.zeroMg, s.scaleResolutionMg)} g` : 'Nothing on the pan. Wait until it is steady.'}</div>
            </div>
            <Button size="sm" variant={zero ? 'outline' : 'navy'} disabled={readZero.isPending || !connected} onClick={() => readZero.mutate()}>
              {readZero.isPending ? <Loader2 className="animate-spin" /> : zero ? <RefreshCw /> : <CircleDashed />} {zero ? 'Read again' : 'Read zero'}
            </Button>
          </div>
          <ErrorBox error={readZero.error} className="mt-2 text-sm" />
        </li>
        <li className={cn('rounded-lg border p-3', !zero && 'opacity-60')}>
          <div className="font-semibold">2. Place the {refOk ? g(refMg, s.scaleResolutionMg) : '…'} g reference weight, then check</div>
          <div className="mt-2 grid gap-3 @md:grid-cols-[10rem_minmax(0,1fr)]">
            <Field label="Reference weight (g)" hint="From its certificate">
              <input inputMode="decimal" value={ref} onChange={(e) => setRef(e.target.value)} className={cn(inputCls, 'font-mono')} aria-invalid={!refOk} />
            </Field>
            <Field label="Note (weight set, certificate no.)">
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={inputCls} />
            </Field>
          </div>
          <Button size="sm" variant="navy" className="mt-3" disabled={!zero || !refOk || check.isPending || !connected} onClick={() => check.mutate()}>
            {check.isPending ? <Loader2 className="animate-spin" /> : <Scale />} Check
          </Button>
          <ErrorBox error={check.error} className="mt-2 text-sm" />
        </li>
      </ol>
      <p className="mt-2 text-xs text-muted">
        Resolution {g(s.scaleResolutionMg)} g. The check passes when the scale is within ±{g(s.scaleUncertaintyMg)} g of the reference weight.
      </p>

      {result && (
        <p role="status" className={cn('mt-3 rounded-md px-3 py-2 text-sm font-semibold', result.pass ? 'bg-ok-100 text-ok' : 'bg-err-100 text-err')}>
          {result.pass
            ? `Passed. The scale read ${g(result.observedMg, s.scaleResolutionMg)} g (off by ${g(result.errorMg, s.scaleResolutionMg)} g). Valid for 24 hours.`
            : `Failed. The scale read ${g(result.observedMg, s.scaleResolutionMg)} g, off by ${g(result.errorMg, s.scaleResolutionMg)} g. Nobody can weigh here until a check passes.`}
        </p>
      )}
    </section>
  );
}
