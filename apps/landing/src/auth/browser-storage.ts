/**
 * localStorage, or null when the browser denies it (private mode, storage
 * disabled, sandboxed iframe). Every caller here treats null as "no persistence
 * available" rather than an error, so a hostile storage environment degrades to
 * a session that simply does not survive a reload.
 *
 * Shared because both the Turnkey session metadata and the authorship key need
 * the same guard, and a divergence between them would be silent.
 */
export function browserKeyStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
