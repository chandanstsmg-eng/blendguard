/**
 * Pictures of ingredients, so operators who struggle with reading can match a
 * bottle by sight: its photo when one has been uploaded, otherwise a
 * drawing of a bottle in the cap / sticker colour, with the rack-bin badge that
 * is also stuck on the shelf.
 */
import { useState } from 'react';
import { cn, pad2 } from '@/lib/utils';

const FALLBACK = ['#2f6fd6', '#2aa198', '#d4a017', '#8b5a2b', '#7e57c2', '#d63c78', '#7cb342', '#c0392b', '#f4d03f', '#4fc3f7'];

/** The ingredient's colour, or a stable colour picked from its code when none is set. */
export function ingredientColor(code: string, colorHex: string | null | undefined) {
  if (colorHex) return colorHex;
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

/** Black or white, whichever reads better on `hex`. */
export function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#102A39' : '#FFFFFF';
}

/** A drawn bottle: coloured cap and liquid, white label band. */
export function BottleArt({ color, className, title }: { color: string; className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 120 180" className={className} role="img" aria-label={title}>
      {/* cap */}
      <rect x="40" y="6" width="40" height="30" rx="6" fill={color} stroke="#102A39" strokeWidth="3" />
      <rect x="46" y="36" width="28" height="14" fill="#dfe6ea" stroke="#102A39" strokeWidth="3" />
      {/* body */}
      <path d="M30 62 Q30 50 46 50 L74 50 Q90 50 90 62 L98 80 L98 164 Q98 174 88 174 L32 174 Q22 174 22 164 L22 80 Z" fill="#f4f7f8" stroke="#102A39" strokeWidth="3" />
      {/* liquid */}
      <path d="M25 104 L95 104 L95 163 Q95 171 87 171 L33 171 Q25 171 25 163 Z" fill={color} opacity="0.85" />
      {/* label */}
      <rect x="32" y="80" width="56" height="40" rx="4" fill="#ffffff" stroke="#102A39" strokeWidth="2" />
      <rect x="40" y="90" width="40" height="6" rx="3" fill={color} />
      <rect x="40" y="102" width="28" height="5" rx="2.5" fill="#c4ced3" />
      {/* shine */}
      <rect x="84" y="128" width="5" height="34" rx="2.5" fill="#ffffff" opacity="0.5" />
    </svg>
  );
}

/** "A-07" in the ingredient's colour: the same badge as on the shelf sticker. */
export function LocationBadge({ rack, bin, color, size = 'md', className }: { rack: string; bin: number; color: string; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  const sizes = { sm: 'h-8 px-2 text-lg rounded-md', md: 'h-12 px-3 text-3xl rounded-lg', lg: 'h-16 px-4 text-5xl rounded-xl', xl: 'h-24 px-6 text-7xl rounded-2xl' };
  return (
    <span
      className={cn('inline-flex items-center justify-center whitespace-nowrap border-4 border-navy-900/80 font-mono font-bold leading-none tabular', sizes[size], className)}
      style={{ background: color, color: inkOn(color) }}
    >
      {rack}-{pad2(bin)}
    </span>
  );
}

/** Photo of the bottle when there is one; the drawn bottle otherwise. */
export function IngredientPicture({
  code,
  name,
  colorHex,
  photoUrl,
  className,
}: {
  code: string;
  name: string;
  colorHex: string | null | undefined;
  photoUrl: string | null | undefined;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const color = ingredientColor(code, colorHex);
  return (
    <div className={cn('relative grid place-items-center overflow-hidden rounded-2xl border-4 bg-white', className)} style={{ borderColor: color }}>
      {photoUrl && !broken ? (
        <img src={photoUrl} alt={name} className="size-full object-contain" onError={() => setBroken(true)} draggable={false} />
      ) : (
        <BottleArt color={color} className="h-[88%] w-auto" title={name} />
      )}
    </div>
  );
}
