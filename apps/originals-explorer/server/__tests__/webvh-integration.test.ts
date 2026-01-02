import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { WebVHIntegrationService } from "../webvh-integration";
import * as path from "path";
import * as fs from "fs";

// Mock the originals SDK
const mockCreateDIDWebVH = mock();
const mockLoadDIDLog = mock();
const mockSaveDIDLog = mock();
const mockUpdateDIDWebVH = mock();

mock.module("../originals", () => ({
  originalsSdk: {
    did: {
      createDIDWebVH: mockCreateDIDWebVH,
      loadDIDLog: mockLoadDIDLog,
      saveDIDLog: mockSaveDIDLog,
      updateDIDWebVH: mockUpdateDIDWebVH,
    },
  },
}));

describe("WebVHIntegrationService", () => {
  const testPublicDir = "/tmp/test-webvh-public";
  const testDomain = "test.example.com";

  beforeEach(() => {
    // Clear mocks
    mockCreateDIDWebVH.mockClear();
    mockLoadDIDLog.mockClear();
    mockSaveDIDLog.mockClear();
    mockUpdateDIDWebVH.mockClear();

    // Set environment variables before any test
    process.env.DID_DOMAIN = testDomain;

    // Clean up test directory if it exists
    if (fs.existsSync(testPublicDir)) {
      fs.rmSync(testPublicDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testPublicDir)) {
      fs.rmSync(testPublicDir, { recursive: true, force: true });
    }
    
    // Clean up env var
    delete process.env.DID_DOMAIN;
    delete process.env.VITE_APP_DOMAIN;
  });

  describe("constructor", () => {
    test("creates service with provided domain", () => {
      const service = new WebVHIntegrationService({
        domain: "custom.domain.com",
        publicDir: testPublicDir,
      });

      expect(service).toBeDefined();
    });

    test("uses DID_DOMAIN environment variable when domain not provided", () => {
      process.env.DID_DOMAIN = "env.example.com";
      
      const service = new WebVHIntegrationService({
        publicDir: testPublicDir,
      });

      expect(service).toBeDefined();
    });

    test("uses VITE_APP_DOMAIN as fallback", () => {
      delete process.env.DID_DOMAIN;
      process.env.VITE_APP_DOMAIN = "vite.example.com";
      
      const service = new WebVHIntegrationService({
        publicDir: testPublicDir,
      });

      expect(service).toBeDefined();
      delete process.env.VITE_APP_DOMAIN;
    });

    test("throws error when no domain is available", () => {
      delete process.env.DID_DOMAIN;
      delete process.env.VITE_APP_DOMAIN;
      
      expect(() => new WebVHIntegrationService({ publicDir: testPublicDir })).toThrow(
        "Domain is required"
      );
    });

    test("creates public directory structure on initialization", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const wellKnownPath = path.join(testPublicDir, ".well-known", "did");
      expect(fs.existsSync(wellKnownPath)).toBe(true);
    });

    test("uses default public directory when not provided", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
      });

      expect(service).toBeDefined();
    });
  });

  describe("createDIDWithSDK", () => {
    test("creates DID with sanitized slug", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const mockResult = {
        did: `did:webvh:${testDomain}:test-user`,
        didDocument: { id: `did:webvh:${testDomain}:test-user` },
        log: [{ entry: "test" }],
        logPath: "/path/to/log",
      };

      mockCreateDIDWebVH.mockResolvedValue(mockResult);

      const result = await service.createDIDWithSDK("test-user");

      expect(result).toEqual(mockResult);
      expect(mockCreateDIDWebVH).toHaveBeenCalledWith({
        domain: testDomain,
        paths: ["test-user"],
        portable: false,
        outputDir: path.join(testPublicDir, ".well-known"),
      });
    });

    test("sanitizes user slug with special characters", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const mockResult = {
        did: `did:webvh:${testDomain}:test-user`,
        didDocument: {},
        log: [],
        logPath: "/path",
      };

      mockCreateDIDWebVH.mockResolvedValue(mockResult);

      await service.createDIDWithSDK("Test@User#123!");

      expect(mockCreateDIDWebVH).toHaveBeenCalledWith(
        expect.objectContaining({
          paths: ["test-user-123"],
        })
      );
    });

    test("handles Turnkey sub-org ID format", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      mockCreateDIDWebVH.mockResolvedValue({
        did: "did:webvh:test.com:sub-org-abc123",
        didDocument: {},
        log: [],
        logPath: "/path",
      });

      await service.createDIDWithSDK("sub-org-abc123");

      expect(mockCreateDIDWebVH).toHaveBeenCalledWith(
        expect.objectContaining({
          paths: ["sub-org-abc123"],
        })
      );
    });

    test("passes through additional options", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      mockCreateDIDWebVH.mockResolvedValue({
        did: "did:webvh:test.com:user",
        didDocument: {},
        log: [],
        logPath: "/path",
      });

      const customOptions = {
        portable: true,
        verificationMethods: [{ type: "Multikey", publicKeyMultibase: "z..." }],
      };

      await service.createDIDWithSDK("user", customOptions);

      expect(mockCreateDIDWebVH).toHaveBeenCalledWith(
        expect.objectContaining(customOptions)
      );
    });

    test("throws error when SDK createDIDWebVH fails", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      mockCreateDIDWebVH.mockRejectedValue(new Error("SDK error"));

      await expect(service.createDIDWithSDK("user")).rejects.toThrow(
        "Failed to create DID with SDK: SDK error"
      );
    });

    test("handles non-Error thrown from SDK", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      mockCreateDIDWebVH.mockRejectedValue("String error");

      await expect(service.createDIDWithSDK("user")).rejects.toThrow(
        "Failed to create DID with SDK: String error"
      );
    });
  });

  describe("loadDIDLog", () => {
    test("loads DID log from file", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const mockLog = [{ entry: "log1" }, { entry: "log2" }];
      mockLoadDIDLog.mockResolvedValue(mockLog);

      const result = await service.loadDIDLog("/path/to/did.jsonl");

      expect(result).toEqual(mockLog);
      expect(mockLoadDIDLog).toHaveBeenCalledWith("/path/to/did.jsonl");
    });

    test("throws error when loading fails", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      mockLoadDIDLog.mockRejectedValue(new Error("File not found"));

      await expect(service.loadDIDLog("/invalid/path")).rejects.toThrow(
        "Failed to load DID log: File not found"
      );
    });
  });

  describe("saveDIDLog", () => {
    test("saves DID log to file", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const mockLog = [{ entry: "log1" }];
      const mockPath = "/saved/path/did.jsonl";
      mockSaveDIDLog.mockResolvedValue(mockPath);

      const result = await service.saveDIDLog("did:webvh:test.com:user", mockLog);

      expect(result).toBe(mockPath);
      expect(mockSaveDIDLog).toHaveBeenCalledWith(
        "did:webvh:test.com:user",
        mockLog,
        path.join(testPublicDir, ".well-known")
      );
    });

    test("throws error when saving fails", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      mockSaveDIDLog.mockRejectedValue(new Error("Write error"));

      await expect(service.saveDIDLog("did:webvh:test.com:user", [])).rejects.toThrow(
        "Failed to save DID log: Write error"
      );
    });
  });

  describe("updateDID", () => {
    test("updates DID document", async () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const mockResult = {
        didDocument: { updated: true },
        log: [{ entry: "update" }],
        logPath: "/path/to/log",
      };

      mockUpdateDIDWebVH.mockResolvedValue(mockResult);

      const did = "did:webvh:test.com:user";
      const currentLog = [{ entry: "old" }];
      const updates = { verificationMethod: [] };
      const signer = { sign: mock() };

      const result = await service.updateDID(did, currentLog, updates, signer);

      expect(result).toEqual(mockResult);
      expect(mockUpdateDIDWebVH).toHaveBeenCalledWith({
        did,
        currentLog,
        updates,
        signer,
        outputDir: path.join(testPublicDir, ".well-known"),
      });
    });
  });

  describe("getDIDLogPath", () => {
    test("generates correct path for DID with single path component", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const did = "did:webvh:example.com:alice";
      const logPath = service.getDIDLogPath(did);

      expect(logPath).toBe(
        path.join(testPublicDir, ".well-known", "did", "example.com", "alice", "did.jsonl")
      );
    });

    test("generates correct path for DID with multiple path components", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const did = "did:webvh:example.com:users:alice";
      const logPath = service.getDIDLogPath(did);

      expect(logPath).toBe(
        path.join(testPublicDir, ".well-known", "did", "example.com", "users", "alice", "did.jsonl")
      );
    });

    test("handles encoded domain with port", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const did = "did:webvh:localhost%3A5000:alice";
      const logPath = service.getDIDLogPath(did);

      expect(logPath).toContain("localhost_5000");
    });

    test("sanitizes domain with special characters", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const did = "did:webvh:test@example.com:alice";
      const logPath = service.getDIDLogPath(did);

      expect(logPath).toContain("test_example.com");
    });

    test("throws error for invalid DID format", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      expect(() => service.getDIDLogPath("did:web")).toThrow("Invalid DID format");
    });

    test("throws error for malformed DID", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      expect(() => service.getDIDLogPath("invalid")).toThrow("Invalid DID format");
    });
  });

  describe("didLogExists", () => {
    test("returns true when log file exists", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      // Create the directory structure and file
      const did = "did:webvh:example.com:testuser";
      const logPath = service.getDIDLogPath(did);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "");

      const exists = service.didLogExists(did);

      expect(exists).toBe(true);
    });

    test("returns false when log file does not exist", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const did = "did:webvh:example.com:nonexistent";
      const exists = service.didLogExists(did);

      expect(exists).toBe(false);
    });

    test("returns false for invalid DID format", () => {
      const service = new WebVHIntegrationService({
        domain: testDomain,
        publicDir: testPublicDir,
      });

      const exists = service.didLogExists("invalid-did");

      expect(exists).toBe(false);
    });
  });
});
