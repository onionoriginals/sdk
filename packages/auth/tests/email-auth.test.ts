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
  createWallet?: () => Promise<unknown>;
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
  const createWallet =
    overrides?.createWallet ?? mock(() => Promise.resolve({ walletId: 'w_new' }));
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
      createWallet,
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

    test('stores session in storage with correct data (no subOrgId before verification)', async () => {
      const client = createMockTurnkeyClient();
      const result = await initiateEmailAuth('user@example.com', client, storage);

      const session = storage.get(result.sessionId);
      expect(session).toBeDefined();
      expect(session!.email).toBe('user@example.com');
      expect(session!.otpId).toBe('otp_123');
      expect(session!.otpEncryptionTargetBundle).toBe(otpFixture.otpEncryptionTargetBundle);
      expect(session!.verified).toBe(false);
      // Sub-org provisioning is deferred until the email is proven
      expect(session!.subOrgId).toBeUndefined();
    });

    test('normalizes the email before sending the OTP and storing the session', async () => {
      const initOtp = mock(() =>
        Promise.resolve({
          otpId: 'otp_123',
          otpEncryptionTargetBundle: otpFixture.otpEncryptionTargetBundle,
        })
      );
      const client = createMockTurnkeyClient({ initOtp });
      const result = await initiateEmailAuth('  User@Example.COM ', client, storage);

      expect(initOtp).toHaveBeenCalledWith(
        expect.objectContaining({ contact: 'user@example.com' })
      );
      expect(storage.get(result.sessionId)!.email).toBe('user@example.com');
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

    test('does not touch Turnkey sub-org APIs before the email is proven', async () => {
      // Unauthenticated initiation must not create billable resources
      // (sub-orgs, wallets) for unproven email addresses.
      const getSubOrgIds = mock(() => Promise.resolve({ organizationIds: [] }));
      const createSubOrganization = mock(() => Promise.resolve({}));
      const createWallet = mock(() => Promise.resolve({}));
      const client = createMockTurnkeyClient({
        getSubOrgIds,
        createSubOrganization,
        createWallet,
      });

      await initiateEmailAuth('new@example.com', client, storage);

      expect(getSubOrgIds).not.toHaveBeenCalled();
      expect(createSubOrganization).not.toHaveBeenCalled();
      expect(createWallet).not.toHaveBeenCalled();
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

    test('marks session as verified and records the provisioned subOrgId', async () => {
      const client = createMockTurnkeyClient();
      const sessionId = await setupSession(client);
      await verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions);

      const session = storage.get(sessionId);
      expect(session!.verified).toBe(true);
      expect(session!.subOrgId).toBe('sub_org_existing');
    });

    test('provisions a new sub-org after successful verification when none exists', async () => {
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
        createSubOrganization,
      });
      const sessionId = await setupSession(client);

      const result = await verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions);
      expect(result.subOrgId).toBe('new_sub_org');
      expect(createSubOrganization).toHaveBeenCalledTimes(1);
      expect(storage.get(sessionId)!.subOrgId).toBe('new_sub_org');
    });

    test('does not provision a sub-org when OTP verification fails', async () => {
      const getSubOrgIds = mock(() => Promise.resolve({ organizationIds: [] }));
      const createSubOrganization = mock(() => Promise.resolve({}));
      const client = createMockTurnkeyClient({
        verifyOtp: mock(() => Promise.reject(new Error('OTP code invalid'))),
        getSubOrgIds,
        createSubOrganization,
      });
      const sessionId = await setupSession(client);

      await expect(
        verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions)
      ).rejects.toThrow('Invalid verification code');
      expect(getSubOrgIds).not.toHaveBeenCalled();
      expect(createSubOrganization).not.toHaveBeenCalled();
    });

    test('reports provisioning failure distinctly from an invalid code', async () => {
      const client = createMockTurnkeyClient({
        getSubOrgIds: mock(() => Promise.reject(new Error('Turnkey is down'))),
      });
      const sessionId = await setupSession(client);

      await expect(
        verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions)
      ).rejects.toThrow('provisioning the Turnkey sub-organization failed');
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

    test('verifies a session without subOrgId (provisioning happens after verification)', async () => {
      const client = createMockTurnkeyClient();
      storage.set('session_no_org', {
        email: 'user@example.com',
        otpId: 'otp_123',
        otpEncryptionTargetBundle: otpFixture.otpEncryptionTargetBundle,
        timestamp: Date.now(),
        verified: false,
      });

      const result = await verifyEmailAuth(
        'session_no_org',
        '123456',
        client,
        storage,
        verifyOptions
      );
      expect(result.verified).toBe(true);
      expect(result.subOrgId).toBe('sub_org_existing');
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

    test('returns the ephemeral keypair that the verification token is bound to', async () => {
      const verifyOtp = mock(() =>
        Promise.resolve({ verificationToken: 'token_bound' })
      );
      const client = createMockTurnkeyClient({ verifyOtp });
      const sessionId = await setupSession(client);

      const result = await verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions);

      expect(result.verificationToken).toBe('token_bound');
      // The ephemeral P-256 keypair generated during encryption must surface
      // so callers can complete a subsequent otpLogin bound to the same key.
      expect(result.publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
      expect(result.privateKey).toMatch(/^[0-9a-f]{64}$/);

      // The returned public key must be the exact key embedded in the
      // encrypted bundle submitted to Turnkey (the key the token is bound to).
      const callArg = verifyOtp.mock.calls[0][0] as Record<string, unknown>;
      const plaintext = decryptOtpBundle(
        callArg.encryptedOtpBundle as string,
        otpFixture.targetPrivateKey
      );
      expect(result.publicKey).toBe(plaintext.public_key);

      // The plaintext OTP code must NOT leak into the result
      expect(Object.values(result)).not.toContain('123456');
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

      const callArg = verifyOtp.mock.calls[0][0] as Record<string, unknown>;

      // The activity must run under the same org context as initOtp (the
      // parent organization, i.e. no organizationId override): Turnkey
      // scopes the otpId to the initiating org, and the sub-org may not
      // even exist yet at verification time.
      expect(callArg.organizationId).toBeUndefined();

      // The plaintext OTP code must never be sent to Turnkey
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

    test('binds the token to a client-supplied publicKey and returns no private key', async () => {
      const verifyOtp = mock(() => Promise.resolve({ verificationToken: 'token_bound' }));
      const client = createMockTurnkeyClient({ verifyOtp });
      const sessionId = await setupSession(client);

      const clientPublicKey = '02' + 'ab'.repeat(32);
      const result = await verifyEmailAuth(sessionId, '123456', client, storage, {
        ...verifyOptions,
        publicKey: clientPublicKey,
      });

      // The client's key is embedded in the encrypted bundle...
      const callArg = verifyOtp.mock.calls[0][0] as Record<string, unknown>;
      const plaintext = decryptOtpBundle(
        callArg.encryptedOtpBundle as string,
        otpFixture.targetPrivateKey
      );
      expect(plaintext.public_key).toBe(clientPublicKey);

      // ...and echoed in the result, with NO private key: the private key
      // never has to leave the client.
      expect(result.publicKey).toBe(clientPublicKey);
      expect(result.privateKey).toBeUndefined();
    });

    describe('OTP attempt limiting', () => {
      test('failed attempts are counted in the session', async () => {
        const client = createMockTurnkeyClient({
          verifyOtp: mock(() => Promise.reject(new Error('OTP code invalid'))),
        });
        const sessionId = await setupSession(client);

        await expect(
          verifyEmailAuth(sessionId, '111111', client, storage, verifyOptions)
        ).rejects.toThrow('Invalid verification code');
        expect(storage.get(sessionId)!.otpAttempts).toBe(1);

        await expect(
          verifyEmailAuth(sessionId, '222222', client, storage, verifyOptions)
        ).rejects.toThrow('Invalid verification code');
        expect(storage.get(sessionId)!.otpAttempts).toBe(2);
      });

      test('session is destroyed after 5 failed attempts', async () => {
        const client = createMockTurnkeyClient({
          verifyOtp: mock(() => Promise.reject(new Error('OTP code invalid'))),
        });
        const sessionId = await setupSession(client);

        for (let i = 1; i <= 4; i++) {
          await expect(
            verifyEmailAuth(sessionId, '111111', client, storage, verifyOptions)
          ).rejects.toThrow('Invalid verification code');
        }

        // 5th failure destroys the session
        await expect(
          verifyEmailAuth(sessionId, '111111', client, storage, verifyOptions)
        ).rejects.toThrow('Too many failed verification attempts');
        expect(storage.get(sessionId)).toBeUndefined();

        // Subsequent attempts fail as an invalid session, so the otpId can
        // no longer be brute-forced
        await expect(
          verifyEmailAuth(sessionId, '111111', client, storage, verifyOptions)
        ).rejects.toThrow('Invalid or expired session');
      });

      test('a correct code within the attempt budget still succeeds', async () => {
        let calls = 0;
        const client = createMockTurnkeyClient({
          verifyOtp: mock(() => {
            calls += 1;
            return calls <= 2
              ? Promise.reject(new Error('OTP code invalid'))
              : Promise.resolve({ verificationToken: 'token_after_retries' });
          }),
        });
        const sessionId = await setupSession(client);

        await expect(
          verifyEmailAuth(sessionId, '111111', client, storage, verifyOptions)
        ).rejects.toThrow('Invalid verification code');
        await expect(
          verifyEmailAuth(sessionId, '222222', client, storage, verifyOptions)
        ).rejects.toThrow('Invalid verification code');

        const result = await verifyEmailAuth(
          sessionId,
          '333333',
          client,
          storage,
          verifyOptions
        );
        expect(result.verified).toBe(true);
        expect(result.verificationToken).toBe('token_after_retries');
      });

      test('malformed codes rejected before Turnkey do not consume attempts', async () => {
        const client = createMockTurnkeyClient();
        const sessionId = await setupSession(client);

        await expect(verifyEmailAuth(sessionId, '!!', client, storage)).rejects.toThrow(
          'Invalid verification code format'
        );
        expect(storage.get(sessionId)!.otpAttempts).toBeUndefined();
      });
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
