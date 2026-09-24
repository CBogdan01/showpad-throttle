import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ROUTES } from '../src/http/routes.js';
import { counterKey } from '../src/rate-limit/keys.js';
import { MemoryStore } from '../src/rate-limit/memory-store.js';
import { RedisStore, connectRedis, createRedisClient } from '../src/rate-limit/redis-store.js';

async function demo(): Promise<void> {
  const namespace = `demo-${randomUUID()}`;
  const redis = createRedisClient(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const apps: ReturnType<typeof buildApp>[] = [];
  const keys: string[] = [];
  const rows: Array<Record<string, string | number>> = [];
  try {
    await connectRedis(redis);
    for (const provider of ['memory', 'redis'] as const) {
      const config = await loadConfig({
        RATE_LIMIT_STORE: provider,
        REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
        CLIENTS_FILE: './config/clients.demo.json',
        RATE_LIMIT_NAMESPACE: namespace, LOG_LEVEL: 'silent',
      });
      const app = buildApp({ config, store: provider === 'memory' ? new MemoryStore() : new RedisStore(redis), logger: false });
      apps.push(app);
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      for (const client of config.clients.values()) {
        for (const { name } of ROUTES) {
          const policy = client[name];
          if (provider === 'redis') keys.push(counterKey(namespace, name, client.id, policy));
          const start = performance.now();
          let retryAfter = '';
          for (let index = 0; index <= policy.limit; index++) {
            const response = await fetch(`${address}/${name}`, {
              headers: { authorization: `Bearer ${client.id}` }, signal: AbortSignal.timeout(3000),
            });
            const allowed = index < policy.limit;
            assert.equal(response.status, allowed ? 200 : 429, `${provider}/${client.id}/${name}`);
            assert.deepEqual(await response.json(), allowed ? { success: true } : { error: 'rate limit exceeded' });
            if (!allowed) {
              retryAfter = response.headers.get('retry-after') ?? '';
              assert.match(retryAfter, /^[1-9]\d*$/);
            }
          }
          assert(performance.now() - start < policy.periodMs / policy.limit, 'Demo took long enough to refill; rerun.');
          rows.push({ provider, client: client.id, endpoint: `/${name}`, allowed: policy.limit, finalStatus: 429, retryAfter });
        }
      }
    }
  } finally {
    try {
      if (redis.isReady && keys.length > 0) await redis.del(keys);
    } finally {
      await Promise.allSettled(apps.map((app) => app.close()));
      if (redis.isOpen) redis.destroy();
    }
  }
  console.table(rows);
  console.log('PASS: both clients, both endpoints, both providers; all eight combinations verified.');
}

demo().catch((error: unknown) => {
  if (error instanceof Error && error.name === 'AssertionError') console.error(error.message);
  console.error('Demo failed. Ensure Redis is running and REDIS_URL is correct; run the test suites for further diagnosis.');
  process.exitCode = 1;
});
