export interface RetryOptions {
  retries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  jitter?: boolean;
}

export class RetryError extends Error {
  public readonly cause: unknown;
  public readonly attempts: number;
  constructor(message: string, cause: unknown, attempts: number) {
    super(message);
    this.name = 'RetryError';
    this.cause = cause;
    this.attempts = attempts;
  }
}

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    retries = 3,
    initialDelayMs = 100,
    maxDelayMs = 5_000,
    backoffFactor = 2,
    shouldRetry = () => true,
    jitter = true
  } = options;

  let attempt = 0;
  let delay = initialDelayMs;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error, attempt)) {
        break;
      }
      await sleep(jitter ? addJitter(delay) : delay);
      delay = Math.min(maxDelayMs, delay * backoffFactor);
      attempt += 1;
    }
  }

  throw new RetryError('Operation failed after retries', lastError, attempt + 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addJitter(ms: number): number {
  const half = ms / 2;
  return Math.floor(half + Math.random() * half);
}

