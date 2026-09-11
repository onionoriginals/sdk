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
