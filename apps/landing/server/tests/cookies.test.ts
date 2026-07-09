import { describe, test, expect } from 'bun:test';
import { parseCookies, extractToken, serializeCookie } from '../cookies';

describe('cookies', () => {
  test('parseCookies splits pairs and keeps = in values', () => {
    expect(parseCookies('auth_token=ab.cd=ef; other=1')).toEqual({
      auth_token: 'ab.cd=ef',
      other: '1',
    });
  });

  test('extractToken prefers Authorization Bearer', () => {
    const req = new Request('http://x', { headers: { Authorization: 'Bearer tok123' } });
    expect(extractToken(req)).toBe('tok123');
  });

  test('extractToken falls back to auth_token cookie', () => {
    const req = new Request('http://x', { headers: { Cookie: 'auth_token=cook456' } });
    expect(extractToken(req)).toBe('cook456');
  });

  test('extractToken returns null when absent', () => {
    expect(extractToken(new Request('http://x'))).toBeNull();
  });

  test('serializeCookie emits attributes', () => {
    const s = serializeCookie({
      name: 'auth_token',
      value: 'v',
      options: { httpOnly: true, sameSite: 'strict', maxAge: 60000, path: '/' },
    });
    expect(s).toContain('auth_token=v');
    expect(s).toContain('HttpOnly');
    expect(s).toContain('SameSite=Strict');
    expect(s).toContain('Max-Age=60'); // 60000ms → 60s (RFC 6265 seconds)
    expect(s).toContain('Path=/');
  });
});
