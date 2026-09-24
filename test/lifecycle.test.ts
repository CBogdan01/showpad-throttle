import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from '../src/lifecycle/deadline.js';
import { RedisStore, parseDecision } from '../src/rate-limit/redis-store.js';
import type { RedisConnection } from '../src/rate-limit/redis-store.js';
import { StoreUnavailableError } from '../src/rate-limit/types.js';

afterEach(() => vi.useRealTimers());

describe('bounded operations', () => {
  it('times out, aborts, disposes once, and handles later rejection', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    let signal: AbortSignal | undefined;
    let rejectOperation: (error: Error) => void = () => {};
    const pending = withDeadline((value) => {
      signal = value;
      return new Promise((_resolve, reject) => { rejectOperation = reject; });
    }, 1000, dispose);
    const assertion = expect(pending).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    rejectOperation(new Error('late network failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a successful operation', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    expect(await withDeadline(async () => 42, 1000, dispose)).toBe(42);
    await vi.advanceTimersByTimeAsync(2000);
    expect(dispose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Redis response boundary', () => {
  it.each([null, {}, [], [1], [1, 0, 0], [true, 0], [0, 0], [0, -1], [1, 2], [0, 1.1], ['1', 0]])(
    'rejects malformed response %j', (value) => {
      expect(() => parseDecision(value)).toThrow(StoreUnavailableError);
    },
  );
  it('accepts only consistent integer decisions', () => {
    expect(parseDecision([1, 0])).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(parseDecision([0, 1])).toEqual({ allowed: false, retryAfterMs: 1 });
  });
});

describe('Redis adapter failure policy', () => {
  it('disposes a stalled connection, does not retry, and rejects later requests', async () => {
    vi.useFakeTimers();
    let open = true;
    const evaluate = vi.fn(() => new Promise<never>(() => {}));
    const destroy = vi.fn(() => { open = false; });
    const client = {
      get isReady() { return open; },
      get isOpen() { return open; },
      withCommandOptions: () => ({ eval: evaluate }),
      destroy,
    } as unknown as RedisConnection;
    const store = new RedisStore(client);
    const input = { key: 'stalled', algorithm: 'fixed-window' as const, policy: { limit: 3, periodMs: 10000 } };
    const assertion = expect(store.consume(input)).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(destroy).toHaveBeenCalledTimes(1);
    await expect(store.consume(input)).rejects.toMatchObject({ reason: 'not-ready' });
    expect(evaluate).toHaveBeenCalledTimes(1);
    await store.close();
    await store.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
