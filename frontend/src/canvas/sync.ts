import type { CanvasElement } from '@nops/shared';
import { useCallback, useMemo, useReducer, useRef } from 'react';
import { api, ApiError } from '../api/client';
import { useToast } from '../components/Toasts';

export type ElementChange = { id: string } & Partial<Pick<CanvasElement, 'x' | 'y' | 'width' | 'height' | 'zIndex' | 'props'>>;
export type NewElement = Pick<CanvasElement, 'id' | 'type' | 'x' | 'y' | 'width' | 'height' | 'zIndex' | 'props'>;

/**
 * Client side of the canvas sync model (docs/09-canvas-spec.md §9.7).
 *
 *  confirmed – the last copy the server acknowledged (holds the version we must send)
 *  shown     – what is drawn: confirmed + our edits that are not acknowledged yet
 *  pending   – how many of our requests touching an element are in flight; while > 0,
 *              polling never overwrites what the user sees
 *
 * All writes go through one queue, so two quick edits of the same element are sent in order and
 * the second uses the version returned by the first: we never conflict with ourselves.
 */
export function useCanvasSync(projectId: string) {
  const confirmed = useRef(new Map<string, CanvasElement>());
  const shown = useRef(new Map<string, CanvasElement>());
  const pending = useRef(new Map<string, number>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const [tick, rerender] = useReducer((x: number) => x + 1, 0);
  const toast = useToast();

  const isPending = (id: string) => (pending.current.get(id) ?? 0) > 0;
  const hold = (ids: string[]) => ids.forEach((id) => pending.current.set(id, (pending.current.get(id) ?? 0) + 1));
  const releaseIds = (ids: string[]) =>
    ids.forEach((id) => {
      const n = (pending.current.get(id) ?? 1) - 1;
      if (n <= 0) pending.current.delete(id);
      else pending.current.set(id, n);
    });

  /**
   * Server copies (load, refetch, changes feed): a higher version wins unless we are mid-edit.
   * Returns true if anything changed.
   */
  const mergeServer = useCallback((incoming: CanvasElement[]): boolean => {
    let changed = false;
    for (const e of incoming) {
      const prev = confirmed.current.get(e.id);
      if (prev && prev.version >= e.version) continue;
      changed = true;
      if (e.deleted) {
        confirmed.current.delete(e.id);
        if (!isPending(e.id)) shown.current.delete(e.id);
      } else {
        confirmed.current.set(e.id, e);
        if (!isPending(e.id)) shown.current.set(e.id, e);
      }
    }
    if (changed) rerender();
    return changed;
  }, []);

  /** Undo our local edits: show the server's copy again. */
  const revert = (ids: string[]) => {
    for (const id of ids) {
      const c = confirmed.current.get(id);
      if (c) shown.current.set(id, c);
      else shown.current.delete(id);
    }
  };

  const fail = (err: unknown, ids: string[], fallback: string) => {
    const e = err instanceof ApiError ? err : new ApiError(0, 'NETWORK', fallback);
    if (e.code === 'ELEMENT_CONFLICT' && Array.isArray(e.details?.conflicts)) {
      for (const c of e.details.conflicts as { id: string; current: CanvasElement | null }[]) {
        if (!c.current || c.current.deleted) confirmed.current.delete(c.id);
        else confirmed.current.set(c.id, c.current);
      }
    }
    releaseIds(ids);
    revert(ids.filter((id) => !isPending(id)));
    rerender();
    toast('error', e.message);
  };

  const enqueue = (ids: string[], job: () => Promise<void>) => {
    hold(ids);
    queue.current = queue.current.then(job, job);
  };

  /** Move / resize / restyle / edit text: shown immediately, saved in order. */
  const save = useCallback(
    (changes: ElementChange[]) => {
      const valid = changes.filter((c) => shown.current.has(c.id));
      if (valid.length === 0) return;
      for (const ch of valid) shown.current.set(ch.id, { ...shown.current.get(ch.id)!, ...ch });
      rerender();
      const ids = valid.map((c) => c.id);
      enqueue(ids, async () => {
        const body = valid
          .filter((c) => confirmed.current.has(c.id))
          .map((c) => ({ ...c, version: confirmed.current.get(c.id)!.version }));
        if (body.length === 0) return releaseIds(ids);
        try {
          const res = await api<{ elements: CanvasElement[] }>('PATCH', `/projects/${projectId}/canvas/elements`, { changes: body });
          for (const e of res.elements) confirmed.current.set(e.id, e);
          releaseIds(ids);
          rerender();
        } catch (err) {
          fail(err, ids, 'Could not save the canvas.');
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  /** Create drawing elements. Ids are generated here, so a retried request cannot duplicate them. */
  const create = useCallback(
    (elements: NewElement[]) => {
      for (const e of elements) {
        shown.current.set(e.id, { ...e, projectId, stageId: null, version: 0, updatedBy: null, updatedAt: new Date().toISOString() });
      }
      rerender();
      const ids = elements.map((e) => e.id);
      enqueue(ids, async () => {
        try {
          const res = await api<{ elements: CanvasElement[] }>('POST', `/projects/${projectId}/canvas/elements`, { elements });
          for (const e of res.elements) confirmed.current.set(e.id, e);
          releaseIds(ids);
          rerender();
        } catch (err) {
          fail(err, ids, 'Could not add that.');
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  const remove = useCallback(
    (ids: string[]) => {
      const targets = ids.filter((id) => shown.current.has(id));
      if (targets.length === 0) return;
      for (const id of targets) shown.current.delete(id);
      rerender();
      enqueue(targets, async () => {
        const body = targets.filter((id) => confirmed.current.has(id)).map((id) => ({ id, version: confirmed.current.get(id)!.version }));
        if (body.length === 0) return releaseIds(targets);
        try {
          await api('POST', `/projects/${projectId}/canvas/elements/delete`, { elements: body });
          for (const id of targets) confirmed.current.delete(id);
          releaseIds(targets);
          rerender();
        } catch (err) {
          fail(err, targets, 'Could not delete.');
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  const restore = useCallback(
    async (ids: string[]) => {
      const res = await api<{ elements: CanvasElement[] }>('POST', `/projects/${projectId}/canvas/elements/restore`, { ids });
      void mergeServer(res.elements);
    },
    [projectId, mergeServer],
  );

  const elements = useMemo(() => [...shown.current.values()], [tick]);
  return { elements, mergeServer, save, create, remove, restore };
}
