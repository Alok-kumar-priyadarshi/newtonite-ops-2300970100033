// Vercel build for the frontend project (Root Directory = frontend). Writes .vercel/output in
// Vercel's Build Output API format: the built app as static files with an SPA fallback.
//
// API_TARGET (the backend project's URL) makes Vercel forward /api/* to the backend, so the
// browser sees one site: no CORS, and the session cookie stays first-party (works in Safari).
// Without it, the app calls VITE_API_URL directly (needs CORS_ORIGINS on the backend).
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(dir, '.vercel/output');
// Local builds read frontend/.env; on Vercel the project's environment variables win.
if (existsSync(path.join(dir, '.env'))) process.loadEnvFile(path.join(dir, '.env'));
const apiTarget = (process.env.API_TARGET ?? '').trim().replace(/\/+$/, '');

if (!apiTarget && !process.env.VITE_API_URL) {
  console.warn('Neither API_TARGET nor VITE_API_URL is set: the app will call /api on its own domain.');
}

rmSync(out, { recursive: true, force: true });
execSync('npm run build', { cwd: dir, stdio: 'inherit' });
cpSync(path.join(dir, 'dist'), path.join(out, 'static'), { recursive: true });

writeJson(path.join(out, 'config.json'), {
  version: 3,
  routes: [
    ...(apiTarget ? [{ src: '^/api/(.*)$', dest: `${apiTarget}/api/$1` }] : []),
    { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { handle: 'filesystem' },
    { src: '/.*', dest: '/index.html' },
  ],
});

console.log(`Frontend output written to frontend/.vercel/output${apiTarget ? ` (/api → ${apiTarget})` : ''}`);

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
