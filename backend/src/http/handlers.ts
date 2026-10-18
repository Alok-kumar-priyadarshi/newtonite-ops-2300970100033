import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { IDEMPOTENCY_HEADER } from '@nops/shared';
import type { ZodTypeAny, z } from 'zod';
import { type Tx, withTransaction } from '../db';
import type { Actor } from '../domain/actor';
import { AppError } from '../domain/errors';
import { afterWrite } from '../runtime';
import { errorBody, toAppError } from './errors';

export interface Result {
  status: number;
  body: unknown;
}
type TxHandler = (tx: Tx, req: Request, actor: Actor) => Promise<Result>;

export const ok = (body: unknown, status = 200): Result => ({ status, body });

/** Validates input with a shared zod schema; failures become 400 VALIDATION_FAILED. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw toAppError(r.error);
  return r.data;
}

const actorOf = (req: Request) => {
  if (!req.actor) throw new AppError('UNAUTHENTICATED', 'Please sign in.');
  return req.actor;
};

function send(res: Response, r: Result) {
  if (r.status === 204) res.status(204).end();
  else res.status(r.status).json(r.body);
}

/** Read-only route. */
export function read(fn: (req: Request, actor: Actor) => Promise<unknown>): RequestHandler {
  return async (req, res) => {
    res.json(await fn(req, actorOf(req)));
  };
}

/** Write route that is naturally idempotent (or doesn't need a key): one transaction. */
export function write(fn: TxHandler): RequestHandler {
  return async (req, res) => {
    const actor = actorOf(req);
    const result = await withTransaction((tx) => fn(tx, req, actor));
    send(res, result);
    afterWrite();
  };
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * Write route protected by an Idempotency-Key (docs/05-data-flows.md §5.4).
 *
 * In ONE transaction: insert (user, key) → run the handler in a savepoint → store its response.
 *  - A duplicate arriving while the first is running blocks on the primary key until it commits,
 *    then finds the stored response and replays it.
 *  - If the first attempt crashed, its key row rolled back with it, so a retry runs normally.
 *  - Business errors (4xx) are stored too, so a retry gets the same answer; 5xx is never stored.
 */
export function idempotent(fn: TxHandler): RequestHandler {
  return async (req, res) => {
    const actor = actorOf(req);
    const key = req.get(IDEMPOTENCY_HEADER);
    if (!key || key.length > 100) {
      throw new AppError('IDEMPOTENCY_KEY_REQUIRED', 'This request needs an Idempotency-Key header.');
    }
    const path = req.baseUrl + req.path;
    const hash = createHash('sha256')
      .update(stableStringify({ method: req.method, path, body: req.body ?? null }))
      .digest('hex');

    const outcome = await withTransaction(async (tx) => {
      const inserted = await tx`
        insert into idempotency_keys (user_id, key, method, path, request_hash)
        values (${actor.id}, ${key}, ${req.method}, ${path}, ${hash})
        on conflict (user_id, key) do nothing
        returning key`;
      if (inserted.length === 0) {
        const [stored] = await tx<{ request_hash: string; response_status: number; response_body: unknown }[]>`
          select request_hash, response_status, response_body from idempotency_keys
          where user_id = ${actor.id} and key = ${key}`;
        if (stored.request_hash !== hash) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
        }
        return { status: stored.response_status, body: stored.response_body, replayed: true };
      }
      let result: Result;
      try {
        result = await tx.savepoint((sp) => fn(sp, req, actor));
      } catch (err) {
        const appErr = toAppError(err);
        if (appErr.status >= 500) throw err;
        result = { status: appErr.status, body: errorBody(appErr, req.requestId) };
      }
      await tx`
        update idempotency_keys set response_status = ${result.status},
          response_body = ${tx.json((result.body ?? null) as any)}
        where user_id = ${actor.id} and key = ${key}`;
      return { ...result, replayed: false };
    });

    if (outcome.replayed) res.setHeader('Idempotent-Replayed', 'true');
    send(res, outcome);
    if (!outcome.replayed && outcome.status < 400) afterWrite();
  };
}
