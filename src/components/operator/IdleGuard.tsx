import { useEffect, useRef, useState } from 'react';
import { Hand } from 'lucide-react';
import { useMe, useSignOut } from '@/hooks/useMe';
import { say } from '@/lib/audio';
import { useT } from '@/lib/i18n';
import { useActivity } from '@/stores/activity';

const WARN_SECONDS = 30;

/**
 * Signs an operator out after the station's idle time without a touch, so the
 * next person never works under someone else's name. 30 seconds before, a
 * full-screen "Are you still here?" asks for one touch. Work in progress is
 * safe: it is saved on the server and the next sign-in asks for the
 * equipment check before going on. It never runs while the operator is
 * pouring on a zeroed scale (see stores/activity.ts).
 */
export function IdleGuard() {
  const t = useT();
  const { data } = useMe();
  const signOut = useSignOut();
  const minutes = data?.station?.idleMinutes ?? 0;
  const [left, setLeft] = useState<number | null>(null);
  const lastTouch = useRef(Date.now());
  const warned = useRef(false);

  useEffect(() => {
    if (!minutes) return;
    const touch = () => {
      lastTouch.current = Date.now();
      warned.current = false;
      setLeft(null);
    };
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true });
    // Pouring on a zeroed scale counts as being here: the countdown starts again once weighing ends.
    if (useActivity.getState().weighing) touch();
    const unsubscribe = useActivity.subscribe((s) => s.weighing && touch());
    const iv = setInterval(() => {
      if (useActivity.getState().weighing) {
        lastTouch.current = Date.now();
        return;
      }
      const idle = (Date.now() - lastTouch.current) / 1000;
      const remaining = Math.ceil(minutes * 60 + WARN_SECONDS - idle);
      if (remaining <= 0) {
        clearInterval(iv);
        void signOut();
      } else if (remaining <= WARN_SECONDS) {
        if (!warned.current) say('say.idle');
        warned.current = true;
        setLeft(remaining);
      }
    }, 1000);
    return () => {
      for (const e of events) window.removeEventListener(e, touch);
      unsubscribe();
      clearInterval(iv);
    };
  }, [minutes, signOut]);

  if (left == null) return null;
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-navy-900/90 p-6 text-center text-white" role="alertdialog" aria-live="assertive">
      <div className="flex flex-col items-center">
        <Hand className="size-32 animate-pulse text-orange" strokeWidth={1.6} />
        <h2 className="mt-6 font-display text-6xl font-bold">{t('idle.title')}</h2>
        <p className="mt-3 text-3xl text-blue-300">{t('idle.body')}</p>
        <button className="mt-10 min-h-32 min-w-[24rem] rounded-2xl bg-orange px-10 font-display text-5xl font-bold uppercase text-navy-900 shadow-[0_5px_0_0_#a85c1c] active:translate-y-0.5">
          {t('idle.stay')}
        </button>
        <p className="mt-6 font-mono text-3xl tabular text-blue-300">{t('idle.leaving', { s: left })}</p>
      </div>
    </div>
  );
}
