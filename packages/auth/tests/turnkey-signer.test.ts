import { describe, test, expect, mock } from 'bun:test';
import { TurnkeyWebVHSigner, createTurnkeySigner } from '../src/server/turnkey-signer';
import { multikey } from '@originals/sdk';

describe('turnkey-signer', () => {
  describe('createTurnkeySigner', () => {
    test('creates a TurnkeyWebVHSigner instance', () => {
      const mockClient = {} as unknown as import('@turnkey/sdk-server').Turnkey;
      const signer = createTurnkeySigner({
        turnkeyClient: mockClient,
        organizationId: 'org_123',
        privateKeyId: 'key_456',
        verificationMethodId: 'did:key:z6Mk...#z6Mk...',
        publicKeyMultibase: 'z6Mk...',
      });

      expect(signer).toBeInstanceOf(TurnkeyWebVHSigner);
    });

    test('signer returns correct verification method ID', () => {
      const mockClient = {} as unknown as import('@turnkey/sdk-server').Turnkey;
      const signer = createTurnkeySigner({
        turnkeyClient: mockClient,
        organizationId: 'org_123',
        privateKeyId: 'key_456',
        verificationMethodId: 'did:key:z6MkTest#z6MkTest',
        publicKeyMultibase: 'z6MkTest',
      });

      expect(signer.getVerificationMethodId()).toBe('did:key:z6MkTest#z6MkTest');
    });

    test('signer returns correct public key multibase', () => {
      const mockClient = {} as unknown as import('@turnkey/sdk-server').Turnkey;
      const signer = createTurnkeySigner({
        turnkeyClient: mockClient,
        organizationId: 'org_123',
        privateKeyId: 'key_456',
        verificationMethodId: 'did:key:z6MkTest#z6MkTest',
        publicKeyMultibase: 'z6MkTestPublicKey',
      });

      expect(signer.getPublicKeyMultibase()).toBe('z6MkTestPublicKey');
    });
  });

  describe('TurnkeyWebVHSigner', () => {
    test('constructor stores all parameters correctly', () => {
      const mockClient = {} as unknown as import('@turnkey/sdk-server').Turnkey;
      const signer = new TurnkeyWebVHSigner(
        'sub_org_id',
        'key_id',
        'z6MkPubKey',
        mockClient,
        'did:key:z6Mk#z6Mk'
      );

      expect(signer.getVerificationMethodId()).toBe('did:key:z6Mk#z6Mk');
      expect(signer.getPublicKeyMultibase()).toBe('z6MkPubKey');
    });

    test('sign throws when Turnkey returns no signature', async () => {
      const mockClient = {
        apiClient: () => ({
          signRawPayload: mock(() =>
            Promise.resolve({
              activity: {
                result: {
                  signRawPayloadResult: { r: null, s: null },
                },
              },
            })
          ),
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;

      const signer = new TurnkeyWebVHSigner(
        'sub_org_id',
        'key_id',
        'z6MkPubKey',
        mockClient,
        'did:key:z6Mk#z6Mk'
      );

      await expect(
        signer.sign({
          document: { id: 'did:example:123' },
          proof: { type: 'DataIntegrityProof' },
        })
      ).rejects.toThrow('Failed to sign with Turnkey');
    });

    test('sign rejects a 65-byte signature instead of silently truncating it', async () => {
      // 32-byte r + 33-byte s = 65 bytes total. A valid Ed25519 signature is
      // exactly 64 bytes; the server signer must reject (not truncate) this,
      // matching the client-side TurnkeyDIDSigner behaviour.
      const r = '00'.repeat(32);
      const s = '11'.repeat(33);
      const mockClient = {
        apiClient: () => ({
          signRawPayload: mock(() =>
            Promise.resolve({
              activity: {
                result: {
                  signRawPayloadResult: { r, s },
                },
              },
            })
          ),
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;

      const signer = new TurnkeyWebVHSigner(
        'sub_org_id',
        'key_id',
        'z6MkPubKey',
        mockClient,
        'did:key:z6Mk#z6Mk'
      );

      await expect(
        signer.sign({
          document: { id: 'did:example:123' },
          proof: { type: 'DataIntegrityProof' },
        })
      ).rejects.toThrow(/65 \(expected 64 bytes\)/);
    });

    test('sign produces a proofValue for a valid 64-byte signature', async () => {
      const r = 'aa'.repeat(32);
      const s = 'bb'.repeat(32);
      const mockClient = {
        apiClient: () => ({
          signRawPayload: mock(() =>
            Promise.resolve({
              activity: {
                result: {
                  signRawPayloadResult: { r, s },
                },
              },
            })
          ),
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;

      const signer = new TurnkeyWebVHSigner(
        'sub_org_id',
        'key_id',
        'z6MkPubKey',
        mockClient,
        'did:key:z6Mk#z6Mk'
      );

      const result = await signer.sign({
        document: { id: 'did:example:123' },
        proof: { type: 'DataIntegrityProof' },
      });

      expect(typeof result.proofValue).toBe('string');
      expect(result.proofValue.length).toBeGreaterThan(0);
    });

    test('sign handles r and s both 0x-prefixed without corrupting the signature', async () => {
      // Regression: Turnkey may return r and s each carrying a '0x' prefix.
      // The signer must strip the prefix from EACH component separately. The
      // buggy implementation concatenated first and stripped only the single
      // leading '0x', leaving an embedded '0x' in the middle of the hex string
      // (e.g. 'aaaa...0xbbbb...') which corrupts the decoded signature bytes.
      const rHex = 'aa'.repeat(32);
      const sHex = 'bb'.repeat(32);
      const mockClient = {
        apiClient: () => ({
          signRawPayload: mock(() =>
            Promise.resolve({
              activity: {
                result: {
                  signRawPayloadResult: { r: `0x${rHex}`, s: `0x${sHex}` },
                },
              },
            })
          ),
        }),
      } as unknown as import('@turnkey/sdk-server').Turnkey;

      const signer = new TurnkeyWebVHSigner(
        'sub_org_id',
        'key_id',
        'z6MkPubKey',
        mockClient,
        'did:key:z6Mk#z6Mk'
      );

      const result = await signer.sign({
        document: { id: 'did:example:123' },
        proof: { type: 'DataIntegrityProof' },
      });

      // Decode the multibase proofValue back to the raw 64-byte signature and
      // confirm it is exactly the concatenation of the r and s bytes (with the
      // 0x prefixes correctly stripped).
      const decoded = multikey.decodeMultibase(result.proofValue);
      const expected = Buffer.from(rHex + sHex, 'hex');
      expect(decoded.length).toBe(64);
      expect(Buffer.from(decoded).equals(expected)).toBe(true);
    });

    test('verify returns false for invalid public key length', async () => {
      const mockClient = {} as unknown as import('@turnkey/sdk-server').Turnkey;
      const signer = new TurnkeyWebVHSigner(
        'sub_org_id',
        'key_id',
        'z6MkPubKey',
        mockClient,
        'did:key:z6Mk#z6Mk'
      );

      const signature = new Uint8Array(64);
      const message = new Uint8Array(32);
      const badPublicKey = new Uint8Array(16); // wrong length

      const result = await signer.verify(signature, message, badPublicKey);
      expect(result).toBe(false);
    });
  });
});
