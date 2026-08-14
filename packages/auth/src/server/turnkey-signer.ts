/**
 * Turnkey Signer - Integration between Turnkey key management and Originals SDK
 *
 * Provides an ExternalSigner implementation that works with Turnkey-managed
 * keys for use with the Originals SDK's DID creation and signing operations.
 */

import { Turnkey } from '@turnkey/sdk-server';
import { ExternalSigner, ExternalVerifier, multikey, signingInput } from '@originals/sdk';
import { turnkeySignBytes } from '../turnkey-sign-bytes.js';
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
      // didwebvh's preimage, produced by the SDK — never by this signer.
      const dataToSign = await signingInput.didWebvh(input.document, input.proof);
      const { signature } = await this.signBytes(dataToSign);
      return { proofValue: multikey.encodeMultibase(signature) };
    } catch (error) {
      console.error('Error signing with Turnkey:', error);
      throw new Error(
        `Failed to sign with Turnkey: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Signs pre-canonicalized, pre-hashed bytes — the capability that lets a
   * Turnkey key author CEL events and sign credentials, not just did:webvh
   * logs. `signerFromExternalSigner` requires exactly this.
   */
  async signBytes(data: Uint8Array): Promise<{ signature: Uint8Array }> {
    const signature = await turnkeySignBytes(
      { turnkeyClient: this.turnkeyClient, organizationId: this.subOrgId, signWith: this.keyId },
      data
    );
    return { signature };
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
      // Ed25519 public keys must be exactly 32 bytes. A 33-byte input is NOT
      // a "prefixed Ed25519 key": Ed25519 multicodec prefixes are 2 bytes
      // (0xed 0x01 → 34 bytes), while 33 bytes is the shape of a compressed
      // secp256k1 key. Stripping one byte verified against garbage — reject
      // instead of guessing (issue #352).
      if (publicKey.length !== 32) {
        return false;
      }

      return await ed25519.verifyAsync(signature, message, publicKey);
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

