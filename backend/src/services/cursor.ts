import { AppError } from '../domain/errors';

/** Opaque keyset-pagination cursors: base64url(JSON of the last row's sort key). */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): unknown {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor.');
  }
}
