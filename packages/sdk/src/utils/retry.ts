export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitterFactor?: number; // 0..1
  isRetriable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const DEFAULTS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 300,
  maxDelayMs: 10_000,
  backoffFactor: 2,
  jitterFactor: 0.1,
  isRetriable: () => true,
  onRetry: () => {}
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function computeDelay(attempt: number, opts: Required<RetryOptions>): number {
  const exp = opts.baseDelayMs * Math.pow(opts.backoffFactor, attempt);
  const withJitter = exp + ((Math.random() * 2 - 1) * opts.jitterFactor * exp);
  return Math.min(Math.max(0, Math.floor(withJitter)), opts.maxDelayMs);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts: Required<RetryOptions> = { ...DEFAULTS, ...options as Partial<Required<RetryOptions>> };
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= opts.maxRetries || !opts.isRetriable(err)) break;
      const delay = computeDelay(attempt, opts);
      opts.onRetry(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
  throw lastError;
}