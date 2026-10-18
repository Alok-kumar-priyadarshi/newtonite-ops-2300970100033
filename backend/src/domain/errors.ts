import { ERROR_CODES, type ErrorCode } from '@nops/shared';

/** A business error with a stable code. Thrown anywhere; rendered by the error handler. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = ERROR_CODES[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found.`);
