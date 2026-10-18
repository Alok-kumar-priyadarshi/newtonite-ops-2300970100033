import { PROJECT_HEALTH, type ProjectDetail, type ProjectHealth, type Stage, type StageKind, type Transition } from '@nops/shared';
import { useEffect, useState } from 'react';
import { Button, inputCls, labelCls, Modal } from '../components/ui';
import { HEALTH_META } from '../lib/format';

const panelCls = 'absolute right-3 top-3 z-10 w-72 space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-lg';

export function StagePanel({
  stage,
  canEditRules,
  onRename,
  onPatch,
  onDelete,
  onClose,
}: {
  stage: Stage;
  canEditRules: boolean;
  onRename: (name: string) => void;
  onPatch: (p: { kind?: StageKind; requiresApproval?: boolean }) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(stage.name);
  useEffect(() => setName(stage.name), [stage.name]);
  const lockTitle = canEditRules ? undefined : 'Only a Lead or the Manager can change workflow rules';
  return (
    <div className={panelCls}>
      <div className="flex items-center">
        <h3 className="font-semibold">Stage</h3>
        <button className="ml-auto text-slate-400" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && name.trim() !== stage.name) onRename(name.trim());
        }}
      >
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label="Stage name" />
        <Button type="submit">Rename</Button>
      </form>
      <label className={labelCls} title={lockTitle}>
        Kind
        <select
          className={`${inputCls} mt-1`}
          value={stage.kind}
          disabled={!canEditRules}
          onChange={(e) => onPatch({ kind: e.target.value as StageKind })}
        >
          <option value="start">Start — new items land here</option>
          <option value="active">Active</option>
          <option value="done">Done — counts as finished</option>
        </select>
      </label>
      <label className="flex items-start gap-2" title={lockTitle}>
        <input type="checkbox" className="mt-1" checked={stage.requiresApproval} disabled={!canEditRules} onChange={(e) => onPatch({ requiresApproval: e.target.checked })} />
        <span>
          <span className="font-medium">🔒 Protected (approval)</span>
          <span className="block text-xs text-slate-500">Entering it needs a Lead/Manager who didn’t create or own the item. Nobody can route around it.</span>
        </span>
      </label>
      {!canEditRules && <p className="text-xs text-slate-500">Kind and protection: Lead or Manager only.</p>}
      <Button variant="danger" className="w-full" onClick={onDelete}>
        Delete stage
      </Button>
    </div>
  );
}

export function TransitionPanel({
  transition,
  fromName,
  toName,
  canEditRules,
  onPatch,
  onInsert,
  onDelete,
  onClose,
}: {
  transition: Transition;
  fromName: string;
  toName: string;
  canEditRules: boolean;
  onPatch: (p: { label?: string | null; requiresReason?: boolean; leadOnly?: boolean }) => void;
  onInsert: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(transition.label ?? '');
  useEffect(() => setLabel(transition.label ?? ''), [transition.label]);
  return (
    <div className={panelCls}>
      <div className="flex items-center">
        <h3 className="font-semibold">Connection</h3>
        <button className="ml-auto text-slate-400" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <p className="text-slate-600">
        {fromName} → {toName}
      </p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onPatch({ label: label.trim() || null });
        }}
      >
        <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Reject" maxLength={40} />
        <Button type="submit">Save</Button>
      </form>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={transition.requiresReason} disabled={!canEditRules} onChange={(e) => onPatch({ requiresReason: e.target.checked })} />
        Reason required (R)
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={transition.leadOnly} disabled={!canEditRules} onChange={(e) => onPatch({ leadOnly: e.target.checked })} />
        Lead or Manager only (L)
      </label>
      {!canEditRules && <p className="text-xs text-slate-500">Rules: Lead or Manager only.</p>}
      <Button className="w-full" onClick={onInsert}>
        ＋ Insert a step here
      </Button>
      <Button variant="danger" className="w-full" onClick={onDelete}>
        Delete connection
      </Button>
    </div>
  );
}

export function NameDialog({ title, initial = '', onSubmit, onClose }: { title: string; initial?: string; onSubmit: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title={title} onClose={onClose} width={380}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSubmit(name.trim());
        }}
      >
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} placeholder="e.g. Bank verification" />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Add
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function ProjectEditDialog({
  project,
  onSave,
  onClose,
  busy,
}: {
  project: ProjectDetail;
  onSave: (fields: Record<string, unknown>) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const canStatus = project.permissions.includes('project.edit_status');
  const canDetails = project.permissions.includes('project.edit_details');
  const [f, setF] = useState({ name: project.name, goal: project.goal, statusNote: project.statusNote, health: project.health });
  return (
    <Modal title="What this project is doing" onClose={onClose} width={520}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const changes: Record<string, unknown> = {};
          if (canDetails && f.name !== project.name) changes.name = f.name;
          if (canDetails && f.goal !== project.goal) changes.goal = f.goal;
          if (canStatus && f.statusNote !== project.statusNote) changes.statusNote = f.statusNote;
          if (canStatus && f.health !== project.health) changes.health = f.health;
          if (Object.keys(changes).length) onSave(changes);
          else onClose();
        }}
      >
        <label className={labelCls}>
          Name
          <input className={`${inputCls} mt-1`} value={f.name} disabled={!canDetails} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className={labelCls}>
          Goal
          <textarea className={`${inputCls} mt-1`} rows={2} value={f.goal} disabled={!canDetails} onChange={(e) => setF({ ...f, goal: e.target.value })} />
        </label>
        <label className={labelCls}>
          Now (status)
          <input className={`${inputCls} mt-1`} value={f.statusNote} disabled={!canStatus} onChange={(e) => setF({ ...f, statusNote: e.target.value })} />
        </label>
        <label className={labelCls}>
          Health
          <select className={`${inputCls} mt-1`} value={f.health} disabled={!canStatus} onChange={(e) => setF({ ...f, health: e.target.value as ProjectHealth })}>
            {PROJECT_HEALTH.map((h) => (
              <option key={h} value={h}>
                {HEALTH_META[h].label}
              </option>
            ))}
          </select>
        </label>
        {!canStatus && <p className="text-xs text-slate-500">Only Leads and the Manager can update the status; only the Manager can change name and goal.</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!canStatus && !canDetails}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
