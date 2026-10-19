import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { CircuitBreaker, withCircuitBreaker } from '../../../src/utils/circuit-breaker';
import { StructuredError } from '../../../src/utils/telemetry';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
  });

  test('starts in CLOSED state', () => {
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  test('stays CLOSED on successful calls', async () => {
    await breaker.execute(() => Promise.resolve('ok'));
    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);
  });

  test('stays CLOSED below failure threshold', async () => {
    for (let i = 0; i < 2; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(2);
  });

  test('transitions to OPEN after reaching failure threshold', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.getFailureCount()).toBe(3);
  });

  test('rejects calls immediately when OPEN', async () => {
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    try {
      await breaker.execute(() => Promise.resolve('should not run'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).code).toBe('CIRCUIT_OPEN');
    }
  });

  test('transitions to HALF_OPEN after reset timeout', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(breaker.getState()).toBe('OPEN');

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 120));

    // Next call should attempt (HALF_OPEN) and succeed
    await breaker.execute(() => Promise.resolve('recovered'));
    expect(breaker.getState()).toBe('CLOSED');
  });

  test('returns to OPEN from HALF_OPEN on failure', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    await new Promise(r => setTimeout(r, 120));

    // Fail in HALF_OPEN
    await breaker.execute(() => Promise.reject(new Error('still broken'))).catch(() => {});
    expect(breaker.getState()).toBe('OPEN');
  });

  test('resets failure count on success', async () => {
    await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    expect(breaker.getFailureCount()).toBe(2);

    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.getFailureCount()).toBe(0);
    expect(breaker.getState()).toBe('CLOSED');
  });

  test('reset() restores CLOSED state', async () => {
    for (let i = 0; i < 3; i++) {
      await breaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.getFailureCount()).toBe(0);

    // Should work again
    const result = await breaker.execute(() => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  test('calls onStateChange callback on transitions', async () => {
    const transitions: Array<[string, string]> = [];
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 50,
      onStateChange: (from, to) => transitions.push([from, to]),
    });

    // Trip to OPEN
    await cb.execute(() => Promise.reject(new Error('1'))).catch(() => {});
    await cb.execute(() => Promise.reject(new Error('2'))).catch(() => {});
    expect(transitions).toEqual([['CLOSED', 'OPEN']]);

    // Wait, then recover -> HALF_OPEN -> CLOSED
    await new Promise(r => setTimeout(r, 70));
    await cb.execute(() => Promise.resolve('ok'));
    expect(transitions).toEqual([
      ['CLOSED', 'OPEN'],
      ['OPEN', 'HALF_OPEN'],
      ['HALF_OPEN', 'CLOSED'],
    ]);
  });

  test('uses default options (5 failures, 60s timeout)', async () => {
    const defaultBreaker = new CircuitBreaker();
    for (let i = 0; i < 4; i++) {
      await defaultBreaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(defaultBreaker.getState()).toBe('CLOSED');

    await defaultBreaker.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    expect(defaultBreaker.getState()).toBe('OPEN');
  });

  test('propagates the original error on failure', async () => {
    const original = new Error('specific provider error');
    try {
      await breaker.execute(() => Promise.reject(original));
    } catch (err) {
      expect(err).toBe(original);
    }
  });

  test('returns the value from successful execution', async () => {
    const result = await breaker.execute(() => Promise.resolve({ data: 42 }));
    expect(result).toEqual({ data: 42 });
  });
});

describe('withCircuitBreaker', () => {
  test('wraps object methods with circuit breaker', async () => {
    const provider = {
      getData: async () => 'result',
      name: 'test-provider',
    };

    const wrapped = withCircuitBreaker(provider, { failureThreshold: 2, resetTimeoutMs: 50 });
    expect(await wrapped.getData()).toBe('result');
    expect(wrapped.name).toBe('test-provider');
    expect(wrapped.circuitBreaker).toBeInstanceOf(CircuitBreaker);
    expect(wrapped.circuitBreaker.getState()).toBe('CLOSED');
  });

  test('opens circuit after failures through proxy', async () => {
    let callCount = 0;
    const provider = {
      failingMethod: async () => {
        callCount++;
        throw new Error('provider down');
      },
    };

    const wrapped = withCircuitBreaker(provider, { failureThreshold: 2, resetTimeoutMs: 1000 });

    await wrapped.failingMethod().catch(() => {});
    await wrapped.failingMethod().catch(() => {});
    expect(wrapped.circuitBreaker.getState()).toBe('OPEN');
    expect(callCount).toBe(2);

    // Next call should be rejected by circuit breaker without calling provider
    try {
      await wrapped.failingMethod();
    } catch (err) {
      expect((err as StructuredError).code).toBe('CIRCUIT_OPEN');
    }
    expect(callCount).toBe(2); // not incremented
  });

  test('shares circuit breaker across all methods', async () => {
    const provider = {
      methodA: async () => { throw new Error('fail'); },
      methodB: async () => { throw new Error('fail'); },
    };

    const wrapped = withCircuitBreaker(provider, { failureThreshold: 3, resetTimeoutMs: 1000 });

    await wrapped.methodA().catch(() => {});
    await wrapped.methodB().catch(() => {});
    await wrapped.methodA().catch(() => {});

    expect(wrapped.circuitBreaker.getState()).toBe('OPEN');
  });

  test('recovers when provider starts working again', async () => {
    let shouldFail = true;
    const provider = {
      query: async () => {
        if (shouldFail) throw new Error('down');
        return 'ok';
      },
    };

    const wrapped = withCircuitBreaker(provider, { failureThreshold: 2, resetTimeoutMs: 50 });

    await wrapped.query().catch(() => {});
    await wrapped.query().catch(() => {});
    expect(wrapped.circuitBreaker.getState()).toBe('OPEN');

    // Fix the provider and wait
    shouldFail = false;
    await new Promise(r => setTimeout(r, 70));

    const result = await wrapped.query();
    expect(result).toBe('ok');
    expect(wrapped.circuitBreaker.getState()).toBe('CLOSED');
  });
});
