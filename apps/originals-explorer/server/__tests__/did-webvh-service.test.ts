import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createUserDIDWebVH,
  getUserSlugFromDID,
  resolveDIDWebVH,
} from "../did-webvh-service";

// Mock the didwebvh-ts library (only resolveDID is used)
const mockResolveDID = mock();

mock.module("didwebvh-ts", () => ({
  resolveDID: mockResolveDID,
}));

// Mock wallet creation with storage
const mockCreateWallet = mock();
const mockRawSign = mock();
const createdWallets: Map<string, any> = new Map();

// Mock Privy client
const mockPrivyClient = {
  walletApi: {
    createWallet: mockCreateWallet,
  },
  wallets: mock(() => ({
    create: mockCreateWallet,
    rawSign: mockRawSign,
  })),
  users: mock(() => ({
    _get: mock((userId: string) => {
      // Return user with all wallets created for this user
      const userWallets = Array.from(createdWallets.values()).filter(w => 
        w.owner?.user_id === userId || w.userId === userId
      );
      return Promise.resolve({
        id: userId,
        linked_accounts: userWallets.map(w => ({ ...w, type: 'wallet' })),
      });
    }),
  })),
} as any;

// Mock key utilities
mock.module("../key-utils", () => ({
  extractPublicKeyFromWallet: mock((wallet: any) => {
    return wallet.publicKey || wallet.public_key || "a".repeat(64);
  }),
  convertToMultibase: mock((hex: string, type: string) => {
    // Return a proper Ed25519 multibase key with the correct header
    // z6Mk... prefix indicates Ed25519 public key
    if (type === 'Ed25519' || type === 'ed25519') {
      return 'z6Mk' + hex.substring(0, 40);
    }
    // For Secp256k1
    return 'zQ3s' + hex.substring(0, 40);
  }),
}));

