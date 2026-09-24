import { createClient } from 'redis';
import { withDeadline } from '../lifecycle/deadline.js';
import { REDIS_SCRIPTS } from './redis-scripts.js';
import { StoreUnavailableError } from './types.js';
import type { ConsumeInput, Decision, RateLimitStore } from './types.js';

export type RedisConnection = ReturnType<typeof createClient>;
type LogFailure = () => void;

export function createRedisClient(url: string, onError: LogFailure = () => {}): RedisConnection {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: { connectTimeout: 3000, reconnectStrategy: false },
  });
  // Never forward a connection error's message: it may contain credentials or host details.
  client.on('error', onError);
  return client;
}

export async function connectRedis(client: RedisConnection): Promise<void> {
  try {
    await withDeadline(async (signal) => {
      await client.connect();
      await client.withCommandOptions({ abortSignal: signal }).ping();
    }, 3000, () => { if (client.isOpen) client.destroy(); });
  } catch (error) {
    if (client.isOpen) client.destroy();
    throw error instanceof StoreUnavailableError ? error : new StoreUnavailableError('command');
  }
}

export function parseDecision(value: unknown): Decision {
  if (!Array.isArray(value) || value.length !== 2) throw new StoreUnavailableError('invalid-response');
  const [flag, retry] = value as unknown[];
  if ((flag !== 0 && flag !== 1) || typeof retry !== 'number' || !Number.isSafeInteger(retry)
      || (flag === 1 ? retry !== 0 : retry <= 0)) {
    throw new StoreUnavailableError('invalid-response');
  }
  return { allowed: flag === 1, retryAfterMs: retry };
}

export class RedisStore implements RateLimitStore {
  private unavailable = false;

  constructor(private readonly client: RedisConnection) {}

  async consume({ key, algorithm, policy }: ConsumeInput): Promise<Decision> {
    if (this.unavailable || !this.client.isReady) throw new StoreUnavailableError('not-ready');
    let result: unknown;
    try {
      result = await withDeadline(
        (signal) => this.client.withCommandOptions({ abortSignal: signal }).eval(REDIS_SCRIPTS[algorithm], {
          keys: [key], arguments: [String(policy.limit), String(policy.periodMs)],
        }),
        1000,
        () => this.destroy(),
      );
    } catch (error) {
      throw error instanceof StoreUnavailableError ? error : new StoreUnavailableError('command');
    }
    return parseDecision(result);
  }

  private destroy(): void {
    this.unavailable = true;
    if (this.client.isOpen) this.client.destroy();
  }

  async close(): Promise<void> {
    if (this.unavailable) return;
    this.unavailable = true;
    if (!this.client.isOpen) return;
    try {
      await withDeadline(() => this.client.close(), 1000, () => this.destroy());
    } catch {
      this.destroy();
    }
  }
}
