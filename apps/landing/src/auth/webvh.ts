/**
 * Client-side did:webvh creation with a browser-local Ed25519 key.
 *
 * Mirrors boop's approach (aviarytech/todo `src/lib/webvh.ts`): the DID is
 * signed in the browser with a real Ed25519 key persisted per sub-org, and
 * Turnkey stays the identity provider (the sub-org id). `createDIDOriginal`
 * self-verifies via didwebvh-ts, so a bad signature throws here.
 *
 * WHY BROWSER-LOCAL, precisely: the PARENT Turnkey API key cannot sign for the
 * sub-org — its quorum holds only the (credential-less) user, so the parent is
 * not a voter (ORGANIZATION_MISMATCH). That is NOT "Turnkey cannot sign this
 * DID": once OTP_LOGIN installs a session credential the user IS a voter, and
 * `signRawPayload` signs arbitrary bytes under the Ed25519 authorship account
 * — exactly how ../sdk/turnkey-cel-signer.ts authors CEL events. This file
 * predates that session (#356 landed 5 days before #428).
 *
 * Custody would need BOTH halves, though: the log is browser-only too, and the
 * DID is not derivable from the seed (entry 0's `versionTime` feeds the SCID).
 */

import * as ed from '@noble/ed25519';
import { OriginalsSDK, encoding, base58AddressToEd25519Multikey } from '@originals/sdk';
import type { ExternalSigner, ExternalVerifier } from '@originals/sdk';
import { turnkeySignBytes } from '@originals/auth';
import { asTurnkeyApiClient, type TurnkeyBitcoinClient } from './turnkey-session';
/**
 * Identity failures that the panel shows by name. The old `AuthorshipKeyError`
 * carried six codes for a browser-custody model (acknowledgement gates, backup
 * files) that no longer exists; only the "cannot sign" case survives it.
 */
export class WebVHIdentityError extends Error {
  constructor(readonly code: 'no-key', message: string) {
    super(message);
    this.name = 'WebVHIdentityError';
  }
}

/** The DID a did:webvh log resolves to: the latest entry's `state.id`. */
export function didFromLog(didLog: unknown): string | null {
  if (!Array.isArray(didLog) || didLog.length === 0) return null;
  const state = (didLog[didLog.length - 1] as { state?: { id?: unknown } } | null)?.state;
  const id = state?.id;
  return typeof id === 'string' && id.startsWith('did:webvh:') ? id : null;
}


// Multicodec prefix for Ed25519 public keys (0xed 0x01), per the Multikey spec.
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

// did:webvh domain. These DIDs are created + displayed, not hosted/resolved, so
// the domain is cosmetic here; default to the dev network.
export const DEFAULT_WEBVH_DOMAIN = 'magby.originals.build';

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

/**
 * The same signer contract backed by a Turnkey-held Ed25519 key (the sub-org's
 * IDENTITY_ACCOUNT) instead of a browser seed. Sibling of BrowserWebVHSigner:
 * identical preimage, identical proofValue encoding — only custody differs.
 *
 * Requires an ACTIVE session. The parent org key is not a voter in the sub-org
 * quorum, so this signs only while OTP_LOGIN's session credential is live;
 * callers gate on `signing === 'active'` rather than discovering it here.
 *
 * `verify` stays local @noble/ed25519 — verification is public-key-only and
 * must never need custody, a network hop, or a live session.
 */
export class TurnkeyWebVHSigner implements ExternalSigner, ExternalVerifier {
  constructor(
    private readonly client: TurnkeyBitcoinClient,
    private readonly subOrgId: string,
    /** The identity account address (`ensureIdentityAccount`). */
    private readonly signWith: string,
    private readonly publicKeyMultibase: string
  ) {}

  async sign(input: {
    document: Record<string, unknown>;
    proof: Record<string, unknown>;
  }): Promise<{ proofValue: string }> {
    if (typeof this.client.signRawPayload !== 'function') {
      throw new WebVHIdentityError('no-key', 'This Turnkey client cannot sign raw payloads');
    }
    const bytes = await OriginalsSDK.prepareDIDDataForSigning(input.document, input.proof);
    const signature = await turnkeySignBytes(
      { turnkeyClient: asTurnkeyApiClient(this.client), organizationId: this.subOrgId, signWith: this.signWith },
      bytes
    );
    return { proofValue: encoding.multibase.encode(signature, 'base58btc') };
  }

  async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
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

/** What `buildUserWebVHDid` needs — satisfied by either custody model. */
export type WebVHSigner = ExternalSigner & ExternalVerifier & { getPublicKeyMultibase(): string };

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
  signer: WebVHSigner,
  opts: {
    domain: string;
    slug: string;
    /**
     * The Turnkey authorship key (`ensureAuthorshipAccount`) that signs this
     * user's CEL events, published as `#key-1` / `assertionMethod` so a third
     * party can resolve the DID and see which key authors their Originals.
     *
     * ATTRIBUTION, NOT ENFORCEMENT: CEL proofs name a self-certifying
     * `did:key:` (TurnkeyCelSigner.getVerificationMethodId), so verification
     * never fetches this document — an Original must verify without a live
     * host. Listing a key here therefore publishes a claim; it cannot revoke.
     *
     * Omitted → no `#key-1` at all. It previously duplicated `#key-0`'s key
     * under a second id, which advertised two authorities where one existed.
     */
    authorshipPublicKeyMultibase?: string;
  }
): Promise<WebVHDidResult> {
  const publicKeyMultibase = signer.getPublicKeyMultibase();
  const authorship = opts.authorshipPublicKeyMultibase;
  const result = await OriginalsSDK.createDIDOriginal({
    type: 'did',
    domain: opts.domain,
    signer,
    verifier: signer,
    // Identity key ONLY: `updateKeys` is authority over the DID log itself,
    // which the per-Original authorship key must never hold.
    updateKeys: [signer.getVerificationMethodId()],
    verificationMethods: [
      { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase },
      ...(authorship
        ? [{ id: '#key-1', type: 'Multikey' as const, controller: '', publicKeyMultibase: authorship }]
        : []),
    ],
    paths: [opts.slug],
    portable: false,
    authentication: ['#key-0'],
    assertionMethod: [authorship ? '#key-1' : '#key-0'],
  });
  return { did: result.did, didDocument: result.doc, didLog: result.log };
}

