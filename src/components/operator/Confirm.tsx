import { Check, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/lib/i18n';
import { useSayOnEnter } from './Voice';
import type { TKey } from '@/lib/i18n';

/**
 * Yes / no question with a big picture on each answer: green tick and red
 * cross, so it can be answered without reading. The question is also spoken.
 */
export function Confirm({
  open,
  question,
  spoken,
  icon,
  onYes,
  onNo,
}: {
  open: boolean;
  question: TKey;
  spoken: TKey;
  icon: React.ReactNode;
  onYes: () => void;
  onNo: () => void;
}) {
  const t = useT();
  useSayOnEnter(open ? spoken : null, undefined, open ? question : null, 0);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onNo()}>
      <DialogContent hideClose className="w-[min(720px,calc(100vw-32px))] p-8">
        <div className="flex flex-col items-center text-center">
          <div className="grid size-28 place-items-center rounded-full bg-mist text-navy [&_svg]:size-16">{icon}</div>
          <DialogTitle className="mt-5 pr-0 text-5xl">{t(question)}</DialogTitle>
          <DialogDescription className="sr-only">{t(question)}</DialogDescription>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-5">
          <button
            onClick={onNo}
            className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-2xl border-4 border-err bg-err-100 font-display text-4xl font-bold text-err active:translate-y-px"
            autoFocus
          >
            <X className="size-20" strokeWidth={3} />
            {t('no')}
          </button>
          <button onClick={onYes} className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-2xl border-4 border-ok bg-ok-100 font-display text-4xl font-bold text-ok active:translate-y-px">
            <Check className="size-20" strokeWidth={3} />
            {t('yes')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
