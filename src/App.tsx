import { lazy, Suspense } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router';
import { useLanguageDefault, useMe } from '@/hooks/useMe';
import { useSocket } from '@/lib/socket';
import { Welcome } from '@/pages/Welcome';
import { OperatorHome } from '@/pages/operator/Home';
import { MyJobs } from '@/pages/operator/MyJobs';
import { Run } from '@/pages/operator/Run';
import { IdleGuard } from '@/components/operator/IdleGuard';
import { Splash } from '@/components/Splash';

// Station PCs never open the consoles, so they are loaded only when needed.
const SupervisorConsole = lazy(() => import('@/pages/supervisor/Console').then((m) => ({ default: m.SupervisorConsole })));

/**
 * Two areas, one per role: operators at the stations, scientists at the desk.
 * Neither can open the other's screens (the server enforces the same rule).
 */
export function App() {
  const qc = useQueryClient();
  useSocket(qc);
  const me = useMe();
  useLanguageDefault(me.data);

  if (me.isLoading) return <Splash />;
  if (me.isError) return <Splash error />;

  const role = me.data?.user?.role;
  const home = role === 'OPERATOR' ? '/operator' : role === 'SUPERVISOR' ? '/supervisor' : null;
  const only = (r: typeof role, el: React.ReactNode) => (role === r ? el : <Navigate to="/" replace />);

  return (
    <Suspense fallback={<Splash />}>
      <Routes>
        <Route path="/" element={home ? <Navigate to={home} replace /> : <Welcome />} />
        <Route path="/operator" element={only('OPERATOR', <OperatorHome />)} />
        <Route path="/operator/jobs" element={only('OPERATOR', <MyJobs />)} />
        <Route path="/operator/run/:id" element={only('OPERATOR', <Run />)} />
        <Route path="/supervisor/*" element={only('SUPERVISOR', <SupervisorConsole />)} />
        {/* The setup screens moved into the scientist console. */}
        <Route path="/admin/*" element={<Navigate to="/supervisor/users" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {role === 'OPERATOR' && <IdleGuard />}
    </Suspense>
  );
}
