import { afterEach, describe, expect, test } from 'bun:test';
import { clearAcceptanceEngine, exposeAcceptanceEngine } from './acceptance-hook';

// #976 B, G7, G9. The hosted acceptance driver reaches the page's engine
// through window.__originalsDemo. Only an acceptance build exposes it: the
// switch set, not the production host, not mainnet (the same conditions as
// resolveFeatures). Production never does.
const STAGING = { VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1', VITE_WEBVH_HOST: 'staging.originals.build', VITE_BTC_NETWORK: 'testnet4' };
const PRODUCTION = { VITE_WEBVH_HOST: 'originals.build', VITE_BTC_NETWORK: 'mainnet' };
const engine = { authed: false };
const exposed = () => (globalThis as { __originalsDemo?: unknown }).__originalsDemo;

describe('window.__originalsDemo', () => {
  afterEach(() => clearAcceptanceEngine());

  test('a production-env build leaves it undefined, with or without the switch', () => {
    for (const env of [PRODUCTION, { ...PRODUCTION, VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1' }, {}]) {
      exposeAcceptanceEngine(engine, env);
      expect(exposed()).toBeUndefined();
    }
  });

  test('mainnet, or the production host, leaves it undefined even with the switch', () => {
    exposeAcceptanceEngine(engine, { ...STAGING, VITE_BTC_NETWORK: 'mainnet' });
    expect(exposed()).toBeUndefined();
    exposeAcceptanceEngine(engine, { ...STAGING, VITE_WEBVH_HOST: 'originals.build' });
    expect(exposed()).toBeUndefined();
  });

  test('a staging acceptance build exposes the engine, and discarding it clears it', () => {
    exposeAcceptanceEngine(engine, STAGING);
    expect(exposed()).toBe(engine);
    clearAcceptanceEngine();
    expect(exposed()).toBeUndefined();
    expect('__originalsDemo' in globalThis).toBe(false);
  });
});
