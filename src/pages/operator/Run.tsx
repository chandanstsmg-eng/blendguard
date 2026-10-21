import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { AnimatePresence, motion } from 'framer-motion';
import { Home, Loader2, PauseCircle } from 'lucide-react';
import { OperatorHeader, TrainingRibbon } from '@/components/operator/OperatorHeader';
import { SupervisorSignoff, type SupervisorAction } from '@/components/operator/SupervisorSignoff';
import { Confirm } from '@/components/operator/Confirm';
import { useSayOnEnter } from '@/components/operator/Voice';
import { SequenceList } from '@/components/run/SequenceList';
import { AUTO_SAVE_MS, BatchHoldPanel, DonePanel, EquipmentCheck, isUnusableLot, StepHoldPanel, TakeBottleStage, WeighStage } from '@/components/run/Stages';
import { CompletePanel } from '@/components/run/CompletePanel';
import { JobStatePanel } from '@/components/run/JobStatePanel';
import { LabWaitPanel } from '@/components/run/LabWaitPanel';
import { Simulator } from '@/components/run/Simulator';
import { Button } from '@/components/ui/button';
import { useMe } from '@/hooks/useMe';
import { api, ApiError } from '@/lib/api';
import { alarm, cue, feedback, OVER_ALARM_MS, prefetchSay, say, spokenGrams, stopAlarm } from '@/lib/audio';
import { errorText, useT, type TKey } from '@/lib/i18n';
import { useBarcodeScanner } from '@/lib/scanner';
import { useReconnectCount, useScaleStore } from '@/lib/socket';
import { cn, g } from '@/lib/utils';
import { useActivity } from '@/stores/activity';
import { evaluate } from '@shared/weighing';
import type { AcceptResult, RunState, RunStep, ScaleState, ScanResult } from '@shared/types';

const MAX_AGE_MS = 3000;

/**
 * Jobs opened by in-app navigation during this page load. Kept in memory on purpose:
 * a browser reload clears it, so a reload always asks for the equipment check.
 */
const openedInApp = new Set<string>();
export const markOpenedInApp = (id: string) => openedInApp.add(id);

/**
 * Some spoken instructions wait so they don't cut off the sound that came just before.
 * (A step held for too much poured exists only on jobs from before over-pours stopped
 * being held; its instruction waits for the alarm and "too much by …".)
 */
const VOICE_DELAY: Partial<Record<TKey, number>> = { 'say.placeVessel': 1500, 'say.holdOver': OVER_ALARM_MS + 4000, 'say.holdVessel': 600, 'say.goTo': 900 };

/**
 * The manufacturing console: one bottle, one instruction, one big button.
 * Every action is sent to the server, which decides; the screen shows the
 * server's answer. Nothing advances until the server has committed it.
 */
