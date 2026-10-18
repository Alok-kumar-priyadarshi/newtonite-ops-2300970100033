import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Settings come from frontend/.env. Only VITE_* values reach the browser bundle; API_TARGET is
// used here by the dev server and never shipped.
const envDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, envDir, ''), ...process.env };
  return {
    envDir,
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      // Where the backend runs during development (API_TARGET, default http://localhost:8080).
      proxy: { '/api': env.API_TARGET || 'http://localhost:8080' },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}'],
    },
  } as any;
});
