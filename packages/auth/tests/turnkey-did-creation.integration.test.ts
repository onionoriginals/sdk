/**
 * Integration test: Turnkey DID creation happy path with a real Ed25519 keypair.
 *
 * Background
 * ----------
 * The skipped tests in uncovered-scenarios.test.ts (AUTH-029) couldn't use a mock
 * Turnkey signRawPayload returning random bytes because didwebvh-ts calls
 * documentStateIsValid() immediately after signing, which performs real Ed25519
 * proof verification via verifier.verify().
 *
 * This file resolves that by constructing a *real* Ed25519 keypair and wrapping it
 * in a Turnkey-shaped signRawPayload mock that produces a genuine signature over
 * the exact payload bytes the SDK sends. The proof therefore verifies successfully
 * and createDIDWithTurnkey() can complete end-to-end without any source changes.
 *
 * Turnkey signRawPayload shape (what TurnkeyDIDSigner reads):
 *   { activity: { result: { signRawPayloadResult: { r: hexString, s: hexString } } } }
 * where r = first 32 bytes of the Ed25519 signature (hex),
 *       s = last 32 bytes of the Ed25519 signature (hex).
 */

import { describe, test, expect } from 'bun:test';
// Import the SDK first — its noble-init module configures @noble/ed25519's
// hashes.sha512 before any crypto operations run, so we don't need to
// configure it ourselves.
import { encoding } from '@originals/sdk';
import * as ed25519Module from '@noble/ed25519';
import { TurnkeyDIDSigner, createDIDWithTurnkey } from '../src/client/turnkey-did-signer';
import { TurnkeySessionExpiredError } from '../src/client/turnkey-client';
import type { Turnkey } from '@turnkey/sdk-server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// @noble/ed25519 v3 exports at the module level: getPublicKeyAsync, signAsync, utils.
const ed = ed25519Module as unknown as {
  utils: { randomSecretKey: () => Uint8Array };
  getPublicKeyAsync: (priv: Uint8Array) => Promise<Uint8Array>;
  signAsync: (msg: Uint8Array, priv: Uint8Array) => Promise<Uint8Array>;
};

// Multicodec prefix for Ed25519 public keys (0xed 0x01).
const ED25519_PUB_PREFIX = new Uint8Array([0xed, 0x01]);

/**
 * Encodes a 32-byte Ed25519 public key as a Multikey publicKeyMultibase string.
 * Format: "z" + base58btc( 0xed 0x01 || publicKeyBytes )
 * This is the format TurnkeyDIDSigner.getVerificationMethodId() and didwebvh-ts expect.
 */
function toPublicKeyMultibase(publicKeyBytes: Uint8Array): string {
  const prefixed = new Uint8Array(ED25519_PUB_PREFIX.length + publicKeyBytes.length);
  prefixed.set(ED25519_PUB_PREFIX);
  prefixed.set(publicKeyBytes, ED25519_PUB_PREFIX.length);
  // encoding.multibase.encode with 'base58btc' prepends the 'z' multibase prefix
  return encoding.multibase.encode(prefixed, 'base58btc');
}

/**
 * Generate a fresh Ed25519 keypair + the publicKeyMultibase string that
 * TurnkeyDIDSigner and didwebvh-ts expect.
 */
async function generateKeypair(): Promise<{
  privateKeyBytes: Uint8Array;
  publicKeyMultibase: string;
}> {
  const privateKeyBytes = ed.utils.randomSecretKey();
  const publicKeyBytes = await ed.getPublicKeyAsync(privateKeyBytes);
  const publicKeyMultibase = toPublicKeyMultibase(publicKeyBytes);
  return { privateKeyBytes, publicKeyMultibase };
}

/**
 * Build a Turnkey-shaped mock client whose signRawPayload:
 * 1. Receives the payload as a hex string (what TurnkeyDIDSigner sends).
 * 2. Signs it with the real Ed25519 private key.
 * 3. Returns the Turnkey-nested response shape the SDK expects.
 *
 * This allows TurnkeyDIDSigner to produce a signature that passes didwebvh-ts's
 * immediate post-creation Ed25519 proof verification.
 */
