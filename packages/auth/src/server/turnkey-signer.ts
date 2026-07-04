/**
 * Turnkey Signer - Integration between Turnkey key management and Originals SDK
 *
 * Provides an ExternalSigner implementation that works with Turnkey-managed
 * keys for use with the Originals SDK's DID creation and signing operations.
 */

import { Turnkey } from '@turnkey/sdk-server';
import { ExternalSigner, ExternalVerifier, multikey, OriginalsSDK } from '@originals/sdk';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as ed25519 from '@noble/ed25519';

// Configure @noble/ed25519 with required SHA-512 function.
//
// NOTE: @noble/ed25519 v3.x moved sync hash configuration from the (now
// frozen) `utils` / `etc` objects to a dedicated, writable `hashes` object.
// `hashes.sha512` is called by the library as `fn(message)` with a single
// already-assembled Uint8Array, so this must not be a variadic wrapper.
const sha512Fn = (msg: Uint8Array): Uint8Array => sha512(msg);

// Initialize Ed25519 configuration
try {
  const ed25519Module = ed25519 as unknown as {
    hashes?: { sha512?: typeof sha512Fn };
  };
  if (ed25519Module.hashes) {
    ed25519Module.hashes.sha512 = sha512Fn;
  }
} catch (error) {
  console.warn('Failed to configure ed25519 utils:', error);
}

/**
 * Turnkey-based signer for use with Originals SDK
 * Implements the ExternalSigner and ExternalVerifier interfaces
 */
export class TurnkeyWebVHSigner implements ExternalSigner, ExternalVerifier {
  private subOrgId: string;
  private keyId: string;
  private publicKeyMultibase: string;
  private turnkeyClient: Turnkey;
  private verificationMethodId: string;

  constructor(
    subOrgId: string,
    keyId: string,
    publicKeyMultibase: string,
    turnkeyClient: Turnkey,
    verificationMethodId: string
  ) {
    this.subOrgId = subOrgId;
    this.keyId = keyId;
    this.publicKeyMultibase = publicKeyMultibase;
    this.turnkeyClient = turnkeyClient;
    this.verificationMethodId = verificationMethodId;
  }

  /**
   * Sign data using Turnkey's API
   */
  async sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }> {
    try {
      // Prepare the data for signing using the SDK's canonical approach
      const prepared: unknown = await OriginalsSDK.prepareDIDDataForSigning(input.document, input.proof);
      if (!(prepared instanceof Uint8Array)) {
        throw new Error('prepareDIDDataForSigning did not return a Uint8Array');
      }
      const dataToSign = prepared;

      // Convert canonical data to hex format for Turnkey's sign API
      const dataHex = `0x${bytesToHex(dataToSign)}`;

      // Sign using Turnkey's API
      const result = await this.turnkeyClient.apiClient().signRawPayload({
        organizationId: this.subOrgId,
        signWith: this.keyId,
        payload: dataHex,
        encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
        hashFunction: 'HASH_FUNCTION_NO_OP',
      });

      const signRawResult = result.activity?.result?.signRawPayloadResult;
      if (!signRawResult?.r || !signRawResult?.s) {
        throw new Error('No signature returned from Turnkey');
      }

      // Turnkey may return r and s with or without a leading '0x' prefix.
      // Strip the prefix from each component SEPARATELY before concatenating:
      // concatenating first and stripping a single leading '0x' would leave an
      // embedded '0x' in the middle (e.g. 'aaaa...0xbbbb...') when both values
      // are prefixed, corrupting Buffer.from(..., 'hex') and breaking the
      // signature. This mirrors the client-side TurnkeyDIDSigner behaviour.
      const r = signRawResult.r;
      const s = signRawResult.s;
      const cleanR = r.startsWith('0x') ? r.slice(2) : r;
      const cleanS = s.startsWith('0x') ? s.slice(2) : s;
      const cleanSig = cleanR + cleanS;
      const signatureBytes = Buffer.from(cleanSig, 'hex');

      // Ed25519 signatures must be exactly 64 bytes (32-byte r + 32-byte s).
      // Never truncate: a 65-byte value is not a valid Ed25519 signature with a
      // spare byte, and silently slicing it would produce an invalid signature
      // that is accepted/stored here but fails later verification (did:webvh
      // resolution / credential validation). Reject anything that is not 64
      // bytes, matching the client-side TurnkeyDIDSigner contract.
      if (signatureBytes.length !== 64) {
        throw new Error(
          `Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`
        );
      }

      // Encode signature as multibase
      const proofValue = multikey.encodeMultibase(signatureBytes);
      return { proofValue };
    } catch (error) {
      console.error('Error signing with Turnkey:', error);
      throw new Error(
        `Failed to sign with Turnkey: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Verify a signature
   */
  async verify(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
  ): Promise<boolean> {
    try {
      // Ed25519 public keys must be exactly 32 bytes
      let ed25519PublicKey = publicKey;
      if (publicKey.length === 33) {
        ed25519PublicKey = publicKey.slice(1);
      } else if (publicKey.length !== 32) {
        return false;
      }

      return await ed25519.verifyAsync(signature, message, ed25519PublicKey);
    } catch (error) {
      console.error('Error verifying signature:', error);
      return false;
    }
  }

  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }

  getPublicKeyMultibase(): string {
    return this.publicKeyMultibase;
  }
}

/**
 * Options object for creating a Turnkey signer.
 */
export interface CreateTurnkeySignerOptions {
  turnkeyClient: Turnkey;
  organizationId: string;
  privateKeyId: string;
  verificationMethodId: string;
  publicKeyMultibase: string;
}

/**
 * Create a Turnkey signer for use with the Originals SDK.
 */
export function createTurnkeySigner(options: CreateTurnkeySignerOptions): TurnkeyWebVHSigner;
/**
 * @deprecated Use the options-object form. TODO(@next-major): remove this overload.
 */
export function createTurnkeySigner(
  subOrgId: string,
  keyId: string,
  turnkeyClient: Turnkey,
  verificationMethodId: string,
  publicKeyMultibase: string
): TurnkeyWebVHSigner;
export function createTurnkeySigner(
  optionsOrSubOrgId: CreateTurnkeySignerOptions | string,
  keyId?: string,
  turnkeyClient?: Turnkey,
  verificationMethodId?: string,
  publicKeyMultibase?: string
): TurnkeyWebVHSigner {
  if (typeof optionsOrSubOrgId === 'string') {
    return new TurnkeyWebVHSigner(
      optionsOrSubOrgId,
      keyId!,
      publicKeyMultibase!,
      turnkeyClient!,
      verificationMethodId!
    );
  }
  const o = optionsOrSubOrgId;
  return new TurnkeyWebVHSigner(
    o.organizationId,
    o.privateKeyId,
    o.publicKeyMultibase,
    o.turnkeyClient,
    o.verificationMethodId
  );
}

