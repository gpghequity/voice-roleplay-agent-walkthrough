import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../server.js';

describe('voice-roleplay-agent-walkthrough smoke', () => {
  it('root returns non-500', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBeLessThan(500);
  });

  it('no secrets leak in root response', async () => {
    const res = await request(app).get('/');
    const body = String(res.text || JSON.stringify(res.body) || '');
    const secretPatterns = [/api_key/i, /private_key/i];
    for (const pat of secretPatterns) {
      expect(pat.test(body)).toBe(false);
    }
  });
});
