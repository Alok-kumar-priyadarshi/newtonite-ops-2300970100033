import type { StageKind, UserMini } from '@nops/shared';
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PRIORITY_META, TYPE_META } from '../lib/format';

export function Avatar({ user, size = 24, link = false }: { user: UserMini | null | undefined; size?: number; link?: boolean }) {
  if (!user) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full border border-dashed border-slate-300 text-slate-400"
        style={{ width: size, height: size, fontSize: size * 0.45 }}
        title="Unassigned"
      >
        +
      </span>
    );
  }
  const el = (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.4, background: user.avatarColor }}
      title={user.fullName}
    >
      {user.initials}
    </span>
  );
  return link ? (
    <Link to={`/people/${user.id}`} onClick={(e) => e.stopPropagation()}>
      {el}
    </Link>
  ) : (
    el
  );
}

export function PriorityChip({ priority }: { priority: number }) {
  const m = PRIORITY_META[priority];
  return <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${m.className}`}>{m.label}</span>;
}

export function TypeIcon({ type }: { type: keyof typeof TYPE_META }) {
  return (
    <span title={TYPE_META[type].label} aria-label={TYPE_META[type].label}>
      {TYPE_META[type].icon}
    </span>
  );
}

export function StageChip({ name, kind }: { name: string; kind: StageKind }) {
  const cls =
    kind === 'done' ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : kind === 'start' ? 'bg-slate-100 text-slate-700 ring-slate-200' : 'bg-blue-50 text-blue-700 ring-blue-200';
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>● {name}</span>;
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({
  variant = 'secondary',
  busy,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-500/60',
    secondary: 'bg-white text-slate-800 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
    danger: 'bg-white text-red-700 ring-1 ring-inset ring-red-300 hover:bg-red-50',
    ghost: 'text-slate-600 hover:bg-slate-100',
  };
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed ${styles[variant]} ${className}`}
    >
      {busy && <Spinner size={14} />}
      {children}
    </button>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
      style={{ width: size, height: size }}
      aria-label="Loading"
    />
  );
}

export function Modal({ title, onClose, children, width = 480 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full rounded-xl bg-white shadow-2xl"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button className="text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** A small dialog that insists on a reason (priority, reassign, reject, reopen, delete, restore). */
export function ReasonDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  danger,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) onConfirm(reason.trim());
        }}
        className="space-y-3"
      >
        {description && <div className="text-sm text-slate-600">{description}</div>}
        {children}
        <label className="block text-sm font-medium">
          Reason <span className="text-red-600">*</span>
          <textarea
            ref={ref}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-normal"
            placeholder="Why? This is recorded in the history."
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={!reason.trim()} busy={busy}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function ErrorState({ error }: { error: unknown }) {
  const e = error as { status?: number; message?: string };
  return (
    <EmptyState title={e?.status === 404 ? 'Not found or you don’t have access' : 'Could not load this'}>
      {e?.status === 404 ? 'It may belong to a project you are not a member of.' : e?.message}
    </EmptyState>
  );
}

export const inputCls = 'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm';
export const labelCls = 'block text-sm font-medium text-slate-700';
