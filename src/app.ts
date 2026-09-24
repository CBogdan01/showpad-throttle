import Fastify, { LogController } from 'fastify';
import type { FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config.js';
import { registerRoutes } from './http/routes.js';
import { INTERNAL_ERROR, UNAVAILABLE } from './http/responses.js';
import { StoreUnavailableError } from './rate-limit/types.js';
import type { RateLimitStore } from './rate-limit/types.js';

export function buildApp({ config, store, logger }: {
  config: AppConfig;
  store: RateLimitStore;
  logger?: FastifyServerOptions['logger'];
}) {
  const app = Fastify({
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'headers.authorization', 'redisUrl'],
    },
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    exposeHeadRoutes: false,
    bodyLimit: 1024,
    requestTimeout: 10000,
    connectionTimeout: 10000,
    keepAliveTimeout: 5000,
    forceCloseConnections: 'idle',
  });
  app.addHook('onClose', async () => store.close());
  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      event: 'request_completed', method: request.method,
      route: request.routeOptions.url ?? 'unmatched', status: reply.statusCode,
      durationMs: reply.elapsedTime, store: config.store,
    });
  });
  app.setErrorHandler((error, request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (error instanceof StoreUnavailableError) {
      request.log.warn({ event: 'storage_unavailable', reason: error.reason });
      return reply.code(503).send(UNAVAILABLE);
    }
    // Preserve framework HTTP errors (e.g. 413) without leaking their messages.
    const status = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'invalid request' });
    }
    request.log.error({ event: 'internal_error' });
    return reply.code(500).send(INTERNAL_ERROR);
  });
  registerRoutes(app, config, store);
  return app;
}
