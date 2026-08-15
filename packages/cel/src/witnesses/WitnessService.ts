/**
 * WitnessService Interface
 * 
 * Defines a pluggable interface for witness services that attest to the
 * existence of events at a point in time. Witnesses add trust anchors
 * to event logs by providing third-party attestations.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { WitnessProof } from '../types.js';

/**
 * Interface for witness services that can attest to event digests.
 * 
 * Implementations might include:
 * - HTTP-based witness services (for did:webvh layer)
 * - Bitcoin timestamping services (for did:btco layer)
 * - Notary services
 * - Blockchain-based attestation services
 * 
 * @example
 * ```typescript
 * class MyHttpWitness implements WitnessService {
 *   constructor(private witnessUrl: string) {}
 *   
 *   async witness(digestMultibase: string): Promise<WitnessProof> {
 *     const response = await fetch(this.witnessUrl, {
 *       method: 'POST',
 *       body: JSON.stringify({ digest: digestMultibase })
 *     });
 *     return response.json();
 *   }
 * }
 * ```
 */
export interface WitnessService {
  /**
   * Witnesses a digest and returns a proof of attestation.
   *
   * The witness should:
   * 1. Record the digest at the current point in time
   * 2. Generate a cryptographic proof of the attestation
   * 3. Include a witnessedAt timestamp in the proof
   *
   * ## Signing-byte contract (issue #314)
   *
   * For signature-based witness proofs, the signature MUST be computed over
   * `witnessSigningBytes(digestMultibase)` — the UTF-8 bytes of the
   * JSON-*quoted* digest string (`"uEiD…"`, surrounding quotes included), NOT
   * the raw/decoded digest bytes. `verifyEventLog` reconstructs the preimage
   * as `canonicalizeEvent(digestMultibase)`, so a witness that signs the
   * decoded bytes (or the unquoted string) produces a proof that fails
   * verification with no hint why. Use the exported `witnessSigningBytes`
   * helper to obtain the exact preimage.
   *
   * @param digestMultibase - The Multibase-encoded digest to witness (from computeDigestMultibase)
   * @returns A WitnessProof containing the attestation and witnessedAt timestamp
   * @throws Error if the witness service is unavailable or fails
   */
  witness(digestMultibase: string): Promise<WitnessProof>;
}
