import { VerifiableCredential } from '../types/index.js';
import { validateDID } from '@originals/cel';

// DID validation and resource hashing moved to @originals/cel with the CEL
// core; re-exported so the SDK surface and existing import sites are unchanged.
export { validateDID, validateDIDDocument, hashResource } from '@originals/cel';

export function validateCredential(vc: VerifiableCredential): boolean {
  // Validate VC structure according to W3C VC spec
  if (!vc['@context'] || !Array.isArray(vc['@context'])) {
    return false;
  }

  // Require the W3C VCDM 2.0 credentials context. The SDK standardizes on
  // VCDM 2.0 and no longer accepts the 1.1 (`2018/credentials/v1`) context
  // (issue #300). A credential presenting only the 1.1 context is rejected.
  const contextValues = vc['@context'];
  const hasVcV2 = contextValues.includes('https://www.w3.org/ns/credentials/v2');
  if (!hasVcV2) {
    return false;
  }

  if (!vc.type || !Array.isArray(vc.type)) {
    return false;
  }

  if (!vc.type.includes('VerifiableCredential')) {
    return false;
  }

  // VC 2.0 uses validFrom; still accept a legacy issuanceDate when reading
  // previously-issued credentials.
  const issuanceTimestamp =
    (vc as { validFrom?: unknown }).validFrom ?? vc.issuanceDate;
  if (!vc.issuer || issuanceTimestamp === undefined) {
    return false;
  }

  // issuer must be a DID string or an object with DID id
  const issuerIsValidDid = (iss: unknown): boolean => {
    if (typeof iss === 'string') return validateDID(iss);
    if (iss && typeof iss === 'object' && 'id' in iss) {
      const issObj = iss;
      if (typeof issObj.id === 'string') return validateDID(issObj.id);
    }
    return false;
  };
  if (!issuerIsValidDid(vc.issuer)) {
    return false;
  }

  // issuanceDate / validFrom should be a valid ISO timestamp
  if (typeof issuanceTimestamp !== 'string' || Number.isNaN(Date.parse(issuanceTimestamp))) {
    return false;
  }

  if (!vc.credentialSubject) {
    return false;
  }

  return true;
}
