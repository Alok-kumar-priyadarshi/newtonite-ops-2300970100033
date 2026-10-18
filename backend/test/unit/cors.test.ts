import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { cors } from '../../src/http/cors';

const app = express();
app.use('/api', cors(['https://app.example.com']));
app.post('/api/ping', (_req, res) => res.json({ ok: true }));

describe('CORS for a frontend on another domain', () => {
  it('answers the preflight for a listed origin, with credentials', async () => {
    const res = await request(app)
      .options('/api/ping')
      .set('Origin', 'https://app.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type, x-requested-with');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toMatch(/X-Requested-With/);
  });

  it('gives an unlisted origin no CORS headers, so the browser blocks it', async () => {
    const res = await request(app).post('/api/ping').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
