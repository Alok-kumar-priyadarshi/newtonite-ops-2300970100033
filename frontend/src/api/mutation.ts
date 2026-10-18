import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toasts';
import { ApiError, newKey } from './client';

interface SafeMutationOptions<V, D> {
  /** Performs the request. `key` is one idempotency key per user intent, reused on retries. */
  fn: (vars: V, key: string) => Promise<D>;
  /** Apply an optimistic change; return a function that undoes it. */
  optimistic?: (vars: V) => (() => void) | void;
  /** Queries to refetch afterwards, whatever the outcome. */
  invalidate?: (vars: V) => QueryKey[];
  onSuccess?: (data: D, vars: V) => void;
  /** Return true to handle an error yourself (e.g. open the conflict panel). */
  onError?: (err: ApiError, vars: V) => boolean | void;
  successMessage?: string | ((data: D, vars: V) => string);
}

/**
 * The one mutation pattern used across the app (docs/08-frontend-views.md §8.4):
 * optimistic update → request with an idempotency key → on network failure retry with the SAME key
 * → on rejection roll back and show the server's reason → refetch what changed.
 */
export function useSafeMutation<V = void, D = unknown>(opts: SafeMutationOptions<V, D>) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<D, ApiError, V, { rollback?: () => void }>({
    mutationFn: async (vars) => {
      const key = newKey();
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await opts.fn(vars, key);
        } catch (err) {
          lastErr = err;
          if (!(err instanceof ApiError) || !err.retryable) throw err;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      throw lastErr;
    },
    onMutate: (vars) => {
      const rollback = opts.optimistic?.(vars);
      return { rollback: rollback || undefined };
    },
    onError: (err, vars, ctx) => {
      ctx?.rollback?.();
      const e = err instanceof ApiError ? err : new ApiError(500, 'INTERNAL', String(err));
      if (opts.onError?.(e, vars)) return;
      toast('error', e.message);
    },
    onSuccess: (data, vars) => {
      opts.onSuccess?.(data, vars);
      const msg = typeof opts.successMessage === 'function' ? opts.successMessage(data, vars) : opts.successMessage;
      if (msg) toast('success', msg);
    },
    onSettled: (_d, _e, vars) => {
      for (const key of opts.invalidate?.(vars) ?? []) qc.invalidateQueries({ queryKey: key });
    },
  });
}
