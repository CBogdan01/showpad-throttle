import type { Client } from './config.js';

/** Raw headers preserve duplicates that Node's normalized header object may discard. */
export function authenticate(rawHeaders: readonly string[], clients: ReadonlyMap<string, Client>): Client | undefined {
  let header: string | undefined;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() !== 'authorization') continue;
    if (header !== undefined) return undefined;
    header = rawHeaders[i + 1];
  }
  if (header === undefined) return undefined;
  const match = /^Bearer +([A-Za-z0-9_-]{1,64})$/i.exec(header.replace(/^[ \t]+|[ \t]+$/g, ''));
  return match?.[1] === undefined ? undefined : clients.get(match[1]);
}
