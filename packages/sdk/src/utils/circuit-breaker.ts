import { StructuredError } from './telemetry';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms to wait before transitioning from OPEN to HALF_OPEN (default: 60000) */
  resetTimeoutMs?: number;
  /** Callback on state transitions */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

const DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
} as const;

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULTS.failureThreshold;
    this.resetTimeoutMs = options.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs;
    this.onStateChange = options.onStateChange;
  }

  /** Current circuit state */
  getState(): CircuitState {
    return this.state;
  }

  /** Number of consecutive failures recorded */
  getFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CIRCUIT_OPEN if the circuit is open and the reset timeout hasn't elapsed.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.transition('HALF_OPEN');
      } else {
        throw new StructuredError(
          'CIRCUIT_OPEN',
          'Circuit breaker is open — the upstream provider has failed repeatedly. ' +
          'Requests are being rejected to prevent cascading failures. ' +
          `The circuit will attempt recovery after ${this.resetTimeoutMs}ms.`,
          {
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
            resetTimeoutMs: this.resetTimeoutMs,
            msSinceLastFailure: Date.now() - this.lastFailureTime,
          }
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /** Reset the circuit breaker to CLOSED state */
  reset(): void {
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    if (this.state !== 'CLOSED') {
      this.transition('CLOSED');
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'HALF_OPEN') {
      this.transition('CLOSED');
    }
  }

  private onFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      // Any failure in HALF_OPEN goes back to OPEN
      this.transition('OPEN');
    } else if (this.state === 'CLOSED' && this.consecutiveFailures >= this.failureThreshold) {
      this.transition('OPEN');
    }
  }

  private transition(to: CircuitState): void {
    const from = this.state;
    this.state = to;
    this.onStateChange?.(from, to);
  }
}

/**
 * Wrap an OrdinalsProvider (or any object) so that every method call
 * goes through a shared CircuitBreaker instance.
 */
export function withCircuitBreaker<T extends object>(
  target: T,
  options?: CircuitBreakerOptions
): T & { readonly circuitBreaker: CircuitBreaker } {
  const breaker = new CircuitBreaker(options);

  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'circuitBreaker') return breaker;
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => breaker.execute(() => value.apply(obj, args));
    },
  });

  return proxy as T & { readonly circuitBreaker: CircuitBreaker };
}
