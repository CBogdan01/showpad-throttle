import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Policy } from './rate-limit/types.js';

export type Client = Readonly<{ id: string; foo: Policy; bar: Policy }>;
export type StoreKind = 'memory' | 'redis';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
export type AppConfig = Readonly<{
  host: string;
  port: number;
  store: StoreKind;
  namespace: string;
  logLevel: LogLevel;
  redisUrl?: string;
  clients: ReadonlyMap<string, Client>;
}>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const identifier = /^[A-Za-z0-9_-]{1,64}$/;

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw new ConfigError(`${label} contains an unknown field`);
  }
  return record;
}

function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function policy(value: unknown, label: string): Policy {
  const record = object(value, ['limit', 'periodMs'], label);
  return Object.freeze({
    limit: integer(record.limit, 1, 10000, `${label}.limit`),
    periodMs: integer(record.periodMs, 1000, 86400000, `${label}.periodMs`),
  });
}

export function parseClients(value: unknown): ReadonlyMap<string, Client> {
  const root = object(value, ['clients'], 'Client configuration');
  if (!Array.isArray(root.clients) || root.clients.length < 2 || root.clients.length > 1000) {
    throw new ConfigError('clients must contain between 2 and 1000 entries');
  }
  const clients = new Map<string, Client>();
  root.clients.forEach((value: unknown, index: number) => {
    const label = `clients[${index}]`;
    const entry = object(value, ['id', 'foo', 'bar'], label);
    if (typeof entry.id !== 'string' || !identifier.test(entry.id)) {
      throw new ConfigError(`${label}.id must match [A-Za-z0-9_-]{1,64}`);
    }
    if (clients.has(entry.id)) throw new ConfigError(`${label}.id is duplicated`);
    clients.set(entry.id, Object.freeze({
      id: entry.id,
      foo: policy(entry.foo, `${label}.foo`),
      bar: policy(entry.bar, `${label}.bar`),
    }));
  });
  return clients;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const store = env.RATE_LIMIT_STORE ?? 'memory';
  if (store !== 'memory' && store !== 'redis') throw new ConfigError('RATE_LIMIT_STORE must be memory or redis');
  const portText = env.PORT ?? '3000';
  if (!/^\d+$/.test(portText)) throw new ConfigError('PORT must be an integer from 1 to 65535');
  const port = integer(Number(portText), 1, 65535, 'PORT');
  const host = env.HOST ?? '127.0.0.1';
  if (!host || /\s/.test(host)) throw new ConfigError('HOST must be a nonempty address without whitespace');
  const namespace = env.RATE_LIMIT_NAMESPACE ?? 'local';
  if (!identifier.test(namespace)) throw new ConfigError('RATE_LIMIT_NAMESPACE must match [A-Za-z0-9_-]{1,64}');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new ConfigError('LOG_LEVEL is not supported');
  }
  let redisUrl: string | undefined;
  if (store === 'redis') {
    try {
      const url = new URL(env.REDIS_URL ?? '');
      if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname) throw new Error();
      redisUrl = url.href;
    } catch {
      throw new ConfigError('REDIS_URL must be a valid redis:// or rediss:// URL in Redis mode');
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(env.CLIENTS_FILE ?? './config/clients.example.json'), 'utf8'));
  } catch {
    throw new ConfigError('CLIENTS_FILE must point to a readable, valid JSON file');
  }
  return Object.freeze({
    host, port, store, namespace, logLevel: logLevel as LogLevel,
    ...(redisUrl === undefined ? {} : { redisUrl }),
    clients: parseClients(raw),
  });
}
