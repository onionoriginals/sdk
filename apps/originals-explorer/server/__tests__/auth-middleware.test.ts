import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createAuthMiddleware } from "../auth-middleware";
import { storage } from "../storage";

// Mock Privy client
const mockPrivyClient = {
  verifyAuthToken: mock(async (token: string) => {
    if (token === "valid-token") {
      return { userId: "did:privy:cltest123" };
    } else if (token === "webvh-user-token") {
      return { userId: "user-with-webvh" };
    }
    throw new Error("Invalid token");
  }),
} as any;

// Mock request/response
function createMockReq(authHeader?: string) {
  return {
    headers: {
      authorization: authHeader,
    },
    path: "/api/test",
  } as any;
}

function createMockRes() {
  const res = {
    statusCode: 200,
    jsonData: null,
    status: mock(function(this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: mock(function(this: any, data: any) {
      this.jsonData = data;
      return this;
    }),
  };
  return res as any;
}

function createMockNext() {
  return mock(() => {});
}

describe("Authentication Middleware", () => {
  const authMiddleware = createAuthMiddleware(mockPrivyClient);

  beforeEach(async () => {
    // Clear mocks
    mockPrivyClient.verifyAuthToken.mockClear();

    // Setup test users
    await storage.ensureUser("did:privy:cltest123");
    await storage.ensureUser("user-with-webvh");
    
    // Give one user a did:webvh
    await storage.updateUser("user-with-webvh", {
      did_webvh: "did:webvh:localhost%3A5000:u-abc123",
      didWebvhDocument: {
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: "did:webvh:localhost%3A5000:u-abc123",
      },
    });
  });

  describe("Token Validation", () => {
    test("rejects request without authorization header", async () => {
      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Missing authorization header" });
      expect(next).not.toHaveBeenCalled();
    });

    test("rejects request with invalid authorization format", async () => {
      const req = createMockReq("InvalidFormat token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid authorization header format" });
      expect(next).not.toHaveBeenCalled();
    });

    test("rejects request with invalid token", async () => {
      const req = createMockReq("Bearer invalid-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(mockPrivyClient.verifyAuthToken).toHaveBeenCalledWith("invalid-token");
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid or expired token" });
      expect(next).not.toHaveBeenCalled();
    });

    test("accepts request with valid token", async () => {
      const req = createMockReq("Bearer valid-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(mockPrivyClient.verifyAuthToken).toHaveBeenCalledWith("valid-token");
      expect(next).toHaveBeenCalled();
      expect((req as any).user).toBeDefined();
      expect((req as any).user.privyDid).toBe("did:privy:cltest123");
    });
  });

  describe("User Information", () => {
    test("sets user information on request", async () => {
      const req = createMockReq("Bearer valid-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect((req as any).user).toBeDefined();
      expect((req as any).user.id).toBe("did:privy:cltest123");
      expect((req as any).user.privyDid).toBe("did:privy:cltest123");
      expect((req as any).user.did_privy).toBe("did:privy:cltest123");
    });

    test("includes did:webvh when available", async () => {
      const req = createMockReq("Bearer webvh-user-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect((req as any).user).toBeDefined();
      expect((req as any).user.did_webvh).toBe("did:webvh:localhost%3A5000:u-abc123");
    });

    test("sets correlation ID on request", async () => {
      const req = createMockReq("Bearer valid-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect((req as any).correlationId).toBeDefined();
      expect(typeof (req as any).correlationId).toBe("string");
    });

    test("uses provided correlation ID from header", async () => {
      const req = createMockReq("Bearer valid-token");
      req.headers['x-correlation-id'] = 'custom-correlation-id';
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect((req as any).correlationId).toBe('custom-correlation-id');
    });
  });

  describe("Canonical DID Selection", () => {
    test("uses did:privy as canonical when webvh disabled", async () => {
      // Ensure webvh is disabled (default)
      process.env.AUTH_DID_WEBVH_ENABLED = 'false';

      const req = createMockReq("Bearer valid-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect((req as any).user.canonicalDid).toBe("did:privy:cltest123");
    });

    test("uses fallback to user ID when no DIDs available", async () => {
      // Create a user with no DIDs
      await storage.ensureUser("user-no-dids");
      await storage.updateUser("user-no-dids", {
        did_webvh: null,
        did_privy: null,
      });

      mockPrivyClient.verifyAuthToken.mockResolvedValueOnce({
        userId: "user-no-dids",
      });

      const req = createMockReq("Bearer test-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect((req as any).user.canonicalDid).toBe("user-no-dids");
    });
  });

  describe("Error Handling", () => {
    test("returns 401 for non-existent user", async () => {
      mockPrivyClient.verifyAuthToken.mockResolvedValueOnce({
        userId: "non-existent-user",
      });

      const req = createMockReq("Bearer test-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "User not found" });
      expect(next).not.toHaveBeenCalled();
    });

    test("handles verification errors gracefully", async () => {
      mockPrivyClient.verifyAuthToken.mockRejectedValueOnce(
        new Error("Verification service unavailable")
      );

      const req = createMockReq("Bearer test-token");
      const res = createMockRes();
      const next = createMockNext();

      await authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Invalid or expired token" });
    });
  });

  describe("Performance", () => {
    test("completes authentication within acceptable latency", async () => {
      const req = createMockReq("Bearer valid-token");
      const res = createMockRes();
      const next = createMockNext();

      const startTime = Date.now();
      await authMiddleware(req, res, next);
      const duration = Date.now() - startTime;

      // Should complete in less than 100ms for in-memory storage
      expect(duration).toBeLessThan(100);
      expect(next).toHaveBeenCalled();
    });
  });
});
