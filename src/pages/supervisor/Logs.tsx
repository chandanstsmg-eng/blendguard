import { useSearchParams } from 'react-router';
import { cn } from '@/lib/utils';
import { ActivityLog } from './ActivityLog';
import { Audit } from '../admin/Audit';

const TABS = [
  { key: 'operator', label: 'Operator activity', hint: 'One operator, one day' },
  { key: 'audit', label: 'Audit trail', hint: 'Every event, with filters and CSV' },
] as const;

/**
 * Both logs in one place: what one operator did on a day (printable), and the
 * full audit trail of the system. The tab is kept in the address (?view=audit).
 */
export function Logs() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'audit' ? 'audit' : 'operator';
  return (
    <>
      <div role="tablist" aria-label="Logs" className="no-print flex gap-8 bg-white px-8 pt-4">
        {TABS.map((t) => {
          const active = view === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setParams(t.key === 'audit' ? { view: 'audit' } : {}, { replace: true })}
              className={cn('border-b-2 pb-2 text-left transition-colors', active ? 'border-orange text-navy' : 'border-transparent text-muted hover:text-navy')}
            >
              <span className="block font-semibold">{t.label}</span>
              <span className="block text-xs text-muted">{t.hint}</span>
            </button>
          );
        })}
      </div>
      {view === 'audit' ? <Audit /> : <ActivityLog />}
    </>
  );
}
