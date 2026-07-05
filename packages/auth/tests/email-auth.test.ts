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
import { createOtpTargetBundle, decryptOtpBundle } from './helpers/otp-test-utils';

// Shared OTP target-bundle fixture: a validly-signed (with test keys)
// otpEncryptionTargetBundle mirroring what Turnkey v6 initOtp returns.
// Turnkey itself is always MOCKED at the client boundary in these tests.
const otpFixture = createOtpTargetBundle();
const verifyOptions = {
  dangerouslyOverrideSignerPublicKey: otpFixture.signerPublicKey,
};

// Mock Turnkey client
function createMockTurnkeyClient(overrides?: {
  initOtp?: () => Promise<unknown>;
  verifyOtp?: () => Promise<unknown>;
  getSubOrgIds?: () => Promise<unknown>;
  getWallets?: () => Promise<unknown>;
  createSubOrganization?: () => Promise<unknown>;
}) {
  const initOtp =
    overrides?.initOtp ??
    mock(() =>
      Promise.resolve({
        otpId: 'otp_123',
        otpEncryptionTargetBundle: otpFixture.otpEncryptionTargetBundle,
      })
    );
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
      // CSPRNG session IDs: prefix + 32 chars of base64url (24 random bytes)
      expect(result.sessionId.length).toBeGreaterThanOrEqual(32);
      expect(result.message).toContain('Verification code sent');
    });

    test('session IDs are unique across calls', async () => {
      const client = createMockTurnkeyClient();
      const storage2 = createInMemorySessionStorage();
      const result1 = await initiateEmailAuth('user@example.com', client, storage);
      const result2 = await initiateEmailAuth('user@example.com', client, storage2);

      expect(result1.sessionId).not.toBe(result2.sessionId);
      storage2.cleanup();
    });

    test('stores session in storage with correct data', async () => {
      const client = createMockTurnkeyClient();
      const result = await initiateEmailAuth('user@example.com', client, storage);

      const session = storage.get(result.sessionId);
      expect(session).toBeDefined();
      expect(session!.email).toBe('user@example.com');
      expect(session!.otpId).toBe('otp_123');
      expect(session!.otpEncryptionTargetBundle).toBe(otpFixture.otpEncryptionTargetBundle);
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

    test('throws when no OTP encryption target bundle returned', async () => {
      // Turnkey v6 initOtp must return the target-encryption bundle; without
      // it the OTP code cannot be encrypted for verification.
      const client = createMockTurnkeyClient({
        initOtp: mock(() => Promise.resolve({ otpId: 'otp_123' })),
      });
      await expect(initiateEmailAuth('user@example.com', client, storage)).rejects.toThrow(
        'no OTP encryption target bundle returned'
      );
    });

    test('calls Turnkey initOtp with correct parameters', async () => {
      const initOtp = mock(() =>
        Promise.resolve({
          otpId: 'otp_456',
          otpEncryptionTargetBundle: otpFixture.otpEncryptionTargetBundle,
        })
      );
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

      const result = await verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions);
      expect(result.verified).toBe(true);
      expect(result.email).toBe('user@example.com');
      expect(result.subOrgId).toBe('sub_org_existing');
      expect(result.verificationToken).toBe('token_abc');
    });

    test('marks session as verified', async () => {
      const client = createMockTurnkeyClient();
      const sessionId = await setupSession(client);
      await verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions);

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

      await expect(
        verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions)
      ).rejects.toThrow('Session expired');
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

    test('throws when OTP encryption target bundle missing in session', async () => {
      // e.g. a session created before the v6 encrypted-bundle flow
      const verifyOtp = mock(() => Promise.resolve({ verificationToken: 'token' }));
      const client = createMockTurnkeyClient({ verifyOtp });
      storage.set('session_no_bundle', {
        email: 'user@example.com',
        subOrgId: 'sub_123',
        otpId: 'otp_123',
        timestamp: Date.now(),
        verified: false,
      });

      await expect(
        verifyEmailAuth('session_no_bundle', '123456', client, storage, verifyOptions)
      ).rejects.toThrow('OTP encryption target bundle not found');
      expect(verifyOtp).not.toHaveBeenCalled();
    });

    test('throws without calling Turnkey when the target bundle signature is untrusted', async () => {
      // Without the test signer override, the bundle must be signed by
      // Turnkey's production enclave key - our test bundle is not.
      const verifyOtp = mock(() => Promise.resolve({ verificationToken: 'token' }));
      const client = createMockTurnkeyClient({ verifyOtp });
      const sessionId = await setupSession(client);

      await expect(
        verifyEmailAuth(sessionId, '123456', client, storage) // no override
      ).rejects.toThrow('Failed to encrypt OTP code');
      expect(verifyOtp).not.toHaveBeenCalled();
    });

    test('throws when verification token not returned', async () => {
      const client = createMockTurnkeyClient({
        verifyOtp: mock(() => Promise.resolve({ verificationToken: null })),
      });
      const sessionId = await setupSession(client);

      await expect(
        verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions)
      ).rejects.toThrow('Invalid verification code');
    });

    test('throws when Turnkey verifyOtp rejects', async () => {
      const client = createMockTurnkeyClient({
        verifyOtp: mock(() => Promise.reject(new Error('OTP code invalid'))),
      });
      const sessionId = await setupSession(client);

      await expect(
        verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions)
      ).rejects.toThrow('Invalid verification code');
    });

    test('rejects code shorter than 4 characters', async () => {
      const client = createMockTurnkeyClient();
      const sessionId = await setupSession(client);
      await expect(verifyEmailAuth(sessionId, '123', client, storage)).rejects.toThrow(
        'Invalid verification code format'
      );
    });

    test('rejects oversized code without calling Turnkey', async () => {
      const verifyOtp = mock(() => Promise.resolve({ verificationToken: 'token' }));
      const client = createMockTurnkeyClient({ verifyOtp });
      const sessionId = await setupSession(client);

      const hugeCode = 'A'.repeat(5000);
      await expect(verifyEmailAuth(sessionId, hugeCode, client, storage)).rejects.toThrow(
        'Invalid verification code format'
      );
      // Turnkey must NOT have been called
      expect(verifyOtp).not.toHaveBeenCalled();
    });

    test('rejects code with non-alphanumeric characters', async () => {
      const client = createMockTurnkeyClient();
      const sessionId = await setupSession(client);
      await expect(verifyEmailAuth(sessionId, '12 456', client, storage)).rejects.toThrow(
        'Invalid verification code format'
      );
    });

    test('calls Turnkey verifyOtp with an encrypted OTP bundle (v6 flow)', async () => {
      const verifyOtp = mock(() =>
        Promise.resolve({ verificationToken: 'token_xyz' })
      );
      const client = createMockTurnkeyClient({ verifyOtp });
      const sessionId = await setupSession(client);

      await verifyEmailAuth(sessionId, '654321', client, storage, verifyOptions);

      expect(verifyOtp).toHaveBeenCalledWith(
        expect.objectContaining({
          otpId: 'otp_123',
          encryptedOtpBundle: expect.any(String),
          expirationSeconds: '900',
        })
      );

      // The plaintext OTP code must never be sent to Turnkey
      const callArg = verifyOtp.mock.calls[0][0] as Record<string, unknown>;
      expect(callArg.otpCode).toBeUndefined();

      // The encrypted bundle must decrypt (with the target key) to the code
      // plus an ephemeral client public key
      const plaintext = decryptOtpBundle(
        callArg.encryptedOtpBundle as string,
        otpFixture.targetPrivateKey
      );
      expect(plaintext.otp_code).toBe('654321');
      expect(plaintext.public_key).toMatch(/^0[23][0-9a-f]{64}$/);
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
