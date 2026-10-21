import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Drop-with-check mark: a measured drop, verified. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-10', className)} aria-hidden>
      <rect width="64" height="64" rx="14" fill="#D98236" />
      <path d="M32 9 C32 9 15 28 15 39.5 a17 17 0 0 0 34 0 C49 28 32 9 32 9Z" fill="#17394C" />
      <path d="M24 39.5 l5.8 5.8 l10.5-11.6" fill="none" stroke="#F8F8F5" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The plant's own logo (public/company-logo.png, the same file the batch records
 * print) when it has been added; otherwise the DhishaAI logo. For a light background.
 */
export function CompanyLogo({ className }: { className?: string }) {
  const [client, setClient] = useState(true);
  return client ? (
    <img src="/company-logo.png" alt="" className={cn('h-14 w-auto select-none', className)} draggable={false} onError={() => setClient(false)} />
  ) : (
    <img src="/dhishaai-logo.png" alt="DhishaAI, Complete Analytics" className={cn('h-14 w-auto select-none', className)} draggable={false} />
  );
}

/** The logo of DhishaAI, the company that built BlendGuard. For a light background. */
export function DeveloperLogo({ className }: { className?: string }) {
  return <img src="/dhishaai-logo.png" alt="DhishaAI, Complete Analytics" className={cn('h-8 w-auto select-none', className)} draggable={false} />;
}

/** "Developed by" + the DhishaAI logo; on a dark background the logo gets a white badge. */
export function DeveloperCredit({ className, dark = false }: { className?: string; dark?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5 text-xs font-medium uppercase tracking-wider', dark ? 'text-blue-300' : 'text-muted', className)}>
      Developed by
      <span className={cn(dark && 'rounded-md bg-white px-2 py-1')}>
        <DeveloperLogo />
      </span>
    </div>
  );
}

/** BlendGuard; with `byline`, signed "A product of DhishaAI" underneath (for the navy panels). */
export function Logo({ className, light = true, byline = false }: { className?: string; light?: boolean; byline?: boolean }) {
  const mark = (
    <div className={cn('flex items-center gap-3', !byline && className)}>
      <LogoMark />
      <span className={cn('font-display text-[1.65rem] font-bold leading-none tracking-wide', light ? 'text-white' : 'text-navy')}>
        Blend<span className="text-orange">Guard</span>
      </span>
    </div>
  );
  if (!byline) return mark;
  return (
    <div className={cn('flex flex-col items-start gap-2.5', className)}>
      {mark}
      <div className="flex items-center gap-2.5 text-xs font-medium uppercase tracking-wider text-blue-300">
        A product of
        <span className="rounded-md bg-white px-2 py-1">
          <DeveloperLogo className="h-7" />
        </span>
      </div>
    </div>
  );
}
