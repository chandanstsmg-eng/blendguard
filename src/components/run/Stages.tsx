/**
 * The operator's working screens, built to be understood without reading:
 * a picture of the bottle and where it is, one big number while pouring, and
 * the whole screen turning yellow (keep pouring) → green (stop) → red (too much).
 * Every screen also speaks its instruction (see Run.tsx).
 */
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Ban,
  CheckCircle2,
  Droplets,
  FlaskConical,
  Hand,
  Hourglass,
  Loader2,
  Lock,
  MapPinOff,
  OctagonX,
  PauseCircle,
  Play,
  Plus,
  Save,
  ScanBarcode,
  ShieldAlert,
  ShieldCheck,
  StickyNote,
  Unplug,
  XOctagon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CallSupervisorButton } from '@/components/operator/CallSupervisor';
import { Confirm } from '@/components/operator/Confirm';
import { RackDiagram } from '@/components/operator/RackDiagram';
import { SafetySigns } from '@/components/operator/Pictograms';
import { RepeatButton } from '@/components/operator/Voice';
import { BottleArt, IngredientPicture, LocationBadge, ingredientColor } from '@/components/visual/Bottle';
import { StageTracker } from './StageTracker';
import { useT, type TKey } from '@/lib/i18n';
import { cn, g } from '@/lib/utils';
import type { RackInfo, RunStep, ScaleState, ScanResult, StationInfo, StepStage } from '@shared/types';
import type { Evaluation } from '@shared/weighing';

/** Seconds the weight must stay correct before it is saved by itself. */
export const AUTO_SAVE_MS = 2000;
/** Seconds the "saved" screen stays before moving on by itself. */
const AUTO_NEXT_MS = 3000;
/** Shown in place of a weight when there is no usable reading. */
const NO_READING = '— —';

/** Scan reasons where the bottle is the right material but must not be used. */
export const isUnusableLot = (reason: string) => reason === 'LOT_QUARANTINE' || reason === 'LOT_REJECTED' || reason === 'LOT_EXPIRED';

/** Title row: instruction, the 3-step bar and REPEAT on one line, so no height is wasted. */
export function StageTitle({ children, stage, repeat = true }: { children: React.ReactNode; stage?: StepStage; repeat?: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-4">
      <h1 className="min-w-0 flex-1 truncate font-display text-5xl font-bold uppercase tracking-wide text-navy short:text-4xl">{children}</h1>
      {stage && <StageTracker stage={stage} className="hidden w-[min(460px,40%)] shrink-0 md:flex" />}
      {repeat && <RepeatButton className="short:min-h-12 short:text-xl" />}
    </div>
  );
}

/** Small "this bottle" chip used while weighing: picture, shelf badge, name, green tick, locked container. */
function BottleChip({ step, onDark = false }: { step: RunStep; onDark?: boolean }) {
  const t = useT();
  const color = ingredientColor(step.ingredientCode, step.colorHex);
  return (
    <div className={cn('flex shrink-0 items-center gap-4 rounded-2xl px-3 py-2 short:py-1.5 tiny:py-1', onDark ? 'bg-white/15' : 'border border-line bg-white')}>
      <IngredientPicture code={step.ingredientCode} name={step.ingredientName} colorHex={step.colorHex} photoUrl={step.photoUrl} className="size-16 shrink-0 border-2 short:size-12 tiny:size-10" />
      {step.location && <LocationBadge rack={step.location.rack.code} bin={step.location.bin} color={color} size="sm" />}
      <div className={cn('min-w-0 flex-1 truncate font-display text-3xl font-bold short:text-2xl', onDark ? 'text-white' : 'text-navy')}>{step.ingredientName}</div>
      {step.containerNo != null && (
        <div className={cn('flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 font-display text-2xl font-bold short:text-xl', onDark ? 'bg-white text-navy' : 'bg-navy text-white')} title={t('container.locked')}>
          <Lock className="size-5" />
          {t('container.n', { n: step.containerNo })}
        </div>
      )}
      <div className={cn('flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 font-semibold', onDark ? 'bg-white/20 text-white' : 'bg-ok-100 text-ok')}>
        <ShieldCheck className="size-6" />
        <span className="hidden md:inline">{t('scan.correct')}</span>
      </div>
    </div>
  );
}

