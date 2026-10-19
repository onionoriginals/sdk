/**
 * The Turnkey authorship key that signs a signed-in user's Originals entries.
 *
 * The bug these guard against: an Original's controller key used to be minted
 * into an in-memory Map and destroyed with the tab, so a published Original
 * could never be inscribed afterwards. Everything here is about that key being
 * (a) derived from Turnkey's account correctly and (b) refused loudly, up
 * front, when this client cannot produce one.
 */
import { describe, test, expect } from 'bun:test';
import { base58 } from '@scure/base';
import { authorshipPublicKeyMultibase, canAuthor, turnkeyAuthorshipSigner } from './turnkey-authorship-signer';
import { hex } from '@scure/base';
import { ed25519 } from '@noble/curves/ed25519.js';
import { localSigner, multibaseEncode, proofHashData, verifyProof } from '@originals/vh/crypto';
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

describe('turnkeyAuthorshipSigner', () => {
  const SECRET = new Uint8Array(32).fill(9);
  const author = localSigner('Ed25519', SECRET);
  const did = 'did:webvh:QmfKdRx6tJWUu8HmhyiRA7kbLyFCiCcifDpK7k6i3H2CHb:example.com';
  const vm = `${did}#key-1`;
  // A stub Turnkey client that signs exactly what it is sent, with a real key.
  const signing = (seen: { payload?: string; hashFunction?: string } = {}) => stubClient({
    signRawPayload: async (params) => {
      Object.assign(seen, params);
      const sig = ed25519.sign(hex.decode(params.payload.slice(2)), SECRET);
      return { activity: { result: { signRawPayloadResult: { r: '0x' + hex.encode(sig.slice(0, 32)), s: '0x' + hex.encode(sig.slice(32)) } } } };
    },
  });
  const entry = { versionId: '1-Qm', versionTime: '2026-10-18T12:00:00.000Z', parameters: { method: 'originals:1.0' }, state: { id: 'did:vh:QmScid', author: { did, verificationMethod: vm, versionId: '1-x' } } };
  const proofOptions = { type: 'DataIntegrityProof' as const, cryptosuite: 'eddsa-jcs-2022', verificationMethod: vm, proofPurpose: 'assertionMethod' };

  test('signs the eddsa-jcs-2022 hash data of the entry, which then verifies', async () => {
    const seen: { payload?: string; hashFunction?: string } = {};
    const signer = turnkeyAuthorshipSigner({ client: signing(seen), subOrgId: 'sub-1', signWith: SOLANA_ADDRESS, verificationMethod: vm });
    const signature = await signer.sign({ entry: entry as never, proofOptions, summary: {} as never });
    expect(seen.hashFunction).toBe('HASH_FUNCTION_NOT_APPLICABLE');
    expect(seen.payload).toBe('0x' + hex.encode(proofHashData(entry as never, proofOptions)));
    const proof = { ...proofOptions, proofValue: multibaseEncode(signature) };
    expect(verifyProof(entry as never, proof, author.publicKeyMultibase)).toBe(true);
  });

  test('refuses an entry naming another author key, or a non-Originals entry', async () => {
    const signer = turnkeyAuthorshipSigner({ client: signing(), subOrgId: 'sub-1', signWith: SOLANA_ADDRESS, verificationMethod: vm });
    await expect(signer.sign({ entry: { ...entry, state: { ...entry.state, author: { ...entry.state.author, verificationMethod: `${did}#key-0` } } } as never, proofOptions, summary: {} as never })).rejects.toThrow(/different author key/);
    await expect(signer.sign({ entry: { ...entry, state: { ...entry.state, id: 'did:webvh:x' } } as never, proofOptions, summary: {} as never })).rejects.toThrow(/Not an Originals entry/);
  });

  test('refuses to sign on a client that cannot, rather than failing obscurely', async () => {
    const signer = turnkeyAuthorshipSigner({ client: stubClient(), subOrgId: 'sub-1', signWith: SOLANA_ADDRESS, verificationMethod: vm });
    await expect(signer.sign({ entry: entry as never, proofOptions, summary: {} as never })).rejects.toThrow(/cannot sign raw payloads/i);
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
