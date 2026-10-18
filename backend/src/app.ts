import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { config } from './config';
import { requireCsrfHeader } from './http/auth';
import { cors } from './http/cors';
import { errorHandler } from './http/errors';
import { apiRouter, publicRouter } from './http/routes';

/** Builds the Express app. Used by the local server, the tests and the Vercel function. */
export function createApp(opts: { serveWeb?: boolean } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    req.requestId = req.get('x-request-id') ?? randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    const started = Date.now();
    res.on('finish', () => {
      if (process.env.NODE_ENV === 'test' || !req.path.startsWith('/api')) return;
      console.log(
        JSON.stringify({
          requestId: req.requestId,
          userId: req.actor?.id,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          ms: Date.now() - started,
        }),
      );
    });
    next();
  });

  if (config.CORS_ORIGINS.length > 0) app.use('/api', cors(config.CORS_ORIGINS));
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use('/api', requireCsrfHeader);
  app.use('/api', publicRouter);
  app.use('/api', apiRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint.' } });
  });

  if (opts.serveWeb) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webDist = path.resolve(here, '../../frontend/dist');
    if (existsSync(webDist)) {
      app.use(express.static(webDist, { index: false, maxAge: '1h' }));
      // SPA fallback: every non-API route renders the app shell.
      app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
    }
  }

  app.use(errorHandler);
  return app;
}
