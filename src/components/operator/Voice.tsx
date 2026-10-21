import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Volume2 } from 'lucide-react';
import { lastPhrase, onLastPhrase, repeatLast, say } from '@/lib/audio';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Speaks `key` once whenever `when` changes to a new value (e.g. a new
 * ingredient or stage), so every screen tells the operator what to do.
 * Re-renders with the same `when` stay silent.
 */
export function useSayOnEnter(key: TKey | null, vars: Record<string, string | number> | undefined, when: string | number | null, delayMs = 250) {
  const said = useRef<string | number | null>(null);
  useEffect(() => {
    // Leaving the screen (when = null) re-arms it, so a dialog that opens again speaks again.
    if (when == null) {
      said.current = null;
      return;
    }
    if (!key || said.current === when) return;
    said.current = when;
    const id = setTimeout(() => say(key, vars), delayMs);
    return () => clearTimeout(id);
    // `vars` is deliberately not a dependency: it is read when `when` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, when, delayMs]);
}

/** Big speaker button: says the last instruction again. */
export function RepeatButton({ className, dark = false }: { className?: string; dark?: boolean }) {
  const t = useT();
  const has = useSyncExternalStore(onLastPhrase, () => !!lastPhrase());
  return (
    <button
      type="button"
      onClick={repeatLast}
      disabled={!has}
      className={cn(
        'inline-flex min-h-16 shrink-0 items-center justify-center gap-3 rounded-xl px-5 font-display text-2xl font-bold uppercase tracking-wide transition-colors disabled:opacity-40',
        dark ? 'bg-white/15 text-white hover:bg-white/25' : 'border-2 border-navy bg-white text-navy shadow-[0_3px_0_0_#17394C] hover:bg-mist active:translate-y-px',
        className,
      )}
      aria-label={t('repeat')}
    >
      <Volume2 className="size-8" />
      <span>{t('repeat')}</span>
    </button>
  );
}
