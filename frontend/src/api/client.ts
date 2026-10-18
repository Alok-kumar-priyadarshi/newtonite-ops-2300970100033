import { CSRF_VALUE } from '@nops/shared';

/**
 * Backend address, fixed at build time from VITE_API_URL. Empty (the default) means the same
 * origin as the page: the API serves the app, the Vite proxy forwards /api, or Vercel rewrites it.
 */
const API_BASE = String(import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

/** Error with the server's machine-readable code (docs/07-api-contracts.md). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: any,
  ) {
    super(message);
  }
  get retryable() {
    return this.status === 0 || this.status === 503;
  }
}

interface Options {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': CSRF_VALUE };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Connection problem — your last action was not saved.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error?.code ?? 'INTERNAL',
      data?.error?.message ?? 'Something went wrong.',
      data?.error?.details,
    );
  }
  return data as T;
}

export const get = <T = any>(path: string, signal?: AbortSignal) => api<T>('GET', path, undefined, { signal });

/** Builds a query string, skipping empty values. */
export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const newKey = () => crypto.randomUUID();
