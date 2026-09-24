import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createStore } from './rate-limit/create-store.js';
import { StoreUnavailableError } from './rate-limit/types.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const store = await createStore(config, () => {
    process.stderr.write(JSON.stringify({ level: 'error', event: 'redis_connection_error' }) + '\n');
  });
  let app: ReturnType<typeof buildApp>;
  try {
    app = buildApp({ config, store });
  } catch (error) {
    await store.close();
    throw error;
  }
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    app.log.info({ event: 'shutdown_started' });
    const timer = setTimeout(() => {
      app.log.error({ event: 'shutdown_deadline_exceeded' });
      app.server.closeAllConnections();
      process.exit(1);
    }, 5000);
    timer.unref();
    try {
      await app.close();
    } catch {
      app.log.error({ event: 'shutdown_failed' });
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message
    : error instanceof StoreUnavailableError ? 'Redis startup failed; check availability and credentials'
    : 'Application startup failed; check the configured address and port';
  process.stderr.write(JSON.stringify({ level: 'error', event: 'startup_failed', message }) + '\n');
  process.exitCode = 1;
});
