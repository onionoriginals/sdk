import { describe, test, expect } from 'bun:test';
import { FEATURES, resolveFeatures } from './features';

// #976 B, gap G7. Hosted publication stays off (owner decision Q13) except on a
// staging acceptance build, never on the production host.
describe('hostedPublication', () => {
  test('is off by default', () => {
    expect(resolveFeatures({}).hostedPublication).toBe(false);
    expect(FEATURES.hostedPublication).toBe(false);
  });

  test('a staging acceptance build turns it on', () => {
    expect(resolveFeatures({ VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1', VITE_WEBVH_HOST: 'staging.originals.build' }).hostedPublication).toBe(true);
  });

  test('the switch is ignored on the production host, with no host, or with any other value', () => {
    for (const env of [
      { VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1', VITE_WEBVH_HOST: 'originals.build' },
      { VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1' },
      { VITE_ACCEPTANCE_HOSTED_PUBLICATION: 'true', VITE_WEBVH_HOST: 'staging.originals.build' },
    ]) {
      expect(resolveFeatures(env).hostedPublication).toBe(false);
    }
  });

  test('the switch is ignored on a mainnet build, whatever its host', () => {
    for (const host of ['staging.originals.build', 'originals.build']) {
      expect(resolveFeatures({ VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1', VITE_WEBVH_HOST: host, VITE_BTC_NETWORK: 'mainnet' }).hostedPublication).toBe(false);
    }
    // A non-mainnet network, or none, leaves the staging build on.
    for (const net of ['testnet4', 'signet', 'regtest', 'off', undefined]) {
      expect(resolveFeatures({ VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1', VITE_WEBVH_HOST: 'staging.originals.build', VITE_BTC_NETWORK: net }).hostedPublication).toBe(true);
    }
  });

  // B6 (scripts/acceptance/hosted-README.md): the production env, the VITE_*
  // shape of .railway/railway.ts, with or without the switch.
  test('the production env never turns it on', () => {
    const production = { VITE_WEBVH_HOST: 'originals.build', VITE_BTC_NETWORK: 'mainnet' };
    expect(resolveFeatures(production).hostedPublication).toBe(false);
    expect(resolveFeatures({ ...production, VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1' }).hostedPublication).toBe(false);
  });

  test('the switch never turns on anything else', () => {
    const on = resolveFeatures({ VITE_ACCEPTANCE_HOSTED_PUBLICATION: '1', VITE_WEBVH_HOST: 'staging.originals.build' });
    expect(on.bitcoinAnchoring).toBe(false);
    expect(on.explore).toBe(false);
  });

  test('the production deploy config does not set the switch', async () => {
    const railway = await Bun.file(new URL('../../../../.railway/railway.ts', import.meta.url)).text();
    expect(railway).not.toContain('VITE_ACCEPTANCE_HOSTED_PUBLICATION');
    expect(railway).toContain('VITE_WEBVH_HOST: "originals.build"');
  });
});

// Preserve main's independent anchoring switch while adding hosted acceptance.
test('anchoring still requires its own explicit build switch', () => {
  expect(resolveFeatures({ VITE_ORIGINALS_BITCOIN_ANCHORING: '1' }).bitcoinAnchoring).toBe(true);
  expect(resolveFeatures({ VITE_ORIGINALS_BITCOIN_ANCHORING: '1' }).hostedPublication).toBe(false);
});
