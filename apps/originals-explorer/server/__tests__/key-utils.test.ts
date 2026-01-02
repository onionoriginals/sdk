import { describe, test, expect, mock } from "bun:test";
import {
  convertToMultibase,
  bytesToHex,
  extractPublicKeyFromWallet,
} from "../key-utils";

// Mock the @originals/sdk module
mock.module("@originals/sdk", () => ({
  multikey: {
    encodePublicKey: mock((bytes: Uint8Array, keyType: string) => {
      // Simple mock implementation that returns a z-prefixed string
      return `z${keyType}_${bytes.length}_${Array.from(bytes.slice(0, 4)).join(',')}`;
    }),
  },
}));

describe("key-utils", () => {
  describe("convertToMultibase", () => {
    test("converts Secp256k1 public key with 0x prefix", () => {
      const publicKeyHex = "0x" + "a".repeat(66); // 33 bytes compressed Secp256k1
      const result = convertToMultibase(publicKeyHex, "Secp256k1");
      
      expect(result).toContain("Secp256k1");
      expect(result.startsWith("z")).toBe(true);
    });

    test("converts Secp256k1 public key without 0x prefix", () => {
      const publicKeyHex = "a".repeat(66); // 33 bytes compressed Secp256k1
      const result = convertToMultibase(publicKeyHex, "Secp256k1");
      
      expect(result).toContain("Secp256k1");
      expect(result.startsWith("z")).toBe(true);
    });

    test("converts Ed25519 public key and removes prefix byte", () => {
      // 33 bytes (with version byte prefix)
      const publicKeyHex = "00" + "b".repeat(64);
      const result = convertToMultibase(publicKeyHex, "Ed25519");
      
      expect(result).toContain("Ed25519");
      expect(result).toContain("32"); // Should be 32 bytes after removing prefix
      expect(result.startsWith("z")).toBe(true);
    });

    test("converts Ed25519 public key that is already 32 bytes", () => {
      // Exactly 32 bytes
      const publicKeyHex = "b".repeat(64);
      const result = convertToMultibase(publicKeyHex, "Ed25519");
      
      expect(result).toContain("Ed25519");
      expect(result).toContain("32"); // Should remain 32 bytes
      expect(result.startsWith("z")).toBe(true);
    });

    test("handles empty hex string", () => {
      const result = convertToMultibase("", "Ed25519");
      expect(result).toBeDefined();
    });

    test("handles short hex string", () => {
      const publicKeyHex = "abcd";
      const result = convertToMultibase(publicKeyHex, "Ed25519");
      
      expect(result).toBeDefined();
      expect(result.startsWith("z")).toBe(true);
    });
  });

  describe("bytesToHex", () => {
    test("converts Uint8Array to hex string", () => {
      const bytes = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
      const result = bytesToHex(bytes);
      
      expect(result).toBe("123456789abcdef0");
    });

    test("converts empty Uint8Array to empty string", () => {
      const bytes = new Uint8Array([]);
      const result = bytesToHex(bytes);
      
      expect(result).toBe("");
    });

    test("converts single byte to hex string", () => {
      const bytes = new Uint8Array([0xff]);
      const result = bytesToHex(bytes);
      
      expect(result).toBe("ff");
    });

    test("pads single digit hex values with leading zero", () => {
      const bytes = new Uint8Array([0x01, 0x0a, 0x00, 0x0f]);
      const result = bytesToHex(bytes);
      
      expect(result).toBe("010a000f");
    });

    test("handles all zero bytes", () => {
      const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
      const result = bytesToHex(bytes);
      
      expect(result).toBe("00000000");
    });

    test("handles all max bytes", () => {
      const bytes = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      const result = bytesToHex(bytes);
      
      expect(result).toBe("ffffffff");
    });
  });

  describe("extractPublicKeyFromWallet", () => {
    test("extracts publicKey from wallet object", () => {
      const wallet = {
        id: "wallet-1",
        chainType: "bitcoin-segwit",
        publicKey: "02" + "a".repeat(64),
      };
      
      const result = extractPublicKeyFromWallet(wallet);
      expect(result).toBe("02" + "a".repeat(64));
    });

    test("extracts public_key from wallet object", () => {
      const wallet = {
        id: "wallet-2",
        chainType: "stellar",
        public_key: "b".repeat(64),
      };
      
      const result = extractPublicKeyFromWallet(wallet);
      expect(result).toBe("b".repeat(64));
    });

    test("prefers publicKey over public_key when both exist", () => {
      const wallet = {
        id: "wallet-3",
        chainType: "ethereum",
        publicKey: "preferred-key",
        public_key: "alternate-key",
      };
      
      const result = extractPublicKeyFromWallet(wallet);
      expect(result).toBe("preferred-key");
    });

    test("throws error when no public key is available", () => {
      const wallet = {
        id: "wallet-4",
        chainType: "bitcoin-segwit",
        address: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
      };
      
      expect(() => extractPublicKeyFromWallet(wallet)).toThrow(
        "No public key available in key object"
      );
    });

    test("error message includes wallet ID", () => {
      const wallet = {
        id: "test-wallet-id",
        chainType: "stellar",
      };
      
      try {
        extractPublicKeyFromWallet(wallet);
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("test-wallet-id");
      }
    });

    test("handles wallet with missing id", () => {
      const wallet = {};
      
      try {
        extractPublicKeyFromWallet(wallet);
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.message).toContain("unknown");
      }
    });

    test("handles wallet with null values", () => {
      const wallet = {
        id: "wallet-5",
        chainType: "bitcoin-segwit",
        publicKey: null,
        public_key: null,
      };
      
      expect(() => extractPublicKeyFromWallet(wallet)).toThrow(
        "No public key available in key object"
      );
    });

    test("handles wallet with undefined values", () => {
      const wallet = {
        id: "wallet-6",
        chainType: "stellar",
        publicKey: undefined,
        public_key: undefined,
      };
      
      expect(() => extractPublicKeyFromWallet(wallet)).toThrow(
        "No public key available in key object"
      );
    });

    test("handles wallet with empty string public key", () => {
      const wallet = {
        id: "wallet-7",
        chainType: "ethereum",
        publicKey: "",
      };
      
      // Empty string is falsy, so should throw error
      expect(() => extractPublicKeyFromWallet(wallet)).toThrow(
        "No public key available in key object"
      );
    });
  });
});
