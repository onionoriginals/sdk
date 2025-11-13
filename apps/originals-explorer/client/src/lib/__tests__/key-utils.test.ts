import { describe, test, expect, mock } from "bun:test";
import { convertToMultibase, extractKeysFromWallets } from "../key-utils";
import type { WalletAccount } from "@turnkey/core";

// Mock the @originals/sdk module
mock.module("@originals/sdk", () => ({
  multikey: {
    encodePublicKey: mock((bytes: Uint8Array, keyType: string) => {
      // Mock implementation that returns a predictable z-prefixed string
      const bytesHex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      return `z${keyType}_${bytesHex.slice(0, 8)}`;
    }),
  },
}));

describe("client key-utils", () => {
  describe("convertToMultibase", () => {
    test("converts Secp256k1 hex public key with 0x prefix", () => {
      const publicKeyHex = "0x02" + "a".repeat(64); // 33 bytes compressed
      const result = convertToMultibase(publicKeyHex, "Secp256k1");

      expect(result).toContain("Secp256k1");
      expect(result.startsWith("z")).toBe(true);
    });

    test("converts Secp256k1 hex public key without 0x prefix", () => {
      const publicKeyHex = "02" + "a".repeat(64); // 33 bytes compressed
      const result = convertToMultibase(publicKeyHex, "Secp256k1");

      expect(result).toContain("Secp256k1");
      expect(result.startsWith("z")).toBe(true);
    });

    test("converts Ed25519 public key with version byte prefix (33 bytes)", () => {
      const publicKeyHex = "00" + "b".repeat(64); // 33 bytes (version + key)
      const result = convertToMultibase(publicKeyHex, "Ed25519");

      // Should remove the version byte, resulting in 32 bytes
      expect(result).toContain("Ed25519");
      expect(result.startsWith("z")).toBe(true);
    });

    test("converts Ed25519 public key without prefix (32 bytes)", () => {
      const publicKeyHex = "b".repeat(64); // Exactly 32 bytes
      const result = convertToMultibase(publicKeyHex, "Ed25519");

      expect(result).toContain("Ed25519");
      expect(result.startsWith("z")).toBe(true);
    });

    test("handles lowercase hex characters", () => {
      const publicKeyHex = "abcdef" + "1".repeat(58);
      const result = convertToMultibase(publicKeyHex, "Ed25519");

      expect(result).toBeDefined();
      expect(result.startsWith("z")).toBe(true);
    });

    test("handles uppercase hex characters", () => {
      const publicKeyHex = "ABCDEF" + "1".repeat(58);
      const result = convertToMultibase(publicKeyHex, "Ed25519");

      expect(result).toBeDefined();
      expect(result.startsWith("z")).toBe(true);
    });

    test("handles mixed case hex characters", () => {
      const publicKeyHex = "0xAbCdEf" + "1".repeat(58);
      const result = convertToMultibase(publicKeyHex, "Ed25519");

      expect(result).toBeDefined();
      expect(result.startsWith("z")).toBe(true);
    });
  });

  describe("extractKeysFromWallets", () => {
    test("extracts keys from properly configured wallets", () => {
      const wallets = [
        {
          walletId: "wallet-1",
          walletName: "Default Wallet",
          accounts: [
            {
              address: "bc1q...",
              addressFormat: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR",
              curve: "CURVE_SECP256K1",
              publicKey: "02" + "a".repeat(64),
              path: "m/44'/0'/0'/0/0",
            } as WalletAccount,
            {
              address: "stellar...",
              addressFormat: "ADDRESS_FORMAT_SOLANA",
              curve: "CURVE_ED25519",
              publicKey: "b".repeat(64),
              path: "m/44'/501'/0'/0'",
            } as WalletAccount,
            {
              address: "stellar2...",
              addressFormat: "ADDRESS_FORMAT_SOLANA",
              curve: "CURVE_ED25519",
              publicKey: "c".repeat(64),
              path: "m/44'/501'/1'/0'",
            } as WalletAccount,
          ],
        },
      ];

      const keys = extractKeysFromWallets(wallets);

      expect(keys).not.toBeNull();
      expect(keys?.authKey).toContain("Secp256k1");
      expect(keys?.assertionKey).toContain("Ed25519");
      expect(keys?.updateKey).toContain("Ed25519");
      expect(keys?.authKey.startsWith("z")).toBe(true);
      expect(keys?.assertionKey.startsWith("z")).toBe(true);
      expect(keys?.updateKey.startsWith("z")).toBe(true);
    });

    test("returns null when no Secp256k1 accounts", () => {
      const wallets = [
        {
          walletId: "wallet-1",
          walletName: "Ed25519 Only",
          accounts: [
            {
              curve: "CURVE_ED25519",
              publicKey: "a".repeat(64),
            } as WalletAccount,
            {
              curve: "CURVE_ED25519",
              publicKey: "b".repeat(64),
            } as WalletAccount,
          ],
        },
      ];

      const keys = extractKeysFromWallets(wallets);
      expect(keys).toBeNull();
    });

    test("returns null when only one Ed25519 account", () => {
      const wallets = [
        {
          walletId: "wallet-1",
          walletName: "Insufficient Ed25519",
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              publicKey: "02" + "a".repeat(64),
            } as WalletAccount,
            {
              curve: "CURVE_ED25519",
              publicKey: "b".repeat(64),
            } as WalletAccount,
            // Missing second Ed25519
          ],
        },
      ];

      const keys = extractKeysFromWallets(wallets);
      expect(keys).toBeNull();
    });

    test("returns null when no Ed25519 accounts", () => {
      const wallets = [
        {
          walletId: "wallet-1",
          walletName: "Secp256k1 Only",
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              publicKey: "02" + "a".repeat(64),
            } as WalletAccount,
          ],
        },
      ];

      const keys = extractKeysFromWallets(wallets);
      expect(keys).toBeNull();
    });

    test("returns null when account missing publicKey", () => {
      const wallets = [
        {
          walletId: "wallet-1",
          walletName: "Missing Keys",
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              // publicKey missing
            } as WalletAccount,
            {
              curve: "CURVE_ED25519",
              publicKey: "b".repeat(64),
            } as WalletAccount,
            {
              curve: "CURVE_ED25519",
              publicKey: "c".repeat(64),
            } as WalletAccount,
          ],
        },
      ];

      const keys = extractKeysFromWallets(wallets);
      expect(keys).toBeNull();
    });

    test("flattens accounts from multiple wallets", () => {
      const wallets = [
        {
          walletId: "wallet-1",
          walletName: "Wallet 1",
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              publicKey: "02" + "a".repeat(64),
            } as WalletAccount,
          ],
        },
        {
          walletId: "wallet-2",
          walletName: "Wallet 2",
          accounts: [
            {
              curve: "CURVE_ED25519",
              publicKey: "b".repeat(64),
            } as WalletAccount,
            {
              curve: "CURVE_ED25519",
              publicKey: "c".repeat(64),
            } as WalletAccount,
          ],
        },
      ];

      const keys = extractKeysFromWallets(wallets);

      expect(keys).not.toBeNull();
      expect(keys?.authKey).toContain("Secp256k1");
      expect(keys?.assertionKey).toContain("Ed25519");
      expect(keys?.updateKey).toContain("Ed25519");
    });

    test("uses first accounts of each type in order", () => {
      const wallets = [
        {
          walletId: "wallet-1",
          walletName: "Multiple Keys",
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              publicKey: "02" + "a".repeat(64), // First Secp256k1 - should be auth
            } as WalletAccount,
            {
              curve: "CURVE_SECP256K1",
              publicKey: "03" + "a".repeat(64), // Second Secp256k1 - ignored
            } as WalletAccount,
            {
              curve: "CURVE_ED25519",
              publicKey: "b".repeat(64), // First Ed25519 - should be assertion
            } as WalletAccount,
            {
              curve: "CURVE_ED25519",
              publicKey: "c".repeat(64), // Second Ed25519 - should be update
            } as WalletAccount,
            {
              curve: "CURVE_ED25519",
              publicKey: "d".repeat(64), // Third Ed25519 - ignored
            } as WalletAccount,
          ],
        },
      ];

      const keys = extractKeysFromWallets(wallets);

      expect(keys).not.toBeNull();
      // Auth key should contain "02aa" (first Secp256k1)
      expect(keys?.authKey).toContain("02aa");
      // Assertion key should contain "bb" (first Ed25519)
      expect(keys?.assertionKey).toContain("bbbb");
      // Update key should contain "cc" (second Ed25519)
      expect(keys?.updateKey).toContain("cccc");
    });

    test("handles empty wallets array", () => {
      const wallets: any[] = [];
      const keys = extractKeysFromWallets(wallets);
      expect(keys).toBeNull();
    });

    test("handles wallets with empty accounts arrays", () => {
      const wallets = [
        {
          walletId: "wallet-1",
          walletName: "Empty",
          accounts: [],
        },
      ];

      const keys = extractKeysFromWallets(wallets);
      expect(keys).toBeNull();
    });
  });
});
