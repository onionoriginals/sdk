import { StructuredError } from './telemetry.js';

/**
 * A process-local, non-reentrant, keyed mutex. A single shared instance is
 * threaded through OriginalsConfig so LifecycleManager, MigrationManager and
 * BitcoinManager coordinate on ONE lock instead of each keeping its own
 * per-instance in-flight Set (issue #303). Keyed by the canonical DID and
 * claimed at the money-spending point (BitcoinManager.inscribeData), a second
 * concurrent inscription of the same DID cannot double-pay regardless of which
 * manager initiates it.
 *
 * Semantics are try-lock / reject-immediately (not queueing): a second holder
 * is rejected rather than serialized, because serializing would let the loser
 * broadcast a duplicate paid inscription once the winner released.
 */
export class OperationLock {
  private readonly held = new Set<string>();

  isLocked(key: string): boolean {
    return this.held.has(key);
  }

  /** Claim `key`. Returns false (without blocking) when already held. */
  tryAcquire(key: string): boolean {
    if (this.held.has(key)) return false;
    this.held.add(key);
    return true;
  }

  release(key: string): void {
    this.held.delete(key);
  }

  /**
   * Run `fn` while holding `key` exclusively; reject immediately with
   * OPERATION_IN_PROGRESS if the key is already held.
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.tryAcquire(key)) {
      throw new StructuredError(
        'OPERATION_IN_PROGRESS',
        `A money-spending Bitcoin operation for ${key} is already in progress; ` +
        'a second concurrent inscription of the same DID would double-pay for a duplicate inscription.'
      );
    }
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }
}
