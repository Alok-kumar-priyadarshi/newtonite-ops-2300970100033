import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { usePerson, usePersonActivity, usePersonStats, useRoleHistory } from '../api/queries';
import { Avatar, Button, ErrorState, Spinner } from '../components/ui';
import { describeActivity } from '../lib/activity';
import { NOTE_META, ROLE_LABEL, shortDate, timeAgo } from '../lib/format';

/** A worker's company profile: who they are, where they work, and their full work history. */
export function PersonPage() {
  const { userId } = useParams();
  const id = userId!;
  const person = usePerson(id);
  const history = useRoleHistory(id);
  const [period, setPeriod] = useState('all');
  const stats = usePersonStats(id, period);
  const [filter, setFilter] = useState('all');
  const activity = usePersonActivity(id, filter);

  if (person.isError) return <div className="p-6"><ErrorState error={person.error} /></div>;
  if (!person.data) return <div className="p-6"><Spinner /></div>;
  const { user, online, currentProjects } = person.data;
  const events = activity.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-5">
        <Avatar user={user} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            {user.fullName}
            <span className={`h-2.5 w-2.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-slate-300'}`} title={online ? 'Online' : 'Offline'} />
          </h1>
          <div className="text-sm text-slate-600">
            {user.designation} · {user.department} · {user.employeeCode}
          </div>
          <div className="text-sm text-slate-500">
            {user.email} · joined {shortDate(user.joinedAt)}
          </div>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Current projects</h2>
          <ul className="space-y-2 text-sm">
            {currentProjects.map((p) => (
              <li key={p.project.id} className="flex items-center gap-2">
                <Link to={`/projects/${p.project.id}/canvas`} className="font-medium hover:underline">{p.project.name}</Link>
                <span className="rounded bg-slate-100 px-1.5 text-xs">{ROLE_LABEL[p.role]}</span>
                <span className="ml-auto text-xs text-slate-500">since {shortDate(p.since)} · {p.openItems} open</span>
              </li>
            ))}
            {currentProjects.length === 0 && <li className="text-slate-400">No shared projects</li>}
          </ul>
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-3 flex items-center">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Contribution</h2>
            <select className="ml-auto rounded border border-slate-300 px-2 py-0.5 text-xs" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">
              <option value="all">All time</option>
              <option value="quarter">Last 90 days</option>
              <option value="month">Last 30 days</option>
            </select>
          </div>
          <div className="grid grid-cols-4 gap-2 text-center">
            {(['claimed', 'resolved', 'approved', 'notes'] as const).map((k) => (
              <div key={k} className="rounded-lg bg-slate-50 py-3">
                <div className="text-2xl font-semibold">{stats.data?.[k] ?? '…'}</div>
                <div className="text-xs capitalize text-slate-500">{k}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Work history</h2>
        <ol className="space-y-2 text-sm">
          {history.data?.map((h, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-56 text-slate-500">
                {shortDate(h.validFrom)} → {h.validTo ? shortDate(h.validTo) : 'now'}
              </span>
              <span className="font-medium">{h.project.name}</span>
              <span className="rounded bg-slate-100 px-1.5 text-xs">{ROLE_LABEL[h.role]}</span>
              {h.reason && <span className="text-xs text-slate-500">“{h.reason}”</span>}
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Activity</h2>
          <div className="ml-auto flex gap-1 text-xs">
            {['all', 'decisions', 'approvals'].map((f) => (
              <button key={f} className={`rounded px-2 py-0.5 ${filter === f ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <ul className="space-y-2 text-sm">
          {events.map((e) => (
            <li key={e.id} className="flex items-start gap-2">
              <span className="mt-0.5 w-16 shrink-0 text-xs text-slate-400">{timeAgo(e.createdAt)}</span>
              <span className="min-w-0 flex-1">
                {e.type === 'note.added' ? `${NOTE_META[e.data.kind]?.icon} ${NOTE_META[e.data.kind]?.label}: “${e.data.body}”` : describeActivity(e)}{' '}
                {e.item && (
                  <Link to={`/items/${e.item.id}`} className="text-brand-700 hover:underline">
                    {e.item.key}
                  </Link>
                )}{' '}
                <span className="text-xs text-slate-500">(as {ROLE_LABEL[e.actorRole] ?? e.actorRole} · {e.project?.key})</span>
              </span>
            </li>
          ))}
          {activity.isLoading && <Spinner />}
          {!activity.isLoading && events.length === 0 && <li className="text-slate-400">No activity in projects you share.</li>}
        </ul>
        {activity.hasNextPage && (
          <Button className="mt-3" onClick={() => activity.fetchNextPage()} busy={activity.isFetchingNextPage}>
            Load more
          </Button>
        )}
      </section>
    </div>
  );
}