/** Container 1 / 2 / 3: chosen before SET TO 0, then recorded and locked by the server. */
function ContainerPicker({ value, lastUsed, disabled, onChange }: { value: number | null; lastUsed: number | null; disabled: boolean; onChange: (n: number) => void }) {
  const t = useT();
  return (
    <div className="w-full max-w-4xl" role="radiogroup" aria-label={t('container.choose')}>
      <div className="mb-2 font-display text-3xl font-bold text-navy short:text-2xl">{t('container.choose')}</div>
      <div className="grid grid-cols-3 gap-4 short:gap-3">
        {[1, 2, 3].map((n) => {
          const on = value === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onChange(n)}
              className={cn(
                'relative flex min-h-24 items-center justify-center gap-4 rounded-2xl border-4 px-4 font-display text-4xl font-bold transition-colors short:min-h-16 short:text-3xl',
                on ? 'border-orange bg-navy text-white shadow-[0_5px_0_0_#D98236]' : 'border-line bg-white text-navy hover:border-navy',
              )}
            >
              {/* Reads "Container 1". "Used last time" sits under the word, in the flow, so it never covers the number on short screens. */}
              <span className="flex flex-col items-end leading-none">
                <span className="hidden sm:inline">{t('container.label')}</span>
                {lastUsed === n && !on && <span className="mt-1 font-sans text-base font-semibold text-muted short:text-sm">{t('container.lastUsed')}</span>}
              </span>
              <span className={cn('grid size-14 place-items-center rounded-xl font-mono text-4xl short:size-11 short:text-3xl', on ? 'bg-orange text-navy-900' : 'bg-mist')}>{n}</span>
              {on && <CheckCircle2 className="absolute right-2 top-2 size-8 text-orange" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Remarks({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border-l-8 border-orange bg-orange-100 px-4 py-2 text-xl font-semibold text-navy-900">
      <StickyNote className="mt-0.5 size-6 shrink-0 text-orange-600" />
      {text}
    </div>
  );
}

/**
 * LAB TEST: the bottle in front of the operator goes for lab test and is added at
 * the end. Asks first (yes / no pictures, spoken). Only offered before set to zero.
 */
function LabSkipButton({ busy, onSkip, className }: { busy: boolean; onSkip: () => void; className?: string }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button variant="outline" size="lg" className={cn('w-full border-warn text-balance leading-tight text-[#8a5a00] hover:bg-warn-100', className)} disabled={busy} onClick={() => setAsking(true)}>
        <FlaskConical />
        {t('lab.skipButton')}
      </Button>
      <Confirm open={asking} question="confirm.labSkip" spoken="say.confirmLabSkip" icon={<FlaskConical />} onNo={() => setAsking(false)} onYes={() => (setAsking(false), onSkip())} />
    </>
  );
}

// ─────────────────────────── 1. TAKE THE BOTTLE (find + scan) ───────────────────────────

export function TakeBottleStage({
  step,
  racks,
  busy,
  last,
  batchId,
  onLabSkip,
}: {
  step: RunStep;
  racks: RackInfo[];
  busy: boolean;
  last: Extract<ScanResult, { ok: false }> | null;
  batchId: string;
  onLabSkip: () => void;
}) {
  const t = useT();
  const color = ingredientColor(step.ingredientCode, step.colorHex);

  return (
    <>
      <StageTitle stage={step.stage}>{t('run.step1')}</StageTitle>
      {/* Fills exactly the space left between the title and the scan row — never taller. */}
      <div className="grid min-h-0 flex-1 gap-4 short:gap-3 lg:grid-cols-2">
        {/* The bottle: what it looks like. */}
        <section className="flex min-h-0 flex-col justify-center-safe gap-4 overflow-hidden rounded-3xl border border-line bg-white p-5 short:gap-3 short:p-4 tiny:gap-2 tiny:p-3">
          <div className="flex min-h-0 items-center justify-center gap-8 short:gap-6 tiny:gap-4">
            <IngredientPicture code={step.ingredientCode} name={step.ingredientName} colorHex={step.colorHex} photoUrl={step.photoUrl} className="h-72 w-52 shrink-0 short:h-56 short:w-40 tiny:h-36 tiny:w-28" />
            <div className="flex min-w-0 flex-col gap-4 short:gap-3 tiny:gap-2">
              {step.location ? (
                <LocationBadge rack={step.location.rack.code} bin={step.location.bin} color={color} size="xl" className="self-start short:h-20 short:text-6xl tiny:h-16 tiny:text-5xl" />
              ) : (
                <span className="inline-flex items-center gap-2 self-start rounded-xl bg-err px-4 py-2 font-display text-3xl font-bold text-white">
                  <MapPinOff className="size-8" /> ?
                </span>
              )}
              {/* Ingredient names are entered in English; lang lets the browser hyphenate a long single word. */}
              <div lang="en" className="hyphens-auto break-words font-display text-5xl font-bold leading-tight text-navy short:text-4xl tiny:text-3xl">
                {step.ingredientName}
              </div>
            </div>
          </div>
          <SafetySigns ppe={step.ppe} hazards={step.hazards} className="justify-center" />
          {step.remarks && <Remarks text={step.remarks} />}
        </section>

        {/* Where it is. */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-3xl bg-navy p-5 text-white short:p-4">
          <div className="mb-3 font-display text-2xl font-bold uppercase text-blue-300 short:mb-2 short:text-xl">{t('run.location')}</div>
          {step.location ? (
            <RackDiagram racks={racks} rack={step.location.rack} bin={step.location.bin} color={color} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border-4 border-dashed border-err bg-err/20 p-6 text-center">
              <MapPinOff className="size-20 text-[#ffb4b4]" />
              <div className="font-display text-4xl font-bold">{t('run.locationNotSet')}</div>
            </div>
          )}
        </section>
      </div>

      {/* Then scan it — always in view at the bottom, with help next to it. */}
      <div className="grid shrink-0 gap-4 short:gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_15rem_15rem]">
        <div aria-live="assertive" className="min-w-0 sm:col-span-2 lg:col-span-1">
          {last ? (
            <ScanProblem step={step} last={last} />
          ) : (
            <div className="flex h-full items-center gap-5 rounded-3xl border-4 border-dashed border-blue-300 bg-white px-5 py-3 short:py-2">
              <div className="relative grid size-20 shrink-0 place-items-center rounded-2xl bg-navy text-orange short:size-16">
                {busy ? <Loader2 className="size-10 animate-spin" /> : <ScanBarcode className="size-12 short:size-10" strokeWidth={1.6} />}
                {!busy && <span className="absolute inset-x-3 top-1/2 h-1 animate-pulse rounded bg-err" aria-hidden />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-4xl font-bold text-navy short:text-3xl">{t('run.scanNow')}</div>
                <div className="mt-1 inline-flex items-center gap-2 rounded-md bg-ok-100 px-3 py-0.5 text-lg font-semibold text-ok">
                  <span className="size-3 animate-pulse rounded-full bg-ok" /> {busy ? t('scan.checking') : t('scan.ready')}
                </div>
              </div>
            </div>
          )}
        </div>
        <LabSkipButton busy={busy} onSkip={onLabSkip} className="h-full min-h-20 short:min-h-16" />
        <CallSupervisorButton batchId={batchId} seq={step.seq} size="lg" className="h-full min-h-20 short:min-h-16" reasons={['CANNOT_FIND', 'WRONG_BOTTLE', 'HELP', 'OTHER']} />
      </div>
    </>
  );
}

function ScanProblem({ step, last }: { step: RunStep; last: Extract<ScanResult, { ok: false }> }) {
  const t = useT();
  const color = ingredientColor(step.ingredientCode, step.colorHex);
  const wrong = last.reason === 'WRONG_INGREDIENT' || last.reason === 'UNKNOWN_BARCODE';
  const unusable = isUnusableLot(last.reason);
  // Right material, wrong batch: the batch the process order asks for comes with the result.
  const wrongLot = last.reason === 'WRONG_LOT';
  const expectedLot = last.expectedLot ?? null;
  const title = wrong ? t('scan.wrong') : unusable ? t('scan.doNotUse') : wrongLot ? t('scan.wrongLotTitle') : t(`scan.${last.reason}` as TKey);
  const detail = unusable
    ? t(`scan.${last.reason}` as TKey)
    : wrongLot
      ? expectedLot
        ? t('scan.WRONG_LOT', { expected: expectedLot })
        : t('scan.wrongLotAny')
      : last.reason === 'UNKNOWN_BARCODE'
        ? t('scan.UNKNOWN_BARCODE')
        : last.reason === 'LOT_REQUIRED'
          ? null
          : t('scan.otherBottle');
  return (
    <motion.div
      key={`${last.reason}-${step.wrongScans}`}
      initial={{ scale: 0.96, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className="flex items-center gap-5 rounded-3xl border-4 border-err bg-err-100 px-5 py-3 short:py-2"
      role="alert"
    >
      {unusable ? <Ban className="size-20 shrink-0 text-err short:size-14" strokeWidth={2.4} /> : <XOctagon className="size-20 shrink-0 text-err short:size-14" strokeWidth={2.2} />}
      <div className="min-w-0 flex-1">
        <div className="font-display text-5xl font-bold uppercase leading-tight text-err short:text-4xl">{title}</div>
        {/* Safety instructions wrap instead of being cut off. */}
        {detail && <div className="text-pretty text-2xl font-semibold leading-snug text-ink short:text-xl">{detail}</div>}
        {last.scannedName && last.reason === 'WRONG_INGREDIENT' && <div className="line-clamp-1 break-words text-lg text-muted short:hidden">{t('scan.youScanned', { name: last.scannedName })}</div>}
      </div>
      {/* Show the right bottle again, so it can be matched by sight (wide screens only, so the text above keeps its room). */}
      <div className="hidden shrink-0 items-center gap-3 rounded-2xl bg-white p-2 2xl:flex">
        <div className="text-center">
          <CheckCircle2 className="mx-auto size-8 text-ok" />
          <div className="text-sm font-bold text-ok">{t('scan.expected')}</div>
        </div>
        <IngredientPicture code={step.ingredientCode} name={step.ingredientName} colorHex={step.colorHex} photoUrl={step.photoUrl} className="h-20 w-16 border-2 short:h-16 short:w-12" />
        {step.location && <LocationBadge rack={step.location.rack.code} bin={step.location.bin} color={color} size="md" />}
      </div>
    </motion.div>
  );
}

// ───────────────────────────────── 2. WEIGH ─────────────────────────────────

type Tone = { panel: string; banner: string; icon: typeof Plus; key: TKey; dark: boolean };

const TONE: Record<string, Tone> = {
  UNDER: { panel: 'bg-white border-4 border-warn', banner: 'bg-warn text-navy-900', icon: Plus, key: 'weigh.addMore', dark: false },
  OK: { panel: 'bg-ok border-4 border-ok text-white', banner: 'bg-white text-ok', icon: CheckCircle2, key: 'weigh.correct', dark: true },
  OVER: { panel: 'bg-err border-4 border-err text-white', banner: 'bg-white text-err', icon: OctagonX, key: 'weigh.tooMuch', dark: true },
  UNSTABLE: { panel: 'bg-white border-4 border-line', banner: 'bg-mist text-navy', icon: Hourglass, key: 'weigh.wait', dark: false },
  DISCONNECTED: { panel: 'bg-err-100 border-4 border-err', banner: 'bg-err text-white', icon: Unplug, key: 'weigh.disconnected', dark: false },
  NOT_VALIDATED: { panel: 'bg-err-100 border-4 border-err', banner: 'bg-err text-white', icon: ShieldAlert, key: 'weigh.notValidated', dark: false },
  CANNOT_CERTIFY: { panel: 'bg-err-100 border-4 border-err', banner: 'bg-err text-white', icon: ShieldAlert, key: 'weigh.cannotCertify', dark: false },
  NOT_TARED: { panel: 'bg-white border-4 border-line', banner: 'bg-navy text-white', icon: ArrowRight, key: 'weigh.notTared', dark: false },
};

export function WeighStage({
  step,
  station,
  scale,
  ev,
  busy,
  error,
  autoSaving,
  container,
  lastContainer,
  onContainer,
  onTare,
  onAccept,
  onLabSkip,
  batchId,
}: {
  step: RunStep;
  station: StationInfo;
  scale: ScaleState | null;
  ev: Evaluation;
  busy: boolean;
  error: string | null;
  autoSaving: boolean;
  /** Container chosen on this screen (not yet recorded). */
  container: number | null;
  /** Container used for the previous ingredient, shown as a hint only. */
  lastContainer: number | null;
  onContainer: (n: number) => void;
  onTare: () => void;
  onAccept: () => void;
  /** Only until the scale is set to zero for this bottle. */
  onLabSkip: () => void;
  batchId: string;
}) {
  const t = useT();
  const res = station.scaleResolutionMg;
  const tared = step.tareGrossMg != null;
  const connected = !!scale?.connected;

  if (!tared) {
    return (
      <>
        <StageTitle stage={step.stage}>{t('weigh.zero')}</StageTitle>
        <BottleChip step={step} />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-4 overflow-y-auto rounded-3xl border border-line bg-white p-5 text-center short:gap-2.5 short:p-3">
          <div className="flex min-h-0 items-center justify-center gap-6">
            <ScaleArt withContainer className="h-40 min-h-0 shrink short:h-28 tiny:hidden" />
            <div className="min-w-0 text-left">
              <div className="max-w-2xl font-display text-4xl font-bold leading-tight text-navy short:text-3xl">{t('weigh.placeVessel')}</div>
              <div className="mt-1 font-mono text-3xl text-muted tabular short:text-2xl" aria-label="Scale reading">
                {connected && scale?.grossMg != null ? `${g(scale.grossMg, res)} g` : NO_READING}
              </div>
            </div>
          </div>
          <ContainerPicker value={container} lastUsed={lastContainer} disabled={busy} onChange={onContainer} />
          {!connected && <ProblemLine text={scaleProblemText(scale, t)} />}
          {connected && !station.scaleValidated && <ProblemLine text={t('weigh.notValidated')} />}
          {error && <ProblemLine text={error} />}
        </div>
        <div className="grid shrink-0 gap-4 short:gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_15rem_15rem]">
          <Button variant="navy" size="xl" className="min-h-28 text-6xl sm:col-span-2 lg:col-span-1 short:min-h-20 short:text-5xl" disabled={busy || !connected || container == null} onClick={onTare}>
            {busy ? <Loader2 className="animate-spin" /> : <span className="grid size-16 place-items-center rounded-full bg-white font-mono text-5xl text-navy short:size-12 short:text-4xl">0</span>}
            {t('weigh.zero')}
          </Button>
          <LabSkipButton busy={busy} onSkip={onLabSkip} className="h-full min-h-20 short:min-h-16" />
          <CallSupervisorButton batchId={batchId} seq={step.seq} size="lg" className="h-full min-h-20 short:min-h-16" reasons={['SCALE_PROBLEM', 'HELP', 'OTHER']} />
        </div>
      </>
    );
  }

  const tone = TONE[ev.verdict];
  const Icon = tone.icon;
  const showNet = ev.netMg != null && connected;

  return (
    <>
      <StageTitle stage={step.stage}>{t('run.step3')}</StageTitle>
      <section className={cn('flex min-h-0 flex-1 flex-col gap-4 overflow-hidden rounded-3xl p-5 transition-colors duration-300 short:gap-2.5 short:p-3', tone.panel)}>
        <BottleChip step={step} onDark={tone.dark} />

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-6">
          <div className="text-center">
            <div className={cn('font-display text-2xl font-bold uppercase short:text-xl tiny:hidden', tone.dark ? 'text-white/80' : 'text-muted')}>{t('weigh.current')}</div>
            <div className="font-mono text-[9rem] font-bold leading-none tabular short:text-[6.5rem] tiny:text-7xl" aria-live="off">
              {showNet ? g(ev.netMg!, res) : NO_READING}
              <span className="ml-2 text-5xl short:text-4xl tiny:text-3xl">g</span>
            </div>
            <div className={cn('mt-2 font-display text-4xl font-bold short:mt-1 short:text-3xl tiny:text-2xl', tone.dark ? 'text-white' : 'text-navy')}>{t('weigh.of', { g: g(step.targetMg, res) })}</div>
          </div>
          <Beaker ev={ev} targetMg={step.targetMg} dark={tone.dark} />
        </div>

        <div className={cn('flex shrink-0 min-h-24 items-center gap-4 rounded-2xl px-6 py-3 short:min-h-0 short:py-2', tone.banner)} role="status" aria-live="polite">
          <Icon className="size-16 shrink-0 short:size-12" strokeWidth={2.4} />
          <div className="min-w-0">
            {/* No `uppercase` here: the English texts are already capitals, and the unit must stay a lowercase "g". */}
            <div className="font-display text-5xl font-bold leading-tight short:text-4xl tiny:text-3xl">
              {ev.verdict === 'UNDER' ? t('weigh.addMore', { g: g(Math.max(0, ev.remainingMg ?? 0), res) }) : ev.verdict === 'OK' && autoSaving ? t('weigh.saving') : ev.verdict === 'DISCONNECTED' ? scaleProblemText(scale, t) : t(tone.key)}
            </div>
            {ev.verdict === 'OVER' && ev.netMg != null && <div className="text-2xl font-bold">{t('weigh.overBy', { g: g(ev.netMg - step.targetMg, res) })}. {t('weigh.tooMuchHint')}</div>}
            {ev.verdict === 'UNDER' && <div className="text-xl font-semibold opacity-80 short:hidden">{t('weigh.pourHint')}</div>}
          </div>
        </div>
        {ev.verdict === 'OK' && autoSaving && (
          <div className="h-4 shrink-0 overflow-hidden rounded-full bg-white/30 short:h-2.5" aria-hidden>
            <motion.div className="h-full rounded-full bg-white" initial={{ width: '0%' }} animate={{ width: '100%' }} transition={{ duration: AUTO_SAVE_MS / 1000, ease: 'linear' }} />
          </div>
        )}
        {error && <ProblemLine text={error} />}

        <div className="grid shrink-0 gap-4 short:gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Button variant="primary" size="xl" className="min-h-24 text-5xl short:min-h-16 short:text-4xl" disabled={busy || ev.verdict !== 'OK'} onClick={onAccept}>
            {busy ? <Loader2 className="animate-spin" /> : <SaveIcon verdict={ev.verdict} />}
            {saveLabel(ev.verdict, t)}
          </Button>
          <CallSupervisorButton batchId={batchId} seq={step.seq} size="lg" className="h-full min-h-24 short:min-h-16" reasons={['SCALE_PROBLEM', 'HELP', 'OTHER']} />
        </div>
      </section>
    </>
  );
}

/**
 * The save button only says "pour more" when more is really needed. While the
 * reading settles it says WAIT; in every other state (too much, scale problem)
 * it stays a plain, greyed-out SAVE with a lock: the banner above says what to do.
 */
function saveLabel(verdict: Evaluation['verdict'], t: ReturnType<typeof useT>) {
  if (verdict === 'UNDER') return t('weigh.notReady');
  if (verdict === 'UNSTABLE') return t('weigh.waitShort');
  return t('weigh.saveNow');
}

function SaveIcon({ verdict }: { verdict: Evaluation['verdict'] }) {
  if (verdict === 'OK') return <Save />;
  if (verdict === 'UNDER') return <Droplets />;
  if (verdict === 'UNSTABLE') return <Hourglass />;
  return <Lock />;
}

/**
 * Upright container that fills as the operator pours. The green band is the
 * accepted range; above it the fill turns red.
 */
function Beaker({ ev, targetMg, dark }: { ev: Evaluation; targetMg: number; dark: boolean }) {
  const max = targetMg * 1.15;
  const pct = (mg: number) => Math.max(0, Math.min(100, (mg / max) * 100));
  const lo = pct(ev.acceptLowMg);
  const hi = pct(ev.acceptHighMg);
  const fill = ev.netMg != null ? pct(ev.netMg) : 0;
  return (
    <div className="relative mr-5 h-full max-h-80 min-h-28 w-32 self-stretch short:w-24" aria-hidden>
      <div className={cn('absolute inset-0 overflow-hidden rounded-b-[2.5rem] rounded-t-lg border-[6px]', dark ? 'border-white bg-white/20' : 'border-navy bg-mist')}>
        <div
          className={cn('absolute inset-x-0 bottom-0 transition-[height] duration-200', ev.verdict === 'OVER' ? 'bg-[#ff6b6b]' : ev.verdict === 'OK' ? 'bg-white' : 'bg-blue')}
          style={{ height: `${fill}%` }}
        />
        <div className="absolute inset-x-0 border-y-4 border-ok bg-ok/40" style={{ bottom: `${lo}%`, height: `${Math.max(2, hi - lo)}%` }} />
      </div>
      <div className={cn('absolute -right-4 h-1.5 w-8 rounded', dark ? 'bg-white' : 'bg-ok')} style={{ bottom: `calc(${pct(targetMg)}% - 3px)` }} />
    </div>
  );
}

/** A scale, optionally with the mixing container on it. */
function ScaleArt({ withContainer, className }: { withContainer?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 220 160" className={className} aria-hidden>
      {withContainer && (
        <g>
          <path d="M70 30 L150 30 L142 104 Q140 112 132 112 L88 112 Q80 112 78 104 Z" fill="#dfe6ea" stroke="#102A39" strokeWidth="4" />
          <path d="M76 70 L144 70 L142 104 Q140 110 132 110 L88 110 Q80 110 78 104 Z" fill="#8fb0c0" opacity="0.7" />
          <path d="M100 6 L110 22 L120 6" fill="none" stroke="#D98236" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" className="animate-bounce" />
        </g>
      )}
      <rect x="30" y="114" width="160" height="12" rx="4" fill="#17394C" />
      <rect x="20" y="126" width="180" height="30" rx="8" fill="#204D62" />
      <rect x="80" y="132" width="60" height="18" rx="3" fill="#102A39" />
      <text x="110" y="146" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontWeight="700" fontSize="14" fill="#7fe0a6">
        0.00
      </text>
    </svg>
  );
}

/** One short line saying why the scale gives no weight; faults the operator can fix get their own text. */
function scaleProblemText(scale: ScaleState | null, t: ReturnType<typeof useT>) {
  switch (scale?.fault) {
    case 'OVERLOAD':
      return t('weigh.faultOverload');
    case 'UNDERLOAD':
      return t('weigh.faultUnderload');
    case 'BUSY':
      return t('weigh.faultBusy');
    default:
      return t('weigh.disconnected');
  }
}

function ProblemLine({ text }: { text: string }) {
  return (
    <p role="alert" className="flex items-center gap-3 rounded-xl bg-err px-5 py-3 text-2xl font-bold text-white">
      <ShieldAlert className="size-8 shrink-0" />
      {text}
    </p>
  );
}

// ───────────────────────────────── 3. SAVED ─────────────────────────────────

export function DonePanel({ step, netMg, resolutionMg, last, onNext }: { step: Pick<RunStep, 'ingredientCode' | 'ingredientName' | 'colorHex' | 'photoUrl'>; netMg: number; resolutionMg: number; last: boolean; onNext: () => void }) {
  const t = useT();
  // Moves on by itself so a steady worker needs no tap; the button is there for the impatient.
  useEffect(() => {
    if (last) return;
    const id = setTimeout(onNext, AUTO_NEXT_MS);
    return () => clearTimeout(id);
  }, [last, onNext]);
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-hidden rounded-3xl bg-ok p-8 text-center text-white short:gap-3 short:p-5"
    >
      <motion.div initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}>
        <CheckCircle2 className="size-40 short:size-24" strokeWidth={1.8} />
      </motion.div>
      <div className="font-display text-7xl font-bold uppercase short:text-6xl">{t('done.title')}</div>
      <div className="text-4xl font-semibold short:text-3xl">{t('done.body')}</div>
      <div className="flex items-center gap-4 rounded-2xl bg-white/15 px-5 py-3 text-2xl short:py-2">
        <IngredientPicture code={step.ingredientCode} name={step.ingredientName} colorHex={step.colorHex} photoUrl={step.photoUrl} className="size-16 border-2 short:size-12" />
        <span className="font-semibold">{step.ingredientName}</span>
        <b className="font-mono text-3xl">{g(netMg, resolutionMg)} g</b>
      </div>
      <Button variant="primary" size="xl" className="relative mt-2 min-h-28 w-full max-w-2xl overflow-hidden text-5xl short:mt-0 short:min-h-20 short:text-4xl" onClick={onNext} autoFocus>
        {!last && <motion.span className="absolute inset-y-0 left-0 bg-white/30" initial={{ width: '0%' }} animate={{ width: '100%' }} transition={{ duration: AUTO_NEXT_MS / 1000, ease: 'linear' }} aria-hidden />}
        <span className="relative flex items-center gap-3">
          {last ? t('done.finish') : t('done.next')}
          <ArrowRight />
        </span>
      </Button>
    </motion.div>
  );
}

// ───────────────────────────────── holds ─────────────────────────────────

export function StepHoldPanel({ step, resolutionMg, liveNetMg, onSignoff }: { step: RunStep; resolutionMg: number; liveNetMg: number | null; onSignoff: () => void }) {
  const t = useT();
  const over = step.holdReason === 'OVERWEIGHT';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden rounded-3xl bg-err p-6 text-white short:gap-3 short:p-4" role="alert">
      <div className="flex items-center gap-5">
        <motion.div animate={{ scale: [1, 1.08, 1] }} transition={{ repeat: Infinity, duration: 1.4 }}>
          <OctagonX className="size-32 shrink-0 short:size-20" strokeWidth={2.2} />
        </motion.div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-7xl font-bold uppercase leading-none short:text-5xl">{over ? t('hold.overTitle') : t('hold.vesselTitle')}</div>
          <div className="mt-3 flex items-center gap-3 text-3xl font-semibold short:mt-2 short:text-2xl">
            <Hand className="size-10 shrink-0" />
            {over ? t('hold.overBody') : t('hold.vesselBody')}
          </div>
        </div>
        <RepeatButton dark />
      </div>
      {/* The middle of the panel says what to do with the container while waiting. */}
      <div className="grid min-h-0 flex-1 content-center gap-5 short:gap-3">
        {over && liveNetMg != null && (
          <div className="grid grid-cols-3 gap-4 short:gap-3">
            <BigReadout label={t('weigh.required')} value={g(step.targetMg, resolutionMg)} />
            <BigReadout label={t('hold.nowOnScale')} value={g(liveNetMg, resolutionMg)} />
            <BigReadout label={t('hold.excess')} value={`+${g(Math.max(0, liveNetMg - step.targetMg), resolutionMg)}`} strong />
          </div>
        )}
        <div className="flex items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-white/40 px-6 py-5 text-center text-3xl font-semibold short:py-3 short:text-2xl">
          <FlaskConical className="size-12 shrink-0 short:size-9" />
          {over ? t('hold.overHelp') : t('hold.vesselHelp')}
        </div>
      </div>
      <div className="grid shrink-0 gap-4 short:gap-3 lg:grid-cols-2 [&>*]:min-w-0">
        <CallSupervisorButton size="xl" className="min-h-24 short:min-h-16" reasons={['HELP']} />
        <Button variant="navy" size="xl" className="min-h-24 short:min-h-16" onClick={onSignoff}>
          <ShieldCheck />
          {t('hold.signoff')}
        </Button>
      </div>
    </div>
  );
}

function BigReadout({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('rounded-2xl px-5 py-3 text-center short:py-2', strong ? 'bg-white text-err' : 'bg-white/15')}>
      <div className={cn('font-display text-2xl font-bold uppercase short:text-xl', strong ? 'text-err/80' : 'text-white/80')}>{label}</div>
      <div className="font-mono text-6xl font-bold tabular short:text-5xl">
        {value}
        <span className="ml-1 text-3xl">g</span>
      </div>
    </div>
  );
}

export function BatchHoldPanel({ reason, onSignoff }: { reason: string | null; onSignoff: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 overflow-hidden rounded-3xl border-4 border-warn bg-warn-100 p-8 text-center short:gap-3 short:p-5" role="alert">
      <PauseCircle className="size-36 shrink-0 text-[#8a5a00] short:size-20" />
      <div className="font-display text-7xl font-bold uppercase text-navy short:text-5xl">{t('hold.batchTitle')}</div>
      <div className="text-3xl font-semibold short:text-2xl">{t('hold.batchBody')}</div>
      {reason && <Remarks text={reason} />}
      <div className="mt-4 grid w-full max-w-3xl gap-4 short:mt-1 md:grid-cols-[auto_1fr]">
        <RepeatButton className="min-h-24 short:min-h-16" />
        <Button variant="navy" size="xl" className="min-h-24 short:min-h-16" onClick={onSignoff}>
          <ShieldCheck />
          {t('hold.signoff')}
        </Button>
      </div>
    </div>
  );
}

// ─────────────────────────── equipment check (pause / restart) ───────────────────────────

/** Three things to check, each a picture to touch. Used after a pause and after a restart. */
export function EquipmentCheck({ title, body, button, busy, onConfirm }: { title: string; body?: string; button: string; busy: boolean; onConfirm: () => void }) {
  const t = useT();
  const items: { key: TKey; art: React.ReactNode }[] = [
    { key: 'pause.check1', art: <ScaleArt withContainer className="h-44 short:h-32 tiny:h-20" /> },
    {
      key: 'pause.check2',
      art: (
        <div className="relative grid h-44 place-items-center short:h-32 tiny:h-20">
          <Droplets className="size-28 text-blue short:size-20 tiny:size-12" />
          <Ban className="absolute size-40 text-err short:size-28 tiny:size-20" strokeWidth={2} />
        </div>
      ),
    },
    {
      key: 'pause.check3',
      art: (
        <div className="flex h-44 items-end gap-2 short:h-32 tiny:h-20">
          <Hand className="size-24 text-navy short:size-16 tiny:size-10" />
          <BottleArt color="#D98236" className="h-40 short:h-28 tiny:h-20" />
        </div>
      ),
    },
  ];
  const [ticked, setTicked] = useState<boolean[]>(items.map(() => false));
  const all = ticked.every(Boolean);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden rounded-3xl border-4 border-warn bg-white p-6 short:gap-3 short:p-4 tiny:gap-2 tiny:p-3">
      <div className="flex shrink-0 items-center gap-4">
        <PauseCircle className="size-20 shrink-0 text-[#b07800] short:size-14 tiny:size-10" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-5xl font-bold uppercase leading-tight text-navy short:text-4xl tiny:text-3xl">{title}</div>
          {body && <div className="mt-1 text-2xl text-muted short:text-xl tiny:text-lg">{body}</div>}
        </div>
        <RepeatButton className="short:min-h-12 short:text-xl" />
      </div>
      <div className="shrink-0 font-display text-3xl font-bold text-navy short:text-2xl tiny:text-xl">{t('pause.checkTitle')}</div>
      <div className="grid min-h-0 flex-1 gap-4 short:gap-3 tiny:gap-2 md:grid-cols-3">
        {items.map((it, i) => (
          <button
            key={it.key}
            role="checkbox"
            aria-checked={ticked[i]}
            onClick={() => setTicked((p) => p.map((v, j) => (j === i ? !v : v)))}
            className={cn(
              'relative flex min-h-0 flex-col items-center justify-center gap-3 rounded-2xl border-4 p-4 text-center font-display text-3xl font-bold transition-colors short:gap-2 short:p-3 short:text-2xl tiny:gap-1 tiny:p-2 tiny:text-xl',
              ticked[i] ? 'border-ok bg-ok-100 text-ok' : 'border-line bg-white text-navy hover:border-navy',
            )}
          >
            <span className={cn('absolute right-3 top-3 grid size-14 place-items-center rounded-full border-4 tiny:right-2 tiny:top-2 tiny:size-10', ticked[i] ? 'border-ok bg-ok text-white' : 'border-line bg-white')}>
              {ticked[i] && <CheckCircle2 className="size-10 tiny:size-7" />}
            </span>
            {it.art}
            {t(it.key)}
          </button>
        ))}
      </div>
      <Button size="xl" className="min-h-28 shrink-0 text-5xl short:min-h-20 short:text-4xl tiny:min-h-16 tiny:text-3xl" disabled={!all || busy} onClick={onConfirm}>
        {busy ? <Loader2 className="animate-spin" /> : <Play className="fill-current" />}
        {button}
      </Button>
    </div>
  );
}
