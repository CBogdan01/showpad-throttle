import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseClients } from '../src/config.js';
import { counterKey } from '../src/rate-limit/keys.js';
import { MemoryStore } from '../src/rate-limit/memory-store.js';
import { FIXED_WINDOW_BODY, TOKEN_BUCKET_BODY } from '../src/rate-limit/redis-scripts.js';
import { RedisStore, connectRedis, createRedisClient, parseDecision } from '../src/rate-limit/redis-store.js';
import { StoreUnavailableError } from '../src/rate-limit/types.js';
import type { Algorithm, Policy } from '../src/rate-limit/types.js';
import { clientDocument, testConfig } from './support/fixtures.js';
import { scenarios } from './support/scenarios.js';

const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const namespace = `test-${randomUUID()}`;
const clients = [createRedisClient(url), createRedisClient(url)];
const stores = clients.map((client) => new RedisStore(client));
const keys = new Set<string>();
function key(label: string): string {
  const value = `throttle:v1:${namespace}:${label}`;
  keys.add(value);
  return value;
}
const clockPrelude = 'local now = tonumber(ARGV[3])\n';
const bodies = { 'fixed-window': FIXED_WINDOW_BODY, 'token-bucket': TOKEN_BUCKET_BODY };
async function deterministic(algorithm: Algorithm, policy: Policy, key: string, now: number, connection = 0) {
  return parseDecision(await clients[connection]!.eval(clockPrelude + bodies[algorithm], {
    keys: [key], arguments: [String(policy.limit), String(policy.periodMs), String(now)],
  }));
}

beforeAll(async () => {
  try {
    await Promise.all(clients.map(connectRedis));
  } catch {
    await Promise.all(stores.map((store) => store.close()));
    throw new Error('Real Redis is required. Run docker compose up -d --wait redis and set REDIS_URL if needed.');
  }
});
afterAll(async () => {
  try {
    if (clients[0]!.isReady && keys.size > 0) await clients[0]!.del([...keys]);
  } finally {
    await Promise.all(stores.map((store) => store.close()));
  }
});

describe('real Redis conformance', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const stateKey = key(randomUUID());
      for (const step of scenario.steps) {
        const decision = await deterministic(scenario.algorithm, scenario.policy, stateKey, step.now);
        expect(decision).toEqual(step.decision);
      }
    });
  }

  it.each(['fixed-window', 'token-bucket'] as const)('shares an atomic %s quota across two connections', async (algorithm) => {
    const stateKey = key(`concurrent-${algorithm}`);
    const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      deterministic(algorithm, { limit: 3, periodMs: 10000 }, stateKey, 100000, index % 2)));
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
  });

  it.each(['fixed-window', 'token-bucket'] as const)('production %s store uses Redis time and survives adapter recreation', async (algorithm) => {
    const input = { key: key(`production-${algorithm}`), algorithm, policy: { limit: 2, periodMs: 3600000 } };
    const start = Date.now();
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 2]!.consume(input)));
    expect(responses.filter((result) => result.allowed)).toHaveLength(2);
    expect(Date.now() - start).toBeLessThan(1800000);
    expect(await clients[0]!.pTTL(input.key)).toBeGreaterThan(0);
    const client = createRedisClient(url);
    await connectRedis(client);
    const replacement = new RedisStore(client);
    try {
      const result = await replacement.consume(input);
      expect(result.allowed).toBe(false);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    } finally { await replacement.close(); }
  });

  it.each(['fixed-window', 'token-bucket'] as const)('expires production %s state after the correct horizon', async (algorithm) => {
    const input = { key: key(`expiry-${algorithm}`), algorithm, policy: { limit: 3, periodMs: 1000 } };
    const started = Date.now();
    for (let i = 0; i < 3; i++) await stores[0]!.consume(input);
    const ttl = await clients[0]!.pTTL(input.key);
    expect(ttl).toBeGreaterThanOrEqual(1000 - (Date.now() - started) - 50);
    expect(ttl).toBeLessThanOrEqual(1000);
    let exists = 1;
    const deadline = Date.now() + 3000;
    while (exists && Date.now() < deadline) {
      await delay(50);
      exists = await clients[0]!.exists(input.key);
    }
    expect(exists).toBe(0);
    expect((await stores[0]!.consume(input)).allowed).toBe(true);
  });

  it('adds clock debt to token expiry and retry', async () => {
    const stateKey = key('clock-debt');
    const policy = { limit: 1, periodMs: 10000 };
    await deterministic('token-bucket', policy, stateKey, 100000);
    const started = Date.now();
    expect(await deterministic('token-bucket', policy, stateKey, 99000))
      .toEqual({ allowed: false, retryAfterMs: 11000 });
    const ttl = await clients[0]!.pTTL(stateKey);
    expect(ttl).toBeGreaterThanOrEqual(11000 - (Date.now() - started) - 50);
  });

  it.each(['fixed-window', 'token-bucket'] as const)('does not reset corrupt %s state', async (algorithm) => {
    const stateKey = key(`corrupt-${algorithm}`);
    await clients[0]!.hSet(stateKey, { unrelated: 'bad' });
    await expect(stores[0]!.consume({ key: stateKey, algorithm, policy: { limit: 3, periodMs: 10000 } }))
      .rejects.toBeInstanceOf(StoreUnavailableError);
    expect(await clients[0]!.hGetAll(stateKey)).toEqual({ unrelated: 'bad' });
  });

  it.each(['fixed-window', 'token-bucket'] as const)('matches memory over a deterministic varied %s arrival stream', async (algorithm) => {
    const policy = { limit: 7, periodMs: 10000 };
    const stateKey = key(`varied-${algorithm}`);
    let now = 100000;
    let seed = 42;
    const memory = new MemoryStore(() => now);
    try {
      for (let index = 0; index < 150; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        now += (seed % 1800) - 200;
        const input = { key: stateKey, algorithm, policy };
        expect(await deterministic(algorithm, policy, stateKey, now)).toEqual(await memory.consume(input));
      }
    } finally { await memory.close(); }
  });

  it.each(['foo', 'bar'] as const)('preserves the HTTP contract and client isolation for Redis /%s', async (route) => {
    const connection = createRedisClient(url);
    await connectRedis(connection);
    const config = testConfig({ store: 'redis', namespace, clients: parseClients(clientDocument(600000)) });
    const app = buildApp({ config, store: new RedisStore(connection), logger: false });
    try {
      for (const client of config.clients.values()) {
        keys.add(counterKey(namespace, route, client.id, client[route]));
        for (let i = 0; i <= client[route].limit; i++) {
          const response = await app.inject({ url: `/${route}`, headers: { authorization: `Bearer ${client.id}` } });
          expect(response.statusCode).toBe(i < client[route].limit ? 200 : 429);
          expect(response.json()).toEqual(i < client[route].limit ? { success: true } : { error: 'rate limit exceeded' });
        }
      }
      connection.destroy();
      const response = await app.inject({ url: `/${route}`, headers: { authorization: 'Bearer client-1' } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'service unavailable' });
    } finally { await app.close(); }
  });
});
