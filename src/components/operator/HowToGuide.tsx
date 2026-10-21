import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, ArrowRight, Check, CircleHelp, OctagonX, ScanBarcode } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { BottleArt, LocationBadge } from '@/components/visual/Bottle';
import { useMe } from '@/hooks/useMe';
import { say } from '@/lib/audio';
import { useT, type TKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** One picture per step of the job, each read aloud. */
const SLIDES: { text: TKey; voice: TKey; art: () => React.ReactNode }[] = [
  {
    text: 'guide.1',
    voice: 'say.guide1',
    art: () => (
      <div className="flex items-end gap-6">
        <BottleArt color="#2f6fd6" className="h-48" />
        <LocationBadge rack="A" bin={7} color="#2f6fd6" size="lg" />
      </div>
    ),
  },
  {
    text: 'guide.2',
    voice: 'say.guide2',
    art: () => (
      <div className="relative grid size-56 place-items-center rounded-3xl bg-navy text-orange">
        <ScanBarcode className="size-36" strokeWidth={1.4} />
        <span className="absolute inset-x-8 top-1/2 h-1 animate-pulse rounded bg-err" />
      </div>
    ),
  },
  {
    text: 'guide.3',
    voice: 'say.guide3',
    art: () => (
      <div className="flex flex-col items-center gap-4">
        <div className="font-mono text-7xl font-bold text-navy">0.00 g</div>
        <div className="h-6 w-72 rounded-lg bg-navy" />
        <div className="rounded-xl bg-navy px-8 py-4 font-display text-4xl font-bold text-white">0</div>
      </div>
    ),
  },
  {
    text: 'guide.4',
    voice: 'say.guide4',
    art: () => (
      <div className="grid size-56 place-items-center rounded-full bg-ok text-white shadow-[0_0_0_16px_rgba(36,132,79,0.25)]">
        <Check className="size-36" strokeWidth={3} />
      </div>
    ),
  },
  {
    text: 'guide.5',
    voice: 'say.guide5',
    art: () => (
      // Too much (red) → take the extra out → correct (green).
      <div className="flex items-center gap-6">
        <div className="grid size-44 place-items-center rounded-full bg-err text-white">
          <OctagonX className="size-28" strokeWidth={2.4} />
        </div>
        <ArrowRight className="size-20 text-navy" strokeWidth={2.4} />
        <div className="grid size-44 place-items-center rounded-full bg-ok text-white">
          <Check className="size-28" strokeWidth={3} />
        </div>
      </div>
    ),
  },
];

const seenKey = (userId: string) => `bg.guideSeen.${userId}`;

/** "HOW TO" button + the guide. Opens by itself the first time an operator signs in on this screen. */
export function HowToGuide({ buttonClassName }: { buttonClassName?: string }) {
  const t = useT();
  const { data } = useMe();
  const userId = data?.user?.id;
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (!userId) return;
    try {
      if (!localStorage.getItem(seenKey(userId))) setOpen(true);
    } catch {
      /* storage blocked: just don't auto-open */
    }
  }, [userId]);

  useEffect(() => {
    if (!open) return;
    // A short wait so the guide is not cut off by the page's own spoken instruction.
    const id = setTimeout(() => say(SLIDES[i].voice), i === 0 ? 1200 : 150);
    return () => clearTimeout(id);
  }, [open, i]);

  const close = () => {
    setOpen(false);
    setI(0);
    try {
      if (userId) localStorage.setItem(seenKey(userId), '1');
    } catch {
      /* ignore */
    }
  };
  const slide = SLIDES[i];
  const lastSlide = i === SLIDES.length - 1;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn('flex h-14 items-center gap-2 rounded-lg bg-white/10 px-3 font-display text-xl font-bold uppercase hover:bg-white/20', buttonClassName)}
        aria-label={t('help')}
      >
        <CircleHelp className="size-7" />
        <span className="hidden lg:inline">{t('help')}</span>
      </button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
        <DialogContent className="w-[min(900px,calc(100vw-32px))] p-8">
          <DialogTitle>{t('guide.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t(slide.text)}</DialogDescription>
          <div className="mt-2 flex justify-center gap-2" aria-hidden>
            {SLIDES.map((_, n) => (
              <span key={n} className={cn('h-3 rounded-full transition-all', n === i ? 'w-10 bg-orange' : n < i ? 'w-3 bg-ok' : 'w-3 bg-line')} />
            ))}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={i} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.18 }} className="flex flex-col items-center">
              <div className="mt-6 grid h-64 place-items-center">{slide.art()}</div>
              <div className="mt-6 flex items-center gap-4">
                <span className="grid size-16 shrink-0 place-items-center rounded-full bg-navy font-display text-4xl font-bold text-white">{i + 1}</span>
                <p className="font-display text-4xl font-bold leading-tight text-navy">{t(slide.text)}</p>
              </div>
            </motion.div>
          </AnimatePresence>
          <div className="mt-8 grid grid-cols-[auto_1fr] gap-4">
            <button
              onClick={() => setI((n) => Math.max(0, n - 1))}
              disabled={i === 0}
              className="flex min-h-20 items-center gap-2 rounded-xl border-2 border-navy px-6 font-display text-2xl font-bold uppercase text-navy disabled:opacity-30"
            >
              <ArrowLeft className="size-8" />
              {t('guide.back')}
            </button>
            <button
              onClick={() => (lastSlide ? close() : setI((n) => n + 1))}
              className={cn('flex min-h-20 items-center justify-center gap-3 rounded-xl font-display text-3xl font-bold uppercase shadow-[0_3px_0_0_rgba(0,0,0,0.25)] active:translate-y-px', lastSlide ? 'bg-ok text-white' : 'bg-orange text-navy-900')}
              autoFocus
            >
              {lastSlide ? t('guide.done') : t('guide.next')}
              {lastSlide ? <Check className="size-9" /> : <ArrowRight className="size-9" />}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
