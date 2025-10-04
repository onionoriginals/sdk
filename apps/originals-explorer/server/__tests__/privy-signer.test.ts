import { describe, test, expect, mock, beforeEach } from "bun:test";
import { PrivyWebVHSigner, createPrivySigner, createVerificationMethodsFromPrivy } from "../privy-signer";

// Mock dependencies
const mockPrivyClient = {
  getUserById: mock(),
  walletApi: {
    createWallet: mock(),
  },
  wallets: mock(() => ({
    rawSign: mock(),
  })),
} as any;

const mockPrepareDataForSigning = mock();
const mockEd25519Verify = mock();
const mockMultikeyEncode = mock();

mock.module("didwebvh-ts", () => ({
  prepareDataForSigning: mockPrepareDataForSigning,
}));

mock.module("@noble/ed25519", () => ({
  ed25519: {
    verify: mockEd25519Verify,
  },
}));

mock.module("@originals/sdk", () => ({
  multikey: {
    encodeMultibase: mockMultikeyEncode,
  },
}));

mock.module("../key-utils", () => ({
  extractPublicKeyFromWallet: mock((wallet: any) => {
    if (wallet.publicKey) return wallet.publicKey;
    if (wallet.public_key) return wallet.public_key;
    return "a".repeat(64);
  }),
  convertToMultibase: mock((hex: string, type: string) => {
    return `z${type}_${hex.substring(0, 8)}`;
  }),
}));

