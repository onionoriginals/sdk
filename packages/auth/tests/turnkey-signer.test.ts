import { describe, test, expect, mock } from 'bun:test';
import { TurnkeyWebVHSigner, createTurnkeySigner } from '../src/server/turnkey-signer';

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
