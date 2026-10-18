import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Local convenience: load backend/.env (this file lives in backend/src, or backend/dist once
// built). Existing variables win, so Docker/Vercel environment settings are never overridden.
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CRON_SECRET: z.string().min(8).default('local-cron-secret'),
  APP_ORIGIN: z.string().url().default('http://localhost:8080'),
  // Frontend origins on other domains allowed to call the API (comma-separated). Empty = same
  // origin only, which is how Docker, dev mode and Vercel run.
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean)),
  PORT: z.coerce.number().int().default(8080),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  DB_IDLE_TIMEOUT: z.coerce.number().int().min(0).default(0),
  // Optional AI assistant (Groq, OpenAI-compatible API). Empty key = assistant switched off.
  GROQ_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
  NODE_ENV: z.string().default('development'),
});

function load() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(
      `Invalid environment configuration:\n  ${issues}\n` +
        'Copy backend/.env.example to backend/.env (see RUNNING.md).',
    );
  }
  // A frontend on another site only receives the session cookie with SameSite=None, which
  // browsers accept only on Secure cookies.
  const crossSite = parsed.data.CORS_ORIGINS.length > 0;
  return {
    ...parsed.data,
    secureCookies: crossSite || parsed.data.APP_ORIGIN.startsWith('https://'),
    cookieSameSite: crossSite ? ('none' as const) : ('lax' as const),
  };
}

export const config = load();
