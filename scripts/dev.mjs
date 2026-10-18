// `npm run dev`: database in Docker, then API (watch), worker (watch) and Vite with hot reload.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';

const shell = process.platform === 'win32';
for (const part of ['backend', 'frontend']) {
  if (!existsSync(`${part}/.env`)) {
    copyFileSync(`${part}/.env.example`, `${part}/.env`);
    console.log(`Created ${part}/.env from ${part}/.env.example`);
  }
}

const step = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
step('docker', ['compose', 'up', '-d', '--wait', 'db']);
step('npm', ['run', 'db:migrate']);
step('npm', ['run', 'db:seed']);

const procs = [
  ['api', 'npm', ['run', 'dev', '-w', 'backend']],
  ['worker', 'npm', ['run', 'dev:worker', '-w', 'backend']],
  ['web', 'npm', ['run', 'dev', '-w', 'frontend']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { shell, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter(Boolean)
      .forEach((line) => console.log(`[${name}] ${line}`));
  p.stdout.on('data', prefix);
  p.stderr.on('data', prefix);
  return p;
});

console.log('\nOpen http://localhost:5173 (Vite) — API on http://localhost:8080\n');
const stop = () => {
  procs.forEach((p) => p.kill());
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
