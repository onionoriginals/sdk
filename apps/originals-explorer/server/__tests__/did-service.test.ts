import { describe, it, expect, jest, beforeEach, afterAll } from 'bun:test';
import { createUserDID, getUserSlugFromDID } from '../did-service';
import { convertToMultibase } from '../key-utils';

// Mock the PrivyClient
const mockPrivyClient = {
  walletApi: {
    createWallet: jest.fn(),
  },
} as any;

// Mock environment variables
const originalEnv = process.env;

describe('DID Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.DID_DOMAIN = 'localhost:5000';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('createUserDID', () => {
    it('should create a DID with all three wallet types', async () => {
      // Mock wallet creation responses
      const mockBtcWallet = {
        id: 'btc-wallet-id-123',
        address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
        publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
        chainType: 'bitcoin-segwit',
      };

      const mockStellarWallet1 = {
        id: 'stellar-wallet-id-456',
        address: 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37',
        publicKey: '5a8e9b3c7d1f2e4a6b8c0d9e1f3a5b7c9d0e2f4a6b8c0d9e1f3a5b7c9d0e2f4a',
        chainType: 'stellar',
      };

      const mockStellarWallet2 = {
        id: 'stellar-wallet-id-789',
        address: 'GCZJM35NKGVK47BB4SPBDV25477PZYIYPVVG453LPYFNXLS3FGHDXOCM',
        publicKey: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
        chainType: 'stellar',
      };

      mockPrivyClient.walletApi.createWallet
        .mockResolvedValueOnce(mockBtcWallet)
        .mockResolvedValueOnce(mockStellarWallet1)
        .mockResolvedValueOnce(mockStellarWallet2);

      const userId = 'did:privy:cltest123456';
      const result = await createUserDID(userId, mockPrivyClient);

      // Verify all three wallets were created
      expect(mockPrivyClient.walletApi.createWallet).toHaveBeenCalledTimes(3);

      // Verify Bitcoin wallet creation
      expect(mockPrivyClient.walletApi.createWallet).toHaveBeenNthCalledWith(1, {
        owner: { userId },
        chainType: 'bitcoin-segwit',
        policyIds: [],
      });

      // Verify Stellar wallet creations
      expect(mockPrivyClient.walletApi.createWallet).toHaveBeenNthCalledWith(2, {
        owner: { userId },
        chainType: 'stellar',
        policyIds: [],
      });

      expect(mockPrivyClient.walletApi.createWallet).toHaveBeenNthCalledWith(3, {
        owner: { userId },
        chainType: 'stellar',
        policyIds: [],
      });

      // Verify DID structure (domain should be URL-encoded)
      expect(result.did).toMatch(/^did:webvh:localhost%3A5000:cltest123456$/);
      expect(result.didDocument).toBeDefined();
      expect(result.didDocument['@context']).toEqual([
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1',
      ]);

      // Verify verification methods (only auth and assertion in did.jsonld)
      // Note: Update key is stored separately in did.jsonl for DID:WebVH
      expect(result.didDocument.verificationMethod).toHaveLength(2);
      expect(result.didDocument.verificationMethod[0].id).toContain('#auth-key');
      expect(result.didDocument.verificationMethod[1].id).toContain('#assertion-key');

      // Verify wallet IDs are stored
      expect(result.authWalletId).toBe('btc-wallet-id-123');
      expect(result.assertionWalletId).toBe('stellar-wallet-id-456');
      expect(result.updateWalletId).toBe('stellar-wallet-id-789');

      // Verify public keys are in multibase format
      expect(result.authKeyPublic).toMatch(/^z/);
      expect(result.assertionKeyPublic).toMatch(/^z/);
      expect(result.updateKeyPublic).toMatch(/^z/);

      // Verify timestamp
      expect(result.didCreatedAt).toBeInstanceOf(Date);
    });

    it('should sanitize user ID for slug', async () => {
      const mockWallet = {
        id: 'wallet-id',
        publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      };

      mockPrivyClient.walletApi.createWallet.mockResolvedValue(mockWallet);

      const userId = 'did:privy:cl_test@user#123';
      const result = await createUserDID(userId, mockPrivyClient);

      // Should remove "did:privy:" prefix and sanitize special chars
      // Domain with port should be URL-encoded
      expect(result.did).toMatch(/^did:webvh:localhost%3A5000:cl-test-user-123$/);
    });

    it('should use custom domain from environment', async () => {
      process.env.DID_DOMAIN = 'app.example.com';

      const mockWallet = {
        id: 'wallet-id',
        publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      };

      mockPrivyClient.walletApi.createWallet.mockResolvedValue(mockWallet);

      const result = await createUserDID('user123', mockPrivyClient);

      // Domain without port doesn't need encoding (no special chars)
      expect(result.did).toMatch(/^did:webvh:app\.example\.com:user123$/);
    });

    it('should throw error if wallet creation fails', async () => {
      mockPrivyClient.walletApi.createWallet.mockRejectedValue(
        new Error('Wallet creation failed')
      );

      await expect(
        createUserDID('user123', mockPrivyClient)
      ).rejects.toThrow('Failed to create DID');
    });

    it('should include authentication and assertion methods in DID document', async () => {
      const mockWallet = {
        id: 'wallet-id',
        publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      };

      mockPrivyClient.walletApi.createWallet.mockResolvedValue(mockWallet);

      const result = await createUserDID('user123', mockPrivyClient);

      expect(result.didDocument.authentication).toEqual([
        `${result.did}#auth-key`,
      ]);
      expect(result.didDocument.assertionMethod).toEqual([
        `${result.did}#assertion-key`,
      ]);
      
      // Update key should NOT be in the DID document
      // It's stored separately in did.jsonl for DID:WebVH
      expect(result.didDocument.capabilityInvocation).toBeUndefined();
      expect(result.didDocument.verificationMethod).toHaveLength(2);
    });
  });

  describe('getUserSlugFromDID', () => {
    it('should extract user slug from valid DID with URL-encoded domain', () => {
      const did = 'did:webvh:localhost%3A5000:user123';
      const slug = getUserSlugFromDID(did);
      expect(slug).toBe('user123');
    });

    it('should extract slug from DID without port', () => {
      const did = 'did:webvh:app.example.com:user123';
      const slug = getUserSlugFromDID(did);
      expect(slug).toBe('user123');
    });

    it('should handle DIDs with hyphens in slug', () => {
      const did = 'did:webvh:app.example.com:test-user-456';
      const slug = getUserSlugFromDID(did);
      expect(slug).toBe('test-user-456');
    });

    it('should return null for invalid DID format', () => {
      expect(getUserSlugFromDID('invalid-did')).toBeNull();
      expect(getUserSlugFromDID('did:web:example.com')).toBeNull();
      expect(getUserSlugFromDID('did:webvh:domain')).toBeNull(); // Missing slug
      expect(getUserSlugFromDID('')).toBeNull();
    });
  });

  describe('DID Document Structure', () => {
    it('should create valid DID document with all required fields', async () => {
      const mockWallet = {
        id: 'wallet-id',
        publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      };

      mockPrivyClient.walletApi.createWallet.mockResolvedValue(mockWallet);

      const result = await createUserDID('user123', mockPrivyClient);
      const doc = result.didDocument;

      // Required top-level fields
      expect(doc).toHaveProperty('@context');
      expect(doc).toHaveProperty('id');
      expect(doc).toHaveProperty('verificationMethod');
      expect(doc).toHaveProperty('authentication');
      expect(doc).toHaveProperty('assertionMethod');
      
      // Should NOT have capabilityInvocation (update key in did.jsonl)
      expect(doc).not.toHaveProperty('capabilityInvocation');
      
      // Should have exactly 2 verification methods
      expect(doc.verificationMethod).toHaveLength(2);

      // Verification methods should have required fields
      doc.verificationMethod.forEach((vm: any) => {
        expect(vm).toHaveProperty('id');
        expect(vm).toHaveProperty('type');
        expect(vm).toHaveProperty('controller');
        expect(vm).toHaveProperty('publicKeyMultibase');
        expect(vm.type).toBe('Multikey');
      });

      // Controller should match DID
      doc.verificationMethod.forEach((vm: any) => {
        expect(vm.controller).toBe(result.did);
      });
    });
  });
});

describe('Key Utilities', () => {
  describe('convertToMultibase', () => {
    it('should convert hex public key to multibase format', () => {
      const hexKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
      const multibaseKey = convertToMultibase(hexKey, 'Secp256k1');

      // Should start with 'z' (base58btc encoding)
      expect(multibaseKey).toMatch(/^z/);
      expect(multibaseKey.length).toBeGreaterThan(40);
    });

    it('should handle hex keys with 0x prefix', () => {
      const hexKey = '0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
      const multibaseKey = convertToMultibase(hexKey, 'Secp256k1');

      expect(multibaseKey).toMatch(/^z/);
    });

    it('should convert Ed25519 keys', () => {
      const hexKey = '5a8e9b3c7d1f2e4a6b8c0d9e1f3a5b7c9d0e2f4a6b8c0d9e1f3a5b7c9d0e2f4a';
      const multibaseKey = convertToMultibase(hexKey, 'Ed25519');

      expect(multibaseKey).toMatch(/^z/);
    });
  });
});
