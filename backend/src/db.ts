import postgres from 'postgres';
import { config } from './config';

/**
 * One connection pool per process. `prepare: false` keeps us compatible with transaction-mode
 * poolers (Neon/PgBouncer). statement_timeout bounds every query, which is also what makes the
 * 30-second overlap window of the changes feed safe (docs/02-architecture.md §2.7).
 */
export const sql = postgres(config.DATABASE_URL, {
  max: config.DB_POOL_MAX,
  prepare: false,
  // 0 = keep idle connections open (long-running server). Closing them after N seconds of quiet
  // made the next burst of parallel queries reconnect all at once, which measured ~13 s on
  // Windows + Docker Desktop. Serverless hosts can set DB_IDLE_TIMEOUT to release connections.
  idle_timeout: config.DB_IDLE_TIMEOUT,
  max_lifetime: 60 * 30, // recycle connections every 30 min
  connect_timeout: 5,
  onnotice: () => {},
  connection: {
    statement_timeout: 10_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  },
});

export type Sql = postgres.Sql | postgres.TransactionSql;
export type Tx = postgres.TransactionSql;

/** Run `fn` in a transaction. Any thrown error rolls everything back. */
export function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx)) as Promise<T>;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === '23505' && (!constraint || e.constraint_name === constraint);
}

export function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? '';
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'CONNECT_TIMEOUT',
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    'CONNECTION_DESTROYED',
    '57P01', // admin shutdown
    '57P03', // cannot connect now
    '53300', // too many connections
    '57014', // statement timeout
    '55P03', // lock timeout
    '40P01', // deadlock detected: the transaction was rolled back, safe to retry
  ].includes(code);
}
