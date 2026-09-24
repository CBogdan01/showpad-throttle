import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import { authenticate } from '../auth.js';
import { counterKey } from '../rate-limit/keys.js';
import type { Algorithm, RateLimitStore, Route } from '../rate-limit/types.js';
import { RATE_LIMITED, SUCCESS, UNAUTHORIZED, retryAfterSeconds } from './responses.js';

export const ROUTES: ReadonlyArray<Readonly<{ name: Route; algorithm: Algorithm }>> = Object.freeze([
  { name: 'foo', algorithm: 'fixed-window' },
  { name: 'bar', algorithm: 'token-bucket' },
]);

export function registerRoutes(app: FastifyInstance, config: AppConfig, store: RateLimitStore): void {
  for (const { name, algorithm } of ROUTES) {
    app.get(`/${name}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const client = authenticate(request.raw.rawHeaders, config.clients);
      if (!client) return reply.code(401).header('WWW-Authenticate', 'Bearer').send(UNAUTHORIZED);
      const policy = client[name];
      const decision = await store.consume({
        key: counterKey(config.namespace, name, client.id, policy), algorithm, policy,
      });
      if (!decision.allowed) {
        return reply.code(429).header('Retry-After', retryAfterSeconds(decision.retryAfterMs)).send(RATE_LIMITED);
      }
      return reply.code(200).send(SUCCESS);
    });
  }
}
