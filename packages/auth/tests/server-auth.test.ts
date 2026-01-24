import { describe, test, expect, mock } from 'bun:test';
import { sendOtp, verifyOtp } from '../src/client/server-auth';

describe('server-auth', () => {
  describe('sendOtp', () => {
    test('sends email to endpoint and returns result', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessionId: 'session_123', message: 'Code sent' }),
        })
      );
      const result = await sendOtp('test@example.com', '/api/auth/send-otp', {
        fetch: mockFetch as unknown as typeof fetch,
      });
      expect(result.sessionId).toBe('session_123');
      expect(result.message).toBe('Code sent');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/auth/send-otp',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com' }),
        })
      );
    });

    test('throws on non-ok response with server message', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({ message: 'Invalid email' }),
        })
      );
      await expect(
        sendOtp('bad', '/api/auth/send-otp', { fetch: mockFetch as unknown as typeof fetch })
      ).rejects.toThrow('Invalid email');
    });

    test('throws with HTTP status when no message in response', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        })
      );
      await expect(
        sendOtp('test@example.com', '/api/auth/send-otp', {
          fetch: mockFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow('HTTP 500');
    });

    test('throws fallback message when json parsing fails', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new Error('Invalid JSON')),
        })
      );
      await expect(
        sendOtp('test@example.com', '/api/auth/send-otp', {
          fetch: mockFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow('Failed to send OTP');
    });

    test('uses default endpoint when not provided', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ sessionId: 's1', message: 'ok' }),
        })
      );
      await sendOtp('test@example.com', undefined, { fetch: mockFetch as unknown as typeof fetch });
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/send-otp', expect.anything());
    });
  });

  describe('verifyOtp', () => {
    test('sends sessionId and code, returns verification result', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ verified: true, email: 'test@example.com', subOrgId: 'org_123' }),
        })
      );
      const result = await verifyOtp('session_123', '123456', '/api/auth/verify-otp', {
        fetch: mockFetch as unknown as typeof fetch,
      });
      expect(result.verified).toBe(true);
      expect(result.email).toBe('test@example.com');
      expect(result.subOrgId).toBe('org_123');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/auth/verify-otp',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: 'session_123', code: '123456' }),
        })
      );
    });

    test('throws on verification failure with server message', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ message: 'Invalid code' }),
        })
      );
      await expect(
        verifyOtp('s1', 'wrong', '/api/auth/verify-otp', {
          fetch: mockFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow('Invalid code');
    });

    test('throws with HTTP status when no message in response', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({}),
        })
      );
      await expect(
        verifyOtp('s1', '123456', '/api/auth/verify-otp', {
          fetch: mockFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow('HTTP 403');
    });

    test('throws fallback message when json parsing fails', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('Invalid JSON')),
        })
      );
      await expect(
        verifyOtp('s1', '123456', '/api/auth/verify-otp', {
          fetch: mockFetch as unknown as typeof fetch,
        })
      ).rejects.toThrow('Verification failed');
    });

    test('uses default endpoint when not provided', async () => {
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ verified: true, email: 'test@example.com', subOrgId: 'org_123' }),
        })
      );
      await verifyOtp('session_123', '123456', undefined, {
        fetch: mockFetch as unknown as typeof fetch,
      });
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/verify-otp', expect.anything());
    });
  });
});
