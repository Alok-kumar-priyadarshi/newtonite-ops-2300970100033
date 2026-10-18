import { ITEM_TYPES } from '@nops/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { type ItemFilters, useItems, useProject } from '../api/queries';
import { AssistantDrawer } from '../components/AssistantDrawer';
import { ItemDrawer } from '../components/ItemDrawer';
import { ItemTable } from '../components/ItemTable';
import { Button, EmptyState, ErrorState, Spinner } from '../components/ui';
import { TYPE_META } from '../lib/format';

const VIEW_TITLES: Record<string, string> = {
  assigned_to_me: 'Assigned to me',
  next_actions_due: 'Next actions due',
  overdue: 'Overdue',
  awaiting_my_approval: 'Awaiting my approval',
  unassigned_urgent: 'Unassigned urgent',
  blocked: 'Blocked',
  forgotten: 'Forgotten',
};

const FILTER_KEYS = ['view', 'stageId', 'type', 'priority', 'assigneeId', 'due', 'q', 'sort'] as const;

/** Every filter lives in the URL, so views can be shared and survive reloads. */
export function ItemsPage() {
  const { projectId } = useParams();
  const [params, setParams] = useSearchParams();
  const project = useProject(projectId);
  const filters: ItemFilters = useMemo(() => {
    const f: ItemFilters = { projectId };
    for (const k of FILTER_KEYS) f[k] = params.get(k) ?? undefined;
    return f;
  }, [params, projectId]);
  const q = useItems(filters);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const first = q.data?.pages[0];
  const openId = params.get('item') ?? undefined;

  const [search, setSearch] = useState(filters.q ?? '');
  const [asking, setAsking] = useState(false);
  useEffect(() => setSearch(filters.q ?? ''), [filters.q]);
  // Debounced search into the URL.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? '') !== search) set('q', search || undefined);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function set(key: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'item') next.delete('item');
    setParams(next, { replace: key === 'q' });
  }

  const title = project.data
    ? `${project.data.name}`
    : filters.view
      ? VIEW_TITLES[filters.view]
      : filters.q
        ? `Search: “${filters.q}”`
        : 'All items';

  const select = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm';

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {projectId && (
          <div className="flex rounded-md ring-1 ring-slate-300">
            <Link to={`/projects/${projectId}/canvas`} className="rounded-l-md px-3 py-1 text-sm text-slate-600 hover:bg-slate-50">
              Canvas
            </Link>
            <span className="rounded-r-md bg-slate-800 px-3 py-1 text-sm text-white">List</span>
          </div>
        )}
        {filters.view && projectId && <span className="rounded bg-slate-100 px-2 py-0.5 text-sm">{VIEW_TITLES[filters.view]}</span>}
        <button
          className="ml-auto rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
          onClick={() => setAsking(true)}
          title="Ask questions about the work in your projects"
        >
          ✨ Ask
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <input className={`${select} w-64`} placeholder="Search title & description…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className={select} value={filters.view ?? ''} onChange={(e) => set('view', e.target.value || undefined)} aria-label="View">
          <option value="">All</option>
          {Object.entries(VIEW_TITLES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {project.data && (
          <select className={select} value={filters.stageId ?? ''} onChange={(e) => set('stageId', e.target.value || undefined)} aria-label="Stage">
            <option value="">Any stage</option>
            {project.data.workflow.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <select className={select} value={filters.priority ?? ''} onChange={(e) => set('priority', e.target.value || undefined)} aria-label="Priority">
          <option value="">Any priority</option>
          <option value="1">P1</option>
          <option value="1,2">P1–P2</option>
          <option value="3">P3</option>
          <option value="4">P4</option>
        </select>
        <select className={select} value={filters.type ?? ''} onChange={(e) => set('type', e.target.value || undefined)} aria-label="Type">
          <option value="">Any type</option>
          {ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_META[t].icon} {TYPE_META[t].label}
            </option>
          ))}
        </select>
        <select className={select} value={filters.assigneeId ?? ''} onChange={(e) => set('assigneeId', e.target.value || undefined)} aria-label="Owner">
          <option value="">Anyone</option>
          <option value="me">Me</option>
          <option value="none">Unassigned</option>
          {filters.assigneeId && !['me', 'none'].includes(filters.assigneeId) && (
            <option value={filters.assigneeId}>
              {items.find((i) => i.assignee?.id === filters.assigneeId)?.assignee?.fullName ?? 'Selected person'}
            </option>
          )}
        </select>
        <select className={select} value={filters.due ?? ''} onChange={(e) => set('due', e.target.value || undefined)} aria-label="Due">
          <option value="">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="week">Due this week</option>
        </select>
        <select className={select} value={filters.sort ?? 'updated'} onChange={(e) => set('sort', e.target.value === 'updated' ? undefined : e.target.value)} aria-label="Sort">
          <option value="updated">Recently updated</option>
          <option value="priority">Priority</option>
          <option value="due">Due date</option>
        </select>
      </div>

      {q.isError ? (
        <ErrorState error={q.error} />
      ) : q.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <EmptyState title="No items match">Try removing a filter.</EmptyState>
      ) : (
        <>
          <ItemTable items={items} onOpen={(id) => set('item', id)} selectedId={openId} />
          <div className="flex items-center justify-between text-sm text-slate-500">
            <span>
              Showing {items.length} of {first?.totalIsCapped ? `${first.total.toLocaleString()}+` : first?.total.toLocaleString()}
            </span>
            {q.hasNextPage && (
              <Button onClick={() => q.fetchNextPage()} busy={q.isFetchingNextPage}>
                Load more
              </Button>
            )}
          </div>
        </>
      )}
      {asking && <AssistantDrawer projectId={projectId} onOpenItem={(id) => set('item', id)} onClose={() => setAsking(false)} />}
      {openId && <ItemDrawer itemId={openId} onClose={() => set('item', undefined)} />}
    </div>
  );
}
