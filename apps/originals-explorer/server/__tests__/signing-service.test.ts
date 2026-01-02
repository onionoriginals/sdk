import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  signWithUserKey,
  verifySignature,
  getVerificationMethodId,
  type KeyPurpose,
} from "../signing-service";

// Mock storage
const mockStorage = {
  getUser: mock(),
  getUserByDid: mock(),
  createUserWithDid: mock(),
  updateUser: mock(),
  getUserByTurnkeyId: mock(),
  createAsset: mock(),
  getAsset: mock(),
  getAssetsByUserId: mock(),
  updateAsset: mock(),
  createAssetType: mock(),
  getAssetTypesByUserId: mock(),
  createWalletConnection: mock(),
  getWalletConnection: mock(),
  getStats: mock(),
  getUserByDidSlug: mock(),
};

mock.module("../storage", () => ({
  storage: mockStorage,
}));

const mockTurnkeyClient = {
  createSigner: mock(),
} as any;

describe("signing-service", () => {
  beforeEach(() => {
    mockStorage.getUser.mockClear();
    mockStorage.getUserByDid.mockClear();
  });

  describe("signWithUserKey", () => {
    test("throws error for user not found", async () => {
      mockStorage.getUser.mockResolvedValue(null);

      await expect(
        signWithUserKey("user-123", "authentication", "data-to-sign", mockTurnkeyClient)
      ).rejects.toThrow("User not found: user-123");
    });

    test("throws error when user has no DID", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-456",
        turnkeyId: "turnkey-user456",
        did: null,
      });

      await expect(
        signWithUserKey("user-456", "authentication", "data-to-sign", mockTurnkeyClient)
      ).rejects.toThrow("User user-456 does not have a DID");
    });

    test("throws error when authentication wallet is missing", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-789",
        turnkeyId: "turnkey-user789",
        did: "did:webvh:test.com:user789",
        authWalletId: null,
        assertionWalletId: "assertion-wallet",
        updateWalletId: "update-wallet",
      });

      await expect(
        signWithUserKey("user-789", "authentication", "data-to-sign", mockTurnkeyClient)
      ).rejects.toThrow("No authentication wallet found for user user-789");
    });

    test("throws error when assertion wallet is missing", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-000",
        turnkeyId: "turnkey-user000",
        did: "did:webvh:test.com:user000",
        authWalletId: "auth-wallet",
        assertionWalletId: null,
        updateWalletId: "update-wallet",
      });

      await expect(
        signWithUserKey("user-000", "assertion", "data-to-sign", mockTurnkeyClient)
      ).rejects.toThrow("No assertion wallet found for user user-000");
    });

    test("throws error when update wallet is missing", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-111",
        turnkeyId: "turnkey-user111",
        did: "did:webvh:test.com:user111",
        authWalletId: "auth-wallet",
        assertionWalletId: "assertion-wallet",
        updateWalletId: null,
      });

      await expect(
        signWithUserKey("user-111", "update", "data-to-sign", mockTurnkeyClient)
      ).rejects.toThrow("No update wallet found for user user-111");
    });

    test("throws error for invalid key purpose", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-222",
        turnkeyId: "turnkey-user222",
        did: "did:webvh:test.com:user222",
        authWalletId: "auth-wallet",
        assertionWalletId: "assertion-wallet",
        updateWalletId: "update-wallet",
      });

      await expect(
        signWithUserKey("user-222", "invalid" as KeyPurpose, "data-to-sign", mockTurnkeyClient)
      ).rejects.toThrow("Invalid key purpose: invalid");
    });

    test("throws pending integration error with correct wallet info", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-333",
        turnkeyId: "turnkey-user333",
        did: "did:webvh:test.com:user333",
        authWalletId: "auth-wallet-333",
        assertionWalletId: "assertion-wallet-333",
        updateWalletId: "update-wallet-333",
      });

      try {
        await signWithUserKey("user-333", "authentication", "test-data", mockTurnkeyClient);
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Turnkey signing integration pending");
        expect(error.message).toContain("Wallet ID: auth-wallet-333");
        expect(error.message).toContain("Key purpose: authentication");
      }
    });

    test("handles Buffer data type", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-444",
        turnkeyId: "turnkey-user444",
        did: "did:webvh:test.com:user444",
        authWalletId: "auth-wallet-444",
        assertionWalletId: "assertion-wallet-444",
        updateWalletId: "update-wallet-444",
      });

      const bufferData = Buffer.from("test data");

      try {
        await signWithUserKey("user-444", "assertion", bufferData, mockTurnkeyClient);
      } catch (error: any) {
        expect(error.message).toContain("Wallet ID: assertion-wallet-444");
        expect(error.message).toContain("Key purpose: assertion");
      }
    });

    test("handles update key purpose", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-555",
        turnkeyId: "turnkey-user555",
        did: "did:webvh:test.com:user555",
        authWalletId: "auth-wallet-555",
        assertionWalletId: "assertion-wallet-555",
        updateWalletId: "update-wallet-555",
      });

      try {
        await signWithUserKey("user-555", "update", "update-data", mockTurnkeyClient);
      } catch (error: any) {
        expect(error.message).toContain("Wallet ID: update-wallet-555");
        expect(error.message).toContain("Key purpose: update");
      }
    });
  });

  describe("verifySignature", () => {
    test("returns false for user not found", async () => {
      mockStorage.getUser.mockResolvedValue(null);

      const result = await verifySignature(
        "user-nonexistent",
        "authentication",
        "data",
        "signature"
      );

      expect(result).toBe(false);
    });

    test("returns false when user has no DID", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-nodid",
        turnkeyId: "turnkey-nodid",
        did: null,
      });

      const result = await verifySignature(
        "user-nodid",
        "authentication",
        "data",
        "signature"
      );

      expect(result).toBe(false);
    });

    test("returns false when authentication public key is missing", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-nokey",
        turnkeyId: "turnkey-nokey",
        did: "did:webvh:test.com:nokey",
        authKeyPublic: null,
        assertionKeyPublic: "assertion-key",
        updateKeyPublic: "update-key",
      });

      const result = await verifySignature(
        "user-nokey",
        "authentication",
        "data",
        "signature"
      );

      expect(result).toBe(false);
    });

    test("returns false when assertion public key is missing", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-noassertion",
        turnkeyId: "turnkey-noassertion",
        did: "did:webvh:test.com:noassertion",
        authKeyPublic: "auth-key",
        assertionKeyPublic: null,
        updateKeyPublic: "update-key",
      });

      const result = await verifySignature(
        "user-noassertion",
        "assertion",
        "data",
        "signature"
      );

      expect(result).toBe(false);
    });

    test("returns false when update public key is missing", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-noupdate",
        turnkeyId: "turnkey-noupdate",
        did: "did:webvh:test.com:noupdate",
        authKeyPublic: "auth-key",
        assertionKeyPublic: "assertion-key",
        updateKeyPublic: null,
      });

      const result = await verifySignature(
        "user-noupdate",
        "update",
        "data",
        "signature"
      );

      expect(result).toBe(false);
    });

    test("returns false for invalid key purpose", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-invalid",
        turnkeyId: "turnkey-invalid",
        did: "did:webvh:test.com:invalid",
        authKeyPublic: "auth-key",
        assertionKeyPublic: "assertion-key",
        updateKeyPublic: "update-key",
      });

      const result = await verifySignature(
        "user-invalid",
        "invalid" as KeyPurpose,
        "data",
        "signature"
      );

      expect(result).toBe(false);
    });

    test("throws not implemented error for valid inputs", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-valid",
        turnkeyId: "turnkey-valid",
        did: "did:webvh:test.com:valid",
        authKeyPublic: "auth-public-key",
        assertionKeyPublic: "assertion-public-key",
        updateKeyPublic: "update-public-key",
      });

      try {
        await verifySignature(
          "user-valid",
          "authentication",
          "test-data",
          "test-signature"
        );
        expect(false).toBe(true); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("Signature verification not yet implemented");
      }
    });
  });

  describe("getVerificationMethodId", () => {
    test("returns null for user not found", async () => {
      mockStorage.getUser.mockResolvedValue(null);

      const result = await getVerificationMethodId("user-notfound", "authentication");

      expect(result).toBeNull();
    });

    test("returns null when user has no DID", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-nodid2",
        turnkeyId: "turnkey-nodid2",
        did: null,
      });

      const result = await getVerificationMethodId("user-nodid2", "authentication");

      expect(result).toBeNull();
    });

    test("returns authentication verification method ID", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-auth",
        turnkeyId: "turnkey-auth",
        did: "did:webvh:test.com:auth",
      });

      const result = await getVerificationMethodId("user-auth", "authentication");

      expect(result).toBe("did:webvh:test.com:auth#auth-key");
    });

    test("returns assertion verification method ID", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-assertion",
        turnkeyId: "turnkey-assertion",
        did: "did:webvh:test.com:assertion",
      });

      const result = await getVerificationMethodId("user-assertion", "assertion");

      expect(result).toBe("did:webvh:test.com:assertion#assertion-key");
    });

    test("returns update verification method ID", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-update",
        turnkeyId: "turnkey-update",
        did: "did:webvh:test.com:update",
      });

      const result = await getVerificationMethodId("user-update", "update");

      expect(result).toBe("did:webvh:test.com:update#update-key");
    });

    test("handles DID with path segments", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-path",
        turnkeyId: "turnkey-path",
        did: "did:webvh:example.com:users:alice",
      });

      const result = await getVerificationMethodId("user-path", "authentication");

      expect(result).toBe("did:webvh:example.com:users:alice#auth-key");
    });

    test("handles encoded domain", async () => {
      mockStorage.getUser.mockResolvedValue({
        id: "user-encoded",
        turnkeyId: "turnkey-encoded",
        did: "did:webvh:localhost%3A5000:alice",
      });

      const result = await getVerificationMethodId("user-encoded", "authentication");

      expect(result).toBe("did:webvh:localhost%3A5000:alice#auth-key");
    });
  });
});
