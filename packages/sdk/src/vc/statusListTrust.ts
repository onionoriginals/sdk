import type { VerifiableCredential, BitstringStatusListEntry } from '../types/index.js';

/** Extract the issuer DID from a credential's string-or-object issuer field. */
export function issuerOf(c: VerifiableCredential): string | undefined {
  return typeof c.issuer === 'string' ? c.issuer : (c.issuer as { id?: string } | undefined)?.id;
}

export type StatusListTrustResult = { verified: boolean; errors: string[] };

/**
 * Trust checks for a resolved status list credential (issue #238), shared by
 * every status-checking path (Verifier.checkCredentialStatus and
 * CredentialManager.verifyCredentialWithStatus) so the checks cannot drift
 * between entry points (issue #301):
 *
 * 1. the list's `id` must equal the entry's `statusListCredential` URL (any
 *    list with a matching statusPurpose would otherwise be accepted),
 * 2. the list's own proof must verify (an entirely unsigned list must not
 *    decide revocation) — proof verification is delegated to the caller via
 *    `verifyListProof` since each entry point verifies with its own machinery,
 * 3. the list's issuer must equal the issuer of the credential being checked —
 *    revocation authority lies with the credential's issuer. (Deliberately
 *    stricter than the W3C Bitstring Status List spec, which permits delegated
 *    status services.)
 */
export async function validateStatusListCredentialTrust(
  vc: VerifiableCredential,
  entry: BitstringStatusListEntry,
  statusListVC: VerifiableCredential,
  verifyListProof: (listVC: VerifiableCredential) => Promise<StatusListTrustResult>
): Promise<StatusListTrustResult> {
  if (!statusListVC.id || statusListVC.id !== entry.statusListCredential) {
    return {
      verified: false,
      errors: [
        `Status list credential id (${String(statusListVC.id)}) does not match the credential's ` +
        `statusListCredential reference (${entry.statusListCredential})`
      ]
    };
  }

  const proofResult = await verifyListProof(statusListVC);
  if (!proofResult.verified) {
    return {
      verified: false,
      errors: ['Status list credential proof verification failed', ...proofResult.errors]
    };
  }

  const credentialIssuer = issuerOf(vc);
  const listIssuer = issuerOf(statusListVC);
  if (!credentialIssuer || !listIssuer || credentialIssuer !== listIssuer) {
    return {
      verified: false,
      errors: [
        `Status list credential issuer (${String(listIssuer)}) does not match the ` +
        `checked credential's issuer (${String(credentialIssuer)})`
      ]
    };
  }

  return { verified: true, errors: [] };
}
