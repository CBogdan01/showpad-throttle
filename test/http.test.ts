import { request as httpRequest } from 'node:http';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryStore } from '../src/rate-limit/memory-store.js';
import { StoreUnavailableError } from '../src/rate-limit/types.js';
import type { RateLimitStore } from '../src/rate-limit/types.js';
import { testConfig } from './support/fixtures.js';

const apps: ReturnType<typeof buildApp>[] = [];
function appWith(store: RateLimitStore = new MemoryStore(() => 100000)) {
  const app = buildApp({ config: testConfig(), store, logger: false });
  apps.push(app);
  return app;
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('HTTP contract', () => {
  it.each(['foo', 'bar'])('%s supports both clients with independent configured allowances', async (route) => {
    const app = appWith();
    for (const [id, limit] of [['client-1', 3], ['client-2', 6]] as const) {
      for (let count = 0; count < limit; count++) {
        const response = await app.inject({ url: `/${route}`, headers: { authorization: `Bearer ${id}` } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['retry-after']).toBeUndefined();
      }
      const denied = await app.inject({ url: `/${route}`, headers: { authorization: `Bearer ${id}` } });
      expect(denied.statusCode).toBe(429);
      expect(denied.json()).toEqual({ error: 'rate limit exceeded' });
      expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
      expect(denied.headers['cache-control']).toBe('no-store');
    }
  });

  it('isolates endpoints while query strings share their route quota', async () => {
    const app = appWith();
    const headers = { authorization: 'Bearer client-1' };
    for (let i = 0; i < 3; i++) expect((await app.inject({ url: `/foo?q=${i}`, headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/foo?new=value', headers })).statusCode).toBe(429);
    expect((await app.inject({ url: '/bar', headers })).statusCode).toBe(200);
  });

  it('rejects credentials before calling storage and leaves unsupported requests uncounted', async () => {
    const consume = vi.fn(async () => ({ allowed: true, retryAfterMs: 0 }));
    const app = appWith({ consume, close: async () => {} });
    for (const authorization of [undefined, '', 'Basic client-1', 'Bearer ', 'Bearer unknown', 'Bearer client-1 extra']) {
      const response = await app.inject({ url: '/foo', headers: authorization === undefined ? {} : { authorization } });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
    for (const request of [{ method: 'HEAD' as const, url: '/foo' }, { method: 'POST' as const, url: '/foo' },
      { method: 'GET' as const, url: '/unknown' }]) {
      expect((await app.inject({ ...request, headers: { authorization: 'Bearer client-1' } })).statusCode).toBe(404);
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects duplicate Authorization headers on an actual HTTP connection', async () => {
    const consume = vi.fn(async () => ({ allowed: true, retryAfterMs: 0 }));
    const app = appWith({ consume, close: async () => {} });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${url}/foo`, {
        headers: ['Host', new URL(url).host, 'Authorization', 'Bearer client-1', 'authorization', 'Bearer client-2'],
      }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
      request.end();
    });
    expect(status).toBe(401);
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([[1, '1'], [999, '1'], [1001, '2']])('rounds %i ms retry up to %s seconds', async (retryAfterMs, expected) => {
    const app = appWith({ consume: async () => ({ allowed: false, retryAfterMs }), close: async () => {} });
    const response = await app.inject({ url: '/bar', headers: { authorization: 'Bearer client-1' } });
    expect(response.headers['retry-after']).toBe(expected);
  });

  it.each([
    [new StoreUnavailableError('command'), 503, 'service unavailable'],
    [new Error('secret should not leak'), 500, 'internal server error'],
  ] as const)('classifies %s without exposing internal details', async (error, code, message) => {
    const app = appWith({ consume: async () => { throw error; }, close: async () => {} });
    const response = await app.inject({ url: '/foo', headers: { authorization: 'Bearer client-1' } });
    expect(response.statusCode).toBe(code);
    expect(response.json()).toEqual({ error: message });
    expect(response.headers['retry-after']).toBeUndefined();
  });

  it('logs operational results without headers, query values, or client IDs', async () => {
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const app = buildApp({
      config: testConfig(), store: new MemoryStore(), logger: { level: 'info', stream },
    });
    apps.push(app);
    await app.inject({ url: '/foo?secret=hidden-query', headers: { authorization: 'Bearer client-1' } });
    await app.inject({ url: '/unknown?secret=hidden-query', headers: { authorization: 'Bearer client-1' } });
    await app.inject({ url: '/bar?secret=hidden-query', headers: { authorization: 'Bearer secret-unknown-client' } });
    expect(output).toContain('request_completed');
    expect(output).not.toContain('client-1');
    expect(output).not.toContain('hidden-query');
    expect(output).not.toContain('authorization');
    expect(output).not.toContain('secret-unknown-client');
  });

  it('gives the application ownership of provider cleanup', async () => {
    const close = vi.fn(async () => {});
    const app = appWith({ consume: async () => ({ allowed: true, retryAfterMs: 0 }), close });
    await app.ready();
    await app.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
