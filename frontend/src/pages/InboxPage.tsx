import type { NotificationItem } from '@nops/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useNotifications } from '../api/queries';
import { Avatar, Button, EmptyState, ErrorState, Spinner } from '../components/ui';
import { timeAgo } from '../lib/format';

export function InboxPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const q = useNotifications(unreadOnly);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['unread'] });
  };
  const open = async (n: NotificationItem) => {
    if (!n.readAt) api('POST', `/notifications/${n.id}/read`).then(refresh).catch(() => {});
    if (n.type === 'canvas.digest' || !n.item) navigate(`/projects/${n.project.id}/canvas`);
    else navigate(`/items/${n.item.id}`);
  };
  const markAll = async () => {
    // Only marks what the user has seen: notifications created up to now.
    await api('POST', '/notifications/read-all', { before: new Date().toISOString() });
    refresh();
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">📥 Inbox</h1>
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
        </label>
        <Button onClick={markAll}>Mark all read</Button>
      </div>
      {q.isError && <ErrorState error={q.error} />}
      {q.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="You’re all caught up">Changes made by your teammates will show up here.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {items.map((n) => (
            <li key={n.id}>
              <button className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50" onClick={() => open(n)}>
                <span className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-brand-600'}`} aria-label={n.readAt ? 'read' : 'unread'} />
                <Avatar user={n.actor} size={28} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm ${n.readAt ? 'text-slate-600' : 'font-medium text-slate-900'}`}>{n.title}</span>
                  <span className="text-xs text-slate-400">
                    {n.project.name} · {timeAgo(n.createdAt)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && (
        <Button onClick={() => q.fetchNextPage()} busy={q.isFetchingNextPage}>
          Load more
        </Button>
      )}
    </div>
  );
}
