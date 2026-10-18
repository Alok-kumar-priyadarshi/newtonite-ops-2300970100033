import { createApp } from './app';
import { config } from './config';
import { sql } from './db';

const app = createApp({ serveWeb: true });
const server = app.listen(config.PORT, () => {
  console.log(`Newtonite Ops API listening on http://localhost:${config.PORT}`);
});

async function shutdown() {
  server.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
