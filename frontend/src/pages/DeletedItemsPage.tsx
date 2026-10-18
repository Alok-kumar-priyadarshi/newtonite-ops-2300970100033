import type { ItemSummary, Page } from '@nops/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, get, qs } from '../api/client';
import { useSafeMutation } from '../api/mutation';
import { useProject } from '../api/queries';
import { Button, EmptyState, ErrorState, ReasonDialog, Spinner } from '../components/ui';
import { timeAgo } from '../lib/format';

export function DeletedItemsPage() {
  const { projectId } = useParams();
  const project = useProject(projectId);
  const q = useInfiniteQuery({
    queryKey: ['deleted', projectId],
    queryFn: ({ pageParam }) => get<Page<ItemSummary>>(`/projects/${projectId}/items/deleted${qs({ cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const [restoring, setRestoring] = useState<ItemSummary | null>(null);
  const restore = useSafeMutation({
    fn: (v: { id: string; reason: string }, key) => api('POST', `/items/${v.id}/restore`, { reason: v.reason }, { idempotencyKey: key }),
    invalidate: () => [['deleted', projectId], ['items'], ['canvas', projectId], ['dashboard']],
    successMessage: 'Restored.',
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div>
        <Link to="/projects" className="text-sm text-slate-500 hover:underline">← Projects</Link>
        <h1 className="text-xl font-semibold">{project.data?.name} · Deleted items</h1>
        <p className="text-sm text-slate-500">Deleted items keep their full history and can be restored.</p>
      </div>
      {q.isError && <ErrorState error={q.error} />}
      {q.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing deleted" />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="font-mono text-xs text-slate-500">{i.key}</span>
              <Link to={`/items/${i.id}`} className="flex-1 truncate hover:underline">{i.title}</Link>
              <span className="text-xs text-slate-400">deleted {timeAgo(i.deletedAt)}</span>
              <Button onClick={() => setRestoring(i)}>Restore</Button>
            </li>
          ))}
        </ul>
      )}
      {q.hasNextPage && <Button onClick={() => q.fetchNextPage()}>Load more</Button>}
      {restoring && (
        <ReasonDialog
          title={`Restore ${restoring.key}`}
          confirmLabel="Restore"
          busy={restore.isPending}
          onClose={() => setRestoring(null)}
          onConfirm={(reason) => restore.mutate({ id: restoring.id, reason }, { onSettled: () => setRestoring(null) })}
        />
      )}
    </div>
  );
}
