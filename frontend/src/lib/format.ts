import type { ItemType, ProjectHealth } from '@nops/shared';

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const units: [number, string][] = [
    [86_400_000 * 30, 'mo'],
    [86_400_000 * 7, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
  ];
  for (const [ms, label] of units) {
    if (abs >= ms) {
      const n = Math.floor(abs / ms);
      return future ? `in ${n}${label}` : `${n}${label} ago`;
    }
  }
  return future ? 'in a moment' : 'just now';
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** ISO → value for <input type="datetime-local"> in the browser's time zone. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

export const TYPE_META: Record<ItemType, { icon: string; label: string }> = {
  incident: { icon: '🔥', label: 'Incident' },
  customer_issue: { icon: '👤', label: 'Customer issue' },
  payment: { icon: '💳', label: 'Payment' },
  compliance: { icon: '🛡', label: 'Compliance' },
  task: { icon: '☑', label: 'Task' },
};

export const PRIORITY_META: Record<number, { label: string; className: string; dot: string }> = {
  1: { label: 'P1', className: 'bg-red-100 text-red-800 ring-red-200', dot: 'bg-red-500' },
  2: { label: 'P2', className: 'bg-orange-100 text-orange-800 ring-orange-200', dot: 'bg-orange-500' },
  3: { label: 'P3', className: 'bg-slate-100 text-slate-700 ring-slate-200', dot: 'bg-slate-400' },
  4: { label: 'P4', className: 'bg-slate-50 text-slate-500 ring-slate-200', dot: 'bg-slate-300' },
};

export const HEALTH_META: Record<ProjectHealth, { label: string; className: string }> = {
  on_track: { label: 'On track', className: 'bg-emerald-100 text-emerald-800' },
  at_risk: { label: 'At risk', className: 'bg-amber-100 text-amber-800' },
  off_track: { label: 'Off track', className: 'bg-red-100 text-red-800' },
  done: { label: 'Done', className: 'bg-slate-200 text-slate-700' },
};

export const ROLE_LABEL: Record<string, string> = {
  manager: 'Manager',
  lead: 'Lead',
  member: 'Member',
  admin: 'Admin',
  system: 'System',
  none: 'Former member',
};

export const NOTE_META: Record<string, { icon: string; label: string }> = {
  note: { icon: '📝', label: 'Note' },
  decision: { icon: '⚖', label: 'Decision' },
  handoff: { icon: '🤝', label: 'Handoff' },
  blocker: { icon: '⛔', label: 'Blocker' },
};
