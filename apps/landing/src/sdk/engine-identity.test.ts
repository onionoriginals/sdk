import { describe, test, expect } from 'bun:test';
import { DemoEngine, engineIdentity } from './engine';
import { OrdMockProvider } from '@originals/sdk/testing';
import { HttpOrdinalsProvider } from './http-ordinals-provider';

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

/**
 * U2 / R5 / KTD2 — provider selection is auth-conditional. Asserted on the
 * CONSTRUCTED engine (tier + the provider instance it handed the SDK), not on
 * a DID: the tier is not observable in the DID string. `networkFlag` is the
 * build flag injected, since import.meta.env is not writable per-test.
 */
describe('DemoEngine tier selection', () => {
  test('an anonymous engine on a mainnet build keeps the mock provider', () => {
    const engine = new DemoEngine({ networkFlag: 'mainnet' });
    expect(engine.tier.real).toBe(false);
    expect(engine.ordinalsProvider).toBeInstanceOf(OrdMockProvider);
    expect(engine.tier.network).toBe('regtest');
    expect(engine.tier.webvhNetwork).toBe('magby');
  });

  test('a signed-in engine on a mainnet build gets the HTTP ordinals provider', () => {
    const engine = new DemoEngine({ authed: true, subOrgId: 'sub-1', networkFlag: 'mainnet' });
    expect(engine.tier.real).toBe(true);
    expect(engine.ordinalsProvider).toBeInstanceOf(HttpOrdinalsProvider);
    expect(engine.tier.network).toBe('mainnet');
    expect(engine.tier.webvhNetwork).toBe('pichu');
  });

  test('with the flag off both auth states behave as they do today (mock, regtest)', () => {
    for (const opts of [{ networkFlag: 'off' as const }, { authed: true, subOrgId: 's', networkFlag: 'off' as const }]) {
      const engine = new DemoEngine(opts);
      expect(engine.ordinalsProvider).toBeInstanceOf(OrdMockProvider);
      expect(engine.tier).toEqual({ real: false, network: 'regtest', webvhNetwork: 'magby' });
    }
  });
});
