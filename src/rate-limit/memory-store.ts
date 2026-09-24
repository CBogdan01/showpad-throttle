import { fixedWindow, tokenBucket } from './algorithms.js';
import type { FixedWindowState, TokenBucketState } from './algorithms.js';
import { StoreUnavailableError } from './types.js';
import type { ConsumeInput, Decision, RateLimitStore } from './types.js';

export class MemoryStore implements RateLimitStore {
  private readonly windows = new Map<string, FixedWindowState>();
  private readonly buckets = new Map<string, TokenBucketState>();
  private closed = false;

  constructor(private readonly now: () => number = Date.now) {}

  async consume({ key, algorithm, policy }: ConsumeInput): Promise<Decision> {
    if (this.closed) throw new StoreUnavailableError('not-ready');
    // No await between read, decide and write: atomic within this event loop.
    if (algorithm === 'fixed-window') {
      const result = fixedWindow(this.windows.get(key), policy, this.now());
      this.windows.set(key, result.state);
      return result.decision;
    }
    const result = tokenBucket(this.buckets.get(key), policy, this.now());
    this.buckets.set(key, result.state);
    return result.decision;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.windows.clear();
    this.buckets.clear();
  }
}
