import type { Policy, Route } from './types.js';

/** Every part comes from validated startup configuration, never the raw URL. */
export function counterKey(namespace: string, route: Route, clientId: string, policy: Policy): string {
  return `throttle:v1:${namespace}:${route}:${clientId}:${policy.limit}:${policy.periodMs}`;
}
