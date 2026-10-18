import type { AllowedTransition, BlockedTransition, ItemDetail, ItemType } from '@nops/shared';
import { ITEM_TYPES, NOTE_KINDS } from '@nops/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, get, qs } from '../api/client';
import { useActivity, useItem, useMe, useMembers, useProject } from '../api/queries';
import { dateTime, fromLocalInput, NOTE_META, ROLE_LABEL, timeAgo, toLocalInput, TYPE_META } from '../lib/format';
import { describeActivity } from '../lib/activity';
import { ConflictPanel } from './ConflictPanel';
import { useItemActions } from './itemActions';
import { useToast } from './Toasts';
import { Avatar, Button, ErrorState, inputCls, labelCls, Modal, PriorityChip, ReasonDialog, Spinner, StageChip, TypeIcon } from './ui';

/** Sends a presence heartbeat every 20 s while the item is open (docs/09 §9.7). */
function usePresence(resourceType: 'item' | 'canvas', resourceId: string | undefined, selected: string[] = []) {
  const [viewers, setViewers] = useState<{ user: any; selectedElementIds: string[] }[]>([]);
  const selectedKey = selected.join(',');
  useEffect(() => {
    if (!resourceId) return;
    let cancelled = false;
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      api('POST', '/presence/heartbeat', { resourceType, resourceId, selectedElementIds: selected })
        .then((r) => !cancelled && setViewers(r.viewers))
        .catch(() => {});
    };
    beat();
    const t = setInterval(beat, 20_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceType, resourceId, selectedKey]);
  return viewers;
}
export { usePresence };

type Dialog =
  | { kind: 'transition'; t: AllowedTransition }
  | { kind: 'priority'; value: number; baseVersion: number }
  | { kind: 'assign' }
  | { kind: 'edit' }
  | { kind: 'delete' }
  | { kind: 'restore' }
  | null;

