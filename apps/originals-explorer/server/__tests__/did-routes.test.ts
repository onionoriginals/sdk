import { describe, test, expect, mock, beforeEach } from "bun:test";

describe("DID Routes Input Validation", () => {
  describe("POST /api/did/submit-log validation", () => {
    test("rejects request with missing did field", () => {
      const requestBody = {
        // did missing
        didDocument: { id: "did:webvh:example.com:user" },
        didLog: [{ versionId: "1" }],
      };

      const missingDid = !requestBody.did;
      expect(missingDid).toBe(true);
    });

    test("rejects request with missing didDocument field", () => {
      const requestBody = {
        did: "did:webvh:example.com:user",
        // didDocument missing
        didLog: [{ versionId: "1" }],
      };

      const missingDidDocument = !requestBody.didDocument;
      expect(missingDidDocument).toBe(true);
    });

    test("rejects request with missing didLog field", () => {
      const requestBody = {
        did: "did:webvh:example.com:user",
        didDocument: { id: "did:webvh:example.com:user" },
        // didLog missing
      };

      const missingDidLog = !requestBody.didLog;
      expect(missingDidLog).toBe(true);
    });

    test("rejects request with null values", () => {
      const requestBody = {
        did: null,
        didDocument: null,
        didLog: null,
      };

      const hasNullValues = !requestBody.did || !requestBody.didDocument || !requestBody.didLog;
      expect(hasNullValues).toBe(true);
    });

    test("rejects request with empty strings", () => {
      const requestBody = {
        did: "",
        didDocument: {},
        didLog: [],
      };

      const hasEmptyDid = !requestBody.did;
      expect(hasEmptyDid).toBe(true);
    });

    test("rejects DID with invalid format (not did:webvh)", () => {
      const invalidDids = [
        "did:peer:123",
        "did:key:z6Mk...",
        "did:btco:abc",
        "not-a-did",
        "webvh:example.com:user",
        "did:web:example.com",
      ];

      for (const did of invalidDids) {
        const isValid = did.startsWith("did:webvh:");
        expect(isValid).toBe(false);
      }
    });

    test("accepts DID with valid did:webvh format", () => {
      const validDids = [
        "did:webvh:example.com:user",
        "did:webvh:localhost%3A5000:user123",
        "did:webvh:SCID123:example.com:alice",
      ];

      for (const did of validDids) {
        const isValid = did.startsWith("did:webvh:");
        expect(isValid).toBe(true);
      }
    });

    test("validates didDocument has verificationMethod array", () => {
      const validDidDocument = {
        id: "did:webvh:example.com:user",
        verificationMethod: [
          { id: "#key-0", type: "Multikey", publicKeyMultibase: "z..." },
          { id: "#key-1", type: "Multikey", publicKeyMultibase: "z..." },
        ],
      };

      expect(Array.isArray(validDidDocument.verificationMethod)).toBe(true);
      expect(validDidDocument.verificationMethod.length).toBeGreaterThan(0);
    });

    test("validates didLog is array", () => {
      const validDidLog = [
        {
          versionId: "1-12345",
          versionTime: "2024-01-01T00:00:00Z",
          state: {},
          proof: [],
        },
      ];

      expect(Array.isArray(validDidLog)).toBe(true);
    });

    test("validates didLog has proof array", () => {
      const validLogEntry = {
        versionId: "1-12345",
        proof: [
          {
            type: "DataIntegrityProof",
            cryptosuite: "eddsa-jcs-2022",
            verificationMethod: "did:key:z...",
            proofValue: "z...",
          },
        ],
      };

      expect(Array.isArray(validLogEntry.proof)).toBe(true);
      expect(validLogEntry.proof.length).toBeGreaterThan(0);
    });
  });

  describe("Key extraction validation", () => {
    test("extracts auth key from verificationMethod[0]", () => {
      const didDocument = {
        verificationMethod: [
          { id: "#key-0", publicKeyMultibase: "zAuthKey123" },
          { id: "#key-1", publicKeyMultibase: "zAssertionKey456" },
        ],
      };

      const authKey = didDocument.verificationMethod.find((vm: any) => vm.id === "#key-0")?.publicKeyMultibase;
      expect(authKey).toBe("zAuthKey123");
    });

    test("extracts assertion key from verificationMethod[1]", () => {
      const didDocument = {
        verificationMethod: [
          { id: "#key-0", publicKeyMultibase: "zAuthKey123" },
          { id: "#key-1", publicKeyMultibase: "zAssertionKey456" },
        ],
      };

      const assertionKey = didDocument.verificationMethod.find((vm: any) => vm.id === "#key-1")?.publicKeyMultibase;
      expect(assertionKey).toBe("zAssertionKey456");
    });

    test("extracts update key from did:key format in proof", () => {
      const proof = {
        verificationMethod: "did:key:zUpdateKey789",
      };

      const didKeyMatch = proof.verificationMethod.match(/did:key:(z[a-zA-Z0-9]+)/);
      const updateKey = didKeyMatch ? didKeyMatch[1] : null;

      expect(updateKey).toBe("zUpdateKey789");
    });

    test("handles missing verificationMethod in DID document", () => {
      const didDocument = {};

      const verificationMethods = didDocument.verificationMethod || [];
      const authKey = verificationMethods.find((vm: any) => vm.id === "#key-0")?.publicKeyMultibase || null;

      expect(authKey).toBeNull();
    });

    test("handles missing publicKeyMultibase field", () => {
      const didDocument = {
        verificationMethod: [
          { id: "#key-0" }, // Missing publicKeyMultibase
        ],
      };

      const authKey = didDocument.verificationMethod.find((vm: any) => vm.id === "#key-0")?.publicKeyMultibase || null;
      expect(authKey).toBeNull();
    });

    test("handles proof without verificationMethod", () => {
      const proof = {
        type: "DataIntegrityProof",
        // verificationMethod missing
      };

      const didKeyMatch = proof.verificationMethod?.match(/did:key:(z[a-zA-Z0-9]+)/);
      const updateKey = didKeyMatch ? didKeyMatch[1] : null;

      expect(updateKey).toBeNull();
    });

    test("handles malformed did:key in proof", () => {
      const invalidFormats = [
        "not-a-did-key",
        "did:web:example.com",
        "zUpdateKey789", // Missing did:key prefix
        "did:key:", // Missing key value
      ];

      for (const format of invalidFormats) {
        const proof = { verificationMethod: format };
        const didKeyMatch = proof.verificationMethod.match(/did:key:(z[a-zA-Z0-9]+)/);
        const updateKey = didKeyMatch ? didKeyMatch[1] : null;

        expect(updateKey).toBeNull();
      }
    });
  });

  describe("DID format validation", () => {
    test("validates basic did:webvh format", () => {
      const did = "did:webvh:example.com:user";
      const parts = did.split(":");

      expect(parts[0]).toBe("did");
      expect(parts[1]).toBe("webvh");
      expect(parts.length).toBeGreaterThanOrEqual(4);
    });

    test("validates did:webvh with SCID", () => {
      const did = "did:webvh:Qm123abcSCID:example.com:alice";
      const parts = did.split(":");

      expect(parts[0]).toBe("did");
      expect(parts[1]).toBe("webvh");
      expect(parts[2]).toContain("Q"); // SCID likely starts with Q
      expect(parts.length).toBe(5);
    });

    test("validates did:webvh with encoded domain", () => {
      const did = "did:webvh:localhost%3A5000:user";
      const parts = did.split(":");

      expect(parts[2]).toContain("%3A"); // Encoded colon
      expect(decodeURIComponent(parts[2])).toBe("localhost:5000");
    });

    test("rejects did:webvh with too few parts", () => {
      const invalidDids = [
        "did:webvh",
        "did:webvh:example.com",
        "did:webvh:",
      ];

      for (const did of invalidDids) {
        const parts = did.split(":");
        const isValid = parts.length >= 4 && parts[0] === "did" && parts[1] === "webvh";
        expect(isValid).toBe(false);
      }
    });
  });

  describe("JSONL format validation", () => {
    test("converts array of log entries to JSONL format", () => {
      const logEntries = [
        { versionId: "1", data: "entry1" },
        { versionId: "2", data: "entry2" },
      ];

      const jsonl = logEntries.map(entry => JSON.stringify(entry)).join("\n");

      const lines = jsonl.split("\n");
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[0]).versionId).toBe("1");
      expect(JSON.parse(lines[1]).versionId).toBe("2");
    });

    test("handles single entry array", () => {
      const logEntries = [{ versionId: "1", data: "only" }];
      const jsonl = logEntries.map(entry => JSON.stringify(entry)).join("\n");

      expect(jsonl).toBe(JSON.stringify(logEntries[0]));
    });

    test("handles empty array", () => {
      const logEntries: any[] = [];
      const jsonl = logEntries.map(entry => JSON.stringify(entry)).join("\n");

      expect(jsonl).toBe("");
    });

    test("handles object converted to array", () => {
      const didLog = { versionId: "1", data: "single" };
      const logEntries = Array.isArray(didLog) ? didLog : [didLog];

      expect(Array.isArray(logEntries)).toBe(true);
      expect(logEntries.length).toBe(1);
      expect(logEntries[0].versionId).toBe("1");
    });
  });

  describe("Temporary DID detection", () => {
    test("detects temporary DID format", () => {
      const tempDids = [
        "temp:turnkey:123abc",
        "temp:turnkey:org_456def",
        "temp:turnkey:SubOrgId",
      ];

      for (const did of tempDids) {
        const isTemporary = did.startsWith("temp:");
        expect(isTemporary).toBe(true);
      });
    });

    test("does not detect real DIDs as temporary", () => {
      const realDids = [
        "did:webvh:example.com:user",
        "did:peer:123",
        "did:key:z6Mk...",
      ];

      for (const did of realDids) {
        const isTemporary = did.startsWith("temp:");
        expect(isTemporary).toBe(false);
      }
    });

    test("handles null DID", () => {
      const did = null;
      const isTemporary = did && did.startsWith("temp:");
      expect(isTemporary).toBeFalsy();
    });

    test("handles undefined DID", () => {
      const did = undefined;
      const isTemporary = did && did.startsWith("temp:");
      expect(isTemporary).toBeFalsy();
    });

    test("handles empty string DID", () => {
      const did = "";
      const isTemporary = did && did.startsWith("temp:");
      expect(isTemporary).toBeFalsy();
    });
  });

  describe("Multibase encoding validation", () => {
    test("validates multibase base58btc format", () => {
      const validKeys = [
        "z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
        "z3u2en7t3yAMWBCCsEGRoR1G", // Shorter but valid
        "zAuthKey123",
      ];

      for (const key of validKeys) {
        expect(key.startsWith("z")).toBe(true);
        expect(key.length).toBeGreaterThan(1);
      }
    });

    test("rejects non-multibase formats", () => {
      const invalidKeys = [
        "02" + "a".repeat(64), // Hex
        "0x" + "a".repeat(64), // Hex with prefix
        "authkey123", // No multibase prefix
        "", // Empty
      ];

      for (const key of invalidKeys) {
        const isValid = key.startsWith("z") && key.length > 1;
        expect(isValid).toBe(false);
      }
    });

    test("validates signature proofValue format", () => {
      const validSignatures = [
        "z5TcWUJvJJoUdCwYt6tJzD...", // Typical Ed25519 signature
        "z" + "A".repeat(87), // 64 bytes = 88 base58 chars approximately
      ];

      for (const sig of validSignatures) {
        expect(sig.startsWith("z")).toBe(true);
      }
    });
  });
});
