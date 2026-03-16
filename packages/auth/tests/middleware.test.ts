import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createAuthMiddleware, createOptionalAuthMiddleware } from '../src/server/middleware';
import { signToken } from '../src/server/jwt';
import type { Request, Response, NextFunction } from 'express';

const TEST_SECRET = 'test-jwt-secret-that-is-long-enough-for-hs256';

function createMockReq(cookies?: Record<string, string>): Request {
  return {
    cookies: cookies ?? {},
  } as unknown as Request;
}

function createMockRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 0,
    _json: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

const mockUser = {
  id: 'user_1',
  email: 'user@example.com',
  did: 'did:peer:123',
  turnkeySubOrgId: 'sub_org_123',
};

describe('middleware', () => {
  const originalEnv = process.env.JWT_SECRET;

  beforeEach(() => {
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.JWT_SECRET = originalEnv;
    } else {
      delete process.env.JWT_SECRET;
    }
  });

  describe('createAuthMiddleware', () => {
    test('authenticates valid token and attaches user to request', async () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const req = createMockReq({ auth_token: token });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(mockUser)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as any).user).toBeDefined();
      expect((req as any).user.id).toBe('user_1');
      expect((req as any).user.turnkeySubOrgId).toBe('sub_org_123');
      expect((req as any).user.email).toBe('user@example.com');
      expect((req as any).user.did).toBe('did:peer:123');
    });

    test('returns 401 when no token present', async () => {
      const req = createMockReq({});
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: 'Not authenticated' });
    });

    test('returns 401 for invalid token', async () => {
      const req = createMockReq({ auth_token: 'invalid.token' });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: 'Invalid or expired token' });
    });

    test('returns 401 when user not found and no createUser', async () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const req = createMockReq({ auth_token: token });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect(res._json).toEqual({ error: 'User not found' });
    });

    test('creates user when not found and createUser provided', async () => {
      const newUser = {
        id: 'user_new',
        email: 'new@example.com',
        did: 'temp:turnkey:sub_org_456',
        turnkeySubOrgId: 'sub_org_456',
      };
      const createUser = mock(() => Promise.resolve(newUser));
      const token = signToken('sub_org_456', 'new@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const req = createMockReq({ auth_token: token });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        createUser,
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(createUser).toHaveBeenCalledWith(
        'sub_org_456',
        'new@example.com',
        'temp:turnkey:sub_org_456'
      );
      expect(next).toHaveBeenCalled();
      expect((req as any).user.id).toBe('user_new');
    });

    test('uses custom cookie name', async () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const req = createMockReq({ my_cookie: token });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(mockUser)),
        jwtSecret: TEST_SECRET,
        cookieName: 'my_cookie',
      });

      await middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as any).user.id).toBe('user_1');
    });

    test('includes sessionToken in user when present in JWT', async () => {
      const token = signToken('sub_org_123', 'user@example.com', 'turnkey_session_xyz', {
        secret: TEST_SECRET,
      });
      const req = createMockReq({ auth_token: token });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(mockUser)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect((req as any).user.sessionToken).toBe('turnkey_session_xyz');
    });

    test('returns 401 when cookies object is undefined', async () => {
      const req = { cookies: undefined } as unknown as Request;
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(res._status).toBe(401);
    });
  });

  describe('createOptionalAuthMiddleware', () => {
    test('attaches user when valid token present', async () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const req = createMockReq({ auth_token: token });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createOptionalAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(mockUser)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as any).user).toBeDefined();
      expect((req as any).user.id).toBe('user_1');
    });

    test('continues without user when no token', async () => {
      const req = createMockReq({});
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createOptionalAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as any).user).toBeUndefined();
    });

    test('continues without user when token is invalid', async () => {
      const req = createMockReq({ auth_token: 'bad.token' });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createOptionalAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as any).user).toBeUndefined();
    });

    test('continues without user when user not found in DB', async () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const req = createMockReq({ auth_token: token });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createOptionalAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as any).user).toBeUndefined();
    });

    test('uses custom cookie name', async () => {
      const token = signToken('sub_org_123', 'user@example.com', undefined, {
        secret: TEST_SECRET,
      });
      const req = createMockReq({ custom_auth: token });
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createOptionalAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(mockUser)),
        jwtSecret: TEST_SECRET,
        cookieName: 'custom_auth',
      });

      await middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
      expect((req as any).user.id).toBe('user_1');
    });

    test('continues when cookies object is undefined', async () => {
      const req = { cookies: undefined } as unknown as Request;
      const res = createMockRes();
      const next = mock(() => {});

      const middleware = createOptionalAuthMiddleware({
        getUserByTurnkeyId: mock(() => Promise.resolve(null)),
        jwtSecret: TEST_SECRET,
      });

      await middleware(req, res, next as NextFunction);

      expect(next).toHaveBeenCalled();
    });
  });
});
