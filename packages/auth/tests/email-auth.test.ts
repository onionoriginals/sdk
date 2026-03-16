import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  initiateEmailAuth,
  verifyEmailAuth,
  isSessionVerified,
  cleanupSession,
  getSession,
  createInMemorySessionStorage,
  type SessionStorage,
} from '../src/server/email-auth';

// Mock Turnkey client
function createMockTurnkeyClient(overrides?: {
  initOtp?: () => Promise<unknown>;
  verifyOtp?: () => Promise<unknown>;
  getSubOrgIds?: () => Promise<unknown>;
  getWallets?: () => Promise<unknown>;
  createSubOrganization?: () => Promise<unknown>;
}) {
  const initOtp = overrides?.initOtp ?? mock(() => Promise.resolve({ otpId: 'otp_123' }));
  const verifyOtp =
    overrides?.verifyOtp ??
    mock(() => Promise.resolve({ verificationToken: 'token_abc' }));
  const getSubOrgIds =
    overrides?.getSubOrgIds ??
    mock(() => Promise.resolve({ organizationIds: ['sub_org_existing'] }));
  const getWallets =
    overrides?.getWallets ??
    mock(() => Promise.resolve({ wallets: [{ walletId: 'w1' }] }));
  const createSubOrganization =
    overrides?.createSubOrganization ??
    mock(() =>
      Promise.resolve({
        activity: {
          result: {
            createSubOrganizationResultV7: { subOrganizationId: 'sub_org_new' },
          },
        },
      })
    );

  return {
    apiClient: () => ({
      initOtp,
      verifyOtp,
      getSubOrgIds,
      getWallets,
      createSubOrganization,
    }),
  } as unknown as import('@turnkey/sdk-server').Turnkey;
}

