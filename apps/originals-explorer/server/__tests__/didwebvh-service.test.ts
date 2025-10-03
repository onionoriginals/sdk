import { describe, test, expect } from "bun:test";
import {
  createUserDIDWebVH,
  getUserSlugFromDID,
} from "../didwebvh-service";

// Mock Privy client
const mockPrivyClient = {
  walletApi: {
    createWallet: async (params: any) => {
      // Return mock wallet based on chain type
      if (params.chainType === "bitcoin-segwit") {
        return {
          id: "btc-wallet-1",
          chainType: "bitcoin-segwit",
          publicKey: "02" + "a".repeat(64), // Mock secp256k1 public key
        };
      } else if (params.chainType === "stellar") {
        return {
          id: `stellar-wallet-${Date.now()}`,
          chainType: "stellar",
          publicKey: "a".repeat(64), // Mock Ed25519 public key
        };
      }
    },
  },
} as any;

describe("DID:WebVH Service", () => {
  describe("createUserDIDWebVH", () => {
    test("creates did:webvh with correct format", async () => {
      const userId = "did:privy:cltest123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient, "localhost:5000");

      expect(result.did).toMatch(/^did:webvh:localhost%3A5000:u-[a-f0-9]{16}$/);
      expect(result.didDocument).toBeDefined();
      expect(result.didDocument.id).toBe(result.did);
      expect(result.authWalletId).toBe("btc-wallet-1");
      expect(result.assertionWalletId).toBeDefined();
      expect(result.updateWalletId).toBeDefined();
    });

    test("creates did:webvh with proper DID document structure", async () => {
      const userId = "did:privy:cltest123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient, "example.com");

      expect(result.didDocument["@context"]).toContain("https://www.w3.org/ns/did/v1");
      expect(result.didDocument["@context"]).toContain("https://w3id.org/security/multikey/v1");
      expect(result.didDocument.verificationMethod).toHaveLength(2);
      expect(result.didDocument.authentication).toContain(`${result.did}#auth-key`);
      expect(result.didDocument.assertionMethod).toContain(`${result.did}#assertion-key`);
    });

    test("creates stable slug from user ID", async () => {
      const userId = "did:privy:cltest123";
      const result1 = await createUserDIDWebVH(userId, mockPrivyClient);
      const result2 = await createUserDIDWebVH(userId, mockPrivyClient);

      const slug1 = getUserSlugFromDID(result1.did);
      const slug2 = getUserSlugFromDID(result2.did);

      expect(slug1).toBe(slug2);
      expect(slug1).toMatch(/^u-[a-f0-9]{16}$/);
    });

    test("handles special characters in user ID", async () => {
      const userId = "did:privy:cl_test@user#123";
      const result = await createUserDIDWebVH(userId, mockPrivyClient);

      const slug = getUserSlugFromDID(result.did);
      expect(slug).toMatch(/^u-[a-f0-9]{16}$/);
      expect(result.did).toMatch(/^did:webvh:/);
    });

    test("creates different DIDs for different users", async () => {
      const result1 = await createUserDIDWebVH("user1", mockPrivyClient);
      const result2 = await createUserDIDWebVH("user2", mockPrivyClient);

      expect(result1.did).not.toBe(result2.did);
    });

    test("handles domain encoding correctly", async () => {
      const result = await createUserDIDWebVH("user1", mockPrivyClient, "localhost:5000");
      expect(result.did).toContain("localhost%3A5000");
    });
  });

  describe("getUserSlugFromDID", () => {
    test("extracts slug from did:webvh", () => {
      const slug = getUserSlugFromDID("did:webvh:localhost%3A5000:u-abc123");
      expect(slug).toBe("u-abc123");
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

  describe("DID Document Structure", () => {
    test("includes required verification methods", async () => {
      const result = await createUserDIDWebVH("user1", mockPrivyClient);
      const doc = result.didDocument;

      expect(doc.verificationMethod).toBeDefined();
      expect(doc.verificationMethod).toHaveLength(2);

      const authKey = doc.verificationMethod.find((vm: any) => vm.id.endsWith("#auth-key"));
      const assertionKey = doc.verificationMethod.find((vm: any) => vm.id.endsWith("#assertion-key"));

      expect(authKey).toBeDefined();
      expect(assertionKey).toBeDefined();
      expect(authKey.type).toBe("Multikey");
      expect(assertionKey.type).toBe("Multikey");
    });

    test("sets correct controller for verification methods", async () => {
      const result = await createUserDIDWebVH("user1", mockPrivyClient);
      const doc = result.didDocument;

      doc.verificationMethod.forEach((vm: any) => {
        expect(vm.controller).toBe(result.did);
      });
    });

    test("includes authentication and assertionMethod relationships", async () => {
      const result = await createUserDIDWebVH("user1", mockPrivyClient);
      const doc = result.didDocument;

      expect(doc.authentication).toContain(`${result.did}#auth-key`);
      expect(doc.assertionMethod).toContain(`${result.did}#assertion-key`);
    });
  });

  describe("Idempotency", () => {
    test("generates same slug for same user ID", async () => {
      const userId = "did:privy:cltest123";

      const result1 = await createUserDIDWebVH(userId, mockPrivyClient);
      const result2 = await createUserDIDWebVH(userId, mockPrivyClient);

      const slug1 = getUserSlugFromDID(result1.did);
      const slug2 = getUserSlugFromDID(result2.did);

      expect(slug1).toBe(slug2);
    });
  });
});
