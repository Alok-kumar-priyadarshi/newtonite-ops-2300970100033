import type { NextFunction, Request, Response } from 'express';
import type { ErrorBody } from '@nops/shared';
import { ZodError } from 'zod';
import { isConnectionError } from '../db';
import { AppError } from '../domain/errors';

export function errorBody(err: AppError, requestId?: string): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
      requestId,
    },
  };
}

/** Converts any thrown error into the standard envelope (docs/07-api-contracts.md §7.1). */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError('VALIDATION_FAILED', 'Some fields are invalid.', {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') return new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large.');
  if (e?.type === 'entity.parse.failed') return new AppError('VALIDATION_FAILED', 'Request body is not valid JSON.');
  if (isConnectionError(err)) {
    return new AppError('SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Your last action was not saved.');
  }
  return new AppError('INTERNAL', 'Something went wrong. Your last action was not saved.');
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const appErr = toAppError(err);
  if (appErr.status >= 500 && process.env.NODE_ENV !== 'test') {
    console.error(JSON.stringify({ msg: 'request failed', requestId: req.requestId, error: String((err as Error)?.stack ?? err) }));
  }
  if (appErr.code === 'SERVICE_UNAVAILABLE') res.setHeader('Retry-After', '5');
  res.status(appErr.status).json(errorBody(appErr, req.requestId));
}