describe("PrivyWebVHSigner", () => {
  beforeEach(() => {
    mockPrivyClient.getUserById.mockClear();
    mockPrivyClient.walletApi.createWallet.mockClear();
    mockPrepareDataForSigning.mockClear();
    mockEd25519Verify.mockClear();
    mockMultikeyEncode.mockClear();
    
    // Reset the wallets mock
    const mockRawSign = mock();
    mockPrivyClient.wallets.mockReturnValue({
      rawSign: mockRawSign,
    });
  });

  describe("constructor", () => {
    test("creates signer with required parameters", () => {
      const signer = new PrivyWebVHSigner(
        "wallet-id-123",
        "zpublickey123",
        mockPrivyClient,
        "did:key:zverification123"
      );

      expect(signer).toBeDefined();
    });
  });

  describe("sign", () => {
    test("signs data using Privy wallet API", async () => {
      mockPrepareDataForSigning.mockResolvedValue("data-to-sign");
      mockMultikeyEncode.mockReturnValue("zsignature123");
      
      const mockRawSign = mock().mockResolvedValue({
        signature: "0xabcdef1234567890",
        encoding: "hex",
      });
      
      mockPrivyClient.wallets.mockReturnValue({
        rawSign: mockRawSign,
      });

      const signer = new PrivyWebVHSigner(
        "wallet-id-123",
        "zpublickey123",
        mockPrivyClient,
        "did:key:zverification123"
      );

      const input = {
        document: { id: "did:webvh:test.com:user" },
        proof: { type: "DataIntegrityProof" },
      };

      const result = await signer.sign(input);

      expect(result.proofValue).toBe("zsignature123");
      expect(mockPrepareDataForSigning).toHaveBeenCalledWith(
        input.document,
        input.proof
      );
      expect(mockRawSign).toHaveBeenCalledWith("wallet-id-123", {
        params: { hash: expect.stringContaining("0x") },
      });
    });

    test("handles signature with base64 encoding", async () => {
      mockPrepareDataForSigning.mockResolvedValue("data-to-sign");
      mockMultikeyEncode.mockReturnValue("zsignature456");
      
      const mockRawSign = mock().mockResolvedValue({
        signature: "YWJjZGVmMTIzNDU2Nzg5MA==",
        encoding: "base64",
      });
      
      mockPrivyClient.wallets.mockReturnValue({
        rawSign: mockRawSign,
      });

      const signer = new PrivyWebVHSigner(
        "wallet-id-456",
        "zpublickey456",
        mockPrivyClient,
        "did:key:zverification456"
      );

      const input = {
        document: { id: "did:webvh:test.com:user2" },
        proof: { type: "DataIntegrityProof" },
      };

      const result = await signer.sign(input);

      expect(result.proofValue).toBe("zsignature456");
    });

    test("handles signature without 0x prefix", async () => {
      mockPrepareDataForSigning.mockResolvedValue("data-to-sign");
      mockMultikeyEncode.mockReturnValue("zsignature789");
      
      const mockRawSign = mock().mockResolvedValue({
        signature: "abcdef1234567890",
        encoding: "hex",
      });
      
      mockPrivyClient.wallets.mockReturnValue({
        rawSign: mockRawSign,
      });

      const signer = new PrivyWebVHSigner(
        "wallet-id-789",
        "zpublickey789",
        mockPrivyClient,
        "did:key:zverification789"
      );

      const input = {
        document: { id: "did:webvh:test.com:user3" },
        proof: { type: "DataIntegrityProof" },
      };

      const result = await signer.sign(input);

      expect(result.proofValue).toBe("zsignature789");
    });

    test("handles signature with no encoding specified (defaults to hex)", async () => {
      mockPrepareDataForSigning.mockResolvedValue("data-to-sign");
      mockMultikeyEncode.mockReturnValue("zsignature000");
      
      const mockRawSign = mock().mockResolvedValue({
        signature: "0xfedcba9876543210",
        encoding: undefined,
      });
      
      mockPrivyClient.wallets.mockReturnValue({
        rawSign: mockRawSign,
      });

      const signer = new PrivyWebVHSigner(
        "wallet-id-000",
        "zpublickey000",
        mockPrivyClient,
        "did:key:zverification000"
      );

      const input = {
        document: { id: "did:webvh:test.com:user4" },
        proof: { type: "DataIntegrityProof" },
      };

      const result = await signer.sign(input);

      expect(result.proofValue).toBe("zsignature000");
    });

    test("throws error for unsupported encoding", async () => {
      mockPrepareDataForSigning.mockResolvedValue("data-to-sign");
      
      const mockRawSign = mock().mockResolvedValue({
        signature: "signature",
        encoding: "unsupported",
      });
      
      mockPrivyClient.wallets.mockReturnValue({
        rawSign: mockRawSign,
      });

      const signer = new PrivyWebVHSigner(
        "wallet-id-err",
        "zpublickey",
        mockPrivyClient,
        "did:key:zverification"
      );

      const input = {
        document: { id: "did:webvh:test.com:user" },
        proof: { type: "DataIntegrityProof" },
      };

      await expect(signer.sign(input)).rejects.toThrow(
        "Unsupported signature encoding: unsupported"
      );
    });

    test("throws error when Privy signing fails", async () => {
      mockPrepareDataForSigning.mockResolvedValue("data-to-sign");
      
      const mockRawSign = mock().mockRejectedValue(new Error("Privy API error"));
      
      mockPrivyClient.wallets.mockReturnValue({
        rawSign: mockRawSign,
      });

      const signer = new PrivyWebVHSigner(
        "wallet-id-fail",
        "zpublickey",
        mockPrivyClient,
        "did:key:zverification"
      );

      const input = {
        document: { id: "did:webvh:test.com:user" },
        proof: { type: "DataIntegrityProof" },
      };

      await expect(signer.sign(input)).rejects.toThrow(
        "Failed to sign with Privy: Privy API error"
      );
    });
  });

  describe("verify", () => {
    test("verifies signature using ed25519", async () => {
      mockEd25519Verify.mockResolvedValue(true);

      const signer = new PrivyWebVHSigner(
        "wallet-id",
        "zpublickey",
        mockPrivyClient,
        "did:key:zverification"
      );

      const signature = new Uint8Array([1, 2, 3, 4]);
      const message = new Uint8Array([5, 6, 7, 8]);
      const publicKey = new Uint8Array([9, 10, 11, 12]);

      const result = await signer.verify(signature, message, publicKey);

      expect(result).toBe(true);
      expect(mockEd25519Verify).toHaveBeenCalledWith(signature, message, publicKey);
    });

    test("returns false when verification fails", async () => {
      mockEd25519Verify.mockResolvedValue(false);

      const signer = new PrivyWebVHSigner(
        "wallet-id",
        "zpublickey",
        mockPrivyClient,
        "did:key:zverification"
      );

      const signature = new Uint8Array([1, 2, 3, 4]);
      const message = new Uint8Array([5, 6, 7, 8]);
      const publicKey = new Uint8Array([9, 10, 11, 12]);

      const result = await signer.verify(signature, message, publicKey);

      expect(result).toBe(false);
    });

    test("returns false when verification throws error", async () => {
      mockEd25519Verify.mockRejectedValue(new Error("Verification error"));

      const signer = new PrivyWebVHSigner(
        "wallet-id",
        "zpublickey",
        mockPrivyClient,
        "did:key:zverification"
      );

      const signature = new Uint8Array([1, 2, 3, 4]);
      const message = new Uint8Array([5, 6, 7, 8]);
      const publicKey = new Uint8Array([9, 10, 11, 12]);

      const result = await signer.verify(signature, message, publicKey);

      expect(result).toBe(false);
    });
  });

  describe("getVerificationMethodId", () => {
    test("returns verification method ID", () => {
      const verificationMethodId = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
      
      const signer = new PrivyWebVHSigner(
        "wallet-id",
        "zpublickey",
        mockPrivyClient,
        verificationMethodId
      );

      const result = signer.getVerificationMethodId();

      expect(result).toBe(verificationMethodId);
    });
  });

  describe("getPublicKeyMultibase", () => {
    test("returns public key in multibase format", () => {
      const publicKeyMultibase = "z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
      
      const signer = new PrivyWebVHSigner(
        "wallet-id",
        publicKeyMultibase,
        mockPrivyClient,
        "did:key:verification"
      );

      const result = signer.getPublicKeyMultibase();

      expect(result).toBe(publicKeyMultibase);
    });
  });
});

