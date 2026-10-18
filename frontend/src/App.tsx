import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from './api/queries';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/ui';
import { AdminPage } from './pages/AdminPage';
import { DeletedItemsPage } from './pages/DeletedItemsPage';
import { HomePage } from './pages/HomePage';
import { InboxPage } from './pages/InboxPage';
import { ItemPage } from './pages/ItemPage';
import { ItemsPage } from './pages/ItemsPage';
import { LoginPage } from './pages/LoginPage';
import { PersonPage } from './pages/PersonPage';
import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { ProjectsPage } from './pages/ProjectsPage';

// The canvas pulls in React Flow, the largest dependency, so it loads on demand.
const CanvasPage = lazy(() => import('./canvas/CanvasPage'));

function Protected({ children }: { children: React.ReactNode }) {
  const me = useMe();
  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <Spinner size={28} />
      </div>
    );
  }
  if (me.isError) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <AppShell>{children}</AppShell>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Protected><HomePage /></Protected>} />
      <Route path="/items" element={<Protected><ItemsPage /></Protected>} />
      <Route path="/items/:itemId" element={<Protected><ItemPage /></Protected>} />
      <Route path="/inbox" element={<Protected><InboxPage /></Protected>} />
      <Route path="/projects" element={<Protected><ProjectsPage /></Protected>} />
      <Route path="/projects/:projectId/list" element={<Protected><ItemsPage /></Protected>} />
      <Route path="/projects/:projectId/deleted" element={<Protected><DeletedItemsPage /></Protected>} />
      <Route path="/projects/:projectId/settings" element={<Protected><ProjectSettingsPage /></Protected>} />
      <Route
        path="/projects/:projectId/canvas"
        element={
          <Protected>
            <Suspense fallback={<div className="p-8 text-slate-400"><Spinner /></div>}>
              <CanvasPage />
            </Suspense>
          </Protected>
        }
      />
      <Route path="/people/:userId" element={<Protected><PersonPage /></Protected>} />
      <Route path="/admin" element={<Protected><AdminPage /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
