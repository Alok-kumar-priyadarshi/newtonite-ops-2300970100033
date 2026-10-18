// `npm test`: starts the disposable test database (docker-compose.test.yml) and runs every test.
import { spawnSync } from 'node:child_process';

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!process.env.TEST_DATABASE_URL) {
  console.log('Starting test database (docker-compose.test.yml)…');
  run('docker', ['compose', '-f', 'docker-compose.test.yml', 'up', '-d', '--wait']);
}
run('npm', ['test', '-w', 'backend']);
run('npm', ['test', '-w', 'frontend']);
