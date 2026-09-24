export type Algorithm = 'fixed-window' | 'token-bucket';
export type Route = 'foo' | 'bar';
export type Policy = Readonly<{ limit: number; periodMs: number }>;
export type Decision = Readonly<{ allowed: boolean; retryAfterMs: number }>;
export type ConsumeInput = Readonly<{
  key: string;
  algorithm: Algorithm;
  policy: Policy;
}>;

/** Implementations must make the complete admission decision atomically. */
export interface RateLimitStore {
  consume(input: ConsumeInput): Promise<Decision>;
  close(): Promise<void>;
}

export class StoreUnavailableError extends Error {
  constructor(public readonly reason: 'not-ready' | 'timeout' | 'command' | 'invalid-response') {
    super('Rate-limit storage is unavailable');
    this.name = 'StoreUnavailableError';
  }
}
