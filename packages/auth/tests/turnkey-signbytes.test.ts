/**
 * Plan 045: a Turnkey key can author Originals provenance.
 *
 * Before this, both Turnkey signers implemented only the document-level
 * `sign({document, proof})`, so `signerFromExternalSigner` threw on them and a
 * Turnkey-backed consumer had to rebuild Turnkey signing itself. The
 * byte-level primitive was already there — buried inside `sign()` and
 * duplicated across the two signers, kept in sync by comment.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import * as ed25519Module from '@noble/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  signerFromExternalSigner,
  assertSignerConformance,
  multikey,
  encoding,
  base58AddressToEd25519Multikey,
} from '@originals/sdk';
import { turnkeySignBytes } from '../src/turnkey-sign-bytes';
import { TurnkeyWebVHSigner } from '../src/server/turnkey-signer';
import type { Turnkey } from '@turnkey/sdk-server';

// @noble/ed25519 v3 exports getPublicKeyAsync/signAsync/verifyAsync at module level.
const ed = ed25519Module as unknown as {
  utils: { randomSecretKey: () => Uint8Array };
  getPublicKeyAsync: (priv: Uint8Array) => Promise<Uint8Array>;
  signAsync: (msg: Uint8Array, priv: Uint8Array) => Promise<Uint8Array>;
  verifyAsync: (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => Promise<boolean>;
};

/** A Turnkey-shaped client that signs with a real Ed25519 key. */
function makeTurnkey(privateKey: Uint8Array, spy?: { payloads: string[] }): Turnkey {
  return {
    apiClient: () => ({
      signRawPayload: async (req: { payload: string }) => {
        spy?.payloads.push(req.payload);
        const hex = req.payload.startsWith('0x') ? req.payload.slice(2) : req.payload;
        const sig = await ed.signAsync(Uint8Array.from(Buffer.from(hex, 'hex')), privateKey);
        return {
          activity: {
            result: {
              signRawPayloadResult: {
                r: Buffer.from(sig.slice(0, 32)).toString('hex'),
                s: Buffer.from(sig.slice(32)).toString('hex'),
              },
            },
          },
        };
      },
    }),
  } as unknown as Turnkey;
}

/** Buffer-free variant of the double, for the no-Buffer environment test. */
function makeTurnkeyNoBuffer(privateKey: Uint8Array): Turnkey {
  return {
    apiClient: () => ({
      signRawPayload: async (req: { payload: string }) => {
        const hex = req.payload.startsWith('0x') ? req.payload.slice(2) : req.payload;
        const sig = await ed.signAsync(hexToBytes(hex), privateKey);
        return {
          activity: {
            result: {
              signRawPayloadResult: {
                r: bytesToHex(sig.slice(0, 32)),
                s: bytesToHex(sig.slice(32)),
              },
            },
          },
        };
      },
    }),
  } as unknown as Turnkey;
}

describe('turnkeySignBytes', () => {
  const privateKey = ed.utils.randomSecretKey();

  test('signs the exact bytes it is given (nothing is hashed on the way)', async () => {
    const data = new TextEncoder().encode('exactly these bytes');
    const sig = await turnkeySignBytes(
      { turnkeyClient: makeTurnkey(privateKey), organizationId: 'org', signWith: 'acct' },
      data
    );
    expect(sig.length).toBe(64);
    const publicKey = await ed.getPublicKeyAsync(privateKey);
    expect(await ed.verifyAsync(sig, data, publicKey)).toBe(true);
  });

  test('sends the payload pre-hashed (HASH_FUNCTION_NO_OP) as hex', async () => {
    const spy = { payloads: [] as string[] };
    const data = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    await turnkeySignBytes(
      { turnkeyClient: makeTurnkey(privateKey, spy), organizationId: 'org', signWith: 'acct' },
      data
    );
    expect(spy.payloads[0].toLowerCase()).toContain('deadbeef');
  });

  test('works with no global Buffer — it is a browser-facing root export', async () => {
    // The client signer runs in the browser, where `Buffer` is undefined
    // without a bundler shim. Hex conversion must not depend on it.
    const realBuffer = globalThis.Buffer;
    // @ts-expect-error - deliberately removing a global for the duration
    delete globalThis.Buffer;
    try {
      const data = new TextEncoder().encode('no Buffer here');
      const sig = await turnkeySignBytes(
        { turnkeyClient: makeTurnkeyNoBuffer(privateKey), organizationId: 'org', signWith: 'acct' },
        data
      );
      expect(sig.length).toBe(64);
      const publicKey = await ed.getPublicKeyAsync(privateKey);
      expect(await ed.verifyAsync(sig, data, publicKey)).toBe(true);
    } finally {
      globalThis.Buffer = realBuffer;
    }
  });

  test('rejects a legacy flat {r,s} response', async () => {
    const flat = {
      apiClient: () => ({ signRawPayload: async () => ({ r: 'aa', s: 'bb' }) }),
    } as unknown as Turnkey;
    await expect(
      turnkeySignBytes({ turnkeyClient: flat, organizationId: 'o', signWith: 'a' }, new Uint8Array(1))
    ).rejects.toThrow(/Invalid signature response from Turnkey/);
  });

  test('rejects a signature that is not 64 bytes rather than truncating', async () => {
    const short = {
      apiClient: () => ({
        signRawPayload: async () => ({
          activity: { result: { signRawPayloadResult: { r: 'aa', s: 'bb' } } },
        }),
      }),
    } as unknown as Turnkey;
    await expect(
      turnkeySignBytes({ turnkeyClient: short, organizationId: 'o', signWith: 'a' }, new Uint8Array(1))
    ).rejects.toThrow(/Invalid Ed25519 signature length: 2/);
  });
});

describe('TurnkeyWebVHSigner satisfies the SDK signer interface [plan 045]', () => {
  const privateKey = ed.utils.randomSecretKey();
  let publicKeyMultibase = '';
  let vmId = '';
  beforeAll(async () => {
    publicKeyMultibase = multikey.encodePublicKey(await ed.getPublicKeyAsync(privateKey), 'Ed25519');
    vmId = `did:key:${publicKeyMultibase}#${publicKeyMultibase}`;
  });

  const makeSigner = () =>
    new TurnkeyWebVHSigner('sub-org', 'key-id', publicKeyMultibase, makeTurnkey(privateKey), vmId);

  test('converts to an OriginalsSigner — this used to throw', async () => {
    const signer = signerFromExternalSigner(makeSigner(), { publicKeyMultibase });
    expect(signer.verificationMethodId).toBe(vmId);
    expect(signer.publicKeyMultibase).toBe(publicKeyMultibase);
  });

  test('passes the conformance harness, so it can author CEL events', async () => {
    await assertSignerConformance(signerFromExternalSigner(makeSigner(), { publicKeyMultibase }));
  });
});

describe('base58AddressToEd25519Multikey bridges a Turnkey account address', () => {
  test('an ADDRESS_FORMAT_SOLANA address becomes a usable Multikey', async () => {
    const publicKey = await ed.getPublicKeyAsync(ed.utils.randomSecretKey());
    // Turnkey Ed25519 accounts report ADDRESS_FORMAT_SOLANA: base58 of the raw key.
    const address = encoding.base58.encode(publicKey);
    expect(base58AddressToEd25519Multikey(address)).toBe(
      multikey.encodePublicKey(publicKey, 'Ed25519')
    );
  });
});
