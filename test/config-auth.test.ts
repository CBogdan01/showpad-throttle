import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authenticate } from '../src/auth.js';
import { ConfigError, loadConfig, parseClients } from '../src/config.js';
import { counterKey } from '../src/rate-limit/keys.js';
import { clientDocument } from './support/fixtures.js';

describe('configuration', () => {
  it('loads the checked-in sample without Redis', async () => {
    const config = await loadConfig({});
    expect(config.store).toBe('memory');
    expect(config.clients.get('client-1')?.foo.limit).toBe(3);
    expect(config.clients.get('client-2')?.bar.limit).toBe(6);
    expect(config.redisUrl).toBeUndefined();
  });

  it.each([0, -1, 1.5, '3', null, NaN, Infinity, 10001])('rejects invalid limit %s', (limit) => {
    const document: any = clientDocument();
    document.clients[0].foo.limit = limit;
    expect(() => parseClients(document)).toThrow(ConfigError);
  });

  it.each([0, 999, 86400001, 1000.5, '10000', null])('rejects invalid period %s', (period) => {
    const document: any = clientDocument();
    document.clients[0].bar.periodMs = period;
    expect(() => parseClients(document)).toThrow(ConfigError);
  });

  it('rejects duplicate IDs, missing policies, unknown fields, and malformed roots', () => {
    const duplicate = clientDocument();
    duplicate.clients[1]!.id = 'client-1';
    expect(() => parseClients(duplicate)).toThrow(/duplicated/);
    for (const value of [null, [], {}, { clients: [] }, { ...clientDocument(), typo: true },
      { clients: [{ id: 'a', foo: { limit: 3, periodMs: 1000 } }, clientDocument().clients[1]] }]) {
      expect(() => parseClients(value)).toThrow(ConfigError);
    }
    const unknown = clientDocument();
    Object.assign(unknown.clients[0]!.foo, { typo: 1 });
    expect(() => parseClients(unknown)).toThrow(/unknown field/);
  });

  it.each(['', 'contains space', 'a:b', 'a'.repeat(65)])('rejects invalid ID %s', (id) => {
    const document = clientDocument();
    document.clients[0]!.id = id;
    expect(() => parseClients(document)).toThrow(ConfigError);
  });

  it.each([
    { PORT: '3000x' }, { PORT: '0' }, { PORT: '65536' }, { PORT: '1.1' },
    { RATE_LIMIT_STORE: 'disk' }, { RATE_LIMIT_NAMESPACE: 'x:y' }, { LOG_LEVEL: 'verbose' },
    { HOST: '' }, { RATE_LIMIT_STORE: 'redis' },
    { RATE_LIMIT_STORE: 'redis', REDIS_URL: 'https://secret@example.com' },
  ])('fails invalid environment clearly: %j', async (env) => {
    await expect(loadConfig(env)).rejects.toBeInstanceOf(ConfigError);
  });

  it('reads an explicit configuration path and does not expose malformed file content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'throttle-config-'));
    const file = join(directory, 'clients.json');
    try {
      await writeFile(file, JSON.stringify(clientDocument(600000)));
      const config = await loadConfig({ CLIENTS_FILE: file });
      expect(config.clients.get('client-1')?.bar.periodMs).toBe(600000);
      await writeFile(file, '{secret');
      await expect(loadConfig({ CLIENTS_FILE: file })).rejects.toThrow('readable, valid JSON');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('isolates namespaces, clients, routes and policy values in stable keys', () => {
    const policy = { limit: 3, periodMs: 10000 };
    const keys = [
      counterKey('a', 'foo', 'client-1', policy), counterKey('b', 'foo', 'client-1', policy),
      counterKey('a', 'bar', 'client-1', policy), counterKey('a', 'foo', 'client-2', policy),
      counterKey('a', 'foo', 'client-1', { ...policy, limit: 6 }),
      counterKey('a', 'foo', 'client-1', { ...policy, periodMs: 20000 }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(counterKey('a', 'foo', 'client-1', policy)).toBe(keys[0]);
  });
});

describe('bearer authentication', () => {
  const clients = parseClients(clientDocument());
  it.each(['Bearer client-1', 'bEaReR client-1', '  Bearer  client-1\t'])('accepts %s', (value) => {
    expect(authenticate(['Authorization', value], clients)?.id).toBe('client-1');
  });
  it.each(['', 'Bearer', 'Bearer ', 'Basic client-1', 'Bearer unknown', 'Bearer CLIENT-1',
    'Bearer\tclient-1', 'Bearer client-1 extra', 'Bearer client-1,Bearer client-2'])('rejects %s', (value) => {
    expect(authenticate(['Authorization', value], clients)).toBeUndefined();
  });
  it('rejects absent and duplicated credentials, including differing header case', () => {
    expect(authenticate([], clients)).toBeUndefined();
    expect(authenticate(['Authorization', 'Bearer client-1', 'authorization', 'Bearer client-2'], clients)).toBeUndefined();
  });
});
