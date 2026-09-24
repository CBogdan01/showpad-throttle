import { parseClients } from '../../src/config.js';
import type { AppConfig } from '../../src/config.js';

export function clientDocument(periodMs = 10000) {
  return {
    clients: [3, 6].map((limit, index) => ({
      id: `client-${index + 1}`,
      foo: { limit, periodMs },
      bar: { limit, periodMs },
    })),
  };
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1', port: 3000, store: 'memory', namespace: 'test',
    logLevel: 'silent', clients: parseClients(clientDocument()), ...overrides,
  };
}
