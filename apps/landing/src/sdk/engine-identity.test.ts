import { describe, test, expect } from 'bun:test';
import { DemoEngine, engineIdentity } from './engine';

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

describe('DemoEngine tier', () => {
  // The tier still follows the build flag and auth state; which Bitcoin
  // provider it gets returns with anchoring (plan 011, PR 10).
  test('real Bitcoin needs both a real-network build and a signed-in visitor', () => {
    expect(new DemoEngine({ networkFlag: 'mainnet' }).tier.real).toBe(false);
    expect(new DemoEngine({ authed: true, subOrgId: 'sub-1', networkFlag: 'mainnet' }).tier.real).toBe(true);
    expect(new DemoEngine({ authed: true, subOrgId: 's', networkFlag: 'off' }).tier.real).toBe(false);
  });
});
