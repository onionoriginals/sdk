/**
 * The Turnkey-held key that authors a signed-in user's Originals.
 *
 * Under the Originals Protocol, every entry of an Original's asset log is
 * signed by an author key of the author's DID (P5.2, P5.3). For a signed-in
 * user that DID is their did:webvh. Its update key is the Turnkey identity
 * account (`#key-0`), and its author key is the separate Turnkey authorship
 * account, published as `#key-1` under assertionMethod. Keeping them apart is
 * what P5.11 asks for. The key is server-held, so it comes back with the
 * session on any device rather than living in one browser's storage.
 *
 * Byte-level signing is NOT reimplemented here: `turnkeySignBytes` from
 * `@originals/auth` is the one place Turnkey actually signs (hex payload,
 * HASH_FUNCTION_NOT_APPLICABLE, r‖s concatenation, 64-byte guard).
 *
 * NAME COLLISION: `auth/authorship-key.ts` is a DIFFERENT key. That one signs
 * the user's own did:webvh identity document; this one signs Originals entries.
 */
import { base58AddressToEd25519Multikey } from '@originals/sdk';
import type { OriginalsSigner, SigningRequest } from '@originals/sdk/originals';
import { proofHashData } from '@originals/vh/crypto';
import type { JsonObject } from '@originals/vh/json';
import { turnkeySignBytes } from '@originals/auth';
import { asTurnkeyApiClient, type TurnkeyBitcoinClient } from '../auth/turnkey-session';

/**
 * The Multikey for a Turnkey Ed25519 account address.
 *
 * The conversion itself is the SDK's `base58AddressToEd25519Multikey`, which
 * exists precisely for `ADDRESS_FORMAT_SOLANA` and says so — "consumers keep
 * re-deriving this by hand and getting it wrong". This is only the non-
 * throwing shape the UI wants: a control that must decide whether to enable
 * itself should not have to catch.
 */
export function authorshipPublicKeyMultibase(address: string): string | null {
  try {
    return base58AddressToEd25519Multikey(address);
  } catch {
    return null;
  }
}

/**
 * An `ExternalSigner` backed by the sub-org's authorship account. Only
 * `signBytes` is implemented: that is what `signerFromExternalSigner` requires
 * and all the SDK ever asks of a CEL signer, since the SDK owns
 * canonicalization and hashing.
 */
/**
 * An `OriginalsSigner` (P5.11) over the Turnkey authorship account. Like the
 * SDK's `keySigner`, it refuses anything that is not an Originals entry naming
 * this author key, and it computes the signed bytes itself from the entry
 * rather than trusting a caller's.
 */
export function turnkeyAuthorshipSigner(opts: {
  /** Resolve per signature when the signer outlives a browser session. */
  client: TurnkeyBitcoinClient | (() => Promise<TurnkeyBitcoinClient>);
  subOrgId: string;
  /** The authorship account address (`ensureAuthorshipAccount`). */
  signWith: string;
  /** The author verification method, `<did>#key-1`. */
  verificationMethod: string;
}): OriginalsSigner {
  return {
    verificationMethod: opts.verificationMethod,
    cryptosuite: 'eddsa-jcs-2022',
    sign: async (request: SigningRequest) => {
      const author = (request.entry.state as { author?: { verificationMethod?: unknown } }).author;
      if (request.proofOptions.verificationMethod !== opts.verificationMethod || author?.verificationMethod !== opts.verificationMethod) {
        throw new Error('This entry names a different author key; refusing to sign it.');
      }
      if (request.proofOptions.cryptosuite !== 'eddsa-jcs-2022' || !/^did:vh:/.test(String((request.entry.state as { id?: unknown }).id))) {
        throw new Error('Not an Originals entry for this key; refusing to sign it.');
      }
      const client = typeof opts.client === 'function' ? await opts.client() : opts.client;
      if (typeof client.signRawPayload !== 'function') {
        throw new Error('This Turnkey client cannot sign raw payloads, so it cannot author Originals.');
      }
      return turnkeySignBytes(
        { turnkeyClient: asTurnkeyApiClient(client), organizationId: opts.subOrgId, signWith: opts.signWith },
        proofHashData(request.entry as unknown as JsonObject, request.proofOptions),
      );
    },
  };
}

/**
 * Whether this client can author Originals at all. Read BEFORE offering an
 * action that would need to sign one: a disabled control with a reason beats
 * an enabled control that throws after the user has committed to it.
 */
export function canAuthor(client: TurnkeyBitcoinClient | null | undefined): boolean {
  return typeof client?.signRawPayload === 'function';
}
