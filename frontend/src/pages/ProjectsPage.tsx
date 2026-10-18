import { Link } from 'react-router-dom';
import { useMe, useProjects } from '../api/queries';
import { Avatar, EmptyState, ErrorState, Spinner } from '../components/ui';
import { HEALTH_META, ROLE_LABEL } from '../lib/format';

export function ProjectsPage() {
  const q = useProjects();
  const me = useMe().data!;
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Projects</h1>
      {me.user.isAdmin && <p className="text-sm text-slate-500">As an Admin you see every project’s summary. Items and canvases are visible only to project members.</p>}
      {q.isError && <ErrorState error={q.error} />}
      {q.isLoading && <Spinner />}
      {q.data?.length === 0 && <EmptyState title="No projects yet" />}
      <div className="grid gap-4 md:grid-cols-2">
        {q.data?.map((p) => (
          <div key={p.id} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-slate-500">
                  {p.team.name} · {p.key}
                </div>
                <h2 className="text-lg font-semibold">{p.name}</h2>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${HEALTH_META[p.health].className}`}>{HEALTH_META[p.health].label}</span>
            </div>
            <p className="mt-2 text-sm text-slate-700">{p.goal}</p>
            {p.statusNote && <p className="mt-1 text-sm text-slate-500">Now: {p.statusNote}</p>}
            <div className="mt-3 flex flex-wrap gap-4 text-sm">
              <span><strong>{p.counts.open}</strong> open</span>
              <span className="text-amber-700"><strong>{p.counts.awaitingApproval}</strong> need approval</span>
              <span className="text-red-700"><strong>{p.counts.blocked}</strong> blocked</span>
              <span className="text-red-700"><strong>{p.counts.overdue}</strong> overdue</span>
            </div>
            <div className="mt-3 flex items-center gap-2 text-sm text-slate-600">
              <Avatar user={p.manager} size={22} link /> Manager
              {p.leads.map((l) => (
                <Avatar key={l.id} user={l} size={22} link />
              ))}
              {p.myRole && <span className="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs">You: {ROLE_LABEL[p.myRole]}</span>}
            </div>
            <div className="mt-4 flex gap-2 text-sm">
              {p.myRole && (
                <>
                  <Link className="rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700" to={`/projects/${p.id}/canvas`}>
                    Open canvas
                  </Link>
                  <Link className="rounded-md px-3 py-1.5 ring-1 ring-slate-300 hover:bg-slate-50" to={`/projects/${p.id}/list`}>
                    List
                  </Link>
                </>
              )}
              {(p.myRole || me.user.isAdmin) && (
                <Link className="rounded-md px-3 py-1.5 ring-1 ring-slate-300 hover:bg-slate-50" to={`/projects/${p.id}/settings`}>
                  👥 Team
                </Link>
              )}
              {p.myRole === 'manager' && (
                <Link className="rounded-md px-3 py-1.5 ring-1 ring-slate-300 hover:bg-slate-50" to={`/projects/${p.id}/deleted`}>
                  Deleted items
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
