export interface CircuitBreakerOptions {
  failureThreshold?: number; // failures within window to open circuit
  successThreshold?: number; // successes in half-open to close circuit
  timeoutMs?: number; // open duration before half-open
}

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: State = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private nextAttemptTime = 0;

  constructor(private readonly options: CircuitBreakerOptions = {}) {}

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const failureThreshold = this.options.failureThreshold ?? 5;
    const successThreshold = this.options.successThreshold ?? 2;
    const timeoutMs = this.options.timeoutMs ?? 10_000;

    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now < this.nextAttemptTime) {
        throw new Error('CircuitBreakerOpen');
      }
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.onSuccess(successThreshold);
      return result;
    } catch (err) {
      this.onFailure(failureThreshold, timeoutMs);
      throw err;
    }
  }

  private onSuccess(successThreshold: number) {
    if (this.state === 'HALF_OPEN') {
      this.successes += 1;
      if (this.successes >= successThreshold) {
        this.state = 'CLOSED';
        this.successes = 0;
        this.failures = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(failureThreshold: number, timeoutMs: number) {
    this.failures += 1;
    if (this.failures >= failureThreshold) {
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + timeoutMs;
      this.successes = 0;
    }
  }
}

