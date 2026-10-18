import type { VersionConflictDetails, ItemDetail } from '@nops/shared';
import { timeAgo } from '../lib/format';
import { Button, Modal } from './ui';

const fmt = (field: string, v: unknown) => {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'priority') return `P${v}`;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toLocaleString();
  return String(v);
};

/**
 * Shown when an edit hit a newer version and the changed fields overlap with ours.
 * "Keep mine" re-sends our values on top of the latest version; "Use theirs" discards ours.
 */
export function ConflictPanel({
  conflict,
  mine,
  onKeepMine,
  onUseTheirs,
  busy,
}: {
  conflict: VersionConflictDetails<ItemDetail>;
  mine: Record<string, unknown>;
  onKeepMine: () => void;
  onUseTheirs: () => void;
  busy?: boolean;
}) {
  return (
    <Modal title="Someone changed this item while you were editing" onClose={onUseTheirs} width={560}>
      <div className="space-y-4 text-sm">
        <ul className="space-y-2">
          {conflict.changes.map((c) => (
            <li key={c.eventId + c.field} className="rounded-md bg-amber-50 px-3 py-2 text-amber-900">
              <strong>{c.by?.fullName ?? 'Someone'}</strong> changed <strong>{c.field}</strong> from {fmt(c.field, c.from)} to{' '}
              {fmt(c.field, c.to)} · {timeAgo(c.at)}
            </li>
          ))}
        </ul>
        <div className="rounded-md border border-slate-200 px-3 py-2">
          <div className="mb-1 font-medium">Your change</div>
          {Object.entries(mine)
            .filter(([k]) => k !== 'version' && k !== 'reason')
            .map(([k, v]) => (
              <div key={k} className="text-slate-700">
                {k}: {fmt(k, v)}
              </div>
            ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onUseTheirs}>Use theirs</Button>
          <Button variant="primary" onClick={onKeepMine} busy={busy}>
            Keep mine
          </Button>
        </div>
      </div>
    </Modal>
  );
}
