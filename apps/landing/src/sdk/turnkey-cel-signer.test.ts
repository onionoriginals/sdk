/**
 * The Turnkey authorship key — the custody change that closes the resume gap.
 *
 * The bug these guard against: an Original's controller key used to be minted
 * into an in-memory Map and destroyed with the tab, so a published Original
 * could never be inscribed afterwards. Everything here is about that key being
 * (a) derived from Turnkey's account correctly and (b) refused loudly, up
 * front, when this client cannot produce one.
 */
import { describe, test, expect } from 'bun:test';
import { base58 } from '@scure/base';
import { authorshipPublicKeyMultibase, canAuthor, TurnkeyCelSigner } from './turnkey-cel-signer';
import { ensureAuthorshipAccount, AUTHORSHIP_ACCOUNT } from '../auth/turnkey-session';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

/** A Solana-format address for a known 32-byte key. */
const PUBKEY = new Uint8Array(32).fill(7);
const SOLANA_ADDRESS = base58.encode(PUBKEY);

function stubClient(over: Partial<TurnkeyBitcoinClient> = {}): TurnkeyBitcoinClient {
  return {
    signTransaction: async () => ({ signedTransaction: '' }),
    createWalletAccounts: async () => ({ addresses: [] }),
    getWallets: async () => ({ wallets: [{ walletId: 'w1' }] }),
    getWalletAccounts: async () => ({ accounts: [] }),
    ...over,
  };
}

describe('authorshipPublicKeyMultibase', () => {
  test('turns a Solana-format address into an Ed25519 multikey', () => {
    const mb = authorshipPublicKeyMultibase(SOLANA_ADDRESS);
    // Multibase base58-btc ('z') carrying the 0xed01 Ed25519 multicodec.
    expect(mb).toBeTruthy();
    expect(mb!.startsWith('z6Mk')).toBe(true);
  });

  test('round-trips: the multikey carries the same 32 bytes back', () => {
    const mb = authorshipPublicKeyMultibase(SOLANA_ADDRESS)!;
    const decoded = base58.decode(mb.slice(1));
    expect(decoded[0]).toBe(0xed);
    expect(decoded[1]).toBe(0x01);
    expect([...decoded.slice(2)]).toEqual([...PUBKEY]);
  });

  test('refuses an address that is not a 32-byte key', () => {
    // A secp256k1 account address handed here by mistake must not become a
    // plausible-looking wrong key — the controller identity would be wrong
    // and nothing downstream would notice.
    expect(authorshipPublicKeyMultibase(base58.encode(new Uint8Array(33)))).toBeNull();
  });

  test('refuses input that is not base58 at all', () => {
    expect(authorshipPublicKeyMultibase('not base58 ! 0OIl')).toBeNull();
  });
});

describe('canAuthor', () => {
  test('false when the client cannot sign raw payloads', () => {
    expect(canAuthor(stubClient())).toBe(false);
  });

  test('false for no client at all', () => {
    expect(canAuthor(null)).toBe(false);
    expect(canAuthor(undefined)).toBe(false);
  });

  test('true once the client exposes signRawPayload', () => {
    expect(canAuthor(stubClient({ signRawPayload: async () => ({}) }))).toBe(true);
  });
});

describe('TurnkeyCelSigner', () => {
  test('reports its verification method as a did:key over the authorship key', () => {
    const mb = authorshipPublicKeyMultibase(SOLANA_ADDRESS)!;
    const signer = new TurnkeyCelSigner({
      client: stubClient(),
      subOrgId: 'sub-1',
      signWith: SOLANA_ADDRESS,
      publicKeyMultibase: mb,
    });
    expect(signer.getVerificationMethodId()).toBe(`did:key:${mb}`);
    expect(signer.getPublicKeyMultibase()).toBe(mb);
  });

  test('refuses to sign on a client that cannot, rather than failing obscurely', async () => {
    const signer = new TurnkeyCelSigner({
      client: stubClient(),
      subOrgId: 'sub-1',
      signWith: SOLANA_ADDRESS,
      publicKeyMultibase: authorshipPublicKeyMultibase(SOLANA_ADDRESS)!,
    });
    await expect(signer.signBytes(new Uint8Array([1, 2, 3]))).rejects.toThrow(/cannot sign raw payloads/i);
  });

  test('signs through turnkeySignBytes and returns its 64 bytes verbatim', async () => {
    const r = '0x' + '11'.repeat(32);
    const s = '0x' + '22'.repeat(32);
    let seen: { payload?: string; signWith?: string; organizationId?: string } = {};
    const client = stubClient({
      signRawPayload: async (params) => {
        seen = params;
        return { activity: { result: { signRawPayloadResult: { r, s } } } };
      },
    });
    const signer = new TurnkeyCelSigner({
      client,
      subOrgId: 'sub-1',
      signWith: SOLANA_ADDRESS,
      publicKeyMultibase: authorshipPublicKeyMultibase(SOLANA_ADDRESS)!,
    });
    const { signature } = await signer.signBytes(new Uint8Array([0xde, 0xad]));
    expect(signature.length).toBe(64);
    expect(signature[0]).toBe(0x11);
    expect(signature[63]).toBe(0x22);
    // The SDK owns canonicalization and hashing: the exact bytes go out.
    expect(seen.payload).toBe('0xdead');
    expect(seen.signWith).toBe(SOLANA_ADDRESS);
    expect(seen.organizationId).toBe('sub-1');
  });
});

describe('ensureAuthorshipAccount', () => {
  test('re-reads the existing account by path instead of creating a second', async () => {
    let created = 0;
    const client = stubClient({
      getWalletAccounts: async () => ({
        accounts: [{ address: SOLANA_ADDRESS, path: AUTHORSHIP_ACCOUNT.path }],
      }),
      createWalletAccounts: async () => {
        created++;
        return { addresses: ['nope'] };
      },
    });
    expect(await ensureAuthorshipAccount(client, 'sub-1')).toBe(SOLANA_ADDRESS);
    // An Original's controller identity must not move under it.
    expect(created).toBe(0);
  });

  test('creates the account on a miss, at the fixed authorship path', async () => {
    let asked: unknown = null;
    const client = stubClient({
      getWalletAccounts: async () => ({ accounts: [] }),
      createWalletAccounts: async (params) => {
        asked = params.accounts[0];
        return { addresses: [SOLANA_ADDRESS] };
      },
    });
    expect(await ensureAuthorshipAccount(client, 'sub-1')).toBe(SOLANA_ADDRESS);
    expect(asked).toMatchObject({ curve: 'CURVE_ED25519', path: AUTHORSHIP_ACCOUNT.path });
  });

  test('treats Turnkey’s “already exists” as proof to re-read, not as failure', async () => {
    let reads = 0;
    const client = stubClient({
      getWalletAccounts: async () => {
        reads++;
        return reads === 1
          ? { accounts: [] }
          : { accounts: [{ address: SOLANA_ADDRESS, path: AUTHORSHIP_ACCOUNT.path }] };
      },
      createWalletAccounts: async () => {
        throw new Error('wallet account already exists');
      },
    });
    expect(await ensureAuthorshipAccount(client, 'sub-1')).toBe(SOLANA_ADDRESS);
  });

  test('surfaces any other create failure', async () => {
    const client = stubClient({
      createWalletAccounts: async () => {
        throw new Error('turnkey is down');
      },
    });
    await expect(ensureAuthorshipAccount(client, 'sub-1')).rejects.toThrow(/turnkey is down/);
  });
});
