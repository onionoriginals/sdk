/**
 * Retry helper with exponential backoff for handling transient errors
 * Useful for Google Drive API rate limits and network errors
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: any) => boolean;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  shouldRetry: (error: any) => {
    // Retry on rate limits, network errors, and temporary Google API errors
    const errorCode = error?.code;
    const errorMessage = error?.message?.toLowerCase() || '';

    return (
      errorCode === 429 || // Rate limit
      errorCode === 503 || // Service unavailable
      errorCode === 500 || // Internal server error
      errorCode === 'ECONNRESET' ||
      errorCode === 'ETIMEDOUT' ||
      errorCode === 'ENOTFOUND' ||
      errorMessage.includes('rate limit') ||
      errorMessage.includes('quota exceeded') ||
      errorMessage.includes('network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('econnreset')
    );
  },
};

/**
 * Execute a function with exponential backoff retry logic
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;
  let delay = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // Check if we should retry this error
      if (!opts.shouldRetry(error)) {
        throw error;
      }

      // Check if we've exhausted retries
      if (attempt >= opts.maxRetries) {
        throw error;
      }

      // Log retry attempt
      console.log(
        `[RetryHelper] Attempt ${attempt + 1}/${opts.maxRetries + 1} failed: ${error.message}. Retrying in ${delay}ms...`
      );

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));

      // Exponential backoff
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError;
}

/**
 * Rate limiter to prevent exceeding API quotas
 */
export class RateLimiter {
  private queue: Array<() => void> = [];
  private activeCount = 0;

  constructor(
    private maxConcurrent: number,
    private minDelayMs: number = 0
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Wait for an available slot
    await this.waitForSlot();

    this.activeCount++;
    let lastExecutionTime = Date.now();

    try {
      const result = await fn();

      // Enforce minimum delay between requests
      if (this.minDelayMs > 0) {
        const elapsed = Date.now() - lastExecutionTime;
        const remaining = this.minDelayMs - elapsed;
        if (remaining > 0) {
          await new Promise(resolve => setTimeout(resolve, remaining));
        }
      }

      return result;
    } finally {
      this.activeCount--;
      this.processQueue();
    }
  }

  private async waitForSlot(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      return;
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  private processQueue(): void {
    if (this.queue.length > 0 && this.activeCount < this.maxConcurrent) {
      const resolve = this.queue.shift()!;
      resolve();
    }
  }

  getStats() {
    return {
      activeCount: this.activeCount,
      queueLength: this.queue.length,
    };
  }
}
