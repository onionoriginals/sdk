/**
 * Turnkey DID Signer Adapter
 * Adapts Turnkey signing to work with didwebvh-ts signer interface
 * Uses @turnkey/sdk-server for all Turnkey operations (no viem/ethers dependency)
 */

import { Turnkey } from '@turnkey/sdk-server';
import { OriginalsSDK, encoding, signingInput, base58AddressToEd25519Multikey } from '@originals/sdk';
import { turnkeySignBytes } from '../turnkey-sign-bytes.js';
import type { TurnkeyWalletAccount } from '../types.js';
import {
  TurnkeySessionExpiredError,
  TURNKEY_ACCOUNT_ROLES,
  withTokenExpiration,
} from './turnkey-client.js';

/**
 * Thrown by {@link createDIDWithTurnkey} when the supplied `updateKeyAccount`
 * does not match the canonical `did-update` role (curve `CURVE_ED25519` at
 * the exact derivation path Turnkey provisions for the DID update key), or
 * when its `address` does not correspond to the `updateKeyPublic` that will
 * be published as the DID's update-key controller. The did:webvh log this
 * function mints is Ed25519-only (`packages/sdk/V3.md`: "Method-log custody
 * must be Ed25519"), so wiring in any other account here would silently mint
 * a controller that this SDK's own resolvers reject or that carries the
 * wrong authority — this rejects it before any signing call.
 */
export class TurnkeyUpdateKeyRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TurnkeyUpdateKeyRoleError';
  }
}

interface SigningInput {
  document: Record<string, unknown>;
  proof: Record<string, unknown>;
}

interface SigningOutput {
  proofValue: string;
}

/**
 * Signer that uses Turnkey for signing DID documents
 * Compatible with didwebvh-ts signer interface
 */
export class TurnkeyDIDSigner {
  private turnkeyClient: Turnkey;
  private signWith: string;
  private subOrgId: string;
  private publicKeyMultibase: string;
  private onExpired?: () => void;

  constructor(
    turnkeyClient: Turnkey,
    signWith: string,
    subOrgId: string,
    publicKeyMultibase: string,
    onExpired?: () => void
  ) {
    this.turnkeyClient = turnkeyClient;
    this.signWith = signWith;
    this.subOrgId = subOrgId;
    this.publicKeyMultibase = publicKeyMultibase;
    this.onExpired = onExpired;
  }

  /**
   * Sign the document and proof using Turnkey
   */
  async sign(input: SigningInput): Promise<SigningOutput> {
    return withTokenExpiration(async () => {
      try {
        // didwebvh's preimage, produced by the SDK — never by this signer.
        // Narrowed explicitly: lint runs before @originals/sdk is built, so the
        // return type is unresolved there and must not flow on unchecked.
        const prepared: unknown = await signingInput.didWebvh(input.document, input.proof);
        if (!(prepared instanceof Uint8Array)) {
          throw new Error('signingInput.didWebvh did not return a Uint8Array');
        }
        const { signature } = await this.signBytes(prepared);
        return { proofValue: encoding.multibase.encode(signature, 'base58btc') };
      } catch (error) {
        console.error('[TurnkeyDIDSigner] Error signing with Turnkey:', error);
        throw this.asExpiryError(error);
      }
    }, this.onExpired);
  }

  /**
   * Signs pre-canonicalized, pre-hashed bytes — the capability that lets a
   * Turnkey key author CEL events and sign credentials, not just did:webvh
   * logs. `signerFromExternalSigner` requires exactly this.
   */
  async signBytes(data: Uint8Array): Promise<{ signature: Uint8Array }> {
    return withTokenExpiration(async () => {
      try {
        const signature = await turnkeySignBytes(
          { turnkeyClient: this.turnkeyClient, organizationId: this.subOrgId, signWith: this.signWith },
          data
        );
        return { signature };
      } catch (error) {
        throw this.asExpiryError(error);
      }
    }, this.onExpired);
  }

  /** Turnkey reports an expired session as a generic error; surface it typed. */
  private asExpiryError(error: unknown): unknown {
    const errorStr = JSON.stringify(error);
    if (
      errorStr.toLowerCase().includes('api_key_expired') ||
      errorStr.toLowerCase().includes('expired api key') ||
      errorStr.toLowerCase().includes('"code":16')
    ) {
      this.onExpired?.();
      return new TurnkeySessionExpiredError();
    }
    return error;
  }

