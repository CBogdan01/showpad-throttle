import type { AppConfig } from '../config.js';
import { MemoryStore } from './memory-store.js';
import { RedisStore, connectRedis, createRedisClient } from './redis-store.js';
import type { RateLimitStore } from './types.js';

export async function createStore(config: AppConfig, onRedisError: () => void = () => {}): Promise<RateLimitStore> {
  if (config.store === 'memory') return new MemoryStore();
  // loadConfig guarantees the URL for Redis mode; this also protects programmatic callers.
  if (!config.redisUrl) throw new Error('Redis mode requires a configured URL');
  const client = createRedisClient(config.redisUrl, onRedisError);
  await connectRedis(client);
  return new RedisStore(client);
}