export function Run() {
  const { id = '' } = useParams();
  const t = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const station = me?.station;

  const run = useQuery({ queryKey: ['run', id], queryFn: () => api.get<RunState>(`/batches/${id}/run`), refetchInterval: 30_000 });
  const scale = useScaleStore((s) => s.scale);
  const setScale = useScaleStore((s) => s.set);

  const [error, setError] = useState<string | null>(null);
  const [scanFail, setScanFail] = useState<Extract<ScanResult, { ok: false }> | null>(null);
  const [justDone, setJustDone] = useState<{ step: Pick<RunStep, 'seq' | 'ingredientCode' | 'ingredientName' | 'colorHex' | 'photoUrl'>; netMg: number; last: boolean } | null>(null);
  const [signoff, setSignoff] = useState<SupervisorAction[] | null>(null);
  const [askPause, setAskPause] = useState(false);
  // Recovery: a reload or a dropped connection in the middle of a job asks for an equipment check first.
  const [needsCheck, setNeedsCheck] = useState(() => !openedInApp.has(id));
  const reconnects = useReconnectCount();
  const firstReconnects = useRef(reconnects);
  useEffect(() => {
    if (reconnects !== firstReconnects.current) setNeedsCheck(true);
  }, [reconnects]);

  // Initial scale reading (afterwards the socket streams it).
  useEffect(() => {
    void api.get<ScaleState>('/station/scale').then(setScale).catch(() => {});
  }, [setScale]);

  // A scale stream that stops counts as disconnected.
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const liveScale: ScaleState | null = scale && Date.now() - scale.at > MAX_AGE_MS + 2000 && !scale.stable ? { ...scale, connected: false } : scale;

  const r = run.data;
  const step = r?.steps.find((s) => s.status === 'CURRENT' || s.status === 'ON_HOLD') ?? null;
  const res = station?.scaleResolutionMg ?? 10;

  // Reset per-step screen state when the step changes.
  const seq = step?.seq;
  const stage = step?.stage;
  // Container chosen for this ingredient before SET TO 0. Once zeroed, the server's recorded number is used.
  const [container, setContainer] = useState<number | null>(null);
  useEffect(() => {
    setScanFail(null);
    setError(null);
  }, [seq, stage]);
  useEffect(() => setContainer(null), [seq]);
  // The container used last (by time: a lab ingredient added later can have a lower number).
  const lastContainer = r ? ([...r.steps].filter((s) => s.status === 'COMPLETED' && s.containerNo != null).sort((a, b) => (a.acceptedAt ?? '').localeCompare(b.acceptedAt ?? '')).at(-1)?.containerNo ?? null) : null;

  const ev = useMemo(() => {
    if (!step || !station) return null;
    return evaluate(
      { connected: !!liveScale?.connected, stable: !!liveScale?.stable, grossMg: liveScale?.grossMg ?? null, at: liveScale?.at ?? 0 },
      step.tareGrossMg,
      step,
      { resolutionMg: station.scaleResolutionMg, uncertaintyMg: station.scaleUncertaintyMg, validated: station.scaleValidated },
    );
  }, [step, station, liveScale]);

  // ── Spoken instruction for each screen, said once when the screen appears. ──
  const tared = step?.tareGrossMg != null;
  const voiceKey: TKey | null = !r
    ? null
    : justDone
      ? null
      : r.status === 'AWAITING_LAB'
        ? r.steps.some((s) => s.status === 'LOCKED')
          ? 'say.labReady'
          : 'say.waitLab'
      : r.status === 'REJECTED' || r.status === 'CORRECTION'
        ? 'say.callSupervisor'
      : r.status === 'PAUSED' || (needsCheck && r.status === 'IN_PROGRESS')
        ? 'say.check'
        : r.status === 'ON_HOLD'
          ? 'say.jobHold'
          : step?.status === 'ON_HOLD'
            ? step.holdReason === 'OVERWEIGHT'
              ? 'say.holdOver'
              : 'say.holdVessel'
            : step?.stage === 'FIND'
              ? step.location
                ? 'say.goTo'
                : 'say.noLocation'
              : step?.stage === 'SCAN'
                ? 'say.scanNow'
                : step?.stage === 'WEIGH' && !tared
                  ? 'say.placeVessel'
                  : null;
  useSayOnEnter(
    voiceKey,
    step?.location ? { rack: step.location.rack.code, bin: step.location.bin } : undefined,
    `${r?.status}|${step?.seq}|${step?.stage}|${step?.status}|${tared}|${needsCheck}|${!!justDone}|${r?.steps.filter((s) => s.status === 'LOCKED').length}`,
    voiceKey ? (VOICE_DELAY[voiceKey] ?? 250) : 250,
  );

  // Get the spoken phrases with numbers (place, weight) ready for this bottle and the next one.
  useEffect(() => {
    if (!r || !step) return;
    const upcoming = [step, r.steps.find((s) => s.status === 'LOCKED' && s.seq > step.seq) ?? r.steps.find((s) => s.status === 'LOCKED')].filter((s): s is RunStep => !!s);
    for (const s of upcoming) {
      if (s.location) prefetchSay('say.goTo', { rack: s.location.rack.code, bin: s.location.bin });
      prefetchSay('say.pour', { g: spokenGrams(g(s.targetMg, res)) });
    }
  }, [step?.seq, t.lang]); // once per bottle and language

  // Spoken guidance while pouring. UNDER / OK / OVER only come from settled
  // readings, so nothing is said while the liquid is still moving; each time the
  // scale settles at a new weight the operator hears how much is left.
  const voice = useRef<{ seq: number | null; said: string | null; remainingMg: number | null; overMg: number | null; alarmAt: number }>({ seq: null, said: null, remainingMg: null, overMg: null, alarmAt: 0 });
  // "Too much by …" waits for the alarm to finish; dropped if the screen closes first.
  const overVoice = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (overVoice.current) clearTimeout(overVoice.current);
      stopAlarm();
    },
    [],
  );
  useEffect(() => {
    if (!ev || !step || step.stage !== 'WEIGH' || step.tareGrossMg == null) return;
    const v = voice.current;
    if (v.seq !== step.seq) Object.assign(v, { seq: step.seq, said: null, remainingMg: null, overMg: null });
    const grams = (mg: number) => spokenGrams(g(Math.abs(mg), res));

    // Too much was added: a 7–8 second alarm so the operator cannot miss it, then the amount
    // over. They take the extra out on their own (no hold); each time the scale settles while
    // still too much, they hear how much is left to take out.
    if (ev.verdict === 'OVER' || (step.status === 'ON_HOLD' && step.holdReason === 'OVERWEIGHT')) {
      const excessMg = ev.netMg != null ? ev.netMg - step.targetMg : null;
      if (v.said !== 'OVER') {
        alarm(OVER_ALARM_MS);
        v.alarmAt = Date.now();
        if (overVoice.current) clearTimeout(overVoice.current);
        if (excessMg != null) overVoice.current = setTimeout(() => say('say.over', { g: grams(excessMg) }), OVER_ALARM_MS + 300);
      } else if (excessMg != null && excessMg !== v.overMg && Date.now() - v.alarmAt > OVER_ALARM_MS + 300) {
        say('say.over', { g: grams(excessMg) });
      }
      v.said = 'OVER';
      v.overMg = excessMg;
      return;
    }
    if (step.status !== 'CURRENT') return;
    // Back in range (or under) after too much: the alarm has done its job.
    if (v.said === 'OVER' && (ev.verdict === 'OK' || ev.verdict === 'UNDER')) {
      stopAlarm();
      if (overVoice.current) clearTimeout(overVoice.current);
    }

    if (ev.verdict === 'OK') {
      if (v.said !== 'OK') feedback('success', 'say.weightCorrect');
      v.said = 'OK';
    } else if (ev.verdict === 'UNDER' && ev.remainingMg != null) {
      if (v.said !== 'UNDER' || v.remainingMg !== ev.remainingMg) {
        const first = v.said == null && ev.remainingMg >= step.targetMg;
        const nearly = ev.remainingMg <= step.targetMg * 0.1;
        say(first ? 'say.pour' : nearly ? 'say.nearly' : 'say.addMore', { g: grams(ev.remainingMg) });
      }
      v.said = 'UNDER';
      v.remainingMg = ev.remainingMg;
    } else if (ev.verdict === 'DISCONNECTED' || ev.verdict === 'NOT_VALIDATED' || ev.verdict === 'CANNOT_CERTIFY') {
      if (v.said !== ev.verdict) feedback('error', 'say.callSupervisor');
      v.said = ev.verdict;
    }
  }, [ev, step, res]);

  const handleError = (e: unknown) => {
    const err = e as ApiError;
    feedback('error');
    if (err instanceof ApiError && (err.code === 'STALE' || err.code === 'WRONG_STAGE' || err.code === 'NOT_CURRENT_STEP')) void run.refetch();
    setError(err instanceof ApiError ? errorText(t.lang, err.code, err.message) : t('err.GENERIC'));
  };
  const put = (next: RunState) => qc.setQueryData(['run', id], next);

  const post = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: object }) => api.post<unknown>(`/batches/${id}${path}`, { version: r?.version, ...body }),
    onMutate: () => setError(null),
    onError: handleError,
  });
  const busy = post.isPending;

  const scan = (barcode: string, source: 'scanner' | 'simulator') => {
    if (!step || (step.stage !== 'FIND' && step.stage !== 'SCAN') || busy) return;
    post.mutate(
      { path: `/steps/${step.seq}/scan`, body: { barcode, source } },
      {
        onSuccess: (d) => {
          const res = d as ScanResult;
          put(res.run);
          if (res.ok) {
            setScanFail(null);
            feedback('success', 'say.correct');
          } else {
            setScanFail(res);
            const reason: string = res.reason;
            feedback('error', reason === 'WRONG_INGREDIENT' ? 'say.wrong' : reason === 'WRONG_LOT' ? 'say.wrongLot' : isUnusableLot(reason) ? 'say.doNotUse' : 'say.scanAgain');
          }
        },
      },
    );
  };

  const tare = () => {
    if (container == null) return;
    post.mutate(
      { path: `/steps/${step!.seq}/tare`, body: { containerNo: container } },
      {
        onSuccess: (d) => {
          const res = d as { ok: boolean; run: RunState; code?: string };
          put(res.run);
          Object.assign(voice.current, { said: null, remainingMg: null });
          if (res.ok) cue('tap');
          else {
            feedback('error');
            // VESSEL_CHANGED puts the step on hold and the hold screen explains it; anything else is shown here.
            if (res.code && res.code !== 'VESSEL_CHANGED') setError(errorText(t.lang, res.code, ''));
          }
        },
      },
    );
  };

  const accept = () => {
    // A tap on SAVE and the auto-save timer can land together; only one request goes out.
    if (post.isPending || !step) return;
    const current = step;
    post.mutate(
      { path: `/steps/${current.seq}/accept` },
      {
        onSuccess: (d) => {
          const res = d as AcceptResult;
          put(res.run);
          if (res.ok) {
            // Last bottle of the job, or the last one that can be done before the lab bottle arrives.
            const last = res.run.status === 'AWAITING_SUBMISSION' || res.run.status === 'AWAITING_LAB';
            feedback('success', res.run.status === 'AWAITING_SUBMISSION' ? 'say.jobCompleted' : 'say.saved');
            setJustDone({ step: current, netMg: res.netMg, last });
          } else {
            // The live voice guidance already says how much is left; too much sets off the alarm (above).
            if (res.verdict !== 'OVER') feedback('warning');
          }
        },
      },
    );
  };

  const simple = (path: string, body?: object) => post.mutate({ path, body }, { onSuccess: (d) => put(d as RunState) });

  // LAB TEST: this bottle waits for the lab and is added at the end; the next one comes up.
  const labSkip = () => {
    if (!step || busy) return;
    post.mutate(
      { path: `/steps/${step.seq}/lab-skip` },
      {
        onSuccess: (d) => {
          put(d as RunState);
          setContainer(null);
          feedback('success');
          void qc.invalidateQueries({ queryKey: ['jobs'] });
        },
      },
    );
  };
  // ARRIVED: the lab bottle is back; it becomes the next bottle to add.
  const labArrived = (labSeq: number) =>
    post.mutate(
      { path: `/steps/${labSeq}/lab-arrived` },
      {
        onSuccess: (d) => {
          put(d as RunState);
          feedback('success');
          void qc.invalidateQueries({ queryKey: ['jobs'] });
        },
      },
    );
  const next = useCallback(() => setJustDone(null), []);

  const running = r?.status === 'IN_PROGRESS' && !needsCheck && !signoff && !askPause;
  const scanning = !!step && (step.stage === 'FIND' || step.stage === 'SCAN') && step.status === 'CURRENT' && running && !justDone;
  useBarcodeScanner((code) => scan(code, 'scanner'), scanning);

  // Auto-save: once the weight has been correct and steady for a moment, save it — one less tap, one less thing to read.
  const autoSaving = !!station?.autoAccept && running && !justDone && !busy && step?.status === 'CURRENT' && step.stage === 'WEIGH' && tared && ev?.verdict === 'OK';
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  useEffect(() => {
    if (!autoSaving) return;
    const t = setTimeout(() => acceptRef.current(), AUTO_SAVE_MS);
    return () => clearTimeout(t);
  }, [autoSaving, seq]);

  // While pouring on a zeroed scale the idle sign-out waits (hands are busy; the live weight must stay visible).
  const weighing = running && !justDone && step?.status === 'CURRENT' && step.stage === 'WEIGH' && tared;
  const setWeighing = useActivity((s) => s.setWeighing);
  useEffect(() => setWeighing(weighing), [weighing, setWeighing]);
  useEffect(() => () => setWeighing(false), [setWeighing]);

  if (run.isError) {
    const err = run.error as ApiError;
    return (
      <Shell>
        <div className="m-auto max-w-xl p-8 text-center">
          <p className="font-display text-4xl font-bold text-navy">{errorText(t.lang, err.code, err.message)}</p>
          <Button size="xl" variant="navy" className="mt-6" onClick={() => nav('/operator')}>
            <Home /> {t('complete.backHome')}
          </Button>
        </div>
      </Shell>
    );
  }
  if (!r || !station) {
    return (
      <Shell>
        <Loader2 className="m-auto size-14 animate-spin text-navy" />
      </Shell>
    );
  }

  const done = r.steps.filter((s) => s.status === 'COMPLETED').length;
  const total = r.steps.length;

  // Waiting for a lab bottle the supervisor skipped (shown after the last "saved" screen).
  if (r.status === 'AWAITING_LAB' && !justDone) {
    return (
      <Shell>
        <div className="flex min-h-0 flex-1 overflow-y-auto">
          <LabWaitPanel
            run={r}
            busy={busy}
            error={error}
            onArrived={labArrived}
            onContinue={() =>
              post.mutate(
                { path: '/start' },
                {
                  onSuccess: (d) => {
                    put(d as RunState);
                    feedback('success');
                    void qc.invalidateQueries({ queryKey: ['jobs'] });
                  },
                },
              )
            }
          />
        </div>
      </Shell>
    );
  }

  // End of job (shown after the last "saved" screen).
  if ((r.status === 'AWAITING_SUBMISSION' || r.status === 'SUBMITTED' || r.status === 'APPROVED' || r.status === 'UNDER_REVIEW') && !justDone) {
    return (
      <Shell>
        <div className="flex min-h-0 flex-1 overflow-y-auto">
          <CompletePanel
            run={r}
            busy={busy}
            error={error}
            onSubmit={() =>
              post.mutate(
                { path: '/submit' },
                {
                  onSuccess: (d) => {
                    put(d as RunState);
                    feedback('success', 'say.sent');
                    void qc.invalidateQueries({ queryKey: ['jobs'] });
                  },
                },
              )
            }
          />
        </div>
      </Shell>
    );
  }

  let center: React.ReactNode;
  if (justDone) {
    center = <DonePanel step={justDone.step} netMg={justDone.netMg} resolutionMg={res} last={justDone.last} onNext={next} />;
  } else if (r.status === 'REJECTED' || r.status === 'CORRECTION') {
    center = <JobStatePanel kind="sentBack" batchId={r.id} />;
  } else if (r.status === 'PAUSED') {
    center = <EquipmentCheck title={t('pause.title')} button={t('pause.resume')} busy={busy} onConfirm={() => simple('/resume', { equipmentChecked: true })} />;
  } else if (r.status === 'ON_HOLD') {
    center = <BatchHoldPanel reason={r.holdReason} onSignoff={() => setSignoff(['RELEASE_HOLD', 'CLOSE_CALL'])} />;
  } else if (r.status !== 'IN_PROGRESS') {
    // Not started (ASSIGNED) or any status this screen has no work for.
    center = <JobStatePanel kind="notRunning" batchId={r.id} />;
  } else if (needsCheck && step) {
    center = (
      <EquipmentCheck
        title={t('recovery.title')}
        body={t('recovery.body')}
        button={t('recovery.continue')}
        busy={busy}
        onConfirm={() => post.mutate({ path: '/recovery-check' }, { onSuccess: (d) => (put(d as RunState), setNeedsCheck(false)) })}
      />
    );
  } else if (step?.status === 'ON_HOLD') {
    center = <StepHoldPanel step={step} resolutionMg={res} liveNetMg={liveScale?.connected ? (ev?.netMg ?? null) : null} onSignoff={() => setSignoff(step.holdReason === 'OVERWEIGHT' ? ['ALLOW_REWEIGH', 'HOLD_BATCH'] : ['ACCEPT_VESSEL', 'HOLD_BATCH'])} />;
  } else if (step?.stage === 'FIND' || step?.stage === 'SCAN') {
    center = <TakeBottleStage step={step} racks={r.racks} busy={busy} last={scanFail} batchId={r.id} onLabSkip={labSkip} />;
  } else if (step?.stage === 'WEIGH' && ev) {
    center = <WeighStage step={step} station={station} scale={liveScale} ev={ev} busy={busy} error={error} autoSaving={autoSaving} container={container} lastContainer={lastContainer} onContainer={(n) => (cue('tap'), setContainer(n))} onTare={tare} onAccept={accept} onLabSkip={labSkip} batchId={r.id} />;
  } else if (run.isFetching) {
    center = <Loader2 className="m-auto size-14 animate-spin text-navy" />;
  } else {
    // Running, but no bottle is current: never leave the operator with an endless spinner.
    center = <JobStatePanel kind="notRunning" batchId={r.id} />;
  }

  const showSimulator = station.scaleMode === 'SIMULATED' && step && r.status === 'IN_PROGRESS' && !justDone && !needsCheck && !signoff;

  return (
    <Shell>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] 2xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="hidden min-h-0 flex-col border-r border-line bg-white lg:flex">
          <SequenceList steps={r.steps} />
          {showSimulator && <Simulator batchId={r.id} step={step!} scale={liveScale} onScan={(b) => scan(b, 'simulator')} />}
        </div>
        {/* Each step is laid out to fit this area exactly, so the operator never scrolls. */}
        <main className="flex min-h-0 flex-col gap-4 overflow-hidden bg-ivory p-4 lg:p-5 short:gap-3 short:p-3">
          {error && step?.stage !== 'WEIGH' && !justDone && (
            <p role="alert" className="shrink-0 rounded-xl bg-err px-5 py-2 text-2xl font-bold text-white">
              {error}
            </p>
          )}
          <AnimatePresence mode="wait">
            <motion.div
              key={`${step?.seq}-${step?.stage === 'SCAN' ? 'FIND' : step?.stage}-${step?.status}-${r.status}-${!!justDone}-${needsCheck}`}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.16 }}
              className="flex min-h-0 flex-1 flex-col gap-4 short:gap-3"
            >
              {center}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      <footer className="no-print flex h-[84px] shrink-0 items-center gap-4 border-t border-line bg-white px-4 short:h-[68px]">
        <Button variant="outline" size="lg" className="min-h-16 short:min-h-12" onClick={() => nav('/operator')}>
          <Home />
          <span className="hidden md:inline">{t('run.home')}</span>
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <div className="shrink-0 font-display text-3xl font-bold text-navy tabular">{t('run.progress', { done, total })}</div>
          <div className="flex h-8 flex-1 gap-1" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            {r.steps.map((s) => (
              <span key={s.id} className={cn('flex-1 rounded-md', s.status === 'COMPLETED' ? 'bg-ok' : s.status === 'CURRENT' ? 'bg-orange' : s.status === 'ON_HOLD' ? 'bg-err' : s.status === 'SKIPPED' ? 'bg-warn' : 'bg-mist')} title={s.status === 'SKIPPED' ? t('step.SKIPPED') : undefined} />
            ))}
          </div>
        </div>
        {station.allowPause && r.status === 'IN_PROGRESS' && !justDone && (
          <Button variant="outline" size="lg" className="min-h-16 border-warn text-[#8a5a00] short:min-h-12" disabled={busy} onClick={() => setAskPause(true)}>
            <PauseCircle />
            {t('run.pause')}
          </Button>
        )}
      </footer>

      {signoff && <SupervisorSignoff run={r} actions={signoff} open onOpenChange={(v) => !v && setSignoff(null)} />}
      <Confirm
        open={askPause}
        question="confirm.pause"
        spoken="say.confirmPause"
        icon={<PauseCircle />}
        onNo={() => setAskPause(false)}
        onYes={() => {
          setAskPause(false);
          // The paused screen then speaks its own instruction ("check three things").
          post.mutate({ path: '/pause' }, { onSuccess: (d) => put(d as RunState) });
        }}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <OperatorHeader />
      <TrainingRibbon />
      {children}
    </div>
  );
}
