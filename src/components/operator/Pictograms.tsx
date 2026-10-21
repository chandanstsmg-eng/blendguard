/**
 * Safety as pictures. Hazards use the red-diamond style of the GHS labels the
 * operators already see on drums and bottles; protective equipment uses the
 * blue round "must wear" style of workplace safety signs. A short word goes
 * underneath, but the picture alone carries the meaning.
 */
import { AlertTriangle, Biohazard, Flame, FlaskConical, Glasses, Hand, Leaf, Pipette, Skull, Utensils, Wind } from 'lucide-react';
import { useT, hasKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const HAZARD_ICON: Record<string, typeof Flame> = {
  FLAMMABLE: Flame,
  IRRITANT: AlertTriangle,
  ENVIRONMENT: Leaf,
  TOXIC: Skull,
  CORROSIVE: FlaskConical,
};

const PPE_ICON: Record<string, typeof Hand> = {
  GLOVES: Hand,
  MASK: Wind,
  GOGGLES: Glasses,
  DROPPER: Pipette,
  SPATULA: Utensils,
};

export function HazardSign({ code, size = 'md' }: { code: string; size?: 'sm' | 'md' | 'lg' }) {
  const t = useT();
  const Icon = HAZARD_ICON[code] ?? Biohazard;
  const box = { sm: 'size-12', md: 'size-20 short:size-14', lg: 'size-28' }[size];
  const key = `hazard.${code}`;
  return (
    <figure className="flex w-min flex-col items-center gap-1.5">
      <div className={cn('grid place-items-center', box)} title={hasKey(key) ? t(key) : code}>
        <div className="grid size-[72%] rotate-45 place-items-center rounded-[10%] border-[5px] border-err bg-white shadow-sm">
          <Icon className="size-[62%] -rotate-45 text-ink" strokeWidth={2.4} />
        </div>
      </div>
      {size !== 'sm' && <figcaption className="whitespace-nowrap text-center text-base font-bold leading-tight text-err">{hasKey(key) ? t(key) : code}</figcaption>}
    </figure>
  );
}

export function PpeSign({ code, size = 'md' }: { code: string; size?: 'sm' | 'md' | 'lg' }) {
  const t = useT();
  const Icon = PPE_ICON[code] ?? Hand;
  const box = { sm: 'size-12', md: 'size-20 short:size-14', lg: 'size-28' }[size];
  const key = `ppe.${code}`;
  return (
    <figure className="flex w-min flex-col items-center gap-1.5">
      <div className={cn('grid place-items-center rounded-full bg-[#1d5fb4] text-white shadow-sm ring-4 ring-white', box)} title={hasKey(key) ? t(key) : code}>
        <Icon className="size-[55%]" strokeWidth={2.2} />
      </div>
      {size !== 'sm' && <figcaption className="whitespace-nowrap text-center text-base font-bold leading-tight text-[#1d5fb4]">{hasKey(key) ? t(key) : code}</figcaption>}
    </figure>
  );
}

/** All safety pictures for an ingredient, PPE first (what to do), then hazards (why). */
export function SafetySigns({ ppe, hazards, size = 'md', className }: { ppe: string[]; hazards: string[]; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  if (!ppe.length && !hazards.length) return null;
  return (
    <div className={cn('flex shrink-0 flex-wrap items-start gap-4 short:gap-3 short:[&_figcaption]:text-sm', className)}>
      {ppe.map((p) => (
        <PpeSign key={p} code={p} size={size} />
      ))}
      {hazards.map((h) => (
        <HazardSign key={h} code={h} size={size} />
      ))}
    </div>
  );
}
