import type { VerifiableCredential } from '../types/index.js';
import type { CredentialStatus } from '../types/credentials.js';

/**
 * Normalize a credential's `credentialStatus` to an array.
 *
 * VCDM 2.0 permits `credentialStatus` to be either a single object or an
 * array of objects (https://www.w3.org/TR/vc-data-model-2.0/#status), for a
 * credential that declares more than one status mechanism (e.g. separate
 * revocation and suspension entries). Reading only the singleton shape let an
 * array-shaped `credentialStatus` skip revocation/suspension checking
 * entirely — every entry it declares must go through the same evaluation, so
 * every status-checking path normalizes through this helper rather than
 * casting `credentialStatus` to a singleton itself (issue #592).
 */
export function credentialStatusEntries(vc: VerifiableCredential): CredentialStatus[] {
  const status = vc.credentialStatus;
  if (!status) return [];
  return Array.isArray(status) ? status : [status];
}

/**
 * Type guard for a well-formed `credentialStatus` entry. `credentialStatus`
 * (and each element of it, when array-shaped) comes from the credential being
 * verified — untrusted input. An element that isn't an object, or has no
 * string `type`, must not reach `.type`/`.statusListCredential` property
 * access in the status-checking paths: reading a property off `null` throws,
 * which would let one malformed array entry crash verification instead of
 * failing the credential closed like every other unevaluable entry does.
 */
export function isCredentialStatusEntry(value: unknown): value is CredentialStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** JSON.stringify for an error message, safe against non-serializable (e.g. circular) untrusted input. */
export function describeMalformedStatusEntry(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