describe("createPrivySigner", () => {
  beforeEach(() => {
    mockPrivyClient.getUserById.mockClear();
  });

  test("creates signer from Privy user and wallet", async () => {
    const mockUser = {
      id: "user-123",
      linkedAccounts: [
        {
          type: "wallet",
          id: "wallet-stellar-1",
          chainType: "stellar",
          publicKey: "a".repeat(64),
        },
        {
          type: "email",
          address: "user@example.com",
        },
      ],
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);

    const signer = await createPrivySigner(
      "user-123",
      "wallet-stellar-1",
      mockPrivyClient,
      "did:key:zverification"
    );

    expect(signer).toBeInstanceOf(PrivyWebVHSigner);
    expect(mockPrivyClient.getUserById).toHaveBeenCalledWith("user-123");
  });

  test("throws error when wallet is not found", async () => {
    const mockUser = {
      id: "user-456",
      linkedAccounts: [
        {
          type: "wallet",
          id: "wallet-other",
          chainType: "ethereum",
        },
      ],
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);

    await expect(
      createPrivySigner(
        "user-456",
        "wallet-nonexistent",
        mockPrivyClient,
        "did:key:zverification"
      )
    ).rejects.toThrow("Wallet not found: wallet-nonexistent");
  });

  test("handles user with no linked accounts", async () => {
    const mockUser = {
      id: "user-789",
      linkedAccounts: undefined,
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);

    await expect(
      createPrivySigner(
        "user-789",
        "wallet-id",
        mockPrivyClient,
        "did:key:zverification"
      )
    ).rejects.toThrow("Wallet not found: wallet-id");
  });

  test("handles user with empty linked accounts", async () => {
    const mockUser = {
      id: "user-000",
      linkedAccounts: [],
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);

    await expect(
      createPrivySigner(
        "user-000",
        "wallet-id",
        mockPrivyClient,
        "did:key:zverification"
      )
    ).rejects.toThrow("Wallet not found: wallet-id");
  });
});

