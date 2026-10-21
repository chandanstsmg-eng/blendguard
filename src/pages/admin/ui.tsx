/** Small building blocks shared by the scientist screens. */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line bg-white px-8 py-6">
      <div>
        <h1 className="font-display text-3xl font-bold text-navy">{title}</h1>
        {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export const inputCls = 'h-11 w-full rounded-lg border border-line bg-white px-3 text-base focus:border-navy focus:outline-none focus:ring-2 focus:ring-navy/20';

export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('grid gap-1.5', className)}>
      <span className="text-sm font-semibold text-ink">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-sm font-semibold text-err">{error}</span>}
    </label>
  );
}

/** Human-readable message for any thrown value. */
export function errMsg(e: unknown, fallback = 'Something went wrong. Please try again.') {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export function ErrorBox({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p className={cn('flex items-start gap-2 rounded-lg bg-err-100 px-4 py-3 font-semibold text-err', className)} role="alert">
      <AlertTriangle className="mt-0.5 size-5 shrink-0" />
      {errMsg(error)}
    </p>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 rounded-xl border border-line bg-white p-12 text-muted">
      <Loader2 className="size-5 animate-spin" /> {label}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children?: React.ReactNode }) {
  return (
    <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-line bg-white p-12 text-center">
      <Icon className="size-10 text-blue-300" />
      <div className="font-display text-xl font-bold text-navy">{title}</div>
      {children && <div className="max-w-md text-muted">{children}</div>}
    </div>
  );
}

/** Pill-style on/off switch. */
export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange/50 disabled:opacity-50',
        checked ? 'bg-ok' : 'bg-line',
      )}
    >
      <span className={cn('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

/** "Saved" tick that fades after a moment; bump `tick` to show it again. */
export function SavedFlash({ tick }: { tick: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!tick) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 1800);
    return () => clearTimeout(t);
  }, [tick]);
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm font-semibold text-ok transition-opacity', show ? 'opacity-100' : 'opacity-0')} aria-live="polite">
      <CheckCircle2 className="size-4" /> Saved
    </span>
  );
}

/** Confirmation dialog for anything destructive or far-reaching. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'danger',
  pending,
  error,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'navy';
  pending?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="w-[min(520px,calc(100vw-32px))]">
        <DialogTitle className="text-2xl">{title}</DialogTitle>
        {description && <DialogDescription className="text-base">{description}</DialogDescription>}
        {children}
        <ErrorBox error={error} className="mt-4" />
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={tone} size="md" disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const LANGUAGES: { value: 'en' | 'hi' | 'ml'; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'हिन्दी (Hindi)' },
  { value: 'ml', label: 'മലയാളം (Malayalam)' },
];

export const langLabel = (l: string) => LANGUAGES.find((x) => x.value === l)?.label ?? l;
