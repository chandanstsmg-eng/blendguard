import { useEffect, useRef, useState } from 'react';
import { AlertOctagon, BellRing, CheckCircle2, CircleDot, FlaskConical, Maximize, Minimize, PauseCircle, ShieldAlert, Timer, Unplug, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { CompanyLogo, DeveloperCredit } from '@/components/Logo';
import { cue } from '@/lib/audio';
import { useFloorScaleStore, useSocketStatus } from '@/lib/socket';
import { cn, fmtTime, g } from '@/lib/utils';
import { errMsg } from '../admin/ui';
import { useCallActions } from './callActions';
import { useFullscreen, useOverview } from './Console';
import { REASON, SCALE_FAULT_SHORT, STAGE_LABEL, STATUS_LABEL, holdLabel, isHeld, mss, openCallCount } from './labels';
import type { Overview } from './types';
import type { ScaleState } from '@shared/types';

type Station = Overview['stations'][number];
type Call = Overview['calls'][number];

/** Re-renders every `ms` so clocks and step timers tick. */
function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const holdKey = (s: Station) => (s.current && isHeld(s.current) ? `${s.current.batchId}:${s.current.stepSeq ?? '-'}:${s.current.holdReason ?? s.current.status}` : null);

/**
 * Wall/desk display for the control room: one large tile per station with
 * live weight, plus an alerts column. Readable from a few metres away.
 */
export function FloorMonitor() {
  const { data, isLoading, isError } = useOverview();
  const byStation = useFloorScaleStore((s) => s.byStation);
  const online = useSocketStatus();
  const now = useNow();
  const { on: fullscreen, toggle: toggleFullscreen } = useFullscreen();
  const [sound, setSound] = useState(true);
  const calls = useCallActions();

  // Sound once for each NEW open call or NEW hold, never for what was already there on first load.
  const seenCalls = useRef<Set<string> | null>(null);
  const seenHolds = useRef<Set<string> | null>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  useEffect(() => {
    if (!data) return;
    const calls = new Set(data.calls.filter((c) => c.status === 'OPEN').map((c) => c.id));
    const holds = new Set(data.stations.map(holdKey).filter((k): k is string => !!k));
    const newCall = seenCalls.current !== null && [...calls].some((id) => !seenCalls.current!.has(id));
    const newHold = seenHolds.current !== null && [...holds].some((k) => !seenHolds.current!.has(k));
    seenCalls.current = calls;
    seenHolds.current = holds;
    if (!soundRef.current) return;
    if (newHold) cue('error');
    else if (newCall) cue('warning');
  }, [data]);

  if (isLoading || !data) {
    return (
      <div className="grid min-h-full place-items-center bg-navy-900 text-white">
        <div className="text-center">
          <div className="mx-auto mb-4 size-12 animate-spin rounded-full border-4 border-white/20 border-t-orange" />
          <p className="text-xl text-blue-300">{isError ? 'Cannot reach the BlendGuard server. Retrying…' : 'Loading the floor…'}</p>
        </div>
      </div>
    );
  }

  const callCount = openCallCount(data);
  const held = data.stations.filter((s) => isHeld(s.current));
  const active = data.stations.filter((s) => s.current).length;
  const waiting = data.counts.ASSIGNED ?? 0;
  const callByStation = new Map<string, Call>();
  for (const c of data.calls) if (c.status === 'OPEN' || !callByStation.has(c.stationCode)) callByStation.set(c.stationCode, c);

  const n = data.stations.length;
  // Tiles never get narrower than ~26rem; the grid adds columns as the screen allows.
  const cols = n <= 1 ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(min(100%,26rem),1fr))]';
  const clock = new Date(now);

  return (
    <div className="flex min-h-full flex-col bg-navy-900 text-white">
      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-white/10 bg-[#0c2230] px-6 py-4">
        <div>
          <div className="font-display text-5xl font-bold leading-none tabular">{clock.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}</div>
          <div className="mt-1 text-blue-300">{clock.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Counter label="Active stations" value={`${active}/${n}`} />
          <Counter label="Open calls" value={callCount} tone={callCount ? 'warn' : undefined} />
          <Counter label="On hold" value={held.length} tone={held.length ? 'err' : undefined} />
          <Counter label="Jobs waiting" value={waiting} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!online && (
            <span className="mr-2 inline-flex items-center gap-2 rounded-lg bg-err/20 px-3 py-2 font-semibold text-[#ffb4b4]">
              <WifiOff className="size-5" /> Connection lost. Reconnecting…
            </span>
          )}
          <button
            onClick={() => {
              const next = !sound;
              setSound(next);
              if (next) cue('tap'); // also unlocks audio in the browser
            }}
            className={cn('inline-flex h-12 items-center gap-2 rounded-lg px-4 font-semibold', sound ? 'bg-white/10 hover:bg-white/20' : 'bg-warn text-navy-900 hover:brightness-105')}
            aria-pressed={!sound}
          >
            {sound ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
            {sound ? 'Sound on' : 'Muted'}
          </button>
          <button onClick={toggleFullscreen} className="inline-flex h-12 items-center gap-2 rounded-lg bg-white/10 px-4 font-semibold hover:bg-white/20">
            {fullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
            {fullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </header>

      <div className="grid flex-1 gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Station tiles */}
        {n === 0 ? (
          <div className="grid place-items-center rounded-2xl border-2 border-dashed border-white/15 p-12 text-center text-xl text-blue-300">No stations are set up yet. Add one under Setup → Station setup.</div>
        ) : (
          <div className={cn('grid content-start gap-5', cols)}>
            {data.stations.map((s) => (
              <StationTile key={s.id} s={s} live={byStation[s.id]} call={callByStation.get(s.code)} now={now} />
            ))}
          </div>
        )}

        {/* Alerts column */}
        <aside className="flex flex-col gap-4">
          <h2 className="flex items-center gap-2 font-display text-2xl font-bold">
            <BellRing className="size-6 text-orange" /> Alerts
          </h2>
          {held.map((s) => (
            <div key={s.id} className="rounded-xl border-2 border-err bg-[#3a1519] p-4">
              <div className="flex items-center gap-2 text-lg font-bold text-[#ffb4b4]">
                <AlertOctagon className="size-5" /> {s.name} · {holdLabel(s.current!)}
              </div>
              <p className="mt-1 text-white/80">
                {s.current!.operator}
                {s.current!.stepSeq ? ` · ingredient #${s.current!.stepSeq}` : ''}. Go to the station for scientist sign-off.
              </p>
            </div>
          ))}
          {data.calls.map((c) => (
            <div key={c.id} className={cn('rounded-xl border-2 p-4', c.status === 'OPEN' ? 'border-warn bg-[#3a2c0e]' : 'border-white/15 bg-white/5')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-bold">{c.stationName}</div>
                  <div className={cn('text-lg', c.status === 'OPEN' ? 'text-[#ffd98a]' : 'text-white/85')}>
                    {REASON[c.reason] ?? c.reason}
                    {c.seq ? ` · #${c.seq}` : ''}
                  </div>
                  <div className="mt-1 text-sm text-blue-300">
                    {c.raisedBy} · {fmtTime(c.createdAt)} · waiting {mss((now - new Date(c.createdAt).getTime()) / 1000)}
                  </div>
                </div>
                <span className={cn('shrink-0 rounded-md px-2 py-1 text-sm font-bold', c.status === 'OPEN' ? 'bg-warn text-navy-900' : 'bg-ok/30 text-[#bfe8cf]')}>{c.status === 'OPEN' ? 'OPEN' : 'On the way'}</span>
              </div>
              <div className="mt-3 flex gap-2">
                {c.status === 'OPEN' && (
                  <button
                    disabled={calls.busy}
                    onClick={() => calls.acknowledge(c)}
                    className="h-11 flex-1 rounded-lg bg-orange px-3 font-bold text-navy-900 hover:bg-orange-600 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange/50 disabled:opacity-60"
                  >
                    I&apos;m on my way
                  </button>
                )}
                <button
                  disabled={calls.busy}
                  onClick={() => calls.requestClose(c)}
                  className="h-11 flex-1 rounded-lg border-2 border-white/30 px-3 font-semibold hover:bg-white/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange/50 disabled:opacity-60"
                >
                  Close…
                </button>
              </div>
            </div>
          ))}
          {held.length === 0 && data.calls.length === 0 && (
            <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-5 text-lg text-[#bfe8cf]">
              <CheckCircle2 className="size-6 shrink-0" /> All clear. Nobody is waiting for you.
            </div>
          )}
          {calls.error && (
            <p role="alert" className="flex items-start justify-between gap-3 rounded-lg bg-err/20 p-3 font-semibold text-[#ffb4b4]">
              {errMsg(calls.error)}
              <button onClick={calls.dismissError} className="shrink-0 text-sm underline">
                Dismiss
              </button>
            </p>
          )}
        </aside>
      </div>
      {/* Full screen hides the console sidebar, so the logos move here. */}
      {fullscreen && (
        <footer className="flex items-center justify-between gap-4 border-t border-white/10 bg-[#0c2230] px-6 py-3">
          <span className="rounded-lg bg-white px-3 py-1.5">
            <CompanyLogo className="h-8" />
          </span>
          <DeveloperCredit dark />
        </footer>
      )}
      {calls.dialog}
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number | string; tone?: 'warn' | 'err' }) {
  return (
    <div className={cn('min-w-32 rounded-xl px-4 py-2', tone === 'err' ? 'bg-err text-white' : tone === 'warn' ? 'bg-warn text-navy-900' : 'bg-white/10')}>
      <div className={cn('text-sm font-semibold', tone ? 'opacity-90' : 'text-blue-300')}>{label}</div>
      <div className="font-display text-4xl font-bold leading-tight tabular">{value}</div>
    </div>
  );
}

function Chip({ tone, children }: { tone: 'err' | 'warn' | 'info' | 'ok'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-sm leading-tight font-bold [&_svg]:size-4 [&_svg]:shrink-0',
        tone === 'err' && 'bg-err text-white',
        tone === 'warn' && 'bg-warn text-navy-900',
        tone === 'info' && 'bg-white/15 text-white',
        tone === 'ok' && 'bg-ok text-white',
      )}
    >
      {children}
    </span>
  );
}

function StationTile({ s, live, call, now }: { s: Station; live: ScaleState | undefined; call: Call | undefined; now: number }) {
  const c = s.current;
  const held = isHeld(c);
  const openCall = call?.status === 'OPEN';
  const scaleConnected = live ? live.connected : s.scaleConnected;
  const gross = live ? (live.connected ? live.grossMg : null) : s.scaleGrossMg;
  const stable = live ? live.stable : s.scaleStable;
  const fault = scaleConnected ? null : live ? (live.fault ?? null) : s.scaleFault;
  const pct = c && c.total ? Math.round((c.done / c.total) * 100) : 0;

  return (
    <article
      className={cn(
        '@container relative min-w-0 overflow-hidden rounded-2xl border-[3px] p-5',
        held ? 'border-err bg-[#3a1519]' : openCall ? 'border-warn bg-[#33280f]' : c ? 'border-white/15 bg-navy' : 'border-white/10 bg-white/[0.04] text-white/70',
      )}
    >
      {held && <div aria-hidden className="animate-bin pointer-events-none absolute inset-0 bg-err/25" />}
      <div className="relative">
        <div className="flex flex-col gap-2 @md:flex-row @md:items-start @md:justify-between @md:gap-3">
          <div className="min-w-0">
            <div className="truncate font-display text-3xl font-bold leading-tight @lg:text-4xl">{s.name}</div>
            <div className="text-blue-300">{s.code}</div>
          </div>
          <div className="flex min-w-0 flex-wrap gap-1.5 @md:max-w-[60%] @md:justify-end">
            {s.scaleMode === 'SIMULATED' && (
              <Chip tone="info">
                <FlaskConical /> Training
              </Chip>
            )}
            {!scaleConnected && (
              <Chip tone="err">
                <Unplug /> {fault ? SCALE_FAULT_SHORT[fault] : 'Scale disconnected'}
              </Chip>
            )}
            {!s.scaleValidated && (
              <Chip tone="warn">
                <ShieldAlert /> Scale check due
              </Chip>
            )}
          </div>
        </div>

        {!c ? (
          <div className="mt-6 flex items-center gap-3 text-2xl text-white/60">
            <CircleDot className="size-6" /> Idle, no job running
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-4">
              <div className="text-2xl font-semibold">{c.operator}</div>
              <div className="text-lg text-white/80">
                {c.perfumeName} <span className="font-mono text-base text-blue-300">{c.batchNo}</span>
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-1 flex justify-between text-lg">
                <span className="text-blue-300">Progress</span>
                <span className="font-bold tabular">
                  {c.done} / {c.total}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-orange transition-[width] duration-500" style={{ width: `${pct}%` }} />
              </div>
            </div>

            {held ? (
              <div className="mt-4 flex items-center gap-3 rounded-xl bg-err px-4 py-3 text-2xl font-bold">
                <AlertOctagon className="size-8 shrink-0" />
                <span className="min-w-0">
                  ON HOLD · {holdLabel(c)}
                  {c.stepSeq && c.stepStatus === 'ON_HOLD' ? <span className="block text-lg font-semibold">at #{c.stepSeq} {c.ingredient}</span> : null}
                </span>
              </div>
            ) : c.status === 'PAUSED' ? (
              <div className="mt-4 flex items-center gap-3 rounded-xl bg-white/10 px-4 py-3 text-2xl font-bold">
                <PauseCircle className="size-7" /> {STATUS_LABEL.PAUSED}
              </div>
            ) : c.stepSeq ? (
              <div className="mt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 text-2xl font-bold break-words @lg:text-3xl">
                    <span className="text-orange">#{c.stepSeq}</span> {c.ingredient}
                  </div>
                  {c.stepStage && <Chip tone={c.stepStage === 'WEIGH' ? 'ok' : 'info'}>{STAGE_LABEL[c.stepStage] ?? c.stepStage}</Chip>}
                </div>
                {c.stepStage === 'WEIGH' && c.targetMg != null && (
                  <LiveWeight gross={gross} tare={c.tareGrossMg} target={c.targetMg} tolMinus={c.tolMinusMg} tolPlus={c.tolPlusMg} stable={stable} res={s.scaleResolutionMg} connected={scaleConnected} />
                )}
              </div>
            ) : (
              <div className="mt-4 text-2xl font-semibold text-white/80">{STATUS_LABEL[c.status]}</div>
            )}

            {c.stepStartedAt && !held && c.status !== 'PAUSED' && (
              <div className="mt-3 flex items-center gap-2 text-lg text-blue-300">
                <Timer className="size-5" /> On this ingredient <span className="font-bold text-white tabular">{mss((now - new Date(c.stepStartedAt).getTime()) / 1000)}</span>
              </div>
            )}
          </>
        )}

        {call && (
          <div className={cn('mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-lg font-semibold', openCall ? 'bg-warn text-navy-900' : 'bg-white/10')}>
            <BellRing className="size-5 shrink-0" />
            <span className="min-w-0">
              {openCall ? 'Calling: ' : 'You are on the way: '}
              {REASON[call.reason] ?? call.reason}
            </span>
          </div>
        )}
      </div>
    </article>
  );
}

function LiveWeight({
  gross,
  tare,
  target,
  tolMinus,
  tolPlus,
  stable,
  res,
  connected,
}: {
  gross: number | null;
  tare: number | null;
  target: number;
  tolMinus: number | null;
  tolPlus: number | null;
  stable: boolean;
  res: number;
  connected: boolean;
}) {
  if (!connected || gross == null) return <div className="mt-3 text-xl text-white/60">Target {g(target, res)} g · no scale reading</div>;
  if (tare == null) return <div className="mt-3 text-xl text-white/70">Target {g(target, res)} g · waiting for the container to be set to zero</div>;
  const net = gross - tare;
  // The line's own tolerance (the operator's screen and the server use the same limits).
  const low = target - (tolMinus ?? 0);
  const high = target + (tolPlus ?? 0);
  const inTol = net >= low && net <= high;
  const over = net > high;
  const fill = target > 0 ? Math.min(100, Math.max(0, (net / target) * 100)) : 0;
  return (
    <div className="mt-3 rounded-xl bg-black/25 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className={cn('font-mono text-4xl font-bold tabular @lg:text-5xl', inTol ? 'text-[#7fe0a6]' : over ? 'text-[#ff9a9a]' : 'text-[#ffc95c]')}>
          {g(net, res)} <span className="text-xl text-white/70 @lg:text-2xl">/ {g(target, res)} g</span>
        </div>
        <span className={cn('text-sm font-semibold', stable ? 'text-[#bfe8cf]' : 'text-white/60')}>{stable ? 'Stable' : 'Settling…'}</span>
      </div>
      {tolMinus != null && tolPlus != null && (
        <div className="mt-1 text-sm text-white/60 tabular">
          Allowed {g(low, res)} to {g(high, res)} g
        </div>
      )}
      <div className="mt-2 h-4 overflow-hidden rounded-full bg-white/15">
        <div className={cn('h-full rounded-full transition-[width] duration-200', inTol ? 'bg-ok' : over ? 'bg-err' : 'bg-warn')} style={{ width: `${fill}%` }} />
      </div>
    </div>
  );
}
