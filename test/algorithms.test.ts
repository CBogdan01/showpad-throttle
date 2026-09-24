import { describe, expect, it } from 'vitest';
import { fixedWindow, tokenBucket } from '../src/rate-limit/algorithms.js';
import { MemoryStore } from '../src/rate-limit/memory-store.js';
import { StoreUnavailableError } from '../src/rate-limit/types.js';
import { scenarios } from './support/scenarios.js';

describe('memory algorithm conformance', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      let now = 0;
      const store = new MemoryStore(() => now);
      for (const step of scenario.steps) {
        now = step.now;
        expect(await store.consume({ key: 'client-route', ...scenario })).toEqual(step.decision);
      }
      await store.close();
    });
  }

  it.each(['fixed-window', 'token-bucket'] as const)('atomically admits 3 of 100 concurrent %s calls', async (algorithm) => {
    const store = new MemoryStore(() => 100000);
    const results = await Promise.all(Array.from({ length: 100 }, () => store.consume({
      key: 'shared', algorithm, policy: { limit: 3, periodMs: 10000 },
    })));
    expect(results.filter((result) => result.allowed)).toHaveLength(3);
    await store.close();
  });

  it('keeps callers state immutable and arithmetic safe at configured maxima', () => {
    const policy = { limit: 10000, periodMs: 86400000 };
    const previous = Object.freeze({ credits: 0, lastRefillMs: 100000 });
    const result = tokenBucket(previous, policy, 8000000000000);
    expect(result.state.credits).toBe(9999 * 86400000);
    expect(Number.isSafeInteger(result.state.credits)).toBe(true);
    expect(previous.credits).toBe(0);
    const state = Object.freeze({ count: 1, resetAtMs: 110000 });
    expect(fixedWindow(state, policy, 100000).state.count).toBe(2);
    expect(state.count).toBe(1);
  });

  it('fails after close and permits idempotent cleanup', async () => {
    const store = new MemoryStore();
    await store.close();
    await store.close();
    await expect(store.consume({ key: 'a', algorithm: 'fixed-window', policy: { limit: 1, periodMs: 1000 } }))
      .rejects.toBeInstanceOf(StoreUnavailableError);
  });
});
