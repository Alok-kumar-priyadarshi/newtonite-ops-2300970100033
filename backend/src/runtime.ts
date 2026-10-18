/**
 * Environment-specific hook run after a successful write. Locally the worker container processes
 * the outbox; on Vercel, src/vercel.ts sets this to drain a few jobs via waitUntil() so
 * notifications usually arrive within seconds instead of at the next cron tick.
 */
let hook: () => void = () => {};

export function setAfterWriteHook(fn: () => void) {
  hook = fn;
}

export function afterWrite() {
  try {
    hook();
  } catch {
    /* never fail a request because of a background nudge */
  }
}