describe('email-auth', () => {
  let storage: SessionStorage;
  const originalEnv = process.env.TURNKEY_ORGANIZATION_ID;

  beforeEach(() => {
    storage = createInMemorySessionStorage();
    process.env.TURNKEY_ORGANIZATION_ID = 'org_test_123';
  });

  afterEach(() => {
    storage.cleanup();
    if (originalEnv !== undefined) {
      process.env.TURNKEY_ORGANIZATION_ID = originalEnv;
    } else {
      delete process.env.TURNKEY_ORGANIZATION_ID;
    }
  });

  describe('createInMemorySessionStorage', () => {
    test('stores and retrieves sessions', () => {
      const session = {
        email: 'test@example.com',
        subOrgId: 'sub_123',
        otpId: 'otp_123',
        timestamp: Date.now(),
        verified: false,
      };
      storage.set('session_1', session);
      expect(storage.get('session_1')).toEqual(session);
    });

    test('returns undefined for missing sessions', () => {
      expect(storage.get('nonexistent')).toBeUndefined();
    });

    test('deletes sessions', () => {
      storage.set('session_1', {
        email: 'test@example.com',
        timestamp: Date.now(),
        verified: false,
      });
      storage.delete('session_1');
      expect(storage.get('session_1')).toBeUndefined();
    });

    test('cleanup clears all sessions', () => {
      storage.set('s1', { email: 'a@b.com', timestamp: Date.now(), verified: false });
      storage.set('s2', { email: 'c@d.com', timestamp: Date.now(), verified: false });
      storage.cleanup();
      expect(storage.get('s1')).toBeUndefined();
      expect(storage.get('s2')).toBeUndefined();
    });
  });

  describe('initiateEmailAuth', () => {
    test('sends OTP and returns session ID', async () => {
      const client = createMockTurnkeyClient();
      const result = await initiateEmailAuth('user@example.com', client, storage);

      expect(result.sessionId).toMatch(/^session_/);
      expect(result.message).toContain('Verification code sent');
    });

    test('stores session in storage with correct data', async () => {
      const client = createMockTurnkeyClient();
      const result = await initiateEmailAuth('user@example.com', client, storage);

      const session = storage.get(result.sessionId);
      expect(session).toBeDefined();
      expect(session!.email).toBe('user@example.com');
      expect(session!.otpId).toBe('otp_123');
      expect(session!.verified).toBe(false);
      expect(session!.subOrgId).toBe('sub_org_existing');
    });

    test('rejects invalid email format', async () => {
      const client = createMockTurnkeyClient();
      await expect(initiateEmailAuth('not-an-email', client, storage)).rejects.toThrow(
        'Invalid email format'
      );
    });

    test('rejects email without domain', async () => {
      const client = createMockTurnkeyClient();
      await expect(initiateEmailAuth('user@', client, storage)).rejects.toThrow(
        'Invalid email format'
      );
    });

    test('throws when no OTP ID returned', async () => {
      const client = createMockTurnkeyClient({
        initOtp: mock(() => Promise.resolve({ otpId: null })),
      });
      await expect(initiateEmailAuth('user@example.com', client, storage)).rejects.toThrow(
        'Failed to initiate OTP'
      );
    });

    test('calls Turnkey initOtp with correct parameters', async () => {
      const initOtp = mock(() => Promise.resolve({ otpId: 'otp_456' }));
      const client = createMockTurnkeyClient({ initOtp });
      await initiateEmailAuth('test@example.com', client, storage);

      expect(initOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          otpType: 'OTP_TYPE_EMAIL',
          contact: 'test@example.com',
          appName: 'Originals',
          otpLength: 6,
          alphanumeric: false,
        })
      );
    });

    test('creates new sub-org when none exists', async () => {
      const createSubOrganization = mock(() =>
        Promise.resolve({
          activity: {
            result: {
              createSubOrganizationResultV7: { subOrganizationId: 'new_sub_org' },
            },
          },
        })
      );
      const client = createMockTurnkeyClient({
        getSubOrgIds: mock(() => Promise.resolve({ organizationIds: [] })),
        getWallets: mock(() => Promise.resolve({ wallets: [] })),
        createSubOrganization,
      });

      const result = await initiateEmailAuth('new@example.com', client, storage);
      const session = storage.get(result.sessionId);
      expect(session!.subOrgId).toBe('new_sub_org');
    });
  });

  describe('verifyEmailAuth', () => {
    async function setupSession(client: ReturnType<typeof createMockTurnkeyClient>) {
      const result = await initiateEmailAuth('user@example.com', client, storage);
      return result.sessionId;
    }

    test('verifies OTP and returns success result', async () => {
      const client = createMockTurnkeyClient();
      const sessionId = await setupSession(client);

      const result = await verifyEmailAuth(sessionId, '123456', client, storage);
      expect(result.verified).toBe(true);
      expect(result.email).toBe('user@example.com');
      expect(result.subOrgId).toBe('sub_org_existing');
    });

    test('marks session as verified', async () => {
      const client = createMockTurnkeyClient();
      const sessionId = await setupSession(client);
      await verifyEmailAuth(sessionId, '123456', client, storage);

      const session = storage.get(sessionId);
      expect(session!.verified).toBe(true);
    });

    test('throws for invalid session ID', async () => {
      const client = createMockTurnkeyClient();
      await expect(
        verifyEmailAuth('nonexistent_session', '123456', client, storage)
      ).rejects.toThrow('Invalid or expired session');
    });

    test('throws for expired session', async () => {
      const client = createMockTurnkeyClient();
      const sessionId = await setupSession(client);

      // Manually expire the session
      const session = storage.get(sessionId)!;
      session.timestamp = Date.now() - 16 * 60 * 1000; // 16 minutes ago
      storage.set(sessionId, session);

      await expect(verifyEmailAuth(sessionId, '123456', client, storage)).rejects.toThrow(
        'Session expired'
      );
    });

    test('throws when OTP ID missing in session', async () => {
      const client = createMockTurnkeyClient();
      storage.set('session_no_otp', {
        email: 'user@example.com',
        subOrgId: 'sub_123',
        timestamp: Date.now(),
        verified: false,
      });

      await expect(
        verifyEmailAuth('session_no_otp', '123456', client, storage)
      ).rejects.toThrow('OTP ID not found');
    });

    test('throws when subOrgId missing in session', async () => {
      const client = createMockTurnkeyClient();
      storage.set('session_no_org', {
        email: 'user@example.com',
        otpId: 'otp_123',
        timestamp: Date.now(),
        verified: false,
      });

      await expect(
        verifyEmailAuth('session_no_org', '123456', client, storage)
      ).rejects.toThrow('Sub-organization ID not found');
    });

    test('throws when verification token not returned', async () => {
      const client = createMockTurnkeyClient({
        verifyOtp: mock(() => Promise.resolve({ verificationToken: null })),
      });
      const sessionId = await setupSession(client);

      await expect(verifyEmailAuth(sessionId, '123456', client, storage)).rejects.toThrow(
        'Invalid verification code'
      );
    });

    test('calls Turnkey verifyOtp with correct parameters', async () => {
      const verifyOtp = mock(() =>
        Promise.resolve({ verificationToken: 'token_xyz' })
      );
      const client = createMockTurnkeyClient({ verifyOtp });
      const sessionId = await setupSession(client);

      await verifyEmailAuth(sessionId, '654321', client, storage);

      expect(verifyOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          otpId: 'otp_123',
          otpCode: '654321',
          expirationSeconds: '900',
        })
      );
    });
  });

  describe('isSessionVerified', () => {
    test('returns false for nonexistent session', () => {
      expect(isSessionVerified('nonexistent', storage)).toBe(false);
    });

    test('returns false for unverified session', () => {
      storage.set('session_1', {
        email: 'user@example.com',
        timestamp: Date.now(),
        verified: false,
      });
      expect(isSessionVerified('session_1', storage)).toBe(false);
    });

    test('returns true for verified session', () => {
      storage.set('session_1', {
        email: 'user@example.com',
        timestamp: Date.now(),
        verified: true,
      });
      expect(isSessionVerified('session_1', storage)).toBe(true);
    });

    test('returns false and cleans up expired session', () => {
      storage.set('session_1', {
        email: 'user@example.com',
        timestamp: Date.now() - 16 * 60 * 1000,
        verified: true,
      });
      expect(isSessionVerified('session_1', storage)).toBe(false);
      expect(storage.get('session_1')).toBeUndefined();
    });
  });

  describe('cleanupSession', () => {
    test('removes session from storage', () => {
      storage.set('session_1', {
        email: 'user@example.com',
        timestamp: Date.now(),
        verified: true,
      });
      cleanupSession('session_1', storage);
      expect(storage.get('session_1')).toBeUndefined();
    });

    test('does not throw for nonexistent session', () => {
      expect(() => cleanupSession('nonexistent', storage)).not.toThrow();
    });
  });

  describe('getSession', () => {
    test('returns session data', () => {
      const session = {
        email: 'user@example.com',
        subOrgId: 'sub_123',
        otpId: 'otp_123',
        timestamp: Date.now(),
        verified: false,
      };
      storage.set('session_1', session);
      expect(getSession('session_1', storage)).toEqual(session);
    });

    test('returns undefined for nonexistent session', () => {
      expect(getSession('nonexistent', storage)).toBeUndefined();
    });

    test('returns undefined and cleans up expired session', () => {
      storage.set('session_1', {
        email: 'user@example.com',
        timestamp: Date.now() - 16 * 60 * 1000,
        verified: false,
      });
      expect(getSession('session_1', storage)).toBeUndefined();
      expect(storage.get('session_1')).toBeUndefined();
    });
  });
});
