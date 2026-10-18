import type { NextFunction, Request, Response } from 'express';

/**
 * CORS for a frontend hosted on another domain (CORS_ORIGINS). Only listed origins get the
 * headers, with credentials so the session cookie is sent. CSRF protection still holds: the
 * required X-Requested-With header forces a preflight, which only listed origins pass.
 */
export function cors(origins: string[]) {
  const allowed = new Set(origins);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (!origin || !allowed.has(origin)) return next();
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Idempotent-Replayed');
    res.vary('Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    next();
  };
}
