import type { DIDManager } from '../did/DIDManager.js';
import { multikey } from '../crypto/Multikey.js';

/**
 * Builds a CEL key resolver from a DIDManager. Resolves the proof's
 * verificationMethod DID to a DID document, finds the matching verification
 * method, and returns its Ed25519 public key bytes (or null if unresolvable,
 * not Ed25519, or revoked/compromised — caller then fails closed).
 */
export function createDidManagerKeyResolver(didManager: DIDManager) {
  return async (verificationMethod: string): Promise<Uint8Array | null> => {
    try {
      const did = verificationMethod.split('#')[0];
      const doc = await didManager.resolveDID(did);
      const vms = doc?.verificationMethod;
      if (!Array.isArray(vms)) return null;
      const vm =
        vms.find(v => v.id === verificationMethod) ??
        vms.find(v => v.id.split('#')[1] === verificationMethod.split('#')[1]);
      if (!vm?.publicKeyMultibase) return null;
      // Fail closed on retired keys: a verification method that has been
      // revoked (rotated out) or marked compromised must never resolve as a
      // valid signing key, otherwise an attacker holding the old private key
      // could forge accepted CEL signatures.
      if (vm.revoked || vm.compromised) return null;
      const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
      return decoded.type === 'Ed25519' ? decoded.key : null;
    } catch {
      return null;
    }
  };
}
