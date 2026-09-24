import type { Algorithm, Decision, Policy } from '../../src/rate-limit/types.js';

export type Step = Readonly<{ now: number; decision: Decision }>;
export type Scenario = Readonly<{ name: string; algorithm: Algorithm; policy: Policy; steps: Step[] }>;
const allow = (now: number): Step => ({ now, decision: { allowed: true, retryAfterMs: 0 } });
const deny = (now: number, retryAfterMs: number): Step => ({ now, decision: { allowed: false, retryAfterMs } });
const policy = { limit: 3, periodMs: 10000 };
const drain = () => [allow(100000), allow(100000), allow(100000)];

export const scenarios: Scenario[] = [
  {
    name: 'fixed boundary and repeated rejection', algorithm: 'fixed-window', policy,
    steps: [...drain(), deny(100000, 10000), deny(105000, 5000), deny(109999, 1),
      allow(110000), allow(110000), allow(110000), deny(110000, 10000)],
  },
  {
    name: 'fixed backward time does not reset quota', algorithm: 'fixed-window', policy,
    steps: [...drain(), deny(99900, 10100), deny(100000, 10000), allow(120000)],
  },
  {
    name: 'token fractions survive repeated denied checks', algorithm: 'token-bucket', policy,
    steps: [...drain(), deny(100000, 3334), deny(101000, 2334), deny(102000, 1334),
      deny(103000, 334), deny(103333, 1), allow(103334), deny(103334, 3333),
      allow(106667), allow(110000), deny(110000, 3334)],
  },
  {
    name: 'token backward time preserves timestamp and credits', algorithm: 'token-bucket', policy,
    steps: [...drain(), deny(99900, 3434), deny(100000, 3334), deny(103333, 1), allow(103334)],
  },
  ...(['fixed-window', 'token-bucket'] as const).map((algorithm): Scenario => ({
    name: `${algorithm} caps long idle to one full allowance`, algorithm, policy,
    steps: [...drain(), allow(1000000000000), allow(1000000000000), allow(1000000000000),
      deny(1000000000000, algorithm === 'fixed-window' ? 10000 : 3334)],
  })),
  ...(['fixed-window', 'token-bucket'] as const).map((algorithm): Scenario => ({
    name: `${algorithm} smallest policy`, algorithm, policy: { limit: 1, periodMs: 1000 },
    steps: [allow(100000), deny(100000, 1000), deny(100999, 1), allow(101000)],
  })),
];
