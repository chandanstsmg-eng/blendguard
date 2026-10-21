import type { RackInfo } from '@shared/types';
import { inkOn } from '@/components/visual/Bottle';
import { pad2 } from '@/lib/utils';
import { useT } from '@/lib/i18n';

/**
 * Where to go and which bin to open. Top: the racks on the floor with the
 * target rack lit. Bottom: the front of that rack with the bin lit in the
 * bottle's own colour. Bins are numbered left→right, top→bottom, as on the
 * rack labels. Drawn for a navy background.
 */
export function RackDiagram({ racks, rack, bin, color = '#D98236' }: { racks: RackInfo[]; rack: RackInfo; bin: number; color?: string }) {
  const t = useT();
  const cellW = 64;
  const cellH = 52;
  const gap = 8;
  const w = rack.cols * cellW + (rack.cols - 1) * gap;
  const h = rack.rows * cellH + (rack.rows - 1) * gap;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 short:gap-3">
      {/* Floor map */}
      <div className="flex shrink-0 items-end gap-2 pt-1.5" aria-hidden>
        {racks.map((r) => {
          const on = r.code === rack.code;
          return (
            <div
              key={r.code}
              className={'flex flex-1 flex-col items-center justify-center rounded-lg border-4 font-display font-bold ' + (on ? 'h-24 shadow-[0_0_0_6px_rgba(255,255,255,0.25)] short:h-16' : 'h-16 border-white/20 bg-white/5 text-white/50 short:h-12')}
              style={on ? { background: color, borderColor: '#fff', color: inkOn(color) } : undefined}
            >
              <span className="text-xs uppercase tracking-widest short:hidden">{t('run.rack')}</span>
              <span className={on ? 'text-6xl leading-none short:text-5xl' : 'text-3xl leading-none'}>{r.code}</span>
            </div>
          );
        })}
      </div>

      {/* Rack front */}
      <div className="flex min-h-0 flex-1 flex-col rounded-2xl bg-navy-900 p-4 short:p-3">
        <div className="mb-3 flex shrink-0 items-baseline justify-between short:mb-1">
          <span className="font-display text-3xl font-bold short:text-2xl">
            {t('run.rack')} {rack.code}
          </span>
          <span className="truncate pl-3 text-sm text-blue-300">{rack.zone}</span>
        </div>
        <svg viewBox={`-6 -6 ${w + 12} ${h + 12}`} className="min-h-0 w-full flex-1" role="img" aria-label={t('run.rackBin', { rack: rack.code, bin: pad2(bin) })}>
          {Array.from({ length: rack.rows * rack.cols }, (_, i) => {
            const n = i + 1;
            const x = (i % rack.cols) * (cellW + gap);
            const y = Math.floor(i / rack.cols) * (cellH + gap);
            const on = n === bin;
            return (
              <g key={n}>
                {on && <rect x={x - 5} y={y - 5} width={cellW + 10} height={cellH + 10} rx={10} fill="#ffffff" className="animate-bin" />}
                <rect x={x} y={y} width={cellW} height={cellH} rx={6} fill={on ? color : '#204D62'} stroke={on ? '#102A39' : '#2c6079'} strokeWidth={on ? 3 : 1} />
                <text x={x + cellW / 2} y={y + cellH / 2 + 8} textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontWeight={700} fontSize={on ? 26 : 16} fill={on ? inkOn(color) : '#8FB0C0'}>
                  {pad2(n)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
