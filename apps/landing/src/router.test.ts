import { describe, test, expect } from 'bun:test';
import { routeForPath, originalPath, didFromPath } from './router';

const DID = 'did:webvh:QmScid123:demo.example.com:user-abc:asset-1';

describe('routeForPath', () => {
  test('/ → landing', () => {
    expect(routeForPath('/')).toBe('landing');
  });
  test('/me → your-originals', () => {
    expect(routeForPath('/me')).toBe('your-originals');
  });
  test('/me/<encoded did> → original-detail', () => {
    expect(routeForPath(originalPath(DID))).toBe('original-detail');
  });
  test('/me/<non-did segment> → landing (SPA fallback)', () => {
    expect(routeForPath('/me/not-a-did')).toBe('landing');
  });
  test('unknown path → landing (SPA fallback)', () => {
    expect(routeForPath('/anything/else')).toBe('landing');
  });
});

describe('originalPath / didFromPath', () => {
  test('round-trips a DID through the path', () => {
    expect(didFromPath(originalPath(DID))).toBe(DID);
  });
  test('encodes the DID as a single path segment', () => {
    expect(originalPath(DID)).not.toContain(':');
    expect(originalPath(DID).slice('/me/'.length)).not.toContain('/');
  });
  test('null for /me itself and for extra segments', () => {
    expect(didFromPath('/me')).toBeNull();
    expect(didFromPath('/me/')).toBeNull();
    expect(didFromPath('/me/a/b')).toBeNull();
  });
  test('null for a segment that does not decode to a did', () => {
    expect(didFromPath('/me/hello')).toBeNull();
  });
  test('null (not a throw) for malformed percent-encoding', () => {
    expect(didFromPath('/me/%GG')).toBeNull();
  });
});
