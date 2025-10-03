import { describe, test, expect, beforeEach } from "bun:test";
import { backfillDIDWebVH, type BackfillOptions, type BackfillStats } from "../backfill-did-webvh";
import { storage } from "../storage";

// Mock Privy client
const mockPrivyClient = {
  walletApi: {
    createWallet: async (params: any) => {
      if (params.chainType === "bitcoin-segwit") {
        return {
          id: `btc-${Date.now()}`,
          chainType: "bitcoin-segwit",
          publicKey: "02" + "a".repeat(64),
        };
      } else if (params.chainType === "stellar") {
        return {
          id: `stellar-${Date.now()}`,
          chainType: "stellar",
          publicKey: "a".repeat(64),
        };
      }
    },
  },
} as any;

// Setup environment
process.env.PRIVY_APP_ID = "test-app-id";
process.env.PRIVY_APP_SECRET = "test-app-secret";

describe("Backfill DID:WebVH Job", () => {
  beforeEach(async () => {
    // Clear storage
    const memStorage = storage as any;
    if (memStorage.users) {
      memStorage.users.clear();
    }
  });

  describe("Dry Run Mode", () => {
    test("does not modify users in dry run", async () => {
      // Create test users
      await storage.ensureUser("user1");
      await storage.ensureUser("user2");
      await storage.ensureUser("user3");

      const options: BackfillOptions = {
        dryRun: true,
        batchSize: 10,
        delayMs: 0,
      };

      const stats = await backfillDIDWebVH(options);

      expect(stats.totalUsers).toBe(3);
      expect(stats.usersNeedingWebvh).toBe(3);
      expect(stats.usersProcessed).toBe(0);
      expect(stats.usersSuccess).toBe(0);

      // Verify no users were modified
      const user1 = await storage.getUser("user1");
      expect(user1?.did_webvh).toBeNull();
    });

    test("identifies users that need migration", async () => {
      // Create users with and without did:webvh
      await storage.ensureUser("user1");
      await storage.ensureUser("user2");
      
      await storage.updateUser("user2", {
        did_webvh: "did:webvh:localhost%3A5000:u-existing",
      });

      const options: BackfillOptions = {
        dryRun: true,
        batchSize: 10,
        delayMs: 0,
      };

      const stats = await backfillDIDWebVH(options);

      expect(stats.totalUsers).toBe(2);
      expect(stats.usersWithWebvh).toBe(1);
      expect(stats.usersNeedingWebvh).toBe(1);
    });
  });

  describe("Execute Mode", () => {
    test("creates did:webvh for users without it", async () => {
      // Create test users
      await storage.ensureUser("user1");
      await storage.ensureUser("user2");

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 10,
        delayMs: 0,
      };

      const stats = await backfillDIDWebVH(options);

      expect(stats.totalUsers).toBe(2);
      expect(stats.usersProcessed).toBe(2);
      expect(stats.usersSuccess).toBe(2);
      expect(stats.usersFailed).toBe(0);

      // Verify users have did:webvh
      const user1 = await storage.getUser("user1");
      const user2 = await storage.getUser("user2");

      expect(user1?.did_webvh).toBeDefined();
      expect(user1?.did_webvh).toMatch(/^did:webvh:/);
      expect(user2?.did_webvh).toBeDefined();
      expect(user2?.did_webvh).toMatch(/^did:webvh:/);
    });

    test("skips users that already have did:webvh", async () => {
      await storage.ensureUser("user1");
      await storage.updateUser("user1", {
        did_webvh: "did:webvh:localhost%3A5000:u-existing",
      });

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 10,
        delayMs: 0,
      };

      const stats = await backfillDIDWebVH(options);

      expect(stats.totalUsers).toBe(1);
      expect(stats.usersWithWebvh).toBe(1);
      expect(stats.usersNeedingWebvh).toBe(0);
      expect(stats.usersProcessed).toBe(0);
    });

    test("processes users in batches", async () => {
      // Create 5 users
      for (let i = 0; i < 5; i++) {
        await storage.ensureUser(`user${i}`);
      }

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 2,
        delayMs: 10,
      };

      const startTime = Date.now();
      const stats = await backfillDIDWebVH(options);
      const duration = Date.now() - startTime;

      expect(stats.usersProcessed).toBe(5);
      expect(stats.usersSuccess).toBe(5);

      // Should have delays between batches
      // 3 batches (2, 2, 1) with 2 delays of 10ms = at least 20ms
      expect(duration).toBeGreaterThanOrEqual(20);
    });
  });

  describe("Idempotency", () => {
    test("can safely run multiple times", async () => {
      await storage.ensureUser("user1");

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 10,
        delayMs: 0,
      };

      // Run first time
      const stats1 = await backfillDIDWebVH(options);
      expect(stats1.usersSuccess).toBe(1);

      const user1 = await storage.getUser("user1");
      const originalDid = user1?.did_webvh;

      // Run second time
      const stats2 = await backfillDIDWebVH(options);
      expect(stats2.usersNeedingWebvh).toBe(0);
      expect(stats2.usersProcessed).toBe(0);

      const user1After = await storage.getUser("user1");
      expect(user1After?.did_webvh).toBe(originalDid);
    });

    test("handles concurrent creation gracefully", async () => {
      await storage.ensureUser("user1");

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 10,
        delayMs: 0,
      };

      // Run backfill twice concurrently
      const [stats1, stats2] = await Promise.all([
        backfillDIDWebVH(options),
        backfillDIDWebVH(options),
      ]);

      // One should succeed, one should find no work
      const totalSuccess = stats1.usersSuccess + stats2.usersSuccess;
      expect(totalSuccess).toBeGreaterThanOrEqual(1);

      // User should only have one did:webvh
      const user1 = await storage.getUser("user1");
      expect(user1?.did_webvh).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    test("continues processing after individual failures", async () => {
      await storage.ensureUser("user1");
      await storage.ensureUser("user2");
      await storage.ensureUser("user3");

      // Create a client that fails for one specific user
      const failingClient = {
        walletApi: {
          createWallet: async (params: any) => {
            const userId = params.owner.userId;
            if (userId === "user2") {
              throw new Error("Wallet creation failed for user2");
            }
            return mockPrivyClient.walletApi.createWallet(params);
          },
        },
      } as any;

      // Override the mock temporarily
      const originalCreateWallet = mockPrivyClient.walletApi.createWallet;
      mockPrivyClient.walletApi.createWallet = failingClient.walletApi.createWallet;

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 10,
        delayMs: 0,
      };

      const stats = await backfillDIDWebVH(options);

      // Restore original mock
      mockPrivyClient.walletApi.createWallet = originalCreateWallet;

      expect(stats.usersProcessed).toBe(3);
      expect(stats.usersSuccess).toBe(2);
      expect(stats.usersFailed).toBe(1);
      expect(stats.errors).toHaveLength(1);
      expect(stats.errors[0].userId).toBe("user2");
    });

    test("records detailed error information", async () => {
      await storage.ensureUser("user1");

      const failingClient = {
        walletApi: {
          createWallet: async () => {
            throw new Error("Specific error message");
          },
        },
      } as any;

      const originalCreateWallet = mockPrivyClient.walletApi.createWallet;
      mockPrivyClient.walletApi.createWallet = failingClient.walletApi.createWallet;

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 10,
        delayMs: 0,
      };

      const stats = await backfillDIDWebVH(options);

      mockPrivyClient.walletApi.createWallet = originalCreateWallet;

      expect(stats.errors).toHaveLength(1);
      expect(stats.errors[0].error).toContain("Specific error message");
    });
  });

  describe("Statistics", () => {
    test("provides accurate statistics", async () => {
      // Create users with different states
      await storage.ensureUser("user1"); // Needs webvh
      await storage.ensureUser("user2"); // Needs webvh
      
      await storage.ensureUser("user3"); // Already has webvh
      await storage.updateUser("user3", {
        did_webvh: "did:webvh:localhost%3A5000:u-existing",
      });

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 10,
        delayMs: 0,
      };

      const stats = await backfillDIDWebVH(options);

      expect(stats.totalUsers).toBe(3);
      expect(stats.usersWithWebvh).toBe(1);
      expect(stats.usersNeedingWebvh).toBe(2);
      expect(stats.usersProcessed).toBe(2);
      expect(stats.usersSuccess).toBe(2);
      expect(stats.usersSkipped).toBe(0);
      expect(stats.usersFailed).toBe(0);
    });
  });

  describe("Performance", () => {
    test("processes large batches efficiently", async () => {
      // Create 20 users
      for (let i = 0; i < 20; i++) {
        await storage.ensureUser(`user${i}`);
      }

      const options: BackfillOptions = {
        dryRun: false,
        batchSize: 10,
        delayMs: 0,
      };

      const startTime = Date.now();
      const stats = await backfillDIDWebVH(options);
      const duration = Date.now() - startTime;

      expect(stats.usersProcessed).toBe(20);
      expect(stats.usersSuccess).toBe(20);

      // Should complete in reasonable time (< 5 seconds)
      expect(duration).toBeLessThan(5000);
    });
  });
});
