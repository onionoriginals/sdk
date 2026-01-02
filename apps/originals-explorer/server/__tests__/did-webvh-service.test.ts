import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  createUserDIDWebVH,
  getUserSlugFromDID,
  resolveDIDWebVH,
} from "../did-webvh-service";

// Mock the originals SDK
const mockCreateDIDWebVH = mock();
const mockResolveDID = mock();

mock.module("../originals", () => ({
  originalsSdk: {
    did: {
      createDIDWebVH: mockCreateDIDWebVH,
      resolveDID: mockResolveDID,
    },
  },
}));

// Mock the turnkey-signer
mock.module("../turnkey-signer", () => ({
  createTurnkeySigner: mock(() => Promise.resolve({
    sign: mock(() => Promise.resolve({ proofValue: "z" + "a".repeat(86) })),
    getVerificationMethodId: () => "did:webvh:test:user#update-key",
  })),
}));

// Mock key utilities
mock.module("../key-utils", () => ({
  convertToMultibase: mock((hex: string, type: string) => {
    if (type === 'Ed25519') {
      return 'z6Mk' + hex.substring(0, 40);
    }
    return 'zQ3s' + hex.substring(0, 40);
  }),
}));

// Mock Turnkey client
const mockGetWallets = mock();
const mockGetWalletAccounts = mock();

const mockTurnkeyClient = {
  apiClient: () => ({
    getWallets: mockGetWallets,
    getWalletAccounts: mockGetWalletAccounts,
  }),
} as any;

describe("DID:WebVH Service", () => {
  beforeEach(() => {
    mockCreateDIDWebVH.mockClear();
    mockResolveDID.mockClear();
    mockGetWallets.mockClear();
    mockGetWalletAccounts.mockClear();
    
    // Default mock implementations
    mockGetWallets.mockResolvedValue({
      wallets: [
        { walletId: "wallet-1", walletName: "Default Wallet" }
      ]
    });
    
    mockGetWalletAccounts.mockResolvedValue({
      accounts: [
        { address: "auth-address", publicKey: "02" + "a".repeat(64), curve: "CURVE_SECP256K1" },
        { address: "assertion-address", publicKey: "b".repeat(64), curve: "CURVE_ED25519" },
        { address: "update-address", publicKey: "c".repeat(64), curve: "CURVE_ED25519" },
      ]
    });
    
    mockCreateDIDWebVH.mockResolvedValue({
      did: "did:webvh:localhost%3A5000:testuser",
      didDocument: {
        "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
        id: "did:webvh:localhost%3A5000:testuser",
        verificationMethod: [
          { id: "#auth-key", type: "Multikey", publicKeyMultibase: "zQ3stest" },
          { id: "#assertion-key", type: "Multikey", publicKeyMultibase: "z6Mktest" }
        ],
        authentication: ["did:webvh:localhost%3A5000:testuser#auth-key"],
        assertionMethod: ["did:webvh:localhost%3A5000:testuser#assertion-key"],
      },
      log: [{ versionId: "1", versionTime: new Date().toISOString() }],
      keyPair: { publicKey: "", privateKey: "" },
    });
  });

  describe("createUserDIDWebVH", () => {
    test("creates did:webvh with proper document structure", async () => {
      const turnkeySubOrgId = "sub-org-123";
      const result = await createUserDIDWebVH(turnkeySubOrgId, mockTurnkeyClient, "localhost:5000");

      expect(result.did).toBe("did:webvh:localhost%3A5000:testuser");
      expect(result.didDocument).toBeDefined();
      expect(result.didDocument["@context"]).toContain("https://www.w3.org/ns/did/v1");
      expect(result.didLog).toBeDefined();
      expect(result.authKeyPublic).toBeDefined();
      expect(result.assertionKeyPublic).toBeDefined();
      expect(result.updateKeyPublic).toBeDefined();
    });

    test("uses wallets from the sub-org", async () => {
      const turnkeySubOrgId = "sub-org-123";
      await createUserDIDWebVH(turnkeySubOrgId, mockTurnkeyClient, "localhost:5000");

      expect(mockGetWallets).toHaveBeenCalledWith({
        organizationId: turnkeySubOrgId,
      });
      expect(mockGetWalletAccounts).toHaveBeenCalled();
    });

    test("handles special characters in sub-org ID", async () => {
      mockCreateDIDWebVH.mockResolvedValue({
        did: "did:webvh:localhost%3A5000:sub-test-user-123",
        didDocument: { id: "did:webvh:localhost%3A5000:sub-test-user-123", "@context": [] },
        log: [],
        keyPair: { publicKey: "", privateKey: "" },
      });
      
      const turnkeySubOrgId = "sub_test@user#123";
      const result = await createUserDIDWebVH(turnkeySubOrgId, mockTurnkeyClient);

      expect(result.didSlug).toBe("sub-test-user-123");
    });

    test("generates proper user slug", async () => {
      mockCreateDIDWebVH.mockResolvedValue({
        did: "did:webvh:localhost%3A5000:abc123",
        didDocument: { id: "did:webvh:localhost%3A5000:abc123", "@context": [] },
        log: [],
        keyPair: { publicKey: "", privateKey: "" },
      });
      
      const turnkeySubOrgId = "abc123";
      const result = await createUserDIDWebVH(turnkeySubOrgId, mockTurnkeyClient);

      expect(result.didSlug).toBe("abc123");
    });

    test("throws error when no wallets found", async () => {
      mockGetWallets.mockResolvedValue({ wallets: [] });

      await expect(
        createUserDIDWebVH("sub-org-123", mockTurnkeyClient)
      ).rejects.toThrow("No wallets found");
    });

    test("throws error when not enough accounts", async () => {
      mockGetWalletAccounts.mockResolvedValue({
        accounts: [
          { address: "auth-address", publicKey: "02" + "a".repeat(64) },
        ]
      });

      await expect(
        createUserDIDWebVH("sub-org-123", mockTurnkeyClient)
      ).rejects.toThrow("Expected 3 wallet accounts");
    });
  });

  describe("resolveDIDWebVH", () => {
    test("resolves DID using the SDK", async () => {
      const mockDoc = {
        "@context": ["https://www.w3.org/ns/did/v1"],
        "id": "did:webvh:example.com:test123"
      };

      mockResolveDID.mockResolvedValue(mockDoc);

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
      const slug = getUserSlugFromDID("did:key:abc123");
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
      mockCreateDIDWebVH.mockResolvedValue({
        did: "did:webvh:example.com:testuser",
        didDocument: { id: "did:webvh:example.com:testuser", "@context": [] },
        log: [],
        keyPair: { publicKey: "", privateKey: "" },
      });
      
      const turnkeySubOrgId = "testuser";
      const domain = "example.com";
      
      const result = await createUserDIDWebVH(turnkeySubOrgId, mockTurnkeyClient, domain);

      expect(result.did).toBe("did:webvh:example.com:testuser");
    });

    test("encodes domain with port correctly", async () => {
      mockCreateDIDWebVH.mockResolvedValue({
        did: "did:webvh:localhost%3A5000:test",
        didDocument: { id: "did:webvh:localhost%3A5000:test", "@context": [] },
        log: [],
        keyPair: { publicKey: "", privateKey: "" },
      });
      
      const result = await createUserDIDWebVH("test", mockTurnkeyClient, "localhost:5000");

      expect(result.did).toBe("did:webvh:localhost%3A5000:test");
    });
  });
});
