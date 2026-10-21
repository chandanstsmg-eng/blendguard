import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { AlertTriangle, ArrowLeft, Fingerprint, KeyRound, Loader2, MonitorX, ScanFace, ShieldCheck, UserRoundCog } from 'lucide-react';
import { CompanyLogo, Logo } from '@/components/Logo';
import { Button } from '@/components/ui/button';
import { LanguageSwitch } from '@/components/operator/LanguageSwitch';
import { Keypad } from '@/components/operator/Keypad';
import { RepeatButton, useSayOnEnter } from '@/components/operator/Voice';
import { useAfterSignIn, useMe } from '@/hooks/useMe';
import { clockText, dateText, useClock } from '@/hooks/useClock';
import { api, ApiError } from '@/lib/api';
import { feedback } from '@/lib/audio';
import { errorText, useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { SessionUser, StationInfo } from '@shared/types';

/** Greets the operator by first name once the server has accepted the sign-in. */
const greet = (r: { user?: SessionUser } | null | undefined) => feedback('success', r?.user ? 'say.hello' : undefined, r?.user ? { name: r.user.name.split(' ')[0] } : undefined);

type Mode =
  | { kind: 'home' }
  | { kind: 'bio'; modality: 'fingerprint' | 'face'; state: 'waiting' | 'checking' }
  | { kind: 'pin-id' }
  | { kind: 'pin'; operatorCode: string }
  | { kind: 'assist-id' }
  | { kind: 'assist'; operatorCode: string }
  | { kind: 'supervisor' };

/**
 * Entry screen. Primary path: one tap, then the station's own fingerprint
 * reader / camera (Windows Hello or a FIDO2 key) verifies the person. The
 * waiting animation is shown only while the real device prompt is open, and
 * success comes only from the server verifying the signed response.
 */
export function Welcome() {
  const t = useT();
  const { data } = useMe();
  const station = data?.station ?? null;
  const now = useClock();
  const after = useAfterSignIn();
  const [mode, setMode] = useState<Mode>({ kind: 'home' });
  const [error, setError] = useState<string | null>(null);
  const [webauthn, setWebauthn] = useState<boolean | null>(null);

  useEffect(() => {
    setWebauthn(browserSupportsWebAuthn() && window.isSecureContext);
  }, []);

  const showError = (e: unknown) => {
    const err = e as ApiError;
    feedback('error');
    setError(err instanceof ApiError ? errorText(t.lang, err.code, err.message) : t('welcome.notRecognised'));
  };

  async function biometric(modality: 'fingerprint' | 'face') {
    setError(null);
    setMode({ kind: 'bio', modality, state: 'waiting' });
    try {
      const optionsJSON = await api.post<Parameters<typeof startAuthentication>[0]['optionsJSON']>('/auth/webauthn/options');
      const response = await startAuthentication({ optionsJSON });
      setMode({ kind: 'bio', modality, state: 'checking' });
      greet(await api.post<{ user: SessionUser }>('/auth/webauthn/verify', { response, modality }));
      await after();
    } catch (e) {
      setMode({ kind: 'home' });
      // The person closed the Windows Hello / security-key prompt, or it timed out.
      if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) {
        setError(t('welcome.cancelled'));
        return;
      }
      showError(e);
    }
  }

  if (!station) return <NoStation onSupervisor={() => setMode({ kind: 'supervisor' })} mode={mode} setMode={setMode} />;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Brand panel */}
      <aside className="flex shrink-0 flex-col justify-between bg-navy p-8 text-white lg:w-[38%] lg:p-12 short:lg:p-8 tiny:p-5 tiny:lg:p-6">
        <Logo byline />
        <div className="my-10 lg:my-0">
          <div className="text-blue-300">
            {t('station')} · <span className="font-mono">{station.code}</span>
          </div>
          <div className="mt-1 font-display text-5xl font-bold leading-none lg:text-6xl short:lg:text-5xl tiny:text-4xl tiny:lg:text-4xl">{station.name}</div>
          {station.scaleMode === 'SIMULATED' && (
            <div className="mt-6 inline-flex rounded bg-warn px-3 py-1.5 text-sm font-bold text-navy-900">{t('training')}</div>
          )}
        </div>
        <div className="border-t border-white/15 pt-5">
          <div className="font-display text-5xl font-bold tabular tiny:text-4xl">{clockText(now)}</div>
          <div className="text-lg text-blue-300">{dateText(now)}</div>
        </div>
      </aside>

      {/* Verification */}
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-ivory">
        <div className="flex shrink-0 items-center justify-between gap-4 p-5 short:py-3 tiny:py-2">
          <CompanyLogo className="h-14 lg:h-16 short:lg:h-12 tiny:h-10 tiny:lg:h-10" />
          <LanguageSwitch dark={false} />
        </div>
        <div className="flex flex-1 items-center-safe justify-center px-6 pb-10 short:pb-5 tiny:pb-3">
          <AnimatePresence mode="wait">
            <motion.div key={mode.kind} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18 }} className="w-full max-w-2xl">
              {mode.kind === 'home' && (
                <Home station={station} webauthn={webauthn} error={error} onBio={biometric} onPin={() => (setError(null), setMode({ kind: 'pin-id' }))} onAssist={() => (setError(null), setMode({ kind: 'assist-id' }))} onSupervisor={() => (setError(null), setMode({ kind: 'supervisor' }))} />
              )}
              {mode.kind === 'bio' && <Waiting modality={mode.modality} checking={mode.state === 'checking'} />}
              {mode.kind === 'pin-id' && <OperatorIdStep title={t('welcome.enterOperatorId')} onBack={() => setMode({ kind: 'home' })} onNext={(code) => setMode({ kind: 'pin', operatorCode: code })} />}
              {mode.kind === 'pin' && (
                <PinStep operatorCode={mode.operatorCode} onBack={() => setMode({ kind: 'pin-id' })} onDone={after} />
              )}
              {mode.kind === 'assist-id' && <OperatorIdStep title={t('welcome.enterOperatorId')} subtitle={t('welcome.assistTitle')} onBack={() => setMode({ kind: 'home' })} onNext={(code) => setMode({ kind: 'assist', operatorCode: code })} />}
              {mode.kind === 'assist' && (
                <PasswordStep
                  title={t('welcome.supervisorAssist')}
                  subtitle={`${t('welcome.operatorId')}: ${mode.operatorCode}`}
                  onBack={() => setMode({ kind: 'assist-id' })}
                  submit={(username, password) => api.post('/auth/assisted', { operatorCode: mode.operatorCode, username, password })}
                  onDone={after}
                />
              )}
              {mode.kind === 'supervisor' && (
                <PasswordStep title={t('welcome.supervisorSignIn')} onBack={() => setMode({ kind: 'home' })} submit={(username, password) => api.post('/auth/login', { username, password })} onDone={after} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function Home({
  station,
  webauthn,
  error,
  onBio,
  onPin,
  onAssist,
  onSupervisor,
}: {
  station: StationInfo;
  webauthn: boolean | null;
  error: string | null;
  onBio: (m: 'fingerprint' | 'face') => void;
  onPin: () => void;
  onAssist: () => void;
  onSupervisor: () => void;
}) {
  const t = useT();
  const tiles: { modality: 'fingerprint' | 'face'; allowed: boolean; icon: typeof Fingerprint; label: string }[] = [
    { modality: 'fingerprint', allowed: station.allowFingerprint, icon: Fingerprint, label: t('welcome.fingerprint') },
    { modality: 'face', allowed: station.allowFace, icon: ScanFace, label: t('welcome.face') },
  ];
  const visible = tiles.filter((x) => x.allowed);
  // Only offer (and ask for) what really works here: fingerprint / face need WebAuthn over https.
  const bioUsable = webauthn === true && visible.length > 0;
  const bioMissing = webauthn === false && visible.length > 0;
  const pinMain = !bioUsable && station.allowPin;
  const prompt = bioUsable ? t('welcome.subtitle') : station.allowPin ? t('welcome.subtitlePin') : station.allowAssisted ? t('welcome.subtitleAssist') : null;
  const voice = webauthn == null ? null : bioUsable ? 'say.welcome' : station.allowPin ? 'say.welcomePin' : null;
  useSayOnEnter(voice, undefined, voice ? `welcome|${voice}` : null, 800);

  const tile = 'flex flex-col items-center gap-5 rounded-3xl border-4 border-navy bg-white p-8 shadow-[0_6px_0_0_#17394C] transition-colors hover:bg-mist active:translate-y-0.5 active:shadow-[0_2px_0_0_#17394C] short:gap-4 short:p-6 tiny:gap-2 tiny:p-4';
  const circle = 'relative grid size-44 place-items-center rounded-full bg-navy text-orange short:size-36 tiny:size-24';
  const tileIcon = 'size-28 short:size-24 tiny:size-14';
  const tileLabel = 'font-display text-4xl font-bold text-navy tiny:text-3xl';

  return (
    <div className="text-center">
      <h1 className="font-display text-5xl font-bold text-navy lg:text-6xl short:lg:text-5xl tiny:text-4xl tiny:lg:text-4xl">{t('welcome.title')}</h1>
      {prompt && (
        <div className="mt-3 flex items-center justify-center gap-4 tiny:mt-2">
          <p className="text-3xl font-semibold text-muted short:text-2xl">{prompt}</p>
          {voice && <RepeatButton className="min-h-14 short:min-h-12" />}
        </div>
      )}

      {error && (
        <div role="alert" className="mx-auto mt-6 flex max-w-xl items-center justify-center gap-3 rounded-xl bg-err-100 px-5 py-4 text-xl font-semibold text-err short:mt-4 short:py-3">
          <AlertTriangle className="size-7 shrink-0" />
          {error}
        </div>
      )}

      {bioUsable && (
        <div className={cn('mx-auto mt-10 grid gap-5 short:mt-6 tiny:mt-4 tiny:gap-4', visible.length > 1 ? 'sm:grid-cols-2' : 'max-w-sm')}>
          {visible.map(({ modality, icon: Icon, label }) => (
            <button key={modality} onClick={() => onBio(modality)} className={tile}>
              <span className={circle}>
                <span className="absolute inset-0 animate-ping rounded-full bg-orange/15 [animation-duration:2.4s]" aria-hidden />
                <Icon className={tileIcon} strokeWidth={1.4} />
              </span>
              <span className={tileLabel}>{label}</span>
            </button>
          ))}
        </div>
      )}

      {/* No fingerprint / face here: the number + PIN sign-in becomes the big button. */}
      {pinMain && (
        <div className="mx-auto mt-10 grid max-w-sm short:mt-6 tiny:mt-4">
          <button onClick={onPin} className={tile}>
            <span className={circle}>
              <KeyRound className={tileIcon} strokeWidth={1.4} />
            </span>
            <span className={tileLabel}>{t('welcome.useOperatorId')}</span>
          </button>
        </div>
      )}

      {bioMissing && (
        <p className="mx-auto mt-4 flex items-center justify-center gap-2 text-base font-semibold text-muted">
          <MonitorX className="size-5 shrink-0" />
          {visible.map((v) => v.label).join(', ')}: {t('welcome.notAvailable')}
        </p>
      )}

      {((station.allowPin && !pinMain) || station.allowAssisted) && (
        <div className="mx-auto mt-8 grid max-w-2xl gap-3 short:mt-5 tiny:mt-4 sm:grid-cols-2">
          {station.allowPin && !pinMain && (
            <Button variant="outline" size="lg" onClick={onPin}>
              <KeyRound />
              {t('welcome.useOperatorId')}
            </Button>
          )}
          {station.allowAssisted && (
            <Button variant="outline" size="lg" className={cn(pinMain && 'sm:col-span-2 sm:mx-auto sm:w-full sm:max-w-sm')} onClick={onAssist}>
              <ShieldCheck />
              {t('welcome.supervisorAssist')}
            </Button>
          )}
        </div>
      )}
      <button
        onClick={onSupervisor}
        className="mt-10 inline-flex h-14 items-center gap-3 rounded-xl border-2 border-line px-5 text-lg font-semibold text-muted hover:border-navy hover:bg-mist hover:text-navy short:mt-6 tiny:mt-4 tiny:h-12"
      >
        <UserRoundCog className="size-6" />
        {t('welcome.supervisorSignIn')}
      </button>
    </div>
  );
}

function Waiting({ modality, checking }: { modality: 'fingerprint' | 'face'; checking: boolean }) {
  const t = useT();
  const Icon = modality === 'face' ? ScanFace : Fingerprint;
  useSayOnEnter(checking ? null : modality === 'face' ? 'say.lookCamera' : 'say.touchSensor', undefined, checking ? null : modality, 0);
  return (
    <div className="flex flex-col items-center text-center" role="status" aria-live="assertive">
      <div className="relative grid size-56 place-items-center short:size-44 tiny:size-36">
        {!checking && <span className="absolute inset-0 animate-ping rounded-full bg-orange/20 [animation-duration:1.8s]" />}
        <span className="relative grid size-48 place-items-center rounded-full bg-navy text-orange short:size-36 tiny:size-28">
          {checking ? <Loader2 className="size-20 animate-spin tiny:size-14" /> : <Icon className="size-28 short:size-20 tiny:size-16" strokeWidth={1.4} />}
        </span>
      </div>
      <p className="mt-8 font-display text-4xl font-bold text-navy short:mt-5">{checking ? t('welcome.verifying') : modality === 'face' ? t('welcome.lookCamera') : t('welcome.touchSensor')}</p>
    </div>
  );
}

function OperatorIdStep({ title, subtitle, onBack, onNext }: { title: string; subtitle?: string; onBack: () => void; onNext: (code: string) => void }) {
  const t = useT();
  const [code, setCode] = useState('');
  return (
    <div className="flex flex-col items-center text-center">
      <BackLink onClick={onBack} />
      <h2 className="font-display text-4xl font-bold text-navy tiny:text-3xl">{title}</h2>
      {subtitle && <p className="mt-2 text-xl text-muted tiny:mt-1 tiny:text-lg">{subtitle}</p>}
      <div className="mt-6 flex w-full flex-col items-center short:mt-4 tiny:mt-2">
        <Keypad value={code} onChange={setCode} label={t('welcome.operatorId')} />
        <Button size="lg" className="mt-5 w-full max-w-sm short:mt-3" disabled={code.length < 3} onClick={() => onNext(code)}>
          {t('welcome.next')}
        </Button>
      </div>
    </div>
  );
}

function PinStep({ operatorCode, onBack, onDone }: { operatorCode: string; onBack: () => void; onDone: () => Promise<void> }) {
  const t = useT();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      greet(await api.post<{ user: SessionUser }>('/auth/pin', { operatorCode, pin }));
      await onDone();
    } catch (e) {
      feedback('error');
      setPin('');
      setError(e instanceof ApiError ? errorText(t.lang, e.code, e.message) : t('err.GENERIC'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-center text-center">
      <BackLink onClick={onBack} />
      <h2 className="font-display text-4xl font-bold text-navy tiny:text-3xl">{t('welcome.enterPin')}</h2>
      <p className="mt-2 text-xl text-muted tiny:mt-1 tiny:text-lg">
        {t('welcome.operatorId')}: <b className="font-mono text-ink">{operatorCode}</b>
      </p>
      {error && (
        <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg bg-err-100 px-4 py-3 text-lg font-semibold text-err">
          <AlertTriangle className="size-6" /> {error}
        </p>
      )}
      <div className="mt-6 flex w-full flex-col items-center short:mt-4 tiny:mt-2">
        <Keypad value={pin} onChange={setPin} masked label={t('welcome.pin')} />
        <Button size="lg" className="mt-5 w-full max-w-sm short:mt-3" disabled={pin.length < 4 || busy} onClick={submit}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {t('welcome.signIn')}
        </Button>
      </div>
    </div>
  );
}

function PasswordStep({ title, subtitle, onBack, submit, onDone }: { title: string; subtitle?: string; onBack: () => void; submit: (u: string, p: string) => Promise<unknown>; onDone: () => Promise<void> }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mx-auto flex max-w-md flex-col items-stretch text-left"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await submit(username, password);
          feedback('success');
          await onDone();
        } catch (err) {
          feedback('error');
          setPassword('');
          setError(err instanceof ApiError ? errorText(t.lang, err.code, err.message) : t('err.GENERIC'));
        } finally {
          setBusy(false);
        }
      }}
    >
      <BackLink onClick={onBack} />
      <h2 className="text-center font-display text-4xl font-bold text-navy">{title}</h2>
      {subtitle && <p className="mt-2 text-center text-xl text-muted">{subtitle}</p>}
      {error && (
        <p role="alert" className="mt-4 flex items-center gap-2 rounded-lg bg-err-100 px-4 py-3 text-lg font-semibold text-err">
          <AlertTriangle className="size-6 shrink-0" /> {error}
        </p>
      )}
      <label className="mt-6 grid gap-1">
        <span className="font-semibold">{t('welcome.username')}</span>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" className="h-14 rounded-lg border-2 border-line bg-white px-4 text-xl focus:border-navy focus:outline-none" />
      </label>
      <label className="mt-4 grid gap-1">
        <span className="font-semibold">{t('welcome.password')}</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="h-14 rounded-lg border-2 border-line bg-white px-4 text-xl focus:border-navy focus:outline-none" />
      </label>
      <Button type="submit" variant="navy" size="lg" className="mt-6" disabled={!username || !password || busy}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        {t('welcome.signIn')}
      </Button>
    </form>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" onClick={onClick} className="mb-6 inline-flex h-12 items-center gap-2 self-start rounded-lg px-3 text-lg font-semibold text-navy hover:bg-mist short:mb-2">
      <ArrowLeft className="size-6" />
      {t('back')}
    </button>
  );
}

