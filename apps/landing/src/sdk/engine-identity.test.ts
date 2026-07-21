import { describe, test, expect } from 'bun:test';
import { engineIdentity } from './engine';

describe('engineIdentity', () => {
  test('anonymous is distinct from any authed identity', () => {
    expect(engineIdentity(false)).toBe('anon');
    expect(engineIdentity(false, 'sub-1')).toBe('anon'); // subOrgId ignored when not authed
    expect(engineIdentity(true, 'sub-1')).not.toBe(engineIdentity(false));
  });

  test('two different accounts have different identities (forces an engine rebuild)', () => {
    expect(engineIdentity(true, 'sub-1')).not.toBe(engineIdentity(true, 'sub-2'));
  });

  test('same auth state is stable (no needless rebuild)', () => {
    expect(engineIdentity(true, 'sub-1')).toBe(engineIdentity(true, 'sub-1'));
    expect(engineIdentity(false)).toBe(engineIdentity(false));
  });
});
