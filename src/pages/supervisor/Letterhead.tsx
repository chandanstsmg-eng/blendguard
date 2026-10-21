import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadCompany } from '@/lib/workReport';

/**
 * The client's letterhead for printed pages: their logo (public/company-logo.png)
 * when there is one, and their name and address from the server's
 * configuration (COMPANY_* in .env). Shown on paper only.
 */
export function Letterhead({ title, children }: { title: string; children?: React.ReactNode }) {
  const company = useQuery({ queryKey: ['company'], queryFn: loadCompany, staleTime: Infinity });
  const [logo, setLogo] = useState(true);
  const c = company.data;
  return (
    <div className="hidden items-start justify-between gap-6 border-b-2 border-navy pb-3 print:flex">
      <div className="min-w-0">
        {logo && <img src="/company-logo.png" alt={c?.name ?? ''} className="mb-1 h-12 w-auto" onError={() => setLogo(false)} />}
        {c && (
          <>
            <div className="font-bold text-ink">{c.name}</div>
            <div className="text-xs text-muted">{c.address.join(', ')}</div>
          </>
        )}
      </div>
      <div className="text-right text-sm">
        <div className="font-bold text-navy">{title}</div>
        {children}
      </div>
    </div>
  );
}
