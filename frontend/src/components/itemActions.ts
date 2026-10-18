import type { ItemDetail, VersionConflictDetails } from '@nops/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { useMe } from '../api/queries';
import { useSafeMutation } from '../api/mutation';

/** Everything that changes after an item changes. */
export const itemKeys = (item: { id: string; projectId: string }) => [
  ['item', item.id],
  ['activity', item.id],
  ['items'],
  ['dashboard'],
  ['canvas', item.projectId],
  ['projects'],
];

export interface PendingConflict {
  conflict: VersionConflictDetails<ItemDetail>;
  fields: Record<string, unknown>;
}

/** Item mutations with optimistic updates, rollback and version-conflict handling. */
export function useItemActions(item: ItemDetail | undefined) {
  const qc = useQueryClient();
  const me = useMe().data;
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const keys = () => (item ? itemKeys(item) : []);
  const setItem = (d: ItemDetail) => qc.setQueryData(['item', d.id], d);
  const patchCache = (fn: (d: ItemDetail) => ItemDetail) => {
    const prev = qc.getQueryData<ItemDetail>(['item', item!.id]);
    if (prev) qc.setQueryData(['item', item!.id], fn(prev));
    return () => prev && qc.setQueryData(['item', item!.id], prev);
  };

  const claim = useSafeMutation({
    fn: (_: void, key) => api<ItemDetail>('POST', `/items/${item!.id}/claim`, {}, { idempotencyKey: key }),
    optimistic: () =>
      me &&
      patchCache((d) => ({
        ...d,
        assignee: { ...me.user, designation: me.user.designation, projectRole: null, openItemCount: 0 },
      })),
    onSuccess: setItem,
    invalidate: keys,
    successMessage: 'Claimed. It’s yours now.',
  });

  const release = useSafeMutation({
    fn: (_: void, key) => api<ItemDetail>('POST', `/items/${item!.id}/release`, { version: item!.version }, { idempotencyKey: key }),
    optimistic: () => patchCache((d) => ({ ...d, assignee: null })),
    onSuccess: setItem,
    invalidate: keys,
  });

  const transition = useSafeMutation({
    fn: (v: { toStageId: string; reason?: string }, key) =>
      api<ItemDetail>('POST', `/items/${item!.id}/transition`, { version: item!.version, ...v }, { idempotencyKey: key }),
    optimistic: (v) => {
      const target = item!.allowedTransitions.find((t) => t.toStageId === v.toStageId);
      return patchCache((d) => ({ ...d, stage: { ...d.stage, id: v.toStageId, name: target?.toStageName ?? d.stage.name } }));
    },
    onSuccess: setItem,
    invalidate: keys,
    successMessage: (d) => `Moved to ${d.stage.name}.`,
  });

  /**
   * Edits made in a form/dialog send the version the form was OPENED with (`baseVersion`), not the
   * latest one polled since. Otherwise a background refresh would let the form silently overwrite
   * someone else's change; with the base version the server's check catches it.
   */
  const assign = useSafeMutation({
    fn: (v: { assigneeId: string | null; reason: string; baseVersion: number }, key) =>
      api<ItemDetail>(
        'POST',
        `/items/${item!.id}/assign`,
        { version: v.baseVersion, assigneeId: v.assigneeId, reason: v.reason },
        { idempotencyKey: key },
      ),
    onSuccess: setItem,
    invalidate: keys,
    successMessage: 'Owner updated.',
  });

  /** PATCH with automatic re-apply when the other person's change touched different fields. */
  const patch = useSafeMutation({
    fn: async (v: { fields: Record<string, unknown>; baseVersion: number }) => {
      try {
        return await api<ItemDetail>('PATCH', `/items/${item!.id}`, { ...v.fields, version: v.baseVersion });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
          const details = err.details as VersionConflictDetails<ItemDetail>;
          const overlap = details.changes.some((c) => c.field in v.fields);
          if (!overlap) {
            return api<ItemDetail>('PATCH', `/items/${item!.id}`, { ...v.fields, version: details.current.version });
          }
        }
        throw err;
      }
    },
    onSuccess: setItem,
    onError: (err, v) => {
      if (err.code === 'VERSION_CONFLICT') {
        setItem(err.details.current);
        setConflict({ conflict: err.details, fields: v.fields });
        return true;
      }
      return false;
    },
    invalidate: keys,
    successMessage: 'Saved.',
  });

  const keepMine = useSafeMutation({
    fn: (_: void) =>
      api<ItemDetail>('PATCH', `/items/${item!.id}`, { ...conflict!.fields, version: conflict!.conflict.current.version }),
    onSuccess: (d) => {
      setItem(d);
      setConflict(null);
    },
    onError: (err) => {
      if (err.code === 'VERSION_CONFLICT') {
        setItem(err.details.current);
        setConflict((c) => (c ? { ...c, conflict: err.details } : c));
        return true;
      }
      setConflict(null);
      return false;
    },
    invalidate: keys,
    successMessage: 'Saved your version.',
  });

  const remove = useSafeMutation({
    fn: (v: { reason: string }, key) => api('DELETE', `/items/${item!.id}`, { version: item!.version, ...v }, { idempotencyKey: key }),
    invalidate: keys,
    successMessage: 'Item deleted. The Manager can restore it from Deleted items.',
  });

  const restore = useSafeMutation({
    fn: (v: { reason: string }, key) => api<ItemDetail>('POST', `/items/${item!.id}/restore`, v, { idempotencyKey: key }),
    onSuccess: setItem,
    invalidate: keys,
    successMessage: 'Item restored.',
  });

  const addNote = useSafeMutation({
    fn: (v: { kind: string; body: string }, key) => api('POST', `/items/${item!.id}/notes`, v, { idempotencyKey: key }),
    invalidate: keys,
  });

  const addBlocker = useSafeMutation({
    fn: (v: { blockerItemId: string }) => api<ItemDetail>('POST', `/items/${item!.id}/links`, v),
    onSuccess: setItem,
    invalidate: keys,
  });

  const removeBlocker = useSafeMutation({
    fn: (blockerId: string) => api('DELETE', `/items/${item!.id}/links/${blockerId}`),
    invalidate: keys,
  });

  return {
    claim,
    release,
    transition,
    assign,
    patch,
    remove,
    restore,
    addNote,
    addBlocker,
    removeBlocker,
    conflict,
    keepMine,
    dismissConflict: () => setConflict(null),
  };
}