export function ItemDetailView({ itemId, onClose }: { itemId: string; onClose?: () => void }) {
  const q = useItem(itemId);
  const item = q.data;
  const me = useMe().data!;
  const actions = useItemActions(item);
  const viewers = usePresence('item', item && !item.deleted ? itemId : undefined);
  const [dialog, setDialog] = useState<Dialog>(null);

  if (q.isLoading) {
    return (
      <div className="flex justify-center p-10 text-slate-400">
        <Spinner />
      </div>
    );
  }
  if (q.isError || !item) {
    return (
      <div className="p-6">
        <ErrorState error={q.error} />
      </div>
    );
  }

  const can = (p: string) => item.permissions.includes(p);
  const isMine = item.assignee?.id === me.user.id;
  const deleted = !!item.deleted;

  return (
    <div className="flex h-full flex-col">
      {viewers.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-1.5 text-sm text-amber-900">
          👀 {viewers.map((v) => v.user.fullName).join(', ')} {viewers.length === 1 ? 'is' : 'are'} also viewing this item
        </div>
      )}
      {deleted && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-2 text-sm text-red-900">
          Deleted by {item.deletedBy?.fullName ?? 'someone'} · {item.deleteReason}
          {can('item.restore') && (
            <Button className="ml-3" onClick={() => setDialog({ kind: 'restore' })}>
              Restore
            </Button>
          )}
        </div>
      )}

      <div className="border-b border-slate-200 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="text-xl"><TypeIcon type={item.type} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-slate-500">
              <Link to={`/projects/${item.projectId}/canvas`} className="hover:underline">{item.projectKey}</Link> · {item.key} · created by{' '}
              {item.createdBy.fullName} · {timeAgo(item.createdAt)}
            </div>
            <h2 className="mt-0.5 text-lg font-semibold leading-snug">{item.title}</h2>
          </div>
          {onClose && (
            <div className="flex items-center gap-1">
              <Link to={`/items/${item.id}`} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Open full page">
                ⤢
              </Link>
              <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {deleted ? (
            <StageChip name={item.stage.name} kind={item.stage.kind} />
          ) : (
            <StageSelect
              item={item}
              busy={actions.transition.isPending}
              onSelect={(t) => (t.requiresReason ? setDialog({ kind: 'transition', t }) : actions.transition.mutate({ toStageId: t.toStageId }))}
            />
          )}
          {can('item.edit_priority') && !deleted ? (
            <select
              aria-label="Priority"
              className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-xs font-semibold"
              value={item.priority}
              onChange={(e) => setDialog({ kind: 'priority', value: Number(e.target.value), baseVersion: item.version })}
            >
              {[1, 2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
          ) : (
            <PriorityChip priority={item.priority} />
          )}
          <span className="flex items-center gap-1.5">
            <Avatar user={item.assignee} size={22} link />
            <span>{item.assignee ? item.assignee.fullName : 'Unassigned'}</span>
          </span>
          {item.dueAt && (
            <span className={item.isOverdue ? 'font-medium text-red-700' : 'text-slate-600'}>
              {item.isOverdue ? '⏰ Overdue' : 'Due'} {dateTime(item.dueAt)}
            </span>
          )}
          {item.isBlocked && <span className="text-red-700">⛓ Blocked</span>}
        </div>

        {!deleted && (
          <div className="mt-3 flex flex-wrap gap-2">
            {!item.assignee && can('item.claim') && (
              <Button variant="primary" busy={actions.claim.isPending} onClick={() => actions.claim.mutate()}>
                Claim
              </Button>
            )}
            {item.assignee && (isMine || can('item.assign')) && (
              <Button variant="ghost" onClick={() => actions.release.mutate()} busy={actions.release.isPending}>
                Release
              </Button>
            )}
            {can('item.assign') && (
              <Button variant="ghost" onClick={() => setDialog({ kind: 'assign' })}>
                Reassign
              </Button>
            )}
            {can('item.edit_details') && (
              <Button variant="ghost" onClick={() => setDialog({ kind: 'edit' })}>
                Edit details
              </Button>
            )}
            {/* Shown to everyone: the server explains who may delete. */}
            <Button variant="ghost" className="ml-auto text-red-700" onClick={() => setDialog({ kind: 'delete' })}>
              Delete
            </Button>
          </div>
        )}
        {!deleted && item.allowedTransitions.length === 0 && item.blockedTransitions.length === 0 && (
          <p className="mt-2 text-xs text-slate-500">
            “{item.stage.name}” has no outgoing connections. Add one on the canvas to move items onward.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-6 px-5 py-4 lg:grid-cols-[1fr_260px]">
          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Description</h3>
            <p className="whitespace-pre-wrap text-sm text-slate-800">{item.description || <span className="text-slate-400">No description.</span>}</p>
          </section>
          <aside className="space-y-5">
            <NextAction
              item={item}
              canEdit={can('item.edit_next_action') && !deleted}
              onSave={(fields, baseVersion) => actions.patch.mutate({ fields, baseVersion })}
              saving={actions.patch.isPending}
            />
            <Blockers item={item} canEdit={can('item.link') && !deleted} actions={actions} />
          </aside>
        </div>
        <Timeline item={item} canComment={can('item.comment') && !deleted} onNote={(v) => actions.addNote.mutateAsync(v)} />
      </div>

      {dialog?.kind === 'transition' && (
        <ReasonDialog
          title={`${dialog.t.label ?? 'Move'} → ${dialog.t.toStageName}`}
          confirmLabel={dialog.t.label ?? 'Move'}
          busy={actions.transition.isPending}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => actions.transition.mutate({ toStageId: dialog.t.toStageId, reason }, { onSettled: () => setDialog(null) })}
        />
      )}
      {dialog?.kind === 'priority' && (
        <ReasonDialog
          title={`Change priority to P${dialog.value}`}
          busy={actions.patch.isPending}
          onClose={() => setDialog(null)}
          onConfirm={(reason) =>
            actions.patch.mutate({ fields: { priority: dialog.value, reason }, baseVersion: dialog.baseVersion }, { onSettled: () => setDialog(null) })
          }
        />
      )}
      {dialog?.kind === 'assign' && <AssignDialog item={item} actions={actions} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <EditDetailsDialog item={item} actions={actions} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ReasonDialog
          title={`Delete ${item.key}?`}
          description="Deleted items disappear from every view but stay in the history. The Project Manager can restore them."
          confirmLabel="Delete"
          danger
          busy={actions.remove.isPending}
          onClose={() => setDialog(null)}
          onConfirm={(reason) =>
            actions.remove.mutate({ reason }, { onSuccess: () => onClose?.(), onSettled: () => setDialog(null) })
          }
        />
      )}
      {dialog?.kind === 'restore' && (
        <ReasonDialog
          title={`Restore ${item.key}?`}
          confirmLabel="Restore"
          busy={actions.restore.isPending}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => actions.restore.mutate({ reason }, { onSettled: () => setDialog(null) })}
        />
      )}
      {actions.conflict && (
        <ConflictPanel
          conflict={actions.conflict.conflict}
          mine={actions.conflict.fields}
          busy={actions.keepMine.isPending}
          onKeepMine={() => actions.keepMine.mutate()}
          onUseTheirs={actions.dismissConflict}
        />
      )}
    </div>
  );
}

const SHORT_REASON: Record<string, string> = {
  NOT_ASSIGNEE: 'claim it first',
  APPROVAL_ROLE_REQUIRED: 'Lead or Manager only',
  SELF_APPROVAL_FORBIDDEN: 'someone else must approve',
  LEAD_OR_MANAGER_REQUIRED: 'Lead or Manager only',
  BLOCKED_BY_OPEN_ITEMS: 'blocked by open items',
};

/**
 * The item's stage as a dropdown. Every stage of the workflow is listed so the whole flow is
 * visible, but only moves the server would accept can be picked; the rest are disabled with the
 * reason (same rules as checkTransition on the server, which still decides).
 */
function StageSelect({ item, busy, onSelect }: { item: ItemDetail; busy: boolean; onSelect: (t: AllowedTransition) => void }) {
  const stages = useProject(item.projectId).data?.workflow.stages ?? [];
  const allowed = new Map(item.allowedTransitions.map((t) => [t.toStageId, t]));
  const blocked: BlockedTransition[] = item.blockedTransitions;
  const blockedIds = new Set(blocked.map((t) => t.toStageId));
  const unconnected = stages.filter((s) => s.id !== item.stage.id && !allowed.has(s.id) && !blockedIds.has(s.id));
  const tone =
    item.stage.kind === 'done'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
      : item.stage.kind === 'start'
        ? 'border-slate-300 bg-slate-50 text-slate-800'
        : 'border-blue-300 bg-blue-50 text-blue-800';
  return (
    <span className="flex items-center gap-1.5">
      <select
        aria-label="Stage"
        title="Change stage"
        value={item.stage.id}
        disabled={busy}
        onChange={(e) => {
          const t = allowed.get(e.target.value);
          if (t) onSelect(t);
        }}
        className={`w-52 truncate rounded-full border px-2.5 py-0.5 text-xs font-semibold disabled:opacity-60 ${tone}`}
      >
        <option value={item.stage.id}>● {item.stage.name}</option>
        {item.allowedTransitions.length > 0 && (
          <optgroup label="Move to">
            {item.allowedTransitions.map((t) => (
              <option key={t.transitionId} value={t.toStageId}>
                → {t.toStageName}
                {t.label ? ` (${t.label})` : ''}
                {t.isApproval ? ' ✓ approve' : ''}
                {t.requiresReason ? ' · reason needed' : ''}
              </option>
            ))}
          </optgroup>
        )}
        {blocked.length > 0 && (
          <optgroup label="Not available to you">
            {blocked.map((t) => (
              <option key={t.transitionId} value={t.toStageId} disabled>
                {t.toStageName}: {SHORT_REASON[t.code] ?? t.reason}
              </option>
            ))}
          </optgroup>
        )}
        {unconnected.length > 0 && (
          <optgroup label={`Not connected from “${item.stage.name}”`}>
            {unconnected.map((s) => (
              <option key={s.id} value={s.id} disabled>
                {s.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {busy && <Spinner size={14} />}
    </span>
  );
}

/** Shown inside an open editor when a background refresh brought a newer version of the item. */
function StaleNote({ item, baseVersion }: { item: ItemDetail; baseVersion: number }) {
  if (item.version === baseVersion) return null;
  return (
    <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
      This item was updated while you were editing. Saving checks for conflicts, so nothing is overwritten.
    </p>
  );
}

function NextAction({
  item,
  canEdit,
  onSave,
  saving,
}: {
  item: ItemDetail;
  canEdit: boolean;
  onSave: (f: Record<string, unknown>, baseVersion: number) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [baseVersion, setBaseVersion] = useState(item.version);
  const [text, setText] = useState(item.nextAction ?? '');
  const [due, setDue] = useState(toLocalInput(item.nextActionDueAt));
  useEffect(() => {
    if (!editing) {
      setText(item.nextAction ?? '');
      setDue(toLocalInput(item.nextActionDueAt));
    }
  }, [item.nextAction, item.nextActionDueAt, editing]);
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">➡ Next action</h3>
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSave({ nextAction: text.trim() || null, nextActionDueAt: fromLocalInput(due) }, baseVersion);
            setEditing(false);
          }}
        >
          <StaleNote item={item} baseVersion={baseVersion} />
          <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder="What needs to happen next?" maxLength={300} />
          <input className={inputCls} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" busy={saving}>Save</Button>
            <Button onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="text-sm">
          {item.nextAction ? (
            <>
              <div className="text-slate-800">“{item.nextAction}”</div>
              {item.nextActionDueAt && <div className="text-xs text-slate-500">due {dateTime(item.nextActionDueAt)}</div>}
            </>
          ) : (
            <div className="text-slate-400">None set</div>
          )}
          {canEdit && (
            <button
              className="mt-1 text-xs text-brand-700 hover:underline"
              onClick={() => {
                setBaseVersion(item.version);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Blockers({ item, canEdit, actions }: { item: ItemDetail; canEdit: boolean; actions: ReturnType<typeof useItemActions> }) {
  const [key, setKey] = useState('');
  const toast = useToast();
  const add = async () => {
    const res = await get(`/items${qs({ projectId: item.projectId, q: key.trim(), limit: 1 })}`);
    const found = res.items[0];
    if (!found) return toast('error', `No item ${key} in this project.`);
    actions.addBlocker.mutate({ blockerItemId: found.id }, { onSuccess: () => setKey('') });
  };
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">⛓ Blocked by</h3>
      <ul className="space-y-1 text-sm">
        {item.blockers.map((b) => (
          <li key={b.id} className="flex items-center gap-2">
            <Link to={`/items/${b.id}`} className={b.stage.kind === 'done' ? 'text-slate-400 line-through' : 'text-brand-700 hover:underline'}>
              {b.key}
            </Link>
            <span className="truncate text-slate-600">{b.title}</span>
            {canEdit && (
              <button className="ml-auto text-xs text-slate-400 hover:text-red-600" onClick={() => actions.removeBlocker.mutate(b.id)} aria-label={`Remove blocker ${b.key}`}>
                ✕
              </button>
            )}
          </li>
        ))}
        {item.blockers.length === 0 && <li className="text-slate-400">Nothing</li>}
      </ul>
      {item.blocking.length > 0 && (
        <p className="mt-2 text-xs text-slate-500">Blocks: {item.blocking.map((b) => b.key).join(', ')}</p>
      )}
      {canEdit && (
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) add();
          }}
        >
          <input className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} placeholder={`${item.projectKey}-123`} />
          <Button type="submit" busy={actions.addBlocker.isPending}>Add</Button>
        </form>
      )}
    </div>
  );
}

function Timeline({ item, canComment, onNote }: { item: ItemDetail; canComment: boolean; onNote: (v: { kind: string; body: string }) => Promise<unknown> }) {
  const [filter, setFilter] = useState('all');
  const q = useActivity(item.id, filter);
  const [kind, setKind] = useState('note');
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const events = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="border-t border-slate-200 px-5 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Timeline</h3>
        <div className="flex gap-1 text-xs">
          {['all', 'notes', 'changes'].map((f) => (
            <button key={f} className={`rounded px-2 py-0.5 ${filter === f ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-100'}`} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>
      {canComment && (
        <form
          className="mb-4 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!body.trim()) return;
            setPosting(true);
            try {
              await onNote({ kind, body: body.trim() });
              setBody('');
            } finally {
              setPosting(false);
            }
          }}
        >
          <select aria-label="Note type" className="rounded-md border border-slate-300 bg-white px-2 text-sm" value={kind} onChange={(e) => setKind(e.target.value)}>
            {NOTE_KINDS.map((k) => (
              <option key={k} value={k}>
                {NOTE_META[k].icon} {NOTE_META[k].label}
              </option>
            ))}
          </select>
          <input className={inputCls} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write an update…" maxLength={5000} />
          <Button type="submit" variant="primary" busy={posting} disabled={!body.trim()}>
            Post
          </Button>
        </form>
      )}
      <ol className="space-y-3">
        {events.map((e) => {
          const isNote = e.type === 'note.added';
          return (
            <li key={e.id} className="flex gap-2.5 text-sm">
              <Avatar user={e.actor} size={24} link />
              <div className="min-w-0 flex-1">
                <div className="text-slate-800">
                  <strong>{e.actor?.fullName ?? 'System'}</strong>{' '}
                  <span className="text-xs text-slate-500">({ROLE_LABEL[e.actorRole] ?? e.actorRole})</span>{' '}
                  {isNote ? (
                    <span className="text-slate-500">
                      {NOTE_META[e.data.kind]?.icon} {NOTE_META[e.data.kind]?.label}
                    </span>
                  ) : (
                    describeActivity(e)
                  )}
                  <span className="ml-2 text-xs text-slate-400" title={new Date(e.createdAt).toLocaleString()}>
                    {timeAgo(e.createdAt)}
                  </span>
                </div>
                {isNote && <p className="mt-0.5 whitespace-pre-wrap rounded-md bg-slate-50 px-3 py-2 text-slate-800">{e.data.body}</p>}
                {!isNote && e.data.reason && <p className="mt-0.5 text-xs text-slate-500">Reason: “{e.data.reason}”</p>}
              </div>
            </li>
          );
        })}
        {q.isLoading && <Spinner />}
        {!q.isLoading && events.length === 0 && <li className="text-sm text-slate-400">No activity yet.</li>}
      </ol>
      {q.hasNextPage && (
        <Button className="mt-3" onClick={() => q.fetchNextPage()} busy={q.isFetchingNextPage}>
          Load older
        </Button>
      )}
    </section>
  );
}

function AssignDialog({ item, actions, onClose }: { item: ItemDetail; actions: ReturnType<typeof useItemActions>; onClose: () => void }) {
  const members = useMembers(item.projectId).data ?? [];
  const [assigneeId, setAssigneeId] = useState(item.assignee?.id ?? '');
  const [baseVersion] = useState(item.version); // the version this dialog was opened with
  return (
    <ReasonDialog
      title={`Reassign ${item.key}`}
      confirmLabel="Reassign"
      busy={actions.assign.isPending}
      onClose={onClose}
      onConfirm={(reason) => actions.assign.mutate({ assigneeId: assigneeId || null, reason, baseVersion }, { onSettled: onClose })}
    >
      <StaleNote item={item} baseVersion={baseVersion} />
      <label className={labelCls}>
        New owner
        <select className={`${inputCls} mt-1`} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.user.id} value={m.user.id}>
              {m.user.fullName} — {ROLE_LABEL[m.role]} ({m.user.openItemCount} open)
            </option>
          ))}
        </select>
      </label>
    </ReasonDialog>
  );
}

function EditDetailsDialog({ item, actions, onClose }: { item: ItemDetail; actions: ReturnType<typeof useItemActions>; onClose: () => void }) {
  // Snapshot of the item when the dialog opened: we send only the fields the user changed compared
  // with it, and its version, so a background refresh can never turn into a silent overwrite.
  const [initial] = useState(item);
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [type, setType] = useState<ItemType>(item.type);
  const [due, setDue] = useState(toLocalInput(item.dueAt));
  return (
    <Modal title={`Edit ${item.key}`} onClose={onClose} width={560}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const fields: Record<string, unknown> = {};
          if (title !== initial.title) fields.title = title;
          if (description !== initial.description) fields.description = description;
          if (type !== initial.type) fields.type = type;
          if (fromLocalInput(due) !== (initial.dueAt ? new Date(initial.dueAt).toISOString() : null)) fields.dueAt = fromLocalInput(due);
          if (Object.keys(fields).length === 0) return onClose();
          actions.patch.mutate({ fields, baseVersion: initial.version }, { onSettled: onClose });
        }}
      >
        <StaleNote item={item} baseVersion={initial.version} />
        <label className={labelCls}>
          Title
          <input className={`${inputCls} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label className={labelCls}>
          Description
          <textarea className={`${inputCls} mt-1`} rows={5} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Type
            <select className={`${inputCls} mt-1`} value={type} onChange={(e) => setType(e.target.value as ItemType)}>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_META[t].icon} {TYPE_META[t].label}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Due
            <input className={`${inputCls} mt-1`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={actions.patch.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