/**
 * A stable, PII-free per-user did:webvh path slug derived from the Turnkey
 * sub-org id. Namespaces the publisher DID log under a per-user URL. The SERVER
 * derives the same slug from the JWT `sub` and rejects any write to a
 * `user-*` path segment that isn't the caller's own — so no user can pre-squat
 * another's publisher namespace (originals-routes.ts `hostPut`). This MUST stay
 * byte-identical to the server's copy. (Asset log/resource paths are hash-derived,
 * not `user-`-prefixed; they're guarded instead by the store's first-writer-wins
 * ownership sidecar.)
 */
export function userWebvhSlug(subOrgId: string): string {
  return `user-${subOrgId.slice(0, 16)}`;
}

/** Where a user's DID log lives on the host: `<domain>/<slug>/did.jsonl`. */
export function userDidLogKey(domain: string, slug: string): string {
  return `${domain}/${slug}/did.jsonl`;
}

/** The durable log store — the `put`/`get` half of the SDK's StorageAdapter. */
export interface DidLogHosting {
  put(objectKey: string, data: Uint8Array | string, options?: { contentType?: string }): Promise<string>;
  get(objectKey: string): Promise<{ content: Uint8Array | string } | null>;
}

/**
 * Create the user's did:webvh under Turnkey custody, or return the one already
 * published for this sub-org.
 *
 * BOTH halves must be durable, not just the key. The DID is NOT derivable from
 * the key: entry 0's `versionTime` feeds the SCID, so re-signing from the same
 * Turnkey key yields a DIFFERENT did:webvh than the user's Originals were
 * authored under. The published log is therefore the source of the DID, and
 * reading it back — not re-deriving — is what makes the identity stable across
 * devices. Losing the log loses the DID even with the key intact.
 */
export async function createUserWebVHDid(params: {
  subOrgId: string;
  email: string;
  domain?: string;
  /** An ACTIVE Turnkey session (`signing === 'active'`). */
  client: TurnkeyBitcoinClient;
  /** `ensureIdentityAccount` — signs the DID. */
  identityAddress: string;
  /** `ensureAuthorshipAccount` — published as assertionMethod, never signs here. */
  authorshipAddress?: string;
  hosting: DidLogHosting;
}): Promise<WebVHDidResult> {
  const domain = params.domain ?? DEFAULT_WEBVH_DOMAIN;
  const slug = userWebvhSlug(params.subOrgId);
  const logKey = userDidLogKey(domain, slug);

  const published = await readPublishedDid(params.hosting, logKey);
  if (published) return published;

  const signer = new TurnkeyWebVHSigner(
    params.client,
    params.subOrgId,
    params.identityAddress,
    base58AddressToEd25519Multikey(params.identityAddress)
  );
  const result = await buildUserWebVHDid(signer, {
    domain,
    slug,
    authorshipPublicKeyMultibase: params.authorshipAddress
      ? base58AddressToEd25519Multikey(params.authorshipAddress)
      : undefined,
  });

  // Publish BEFORE returning: a DID whose log never landed is one the user
  // cannot resolve and cannot recreate (a fresh build gets a new SCID).
  await params.hosting.put(logKey, serializeDidLog(result.didLog), {
    contentType: 'application/jsonl',
  });
  return result;
}

/**
 * The DID already published for this sub-org, or null — WITHOUT minting one.
 * Distinct from `createUserWebVHDid` on purpose: rendering a returning user's
 * identity must never be able to create an identity as a side effect.
 */
export async function readUserWebVHDid(params: {
  subOrgId: string;
  domain?: string;
  hosting: DidLogHosting;
}): Promise<WebVHDidResult | null> {
  const domain = params.domain ?? DEFAULT_WEBVH_DOMAIN;
  return readPublishedDid(params.hosting, userDidLogKey(domain, userWebvhSlug(params.subOrgId)));
}

/** didwebvh logs are JSONL — one entry per line, not a JSON array. */
function serializeDidLog(log: unknown): string {
  const entries = Array.isArray(log) ? log : [log];
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function parseDidLog(text: string): Array<{ state?: unknown }> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Tolerate a JSON array too: some writers emit one, and a resolver that
  // rejects it would strand a recoverable DID.
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** The DID already published for this key, or null if absent/unusable. */
async function readPublishedDid(
  hosting: DidLogHosting,
  logKey: string
): Promise<WebVHDidResult | null> {
  try {
    const found = await hosting.get(logKey);
    if (!found) return null;
    const text =
      typeof found.content === 'string' ? found.content : new TextDecoder().decode(found.content);
    const didLog = parseDidLog(text);
    const did = didFromLog(didLog);
    if (!did) return null;
    return { did, didDocument: didLog[didLog.length - 1]?.state, didLog };
  } catch {
    return null;
  }
}

