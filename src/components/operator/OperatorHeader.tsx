import { useState } from 'react';
import { LogOut, Volume2, VolumeX, Wifi, WifiOff } from 'lucide-react';
import { CompanyLogo, Logo } from '@/components/Logo';
import { LanguageSwitch } from './LanguageSwitch';
import { HowToGuide } from './HowToGuide';
import { Confirm } from './Confirm';
import { useMe, useSignOut } from '@/hooks/useMe';
import { clockText, useClock } from '@/hooks/useClock';
import { useSocketStatus } from '@/lib/socket';
import { useT } from '@/lib/i18n';
import { usePrefs } from '@/stores/prefs';
import { cn } from '@/lib/utils';

/**
 * Top bar on every operator screen. Every control is at least 56 px tall and
 * has a picture plus a word; signing out asks first (yes / no pictures).
 */
export function OperatorHeader() {
  const t = useT();
  const { data } = useMe();
  const now = useClock();
  const online = useSocketStatus();
  const signOut = useSignOut();
  const { sound, setSound } = usePrefs();
  const [asking, setAsking] = useState(false);
  const user = data?.user;
  const station = data?.station;

  return (
    <header className="no-print flex h-[84px] shrink-0 items-center gap-3 bg-navy px-4 text-white lg:px-5 short:h-[68px] short:[&_.h-14]:h-12 short:[&_.size-14]:size-12">
      <Logo />
      <span className="hidden rounded-lg bg-white px-3 py-1.5 lg:block">
        <CompanyLogo className="h-9 short:h-8" />
      </span>
      <div className="mx-1 hidden h-12 w-px bg-white/15 md:block" />
      <div className="hidden min-w-0 md:block">
        <div className="text-xs font-semibold text-blue-300">{t('station')}</div>
        <div className="truncate font-display text-2xl font-bold leading-tight">{station?.name ?? '—'}</div>
      </div>

      <div className="ml-auto flex items-center gap-2.5">
        <div className="hidden font-display text-2xl font-bold tabular xl:block">{clockText(now)}</div>
        {!online && (
          <div className="flex h-14 items-center gap-2 rounded-lg bg-err px-3 font-semibold text-white" role="status" aria-live="polite">
            <WifiOff className="size-6" />
            <span className="hidden sm:inline">{t('offline')}</span>
          </div>
        )}
        {online && (
          <div className="grid size-14 place-items-center rounded-lg bg-ok/25 text-[#bfe8cf]" role="status" title={t('online')} aria-label={t('online')}>
            <Wifi className="size-6" />
          </div>
        )}
        <LanguageSwitch remember={!!user} />
        <button
          onClick={() => setSound(!sound)}
          className={cn('flex h-14 items-center gap-2 rounded-lg px-3 font-semibold', sound ? 'bg-white/10 hover:bg-white/20' : 'bg-warn text-navy-900')}
          aria-label={sound ? t('soundOn') : t('soundOff')}
          aria-pressed={sound}
        >
          {sound ? <Volume2 className="size-7" /> : <VolumeX className="size-7" />}
          <span className="hidden 2xl:inline">{sound ? t('soundOn') : t('soundOff')}</span>
        </button>
        {user && <HowToGuide />}
        {user && (
          <div className="flex items-center gap-2 rounded-lg bg-white/10 p-1">
            <div className="grid size-12 place-items-center rounded-md bg-orange font-display text-xl font-bold text-navy-900" aria-hidden>
              {user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
            </div>
            <div className="hidden max-w-36 pr-1 leading-tight xl:block">
              <div className="truncate font-semibold">{user.name.split(' ')[0]}</div>
              {user.operatorCode && <div className="text-xs text-blue-300">{t('header.id', { code: user.operatorCode })}</div>}
            </div>
            <button onClick={() => setAsking(true)} className="flex h-12 items-center gap-2 rounded-md bg-white/15 px-3 font-display text-lg font-bold uppercase hover:bg-white/25">
              <LogOut className="size-6" />
              <span className="hidden lg:inline">{t('signOut')}</span>
            </button>
          </div>
        )}
      </div>
      <Confirm
        open={asking}
        question="confirm.signOut"
        spoken="say.confirmSignOut"
        icon={<LogOut />}
        onNo={() => setAsking(false)}
        onYes={() => {
          setAsking(false);
          void signOut();
        }}
      />
    </header>
  );
}

export function TrainingRibbon() {
  const t = useT();
  const { data } = useMe();
  if (data?.station?.scaleMode !== 'SIMULATED') return null;
  return (
    <div className="no-print flex h-8 shrink-0 items-center justify-center bg-[repeating-linear-gradient(135deg,#e7a42a_0_14px,#f0b84c_14px_28px)] text-sm font-bold tracking-wide text-navy-900 tiny:h-6 tiny:text-xs">
      {t('training')}
    </div>
  );
}
