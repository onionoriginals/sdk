/**
 * The Turnkey-held key that authors an Original.
 *
 * Every Original is a CEL, and every lifecycle step appends a signed event to
 * it. Until this existed, the key that signed those events was minted by
 * `createAsset` into the DemoEngine's in-memory Map and destroyed with the tab:
 * a published Original could never be inscribed afterwards, because nothing
 * could sign its `migrate` event. That is the pre-broadcast resume gap.
 *
 * The fix is custody, not UI. This signer puts the asset's controller key in
 * Turnkey — Ed25519, because CEL is Ed25519-only, and server-held, so it comes
 * back with the session on any device rather than living in one browser's
 * storage. `signerFromExternalSigner` adapts it to the SDK's `config.signer`,
 * which `createAsset` then adopts as the controller instead of generating one.
 *
 * Byte-level signing is NOT reimplemented here: `turnkeySignBytes` from
 * `@originals/auth` is the one place Turnkey actually signs (hex payload,
 * HASH_FUNCTION_NO_OP, r‖s concatenation, 64-byte guard), and it is already
 * documented as the capability that lets a Turnkey key author CEL events.
 */
import type { Turnkey } from '@turnkey/sdk-server';
import { base58AddressToEd25519Multikey } from '@originals/sdk';
import { turnkeySignBytes } from '@originals/auth';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

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
 * `turnkeySignBytes` reaches the API as `client.apiClient().signRawPayload`
 * — the server SDK's shape. The browser's IndexedDB client exposes
 * `signRawPayload` directly, so it is wrapped rather than special-cased
 * inside the shared signing helper.
 */
function asApiClient(client: TurnkeyBitcoinClient): Turnkey {
  return { apiClient: () => client } as unknown as Turnkey;
}

/**
 * An `ExternalSigner` backed by the sub-org's authorship account. Only
 * `signBytes` is implemented: that is what `signerFromExternalSigner` requires
 * and all the SDK ever asks of a CEL signer, since the SDK owns
 * canonicalization and hashing.
 */
export class TurnkeyCelSigner {
  private readonly client: TurnkeyBitcoinClient;
  private readonly subOrgId: string;
  private readonly signWith: string;
  private readonly publicKeyMultibase: string;

  constructor(opts: {
    client: TurnkeyBitcoinClient;
    subOrgId: string;
    /** The authorship account address (`ensureAuthorshipAccount`). */
    signWith: string;
    publicKeyMultibase: string;
  }) {
    this.client = opts.client;
    this.subOrgId = opts.subOrgId;
    this.signWith = opts.signWith;
    this.publicKeyMultibase = opts.publicKeyMultibase;
  }

  /**
   * `ExternalSigner` declares this, but a CEL signer never reaches it: the SDK
   * owns canonicalization and hands over finished bytes, and
   * `signerFromExternalSigner` refuses a sign()-only signer for exactly that
   * reason. Implemented as a refusal so a future caller that wires this into
   * the document-level path is told why instead of getting a wrong signature.
   */
  async sign(): Promise<{ proofValue: string }> {
    throw new Error(
      'TurnkeyCelSigner signs SDK-owned preimages via signBytes; it does not canonicalize documents itself.'
    );
  }

  async signBytes(data: Uint8Array): Promise<{ signature: Uint8Array }> {
    if (typeof this.client.signRawPayload !== 'function') {
      throw new Error('This Turnkey client cannot sign raw payloads, so it cannot author CEL events.');
    }
    const signature = await turnkeySignBytes(
      { turnkeyClient: asApiClient(this.client), organizationId: this.subOrgId, signWith: this.signWith },
      data
    );
    return { signature };
  }

  getVerificationMethodId(): string {
    return `did:key:${this.publicKeyMultibase}`;
  }

  getPublicKeyMultibase(): string {
    return this.publicKeyMultibase;
  }
}

/**
 * Whether this client can author CEL events at all. Read BEFORE offering an
 * action that would need to sign one: a disabled control with a reason beats
 * an enabled control that throws after the user has committed to it.
 */
export function canAuthor(client: TurnkeyBitcoinClient | null | undefined): boolean {
  return typeof client?.signRawPayload === 'function';
}
