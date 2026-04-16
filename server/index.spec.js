import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app, { pct } from './index.js';

describe('Backend Core Logic', () => {
  it('pct() should calculate percentages correctly', () => {
    expect(pct(50, 100)).toBe(50);
    expect(pct(1, 3)).toBe(33.33);
    expect(pct(0, 100)).toBe(0);
    expect(pct(50, 0)).toBe(0);
  });

  it('GET /health should return 200 and ok:true', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.timestamp).toBeDefined();
  });
});
