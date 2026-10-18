// Vercel function entry, bundled by scripts/vercel-build.mjs. Not used locally or in Docker.
import { waitUntil } from '@vercel/functions';
import { createApp } from './app';
import { processOutboxBatch } from './outbox/process';
import { setAfterWriteHook } from './runtime';

// There is no long-running worker on Vercel. After each successful write, drain a few outbox jobs
// once the response has been sent, so notifications usually arrive within seconds. The external
// scheduler calling /api/internal/outbox/run every minute is the safety net.
setAfterWriteHook(() => waitUntil(processOutboxBatch(10).catch(() => 0)));

export default createApp();
