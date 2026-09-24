// The PDF's HTTP example spells this "success"; page 1 contains "succes".
export const SUCCESS = Object.freeze({ success: true });
export const RATE_LIMITED = Object.freeze({ error: 'rate limit exceeded' });
export const UNAUTHORIZED = Object.freeze({ error: 'unauthorized' });
export const UNAVAILABLE = Object.freeze({ error: 'service unavailable' });
export const INTERNAL_ERROR = Object.freeze({ error: 'internal server error' });

export function retryAfterSeconds(milliseconds: number): string {
  return String(Math.max(1, Math.ceil(milliseconds / 1000)));
}
