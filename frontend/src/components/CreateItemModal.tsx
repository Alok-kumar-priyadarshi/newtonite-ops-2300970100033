import { ITEM_TYPES, type ItemDetail, type ItemType } from '@nops/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useSafeMutation } from '../api/mutation';
import { useMe, useMembers, useProject } from '../api/queries';
import { fromLocalInput, TYPE_META } from '../lib/format';
import { Button, inputCls, labelCls, Modal } from './ui';

export function CreateItemModal({ defaultProjectId, onClose }: { defaultProjectId?: string; onClose: () => void }) {
  const me = useMe().data!;
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState(
    me.memberships.find((m) => m.projectId === defaultProjectId)?.projectId ?? me.memberships[0]?.projectId ?? '',
  );
  const role = me.memberships.find((m) => m.projectId === projectId)?.role;
  const members = useMembers(projectId).data ?? [];
  const startStage = useProject(projectId).data?.workflow.stages.find((s) => s.kind === 'start');
  const [type, setType] = useState<ItemType>('task');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(3);
  const [due, setDue] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  const create = useSafeMutation({
    // One idempotency key per click of "Create"; network retries reuse it, so a slow
    // connection never produces two items.
    fn: (_: void, key) =>
      api<ItemDetail>(
        'POST',
        '/items',
        { projectId, type, title, description, priority, dueAt: fromLocalInput(due), assigneeId: assigneeId || null },
        { idempotencyKey: key },
      ),
    invalidate: () => [['items'], ['dashboard'], ['canvas', projectId], ['projects']],
    successMessage: (d) => `Created ${d.key}.`,
    onSuccess: (d) => {
      onClose();
      navigate(`/items/${d.id}`);
    },
  });

  // Members may only assign new items to themselves (the server enforces this too).
  const assignable = role === 'member' ? members.filter((m) => m.user.id === me.user.id) : members;

  return (
    <Modal title="New item" onClose={onClose} width={560}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!create.isPending) create.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Project
            <select className={`${inputCls} mt-1`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {me.memberships.map((m) => (
                <option key={m.projectId} value={m.projectId}>
                  {m.projectName} ({m.projectKey})
                </option>
              ))}
            </select>
          </label>
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
        </div>
        <label className={labelCls}>
          Title
          <input className={`${inputCls} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} autoFocus placeholder="What needs attention?" />
        </label>
        <label className={labelCls}>
          Description — why does this exist?
          <textarea className={`${inputCls} mt-1`} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} />
        </label>
        <div className="grid grid-cols-3 gap-3">
          <label className={labelCls}>
            Priority
            <select className={`${inputCls} mt-1`} value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              <option value={1}>P1 — critical</option>
              <option value={2}>P2 — high</option>
              <option value={3}>P3 — normal</option>
              <option value={4}>P4 — low</option>
            </select>
          </label>
          <label className={labelCls}>
            Due
            <input className={`${inputCls} mt-1`} type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label className={labelCls}>
            Owner
            <select className={`${inputCls} mt-1`} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Unassigned</option>
              {assignable.map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.fullName}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          {startStage && (
            <p className="mr-auto text-xs text-slate-500">
              New items start in <strong>“{startStage.name}”</strong> and move along the workflow from there.
            </p>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={create.isPending} disabled={!title.trim() || !projectId}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
