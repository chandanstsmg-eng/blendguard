import { Delete, Eraser } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Big on-screen number pad (fallback sign-in only). Works with gloves; no system keyboard needed. */
export function Keypad({ value, onChange, max = 8, masked = false, label }: { value: string; onChange: (v: string) => void; max?: number; masked?: boolean; label: string }) {
  const t = useT();
  const press = (d: string) => value.length < max && onChange(value + d);
  return (
    <div className="w-full max-w-sm">
      <div className="mb-4 flex h-20 items-center justify-center rounded-xl border-2 border-navy bg-white font-mono text-4xl font-bold tracking-[0.3em] text-navy short:mb-3 short:h-16 tiny:h-14" aria-label={label} aria-live="polite">
        {value ? (masked ? '•'.repeat(value.length) : value) : <span className="text-2xl font-normal tracking-normal text-muted">{label}</span>}
      </div>
      <div className="grid grid-cols-3 gap-3 tiny:gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Key key={d} onClick={() => press(d)}>
            {d}
          </Key>
        ))}
        <Key onClick={() => onChange('')} className="bg-err-100 text-err" aria-label={t('clear')} title={t('clear')}>
          <Eraser className="size-8" />
        </Key>
        <Key onClick={() => press('0')}>0</Key>
        <Key onClick={() => onChange(value.slice(0, -1))} aria-label={t('delete')} title={t('delete')}>
          <Delete className="size-8" />
        </Key>
      </div>
    </div>
  );
}

function Key({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn('grid h-20 place-items-center rounded-xl border border-line bg-white font-mono text-4xl short:h-16 tiny:h-14 tiny:text-3xl font-bold text-navy shadow-[0_3px_0_0_#d9dfe2] active:translate-y-px active:bg-mist', className)}
      {...props}
    />
  );
}
