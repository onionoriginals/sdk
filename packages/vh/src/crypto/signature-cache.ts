/**
 * The store behind `checkSignature`'s cache. Internal: not in the package's
 * exports map. `@originals/vh/crypto` exposes only the bounds and
 * `clearSignatureCache`; tests import this module directly to see which
 * checks are held, in which order.
 */

/** Checked signatures by `${key type}:${hex key}:${hex data}:${hex signature}`, oldest first. */
const checks = new Map<string, boolean>();

export function lookup(id: string): boolean | undefined {
  return checks.get(id);
}

/** Keep a result, first dropping the oldest when `capacity` are held. */
export function remember(id: string, ok: boolean, capacity: number): void {
  if (checks.size >= capacity) checks.delete(checks.keys().next().value!);
  checks.set(id, ok);
}

export function clear(): void {
  checks.clear();
}

/** The cached checks' ids, oldest first. For tests. */
export function heldIds(): string[] {
  return [...checks.keys()];
}
