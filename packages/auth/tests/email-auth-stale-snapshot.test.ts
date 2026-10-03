import { describe, test, expect, mock } from 'bun:test';
import {
  initiateEmailAuth,
  verifyEmailAuth,
  AUTH_EMAIL_ERROR_CODES,
  type SessionStorage,
} from '../src/server/email-auth';
import { createOtpTargetBundle } from './helpers/otp-test-utils';
import type { EmailAuthSession } from '../src/types';

const otpFixture = createOtpTargetBundle();
const verifyOptions = { dangerouslyOverrideSignerPublicKey: otpFixture.signerPublicKey };

function rejectingClient() {
  const verifyOtp = mock(() =>
    Promise.reject(Object.assign(new Error('OTP code invalid'), { code: 3 }))
  );
  const client = {
    apiClient: () => ({
      initOtp: () =>
        Promise.resolve({
          otpId: 'otp_123',
          otpEncryptionTargetBundle: otpFixture.otpEncryptionTargetBundle,
        }),
      verifyOtp,
    }),
  } as unknown as import('@turnkey/sdk-server').Turnkey;
  return { client, verifyOtp };
}

// Shared-store shape (Redis/SQL): every read is a detached copy; the claim is
// an atomic conditional write. `gate(n)` orders the n-th claim; `afterClaim`
// mutates the store between a won claim and verifyEmailAuth's re-read.
function detachedStorage(hooks: {
  gate?: (n: number) => Promise<void>;
  afterClaim?: (sessions: Map<string, EmailAuthSession>, id: string) => void;
} = {}) {
  const sessions = new Map<string, EmailAuthSession>();
  let claims = 0;
  const storage: SessionStorage = {
    get: async (id) => {
      const s = sessions.get(id);
      return s && structuredClone(s);
    },
    set: async (id, s) => {
      sessions.set(id, structuredClone(s));
    },
    delete: async (id) => {
      sessions.delete(id);
    },
    cleanup: () => sessions.clear(),
    claimForVerification: async (id) => {
      await hooks.gate?.(claims++);
      const s = sessions.get(id);
      if (!s || s.verified || s.verifying) return false;
      s.verifying = true;
      hooks.afterClaim?.(sessions, id);
      return true;
    },
  };
  return { storage, sessions };
}

describe('verifyEmailAuth attempt accounting with a detached-read store', () => {
  test('a guess whose claim lands after an earlier failure increments the latest counter', async () => {
    const { client } = rejectingClient();
    let first!: Promise<unknown>;
    const { storage, sessions } = detachedStorage({
      gate: (n) => (n === 0 ? Promise.resolve() : first.then(() => undefined, () => undefined)),
    });
    const { sessionId } = await initiateEmailAuth('user@example.com', client, storage);

    first = verifyEmailAuth(sessionId, '111111', client, storage, verifyOptions);
    const second = verifyEmailAuth(sessionId, '222222', client, storage, verifyOptions);

    const codes = (await Promise.allSettled([first, second])).map((r) =>
      r.status === 'rejected' ? (r.reason as { code?: string }).code : 'fulfilled'
    );
    expect(codes).toEqual([
      AUTH_EMAIL_ERROR_CODES.otpCodeIncorrect,
      AUTH_EMAIL_ERROR_CODES.otpCodeIncorrect,
    ]);
    expect(sessions.get(sessionId)!.otpAttempts).toBe(2);
  });

  test('five concurrent wrong guesses with serialized claims exhaust the session', async () => {
    const { client, verifyOtp } = rejectingClient();
    const calls: Promise<unknown>[] = [];
    const { storage, sessions } = detachedStorage({
      gate: (n) =>
        n === 0 ? Promise.resolve() : calls[n - 1]!.then(() => undefined, () => undefined),
    });
    const { sessionId } = await initiateEmailAuth('user@example.com', client, storage);

    for (let i = 0; i < 5; i++) {
      calls.push(verifyEmailAuth(sessionId, `10000${i}`, client, storage, verifyOptions));
    }
    const codes = (await Promise.allSettled(calls)).map((r) =>
      r.status === 'rejected' ? (r.reason as { code?: string }).code : 'fulfilled'
    );

    expect(verifyOtp).toHaveBeenCalledTimes(5);
    expect(codes).toEqual([
      ...Array(4).fill(AUTH_EMAIL_ERROR_CODES.otpCodeIncorrect),
      AUTH_EMAIL_ERROR_CODES.otpAttemptsExceeded,
    ]);
    expect(sessions.has(sessionId)).toBe(false);
  });

  test('a session deleted between the claim and the re-read is reported invalid without calling Turnkey', async () => {
    const { client, verifyOtp } = rejectingClient();
    const { storage } = detachedStorage({ afterClaim: (sessions, id) => sessions.delete(id) });
    const { sessionId } = await initiateEmailAuth('user@example.com', client, storage);

    await expect(
      verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions)
    ).rejects.toMatchObject({ code: AUTH_EMAIL_ERROR_CODES.sessionInvalid });
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  test('a session that expires between the claim and the re-read is deleted without calling Turnkey', async () => {
    const { client, verifyOtp } = rejectingClient();
    const { storage, sessions } = detachedStorage({
      afterClaim: (sessions, id) => {
        sessions.get(id)!.timestamp = Date.now() - 16 * 60 * 1000;
      },
    });
    const { sessionId } = await initiateEmailAuth('user@example.com', client, storage);

    await expect(
      verifyEmailAuth(sessionId, '123456', client, storage, verifyOptions)
    ).rejects.toMatchObject({ code: AUTH_EMAIL_ERROR_CODES.sessionExpired });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(sessions.has(sessionId)).toBe(false);
  });
});
