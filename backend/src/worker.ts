import { sql } from './db';
import { cleanupExpired } from './outbox/maintenance';
import { processOutboxBatch } from './outbox/process';

/**
 * Local/container worker: polls the outbox every 2 s (immediately again while there is work),
 * and runs housekeeping every 10 minutes.
 */
let running = true;
const CLEANUP_EVERY_MS = 10 * 60_000;

async function loop() {
  console.log('outbox worker started');
  let lastCleanup = 0;
  while (running) {
    try {
      if (Date.now() - lastCleanup > CLEANUP_EVERY_MS) {
        lastCleanup = Date.now();
        const removed = await cleanupExpired();
        console.log(JSON.stringify({ msg: 'cleanup', ...removed }));
      }
      const n = await processOutboxBatch(50);
      if (n === 0) await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(JSON.stringify({ msg: 'worker loop error', error: String(err) }));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await sql.end({ timeout: 5 });
}

process.on('SIGTERM', () => (running = false));
process.on('SIGINT', () => (running = false));
loop();
