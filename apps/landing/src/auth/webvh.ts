/**
 * Client-side did:webvh creation with a browser-local Ed25519 key.
 *
 * Mirrors boop's approach (aviarytech/todo `src/lib/webvh.ts`): the DID is
 * signed in the browser with a real Ed25519 key persisted per sub-org, and
 * Turnkey stays the identity provider (the sub-org id). Signing the DID via
 * the parent Turnkey API key is impossible — the sub-org quorum only contains
 * the (credential-less) user until they attach a session, so the parent is not
 * a voter (ORGANIZATION_MISMATCH). A browser-local key sidesteps that and still
 * produces genuine, verifiable signatures: `createDIDOriginal` runs
 * didwebvh-ts's post-sign self-verification, so a bad signature throws here.
 */

import * as ed from '@noble/ed25519';
import { OriginalsSDK, encoding } from '@originals/sdk';
import type { ExternalSigner, ExternalVerifier } from '@originals/sdk';

// Multicodec prefix for Ed25519 public keys (0xed 0x01), per the Multikey spec.
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);
const KEY_STORAGE_PREFIX = 'originals-webvh-ed25519';
const DID_LOG_STORAGE_PREFIX = 'originals-webvh-did-log';

// did:webvh domain. These DIDs are created + displayed, not hosted/resolved, so
// the domain is cosmetic here; default to the dev network.
export const DEFAULT_WEBVH_DOMAIN = 'magby.originals.build';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Encode a raw 32-byte Ed25519 public key as a Multikey publicKeyMultibase. */
export function ed25519PublicKeyMultibase(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC);
  prefixed.set(publicKey, ED25519_MULTICODEC.length);
  return encoding.multibase.encode(prefixed, 'base58btc');
}

/** Ed25519 signer over an in-browser private key, compatible with the SDK. */
export class BrowserWebVHSigner implements ExternalSigner, ExternalVerifier {
  constructor(
    private readonly privateKey: Uint8Array,
    private readonly publicKeyMultibase: string
  ) {}

  async sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }> {
    const bytes = await OriginalsSDK.prepareDIDDataForSigning(input.document, input.proof);
    const signature = await ed.signAsync(bytes, this.privateKey);
    return { proofValue: encoding.multibase.encode(signature, 'base58btc') };
  }

  async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    // Accept a 33-byte multikey-prefixed key by dropping the leading byte.
    const key = publicKey.length === 33 ? publicKey.slice(1) : publicKey;
    if (key.length !== 32) return false;
    try {
      return await ed.verifyAsync(signature, message, key);
    } catch {
      return false;
    }
  }

  getVerificationMethodId(): string {
    return `did:key:${this.publicKeyMultibase}`;
  }

  getPublicKeyMultibase(): string {
    return this.publicKeyMultibase;
  }
}

export interface WebVHDidResult {
  did: string;
  didDocument: unknown;
  didLog: unknown;
}

/**
 * Build a did:webvh from a signer + slug. Testable core (no browser storage):
 * `createDIDOriginal` normalizes the did:key updateKey to bare multikey form
 * (didwebvh-ts >= 2.8) and self-verifies the signature.
 */
export async function buildUserWebVHDid(
  signer: BrowserWebVHSigner,
  opts: { domain: string; slug: string }
): Promise<WebVHDidResult> {
  const publicKeyMultibase = signer.getPublicKeyMultibase();
  const result = await OriginalsSDK.createDIDOriginal({
    type: 'did',
    domain: opts.domain,
    signer,
    verifier: signer,
    updateKeys: [signer.getVerificationMethodId()],
    verificationMethods: [
      { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase },
      { id: '#key-1', type: 'Multikey', controller: '', publicKeyMultibase },
    ],
    paths: [opts.slug],
    portable: false,
    authentication: ['#key-0'],
    assertionMethod: ['#key-1'],
  });
  return { did: result.did, didDocument: result.doc, didLog: result.log };
}

/** Get or create the per-sub-org browser Ed25519 key (persisted in localStorage). */
async function getOrCreateBrowserKeyPair(
  subOrgId: string
): Promise<{ privateKey: Uint8Array; publicKeyMultibase: string }> {
  const storageKey = `${KEY_STORAGE_PREFIX}:${subOrgId}`;
  const existing = localStorage.getItem(storageKey);
  const privateKey = existing ? hexToBytes(existing) : ed.utils.randomPrivateKey();
  if (!existing) localStorage.setItem(storageKey, bytesToHex(privateKey));
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKeyMultibase: ed25519PublicKeyMultibase(publicKey) };
}

/**
 * Create (or re-create, deterministically from the persisted key) the user's
 * did:webvh in the browser. The sub-org id supplies a stable, PII-free slug.
 */
export async function createUserWebVHDid(params: {
  subOrgId: string;
  email: string;
  domain?: string;
}): Promise<WebVHDidResult> {
  const { privateKey, publicKeyMultibase } = await getOrCreateBrowserKeyPair(params.subOrgId);
  const signer = new BrowserWebVHSigner(privateKey, publicKeyMultibase);
  const slug = `user-${params.subOrgId.slice(0, 16)}`;
  const result = await buildUserWebVHDid(signer, {
    domain: params.domain ?? DEFAULT_WEBVH_DOMAIN,
    slug,
  });
  localStorage.setItem(`${DID_LOG_STORAGE_PREFIX}:${params.subOrgId}`, JSON.stringify(result.didLog));
  return result;
}
