import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, ClipboardPlus, FileBarChart, FlaskConical, LogOut, MonitorCog, MonitorPlay, Package, Scale, ScrollText, UserCog, Wifi, WifiOff } from 'lucide-react';
import { CompanyLogo, DeveloperLogo, Logo } from '@/components/Logo';
import { useMe, useSignOut } from '@/hooks/useMe';
import { api } from '@/lib/api';
import { useSocketStatus } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { FloorMonitor } from './FloorMonitor';
import { Overview } from './Overview';
import { AssignJob } from './AssignJob';
import { Stations } from './Stations';
import { ShiftReport } from './ShiftReport';
import { Logs } from './Logs';
import { Users as UsersSetup } from '../admin/Users';
import { Stations as StationSetup } from '../admin/Stations';
import { Ingredients } from '../admin/Ingredients';
import { Formulas } from '../admin/Formulas';
import { openCallCount } from './labels';
import type { Overview as OverviewData } from './types';

export function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: () => api.get<OverviewData>('/supervisor/overview'), refetchInterval: 15_000 });
}

/** Tracks whether the browser is in full-screen mode (the floor monitor hides the sidebar then). */
export function useFullscreen() {
  const [on, setOn] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const h = () => setOn(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };
  return { on, toggle };
}

const NAV = [
  {
    title: 'Daily work',
    items: [
      { to: '/supervisor/assign', label: 'Assign job', icon: ClipboardPlus, badge: false },
      { to: '/supervisor/overview', label: 'Jobs & calls', icon: ClipboardList, badge: true },
      { to: '/supervisor/monitor', label: 'Floor monitor', icon: MonitorPlay, badge: false },
      { to: '/supervisor/stations', label: 'Scale checks', icon: Scale, badge: false },
      { to: '/supervisor/report', label: 'Shift report', icon: FileBarChart, badge: false },
    ],
  },
  {
    title: 'Setup & records',
    items: [
      { to: '/supervisor/users', label: 'Users', icon: UserCog, badge: false },
      { to: '/supervisor/station-setup', label: 'Station setup', icon: MonitorCog, badge: false },
      { to: '/supervisor/ingredients', label: 'Ingredients', icon: Package, badge: false },
      { to: '/supervisor/formulas', label: 'Formulas', icon: FlaskConical, badge: false },
      { to: '/supervisor/logs', label: 'Logs', icon: ScrollText, badge: false },
    ],
  },
];

/** Desktop scientist console: the floor (jobs, calls, scale checks) and the system setup. */
export function SupervisorConsole() {
  const { data } = useMe();
  const signOut = useSignOut();
  const online = useSocketStatus();
  const overview = useOverview();
  const { on: fullscreen } = useFullscreen();
  const calls = openCallCount(overview.data);

  return (
    <div className="flex h-full bg-mist print:block print:h-auto print:bg-white">
      <aside className={cn('no-print w-64 shrink-0 flex-col bg-navy text-white', fullscreen ? 'hidden' : 'flex')}>
        <div className="flex flex-col gap-4 px-5 py-5">
          <Logo />
          <div className="flex justify-center rounded-lg bg-white px-3 py-2">
            <CompanyLogo className="h-9" />
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4">
          {NAV.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              <div className="px-3 pb-1 text-xs font-semibold text-blue-300">{group.title}</div>
              {group.items.map(({ to, label, icon: Icon, badge }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => cn('flex h-10 shrink-0 items-center gap-3 rounded-lg px-3 font-medium transition-colors', isActive ? 'bg-white font-semibold text-navy' : 'text-white/80 hover:bg-white/10 hover:text-white')}
                >
                  <Icon className="size-[18px]" />
                  {label}
                  {badge && calls > 0 && <span className="ml-auto rounded-full bg-orange px-2 text-sm font-bold text-navy-900">{calls}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-white/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{data?.user?.name}</div>
              <div className={cn('flex items-center gap-1.5 text-xs', online ? 'text-blue-300' : 'text-[#ffb4b4]')}>
                {online ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
                {online ? 'Scientist · Live' : 'Connection lost. Reconnecting…'}
              </div>
            </div>
            <button onClick={() => void signOut()} className="grid size-10 place-items-center rounded-lg bg-white/10 hover:bg-white/20" title="Sign out" aria-label="Sign out">
              <LogOut className="size-5" />
            </button>
          </div>
          <div className="mt-3 flex flex-col items-center gap-1 rounded-lg bg-white px-3 pb-2 pt-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Developed by</span>
            <DeveloperLogo className="h-11" />
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto print:overflow-visible">
        <Routes>
          <Route path="monitor" element={<FloorMonitor />} />
          <Route path="overview" element={<Overview />} />
          <Route path="assign" element={<AssignJob />} />
          <Route path="report" element={<ShiftReport />} />
          <Route path="stations" element={<Stations />} />
          <Route path="users" element={<UsersSetup />} />
          <Route path="station-setup" element={<StationSetup />} />
          <Route path="ingredients" element={<Ingredients />} />
          <Route path="formulas" element={<Formulas />} />
          <Route path="logs" element={<Logs />} />
          {/* Older links: these pages are now part of Users and Logs. */}
          <Route path="operators" element={<Navigate to="/supervisor/users" replace />} />
          <Route path="activity" element={<Navigate to="/supervisor/logs" replace />} />
          <Route path="audit" element={<Navigate to="/supervisor/logs?view=audit" replace />} />
          <Route path="*" element={<Navigate to="/supervisor/assign" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line bg-white px-8 py-6 print:border-0 print:px-0 print:py-2">
      <div>
        <h1 className="font-display text-3xl font-bold text-navy">{title}</h1>
        {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
