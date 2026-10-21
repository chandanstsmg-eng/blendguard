import { api } from '@/lib/api';
import { LANGS } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { usePrefs } from '@/stores/prefs';

/** Always-visible three-way language switch. Large enough for a gloved finger. */
export function LanguageSwitch({ dark = true, remember = false }: { dark?: boolean; remember?: boolean }) {
  const { lang, setLang } = usePrefs();
  return (
    <div role="radiogroup" aria-label="Language" className={cn('flex rounded-lg p-1', dark ? 'bg-white/10' : 'bg-mist')}>
      {LANGS.map((l) => {
        const active = l.code === lang;
        return (
          <button
            key={l.code}
            role="radio"
            aria-checked={active}
            aria-label={l.label}
            onClick={() => {
              setLang(l.code);
              if (remember) void api.post('/me/language', { language: l.code }).catch(() => {});
            }}
            className={cn(
              'h-14 min-w-16 rounded-md px-3 text-xl font-bold transition-colors short:h-12',
              active ? 'bg-orange text-navy-900' : dark ? 'text-white/85 hover:bg-white/10' : 'text-navy hover:bg-white',
            )}
          >
            {l.short}
          </button>
        );
      })}
    </div>
  );
}
