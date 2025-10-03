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

// Mock Privy client
const mockPrivyClient = {
  walletApi: {
    createWallet: mock(),
  },
} as any;

// Mock key utilities
mock.module("../key-utils", () => ({
  extractPublicKeyFromWallet: mock(() => "a".repeat(64)),
  convertToMultibase: mock((hex: string, type: string) => {
    if (type === 'Secp256k1') return `z${hex.substring(0, 40)}`;
    return `z${hex.substring(0, 40)}`;
  }),
}));

describe("DID:WebVH Service", () => {
  beforeEach(() => {
    mockPrivyClient.walletApi.createWallet.mockClear();
    mockResolveDID.mockClear();
    
    // Default mock implementations
    mockPrivyClient.walletApi.createWallet.mockImplementation((params: any) => {
      if (params.chainType === "bitcoin-segwit") {
        return Promise.resolve({
          id: "btc-wallet-1",
          chainType: "bitcoin-segwit",
          publicKey: "02" + "a".repeat(64),
        });
      } else if (params.chainType === "stellar") {
        return Promise.resolve({
          id: `stellar-wallet-${Date.now()}`,
          chainType: "stellar",
          publicKey: "a".repeat(64),
        });
      }
    });

    // No need to mock createDID since we're not using it anymore
  });

  describe("createUserDIDWebVH", () => {
    test("creates did:webvh with proper document structure", async () => {
      const userId = "did:privy:cltest123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient, "localhost:5000");

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
      await createUserDIDWebVH(userId, mockPrivyClient, "localhost:5000");

      expect(mockPrivyClient.walletApi.createWallet).toHaveBeenCalledTimes(3);
      
      // Bitcoin wallet for authentication
      expect(mockPrivyClient.walletApi.createWallet).toHaveBeenNthCalledWith(1, {
        owner: { userId },
        chainType: "bitcoin-segwit",
        policyIds: [],
      });

      // First Stellar wallet for assertion
      expect(mockPrivyClient.walletApi.createWallet).toHaveBeenNthCalledWith(2, {
        owner: { userId },
        chainType: "stellar",
        policyIds: [],
      });

      // Second Stellar wallet for updates
      expect(mockPrivyClient.walletApi.createWallet).toHaveBeenNthCalledWith(3, {
        owner: { userId },
        chainType: "stellar",
        policyIds: [],
      });
    });

    test("handles special characters in user ID", async () => {
      const userId = "did:privy:cl_test@user#123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient);

      expect(result.didSlug).toBe("cl-test-user-123");
      expect(result.did).toContain("cl-test-user-123");
    });

    test("strips did:privy prefix correctly", async () => {
      const userId = "did:privy:abc123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient);

      expect(result.didSlug).toBe("abc123");
      expect(result.did).toContain("abc123");
    });

    test("handles user ID without did:privy prefix", async () => {
      const userId = "abc123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient);

      expect(result.didSlug).toBe("abc123");
      expect(result.did).toContain("abc123");
    });

    test("throws error when wallet creation fails", async () => {
      mockPrivyClient.walletApi.createWallet.mockRejectedValue(new Error("Wallet creation failed"));

      await expect(
        createUserDIDWebVH("did:privy:test", mockPrivyClient)
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
      
      const result = await createUserDIDWebVH(userId, mockPrivyClient, domain);

      expect(result.did).toBe("did:webvh:example.com:testuser");
    });

    test("uses environment domain when not specified", async () => {
      process.env.DID_DOMAIN = "env.example.com";
      
      const result = await createUserDIDWebVH("did:privy:test", mockPrivyClient);

      expect(result.did).toBe("did:webvh:env.example.com:test");

      delete process.env.DID_DOMAIN;
    });

    test("encodes domain with port correctly", async () => {
      const result = await createUserDIDWebVH("did:privy:test", mockPrivyClient, "localhost:5000");

      expect(result.did).toBe("did:webvh:localhost%3A5000:test");
    });
  });
});
