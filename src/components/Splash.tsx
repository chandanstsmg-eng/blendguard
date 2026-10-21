import { useT } from '@/lib/i18n';
import { DeveloperCredit, LogoMark } from './Logo';

export function Splash({ error }: { error?: boolean }) {
  const t = useT();
  return (
    <div className="relative grid h-full place-items-center bg-navy text-white">
      <div className="flex flex-col items-center gap-5 text-center">
        <LogoMark className="size-20" />
        {error ? (
          <>
            <p className="font-display text-3xl font-bold">{t('splash.offline')}</p>
            <p className="text-lg text-blue-300">{t('splash.check')}</p>
            <button className="mt-2 rounded-lg bg-orange px-8 py-4 font-display text-2xl font-bold text-navy-900" onClick={() => location.reload()}>
              {t('splash.retry')}
            </button>
          </>
        ) : (
          <p className="font-display text-2xl tracking-wide text-blue-300">BlendGuard</p>
        )}
      </div>
      <DeveloperCredit dark className="absolute bottom-6 left-1/2 -translate-x-1/2" />
    </div>
  );
}
