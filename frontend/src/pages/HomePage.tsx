import { Link, useNavigate } from 'react-router-dom';
import { useDashboard, useMe } from '../api/queries';
import { ItemTable } from '../components/ItemTable';
import { EmptyState, ErrorState, Spinner } from '../components/ui';
import { timeAgo } from '../lib/format';

const CARDS: { key: keyof import('@nops/shared').Dashboard['counts']; view: string; label: string; hint: string; tone?: string }[] = [
  { key: 'assignedToMe', view: 'assigned_to_me', label: 'Assigned to me', hint: 'open items you own' },
  { key: 'nextActionsDue', view: 'next_actions_due', label: 'Next actions due', hint: 'due by end of today' },
  { key: 'awaitingMyApproval', view: 'awaiting_my_approval', label: 'Awaiting my approval', hint: 'you can approve', tone: 'amber' },
  { key: 'unassignedUrgent', view: 'unassigned_urgent', label: 'Unassigned urgent', hint: 'P1–P2 with no owner', tone: 'red' },
  { key: 'overdue', view: 'overdue', label: 'Overdue', hint: 'past their due date', tone: 'red' },
  { key: 'blocked', view: 'blocked', label: 'Blocked', hint: 'waiting on other items' },
  { key: 'forgotten', view: 'forgotten', label: 'Forgotten', hint: 'no activity for 5 days', tone: 'amber' },
];

export function HomePage() {
  const me = useMe().data!;
  const q = useDashboard();
  const navigate = useNavigate();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  if (me.memberships.length === 0 && !me.user.isAdmin) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="mb-4 text-2xl font-semibold">{greeting}, {me.user.fullName.split(' ')[0]}</h1>
        <EmptyState title="You’re not in any project yet">Ask an Admin to add you to a project.</EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{greeting}, {me.user.fullName.split(' ')[0]}</h1>
        <span className="text-xs text-slate-400">{q.dataUpdatedAt ? `Updated ${timeAgo(new Date(q.dataUpdatedAt).toISOString())}` : ''}</span>
      </div>
      {q.isError && <ErrorState error={q.error} />}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {CARDS.map((c) => {
          const n = q.data?.counts[c.key];
          const highlight = n && c.tone === 'red' ? 'text-red-700' : n && c.tone === 'amber' ? 'text-amber-700' : 'text-slate-900';
          return (
            <Link key={c.key} to={`/items?view=${c.view}`} className="rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-500 hover:shadow-sm">
              <div className="text-sm text-slate-600">{c.label}</div>
              <div className={`mt-1 text-3xl font-semibold ${highlight}`}>{n === undefined ? '…' : n >= 1000 ? '999+' : n}</div>
              <div className="text-xs text-slate-400">{c.hint}</div>
            </Link>
          );
        })}
      </div>
      <section>
        <h2 className="mb-2 font-semibold">Due soon</h2>
        {q.isLoading ? (
          <Spinner />
        ) : q.data && q.data.dueSoon.length > 0 ? (
          <ItemTable items={q.data.dueSoon} onOpen={(id) => navigate(`/items/${id}`)} />
        ) : (
          <EmptyState title="Nothing due soon">Items you own or can pick up will appear here when they have a due date.</EmptyState>
        )}
      </section>
    </div>
  );
}
