import type { Decision, Policy } from './types.js';

export type FixedWindowState = Readonly<{ count: number; resetAtMs: number }>;
export type TokenBucketState = Readonly<{ credits: number; lastRefillMs: number }>;
type Transition<State> = Readonly<{ state: State; decision: Decision }>;

export function fixedWindow(
  previous: FixedWindowState | undefined,
  { limit, periodMs }: Policy,
  now: number,
): Transition<FixedWindowState> {
  const state = !previous || now >= previous.resetAtMs
    ? { count: 0, resetAtMs: now + periodMs }
    : previous;
  if (state.count >= limit) {
    return { state, decision: { allowed: false, retryAfterMs: state.resetAtMs - now } };
  }
  return {
    state: { ...state, count: state.count + 1 },
    decision: { allowed: true, retryAfterMs: 0 },
  };
}

export function tokenBucket(
  previous: TokenBucketState | undefined,
  { limit, periodMs }: Policy,
  now: number,
): Transition<TokenBucketState> {
  const capacity = limit * periodMs;
  const lastRefillMs = Math.max(now, previous?.lastRefillMs ?? now);
  // Cap elapsed before multiplication to preserve integer precision after long idle periods.
  const elapsed = Math.min(periodMs, lastRefillMs - (previous?.lastRefillMs ?? now));
  let credits = Math.min(capacity, (previous?.credits ?? capacity) + elapsed * limit);
  const allowed = credits >= periodMs;
  if (allowed) credits -= periodMs;
  const retryAfterMs = allowed ? 0
    : lastRefillMs - now + Math.ceil((periodMs - credits) / limit);
  return { state: { credits, lastRefillMs }, decision: { allowed, retryAfterMs } };
}
