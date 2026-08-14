/**
 * The four signing preimages of this SDK, consolidated (plan 039).
 *
 * Invariant: the SDK canonicalizes and hashes; a signer only ever signs the
 * opaque bytes these functions return. Every internal signing path routes
 * through here, so "which bytes do I sign?" has exactly one answer per context
 * and the four constructions cannot drift apart again.
 *
 * Heavy dependencies (jsonld, didwebvh-ts) are loaded lazily so this module is
 * safe to import from the browser-slim entry points.
 */

import { canonicalizeEntryForChain, witnessSigningBytes } from '../cel/canonicalize.js';
import { sha256Bytes } from '../utils/hash.js';
import { StructuredError } from '../utils/telemetry.js';

/** Minimal documentLoader shape (same contract the VC stack uses). */
export type SigningDocumentLoader = (url: string) => Promise<{ document: unknown }>;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export const signingInput = {
  /**
   * CEL controller-proof preimage: JCS bytes of the committed fields
   * `{ type, data, previousEvent? }` — exactly what `verifyEventLog`
   * reconstructs and verifies. Stray keys are never signed.
   */
  celEvent(entry: { type: unknown; data?: unknown; previousEvent?: unknown }): Uint8Array {
    return canonicalizeEntryForChain(entry as { type: unknown; data: unknown; previousEvent?: unknown });
  },

  /**
   * CEL witness-attestation preimage: UTF-8 bytes of the JSON-quoted digest
   * (surrounding quotes INCLUDED). See `witnessSigningBytes` for why signing
   * the raw digest bytes instead silently never verifies.
   */
  witness(digestMultibase: string): Uint8Array {
    return witnessSigningBytes(digestMultibase);
  },

  /**
   * did:webvh log-entry preimage, exactly didwebvh-ts's construction:
   * sha256(JCS(proof)) || sha256(JCS(document)). Delegates to the library so
   * the SDK and didwebvh-ts can never disagree on the bytes.
   */
  async didWebvh(document: Record<string, unknown>, proof: Record<string, unknown>): Promise<Uint8Array> {
    const mod = await import('didwebvh-ts') as {
      prepareDataForSigning?: (document: unknown, proof: unknown) => Promise<Uint8Array>;
    };
    if (typeof mod.prepareDataForSigning !== 'function') {
      throw new StructuredError('DIDWEBVH_UNAVAILABLE', 'didwebvh-ts does not export prepareDataForSigning');
    }
    return mod.prepareDataForSigning(document, proof);
  },

  /**
   * eddsa-rdfc-2022 credential preimage: sha256(RDFC(proofConfig)) ||
   * sha256(RDFC(document)). `proofValue`/`jws` are stripped from the config
   * before canonicalization, and a `proof` on the document is ignored, so the
   * same call serves both the signing and the verification side.
   */
  async credential(
    document: Record<string, unknown>,
    proofConfig: Record<string, unknown>,
    { documentLoader }: { documentLoader: SigningDocumentLoader }
  ): Promise<Uint8Array> {
    // jsonld is heavy and node-leaning; load it only when a credential is signed.
    const { canonize, canonizeProof } = await import('../vc/utils/jsonld.js');
    const unsigned: Record<string, unknown> = { ...document };
    delete unsigned.proof;
    const transformed = await canonize(unsigned, { documentLoader });
    const canonicalProofConfig = await canonizeProof(proofConfig, { documentLoader });
    return concat(await sha256Bytes(canonicalProofConfig), await sha256Bytes(transformed));
  },
};
