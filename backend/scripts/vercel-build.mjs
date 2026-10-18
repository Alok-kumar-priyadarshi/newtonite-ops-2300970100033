// Vercel build for the backend project (Root Directory = backend). Writes .vercel/output in
// Vercel's Build Output API format: the API as one bundled Node function serving /api/*.
//
// The API is bundled (as the Docker build does with tsup) because it is ES-module TypeScript with
// extensionless imports and a TypeScript workspace package, which Node cannot load as-is.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(dir, '.vercel/output');
const fn = path.join(out, 'functions/api.func');

rmSync(out, { recursive: true, force: true });

await build({
  entryPoints: [path.join(dir, 'src/vercel.ts')],
  outfile: path.join(fn, 'index.mjs'),
  bundle: true, // all dependencies included: the function needs no node_modules
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // CommonJS dependencies (express, jsonwebtoken, …) call require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});

writeJson(path.join(fn, '.vc-config.json'), {
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false, // Express parses bodies and queries itself
  maxDuration: 30,
});
writeJson(path.join(out, 'config.json'), {
  version: 3,
  routes: [{ src: '^/api(?:/.*)?$', dest: '/api' }],
});

console.log('Backend output written to backend/.vercel/output');

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