describe("createVerificationMethodsFromPrivy", () => {
  beforeEach(() => {
    mockPrivyClient.getUserById.mockClear();
    mockPrivyClient.walletApi.createWallet.mockClear();
    process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS = "";
  });

  test("creates verification methods with existing stellar wallets", async () => {
    const mockUser = {
      id: "user-123",
      linkedAccounts: [
        {
          type: "wallet",
          id: "stellar-wallet-1",
          chainType: "stellar",
          publicKey: "a".repeat(64),
        },
        {
          type: "wallet",
          id: "stellar-wallet-2",
          chainType: "stellar",
          publicKey: "b".repeat(64),
        },
      ],
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);

    const result = await createVerificationMethodsFromPrivy(
      "user-123",
      mockPrivyClient,
      "test.example.com",
      "testuser"
    );

    expect(result.verificationMethods).toHaveLength(1);
    expect(result.verificationMethods[0].type).toBe("Multikey");
    expect(result.updateKey).toContain("did:key:z");
    expect(result.authWalletId).toBe("stellar-wallet-1");
    expect(result.updateWalletId).toBe("stellar-wallet-2");
    expect(mockPrivyClient.walletApi.createWallet).not.toHaveBeenCalled();
  });

  test("creates both wallets when none exist", async () => {
    const mockUser = {
      id: "user-456",
      linkedAccounts: [],
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);
    mockPrivyClient.walletApi.createWallet
      .mockResolvedValueOnce({
        id: "new-stellar-1",
        chainType: "stellar",
        publicKey: "c".repeat(64),
      })
      .mockResolvedValueOnce({
        id: "new-stellar-2",
        chainType: "stellar",
        publicKey: "d".repeat(64),
      });

    const result = await createVerificationMethodsFromPrivy(
      "user-456",
      mockPrivyClient,
      "test.example.com",
      "newuser"
    );

    expect(mockPrivyClient.walletApi.createWallet).toHaveBeenCalledTimes(2);
    expect(result.authWalletId).toBe("new-stellar-1");
    expect(result.updateWalletId).toBe("new-stellar-2");
  });

  test("creates update wallet when only one exists", async () => {
    const mockUser = {
      id: "user-789",
      linkedAccounts: [
        {
          type: "wallet",
          id: "stellar-existing",
          chainType: "stellar",
          publicKey: "e".repeat(64),
        },
      ],
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);
    mockPrivyClient.walletApi.createWallet.mockResolvedValue({
      id: "new-stellar-update",
      chainType: "stellar",
      publicKey: "f".repeat(64),
    });

    const result = await createVerificationMethodsFromPrivy(
      "user-789",
      mockPrivyClient,
      "test.example.com",
      "partialuser"
    );

    expect(mockPrivyClient.walletApi.createWallet).toHaveBeenCalledTimes(1);
    expect(result.authWalletId).toBe("stellar-existing");
    expect(result.updateWalletId).toBe("new-stellar-update");
  });

  test("uses policy IDs from environment", async () => {
    process.env.PRIVY_EMBEDDED_WALLET_POLICY_IDS = "policy-1, policy-2, policy-3";

    const mockUser = {
      id: "user-000",
      linkedAccounts: [],
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);
    mockPrivyClient.walletApi.createWallet.mockResolvedValue({
      id: "wallet-with-policy",
      chainType: "stellar",
      publicKey: "g".repeat(64),
    });

    await createVerificationMethodsFromPrivy(
      "user-000",
      mockPrivyClient,
      "test.example.com",
      "policyuser"
    );

    expect(mockPrivyClient.walletApi.createWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        policyIds: ["policy-1", "policy-2", "policy-3"],
      })
    );
  });

  test("constructs correct DID format", async () => {
    const mockUser = {
      id: "user-did",
      linkedAccounts: [
        {
          type: "wallet",
          id: "stellar-1",
          chainType: "stellar",
          publicKey: "h".repeat(64),
        },
        {
          type: "wallet",
          id: "stellar-2",
          chainType: "stellar",
          publicKey: "i".repeat(64),
        },
      ],
    };

    mockPrivyClient.getUserById.mockResolvedValue(mockUser);

    const result = await createVerificationMethodsFromPrivy(
      "user-did",
      mockPrivyClient,
      "example.com",
      "alice"
    );

    // The verification method should reference the correct DID
    expect(result.updateKey).toMatch(/^did:key:z/);
  });
});