function makeRealSigningClient(
  privateKeyBytes: Uint8Array,
  callSpy?: { count: number }
): Turnkey {
  return {
    apiClient: () => ({
      signRawPayload: async (request: { payload: string; [k: string]: unknown }) => {
        if (callSpy) callSpy.count++;

        const payloadBytes = Buffer.from(request.payload, 'hex');
        const sigBytes = await ed.signAsync(payloadBytes, privateKeyBytes);

        // Ed25519 signature is always 64 bytes: first 32 = r, last 32 = s
        const r = Buffer.from(sigBytes.slice(0, 32)).toString('hex');
        const s = Buffer.from(sigBytes.slice(32, 64)).toString('hex');

        return {
          activity: { result: { signRawPayloadResult: { r, s } } },
        };
      },
    }),
  } as unknown as Turnkey;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('[AUTH-029-INTEGRATION] createDIDWithTurnkey — real Ed25519 keypair', () => {
  test(
    'happy path: returns { did, didDocument, didLog } with a valid did: identifier',
    async () => {
      const update = await generateKeypair();
      const auth = await generateKeypair();
      const assertion = await generateKeypair();

      const turnkeyClient = makeRealSigningClient(update.privateKeyBytes);

      const result = await createDIDWithTurnkey({
        turnkeyClient,
        updateKeyAccount: {
          address: 'key_addr_update',
          curve: 'CURVE_ED25519',
          path: "m/44'/501'/1'/0'",
          addressFormat: 'ADDRESS_FORMAT_SOLANA',
        },
        subOrgId: 'sub_org_integration_test',
        authKeyPublic: auth.publicKeyMultibase,
        assertionKeyPublic: assertion.publicKeyMultibase,
        updateKeyPublic: update.publicKeyMultibase,
        domain: 'magby.originals.build',
        slug: 'integration-test-user',
      });

      // Shape assertions
      expect(result).toHaveProperty('did');
      expect(result).toHaveProperty('didDocument');
      expect(result).toHaveProperty('didLog');

      // DID must be a string starting with "did:"
      expect(typeof result.did).toBe('string');
      expect(result.did).toMatch(/^did:/);

      // DID document must be a non-null object
      expect(result.didDocument).toBeTruthy();
      expect(typeof result.didDocument).toBe('object');

      // Log must be present
      expect(result.didLog).toBeTruthy();
    },
    15_000
  );

  test(
    'signRawPayload is called at least once during DID creation',
    async () => {
      const update = await generateKeypair();
      const auth = await generateKeypair();
      const assertion = await generateKeypair();

      const spy = { count: 0 };
      const turnkeyClient = makeRealSigningClient(update.privateKeyBytes, spy);

      await createDIDWithTurnkey({
        turnkeyClient,
        updateKeyAccount: {
          address: 'key_addr_update',
          curve: 'CURVE_ED25519',
          path: "m/44'/501'/1'/0'",
          addressFormat: 'ADDRESS_FORMAT_SOLANA',
        },
        subOrgId: 'sub_org_spy_test',
        authKeyPublic: auth.publicKeyMultibase,
        assertionKeyPublic: assertion.publicKeyMultibase,
        updateKeyPublic: update.publicKeyMultibase,
        domain: 'magby.originals.build',
        slug: 'spy-test-user',
      });

      expect(spy.count).toBeGreaterThan(0);
    },
    15_000
  );

  test(
    'TurnkeyDIDSigner.sign() with real keypair produces a z-prefixed base58btc proofValue',
    async () => {
      const { privateKeyBytes, publicKeyMultibase } = await generateKeypair();
      const turnkeyClient = makeRealSigningClient(privateKeyBytes);

      const signer = new TurnkeyDIDSigner(
        turnkeyClient,
        'key_addr_update',
        'sub_org_test',
        publicKeyMultibase
      );

      const result = await signer.sign({
        document: { id: 'did:webvh:magby.originals.build:test-signer' },
        proof: {
          type: 'DataIntegrityProof',
          cryptosuite: 'eddsa-jcs-2022',
          verificationMethod: `did:key:${publicKeyMultibase}`,
          created: new Date().toISOString(),
          proofPurpose: 'assertionMethod',
        },
      });

      expect(result).toHaveProperty('proofValue');
      expect(typeof result.proofValue).toBe('string');
      // base58btc multibase prefix
      expect(result.proofValue.startsWith('z')).toBe(true);
      // Ed25519 signature is 64 bytes; base58btc encoding of 64 bytes is ~88 chars
      expect(result.proofValue.length).toBeGreaterThan(80);
    },
    10_000
  );

  test(
    'expired session during DID creation fires onExpired and throws TurnkeySessionExpiredError',
    async () => {
      // Does not need a real key — throws before signing succeeds
      const expiredError = { code: 'api_key_expired', message: 'api_key_expired' };

      const turnkeyClient: Turnkey = {
        apiClient: () => ({
          signRawPayload: async () => { throw expiredError; },
        }),
      } as unknown as Turnkey;

      let onExpiredCalled = false;

      await expect(
        createDIDWithTurnkey({
          turnkeyClient,
          updateKeyAccount: {
            address: 'key_addr',
            curve: 'CURVE_ED25519',
            path: "m/44'/501'/1'/0'",
            addressFormat: 'ADDRESS_FORMAT_SOLANA',
          },
          subOrgId: 'sub_org_test',
          // Reuse the well-known fixture keys from uncovered-scenarios.test.ts
          authKeyPublic: 'z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp',
          assertionKeyPublic: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
          updateKeyPublic: 'z6MknGc3omQfErKtumfzKgaEsXYP4amJiosdMXaGK9PFqaHh',
          domain: 'magby.originals.build',
          slug: 'expired-session-test',
          onExpired: () => { onExpiredCalled = true; },
        })
      ).rejects.toBeInstanceOf(TurnkeySessionExpiredError);

      expect(onExpiredCalled).toBe(true);
    },
    10_000
  );
});