function NoStation({ mode, setMode, onSupervisor }: { mode: Mode; setMode: (m: Mode) => void; onSupervisor: () => void }) {
  const t = useT();
  const after = useAfterSignIn();
  return (
    <div className="flex h-full flex-col bg-navy text-white">
      <div className="flex items-center justify-between gap-4 p-6">
        <div className="flex items-center gap-5">
          <Logo byline />
          <span className="rounded-xl bg-white px-4 py-2">
            <CompanyLogo className="h-10" />
          </span>
        </div>
        <LanguageSwitch />
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        {mode.kind === 'supervisor' ? (
          <div className="w-full max-w-md rounded-2xl bg-ivory p-8 text-ink">
            <PasswordStep title={t('welcome.supervisorSignIn')} onBack={() => setMode({ kind: 'home' })} submit={(u, p) => api.post('/auth/login', { username: u, password: p })} onDone={after} />
          </div>
        ) : (
          <div className="max-w-xl text-center">
            <MonitorX className="mx-auto size-20 text-orange" />
            <h1 className="mt-6 font-display text-4xl font-bold">{t('welcome.noStation')}</h1>
            <p className="mt-3 text-xl text-blue-300">{t('welcome.askSetup')}</p>
            <Button size="lg" className="mt-8" onClick={onSupervisor}>
              <UserRoundCog />
              {t('welcome.supervisorSignIn')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