  /**
   * Get the verification method ID for this signer
   */
  getVerificationMethodId(): string {
    return `did:key:${this.publicKeyMultibase}`;
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
      return await OriginalsSDK.verifyDIDSignature(signature, message, publicKey);
    } catch (error) {
      console.error('[TurnkeyDIDSigner] Error verifying signature:', error);
      return false;
    }
  }
}

/**
 * Create a DID:WebVH using OriginalsSDK.createDIDOriginal() with Turnkey signing
 */
export async function createDIDWithTurnkey(params: {
  turnkeyClient: Turnkey;
  updateKeyAccount: TurnkeyWalletAccount;
  subOrgId: string;
  authKeyPublic: string;
  assertionKeyPublic: string;
  updateKeyPublic: string;
  domain: string;
  slug: string;
  onExpired?: () => void;
}): Promise<{
  did: string;
  didDocument: unknown;
  didLog: unknown;
}> {
  const {
    turnkeyClient,
    updateKeyAccount,
    subOrgId,
    authKeyPublic,
    assertionKeyPublic,
    updateKeyPublic,
    domain,
    slug,
    onExpired,
  } = params;

  // Reject before any signing call: the did:webvh update-key role is
  // Ed25519-only, and this package provisions the update key at a specific
  // path distinct from the assertion key (see #744) — a curve check alone
  // is not enough to tell them apart.
  const updateRole = TURNKEY_ACCOUNT_ROLES.find((r) => r.role === 'did-update')!;
  if (updateKeyAccount.curve !== updateRole.curve || updateKeyAccount.path !== updateRole.path) {
    throw new TurnkeyUpdateKeyRoleError(
      `updateKeyAccount must be the canonical did-update account (curve ${updateRole.curve} ` +
        `at path ${updateRole.path}), got curve ${updateKeyAccount.curve} at path ` +
        `${updateKeyAccount.path}. Use getKeyByRole(wallets, 'did-update') to select the correct account.`
    );
  }

  // curve/path are caller-supplied labels, not proof that `address` is
  // actually the did-update key: rebind `address` to the public key it
  // will sign for and require it to match `updateKeyPublic`, the key that
  // gets published as the DID's update-key controller.
  let updateKeyAccountMultikey: string;
  try {
    updateKeyAccountMultikey = base58AddressToEd25519Multikey(updateKeyAccount.address);
  } catch (error) {
    throw new TurnkeyUpdateKeyRoleError(
      `updateKeyAccount.address is not a valid ${updateRole.addressFormat} Ed25519 address: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (updateKeyAccountMultikey !== updateKeyPublic) {
    throw new TurnkeyUpdateKeyRoleError(
      `updateKeyAccount.address does not correspond to updateKeyPublic. The did-update role check ` +
        `(curve + path) does not prove the supplied account is the key behind updateKeyPublic — ` +
        `re-derive both from the same getKeyByRole(wallets, 'did-update') result.`
    );
  }

  // Create Turnkey signer for the update key
  const signer = new TurnkeyDIDSigner(
    turnkeyClient,
    updateKeyAccount.address,
    subOrgId,
    updateKeyPublic,
    onExpired
  );

  // Use SDK's createDIDOriginal
  const result = await OriginalsSDK.createDIDOriginal({
    type: 'did',
    domain,
    signer,
    verifier: signer,
    updateKeys: [signer.getVerificationMethodId()],
    // `controller` is omitted, not `''`: didwebvh-ts fills a missing
    // controller in with the DID being created (`vm.controller ?? did`),
    // but `??` does not replace an empty string, so `''` would have
    // survived verbatim into the published DID document (#804).
    verificationMethods: [
      {
        id: '#key-0',
        type: 'Multikey',
        publicKeyMultibase: authKeyPublic,
      },
      {
        id: '#key-1',
        type: 'Multikey',
        publicKeyMultibase: assertionKeyPublic,
      },
    ],
    paths: [slug],
    portable: false,
    authentication: ['#key-0'],
    assertionMethod: ['#key-1'],
  });

  return {
    did: result.did,
    didDocument: result.doc,
    didLog: result.log,
  };
}
