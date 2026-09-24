import { StoreUnavailableError } from '../rate-limit/types.js';

/** Aborting does not undo remote writes; onTimeout must dispose of the stuck resource. */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  onTimeout: () => void,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Publish the timeout before aborting pending I/O, whose rejection can be immediate.
      reject(new StoreUnavailableError('timeout'));
      controller.abort();
      onTimeout();
    }, milliseconds);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), expiry]);
  } finally {
    clearTimeout(timer);
  }
}