describe("DID:WebVH Service", () => {
  beforeEach(() => {
    mockCreateWallet.mockClear();
    mockResolveDID.mockClear();
    mockRawSign.mockClear();
    createdWallets.clear();
    
    // Default mock implementations
    let walletCounter = 0;
    mockCreateWallet.mockImplementation((params: any) => {
      const chainType = params.chainType || params.chain_type;
      const userId = params.owner?.user_id || params.userId;
      walletCounter++;
      const wallet: any = {
        owner: { user_id: userId },
        userId,
      };
      
      if (chainType === "bitcoin-segwit") {
        wallet.id = `btc-wallet-${walletCounter}`;
        wallet.chainType = "bitcoin-segwit";
        wallet.chain_type = "bitcoin-segwit";
        wallet.publicKey = "02" + "a".repeat(64);
      } else if (chainType === "stellar") {
        wallet.id = `stellar-wallet-${walletCounter}`;
        wallet.chainType = "stellar";
        wallet.chain_type = "stellar";
        wallet.publicKey = "a".repeat(64);
      }
      
      // Store the wallet so it can be retrieved later
      createdWallets.set(wallet.id, wallet);
      return Promise.resolve(wallet);
    });

    mockRawSign.mockImplementation(() => Promise.resolve({
      signature: "0x" + "a".repeat(128),
      encoding: "hex",
    }));

    // No need to mock createDID since we're not using it anymore
  });

  describe("createUserDIDWebVH", () => {
    test("creates did:webvh with proper document structure", async () => {
      const userId = "did:privy:cltest123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient, "mock-auth-token", "localhost:5000");

      // Verify result structure
      expect(result.did).toBe("did:webvh:localhost%3A5000:cltest123");
      expect(result.didDocument).toBeDefined();
      expect(result.didDocument.id).toBe("did:webvh:localhost%3A5000:cltest123");
      expect(result.didDocument["@context"]).toContain("https://www.w3.org/ns/did/v1");
      expect(result.didDocument["@context"]).toContain("https://w3id.org/security/multikey/v1");
      expect(result.didDocument.verificationMethod).toHaveLength(2);
      expect(result.didDocument.authentication).toContain("did:webvh:localhost%3A5000:cltest123#auth-key");
      expect(result.didDocument.assertionMethod).toContain("did:webvh:localhost%3A5000:cltest123#assertion-key");
      expect(result.didLog).toBeDefined();
      expect(result.authWalletId).toBe("btc-wallet-1");
      expect(result.assertionWalletId).toBeDefined();
      expect(result.updateWalletId).toBeDefined();
      expect(result.didSlug).toBe("cltest123");
    });

    test("creates three wallets (Bitcoin + 2 Stellar)", async () => {
      const userId = "did:privy:cltest123";
      await createUserDIDWebVH(userId, mockPrivyClient, "mock-auth-token", "localhost:5000");

      expect(mockCreateWallet).toHaveBeenCalledTimes(2); // 2 Stellar wallets (auth and update)
      
      // Stellar wallet for authentication (first call)
      expect(mockCreateWallet).toHaveBeenNthCalledWith(1, expect.objectContaining({
        chain_type: "stellar",
      }));

      // Stellar wallet for updates (second call)
      expect(mockCreateWallet).toHaveBeenNthCalledWith(2, expect.objectContaining({
        chain_type: "stellar",
      }));
    });

    test("handles special characters in user ID", async () => {
      const userId = "did:privy:cl_test@user#123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient, "mock-auth-token");

      expect(result.didSlug).toBe("cl-test-user-123");
      expect(result.did).toContain("cl-test-user-123");
    });

    test("strips did:privy prefix correctly", async () => {
      const userId = "did:privy:abc123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient, "mock-auth-token");

      expect(result.didSlug).toBe("abc123");
      expect(result.did).toContain("abc123");
    });

    test("handles user ID without did:privy prefix", async () => {
      const userId = "abc123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient, "mock-auth-token");

      expect(result.didSlug).toBe("abc123");
      expect(result.did).toContain("abc123");
    });

    test("throws error when wallet creation fails", async () => {
      mockCreateWallet.mockRejectedValue(new Error("Wallet creation failed"));

      await expect(
        createUserDIDWebVH("did:privy:test", mockPrivyClient, "mock-auth-token")
      ).rejects.toThrow("Failed to create DID:WebVH");
    });
  });

  describe("resolveDIDWebVH", () => {
    test("resolves DID using didwebvh-ts library", async () => {
      const mockDoc = {
        "@context": ["https://www.w3.org/ns/did/v1"],
        "id": "did:webvh:example.com:test123"
      };

      mockResolveDID.mockResolvedValue({ doc: mockDoc });

      const result = await resolveDIDWebVH("did:webvh:example.com:test123");

      expect(mockResolveDID).toHaveBeenCalledWith("did:webvh:example.com:test123");
      expect(result).toEqual(mockDoc);
    });

    test("returns null when resolution fails", async () => {
      mockResolveDID.mockRejectedValue(new Error("Resolution failed"));

      const result = await resolveDIDWebVH("did:webvh:example.com:test123");

      expect(result).toBeNull();
    });
  });

  describe("getUserSlugFromDID", () => {
    test("extracts slug from did:webvh", () => {
      const slug = getUserSlugFromDID("did:webvh:localhost%3A5000:abc123");
      expect(slug).toBe("abc123");
    });

    test("returns null for invalid DID format", () => {
      const slug = getUserSlugFromDID("did:privy:abc123");
      expect(slug).toBeNull();
    });

    test("returns null for malformed did:webvh", () => {
      const slug = getUserSlugFromDID("did:webvh:domain");
      expect(slug).toBeNull();
    });

    test("handles complex domain with colons", () => {
      const slug = getUserSlugFromDID("did:webvh:example.com%3A8080:u-abc123");
      expect(slug).toBe("u-abc123");
    });
  });

  describe("Domain handling", () => {
    test("uses provided domain", async () => {
      const userId = "did:privy:testuser";
      const domain = "example.com";
      
      const result = await createUserDIDWebVH(userId, mockPrivyClient, "mock-auth-token", domain);

      expect(result.did).toBe("did:webvh:example.com:testuser");
    });

    test("uses environment domain when not specified", async () => {
      process.env.DID_DOMAIN = "env.example.com";
      
      const result = await createUserDIDWebVH("did:privy:test", mockPrivyClient, "mock-auth-token");

      expect(result.did).toBe("did:webvh:env.example.com:test");

      delete process.env.DID_DOMAIN;
    });

    test("encodes domain with port correctly", async () => {
      const result = await createUserDIDWebVH("did:privy:test", mockPrivyClient, "mock-auth-token", "localhost:5000");

      expect(result.did).toBe("did:webvh:localhost%3A5000:test");
    });
  });
});
