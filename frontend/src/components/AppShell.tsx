import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useMe, useUnreadCount } from '../api/queries';
import { CreateItemModal } from './CreateItemModal';
import { Avatar } from './ui';

const navCls = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-100'}`;

export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe().data!;
  const unread = useUnreadCount().data?.count ?? 0;
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const currentProjectId = /^\/projects\/([0-9a-f-]{36})/.exec(location.pathname)?.[1];

  const byTeam = useMemo(() => {
    const groups = new Map<string, typeof me.memberships>();
    for (const m of me.memberships) groups.set(m.teamName, [...(groups.get(m.teamName) ?? []), m]);
    return [...groups.entries()];
  }, [me.memberships]);

  // Keyboard shortcuts: "/" focuses search, "c" creates an item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      } else if (e.key.toLowerCase() === 'c' && !e.metaKey && !e.ctrlKey && me.memberships.length > 0) {
        e.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [me.memberships.length]);

  const logout = async () => {
    await api('POST', '/auth/logout').catch(() => {});
    qc.clear();
    navigate('/login');
  };

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <Link to="/" className="flex items-center gap-2 px-4 py-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">N</span>
          <span className="font-semibold">Newtonite Ops</span>
        </Link>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
          <NavLink to="/" end className={navCls}>🏠 Home</NavLink>
          <NavLink to="/items?view=assigned_to_me" className={() => navCls({ isActive: location.pathname === '/items' && location.search.includes('assigned_to_me') })}>
            ✅ My work
          </NavLink>
          <NavLink to="/inbox" className={navCls}>
            📥 Inbox
            {unread > 0 && <span className="ml-auto rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
          </NavLink>
          <NavLink to="/projects" end className={navCls}>📁 Projects</NavLink>
          {byTeam.map(([team, projects]) => (
            <div key={team} className="pt-4">
              <div className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{team}</div>
              {projects.map((p) => (
                <NavLink
                  key={p.projectId}
                  to={`/projects/${p.projectId}/canvas`}
                  className={() => navCls({ isActive: currentProjectId === p.projectId })}
                >
                  <span className="truncate">{p.projectName}</span>
                  <span className="ml-auto text-xs text-slate-400">{p.projectKey}</span>
                </NavLink>
              ))}
            </div>
          ))}
          {me.user.isAdmin && (
            <div className="pt-4">
              <NavLink to="/admin" className={navCls}>⚙ Admin</NavLink>
            </div>
          )}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
          <Link to="/" className="font-semibold md:hidden">Newtonite Ops</Link>
          <form
            className="max-w-md flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              navigate(`/items?q=${encodeURIComponent(search)}`);
            }}
          >
            <input
              id="global-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search items or jump to a key like PAY-42   ( / )"
              className="w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm"
            />
          </form>
          <div className="ml-auto flex items-center gap-2">
            {me.memberships.length > 0 && (
              <button className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700" onClick={() => setCreating(true)}>
                + New <span className="hidden opacity-70 sm:inline">(C)</span>
              </button>
            )}
            <Link to="/inbox" className="relative rounded-md p-1.5 text-lg hover:bg-slate-100" aria-label={`Inbox, ${unread} unread`}>
              🔔
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </Link>
            <div className="relative">
              <button className="flex items-center gap-2 rounded-md p-1 hover:bg-slate-100" onClick={() => setMenuOpen((o) => !o)}>
                <Avatar user={me.user} size={28} />
              </button>
              {menuOpen && (
                <div className="absolute right-0 z-40 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg" onMouseLeave={() => setMenuOpen(false)}>
                  <div className="border-b border-slate-100 px-3 py-2">
                    <div className="font-medium">{me.user.fullName}</div>
                    <div className="text-xs text-slate-500">{me.user.designation}</div>
                  </div>
                  <Link className="block px-3 py-2 hover:bg-slate-50" to={`/people/${me.user.id}`} onClick={() => setMenuOpen(false)}>
                    My profile
                  </Link>
                  <button className="block w-full px-3 py-2 text-left hover:bg-slate-50" onClick={logout}>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
      {creating && <CreateItemModal defaultProjectId={currentProjectId} onClose={() => setCreating(false)} />}
    </div>
  );
}
