import { describe, test, expect } from 'bun:test';
import { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';

describe('BitcoinManager.inscribeData deferred content', () => {
  const config = { network: 'regtest', defaultKeyType: 'ES256K', ordinalsProvider: new OrdMockProvider() } as never;

  test('passes a content-builder through to the provider', async () => {
    const bm = new BitcoinManager(config);
    const inscription = await bm.inscribeData(
      (satoshi: string) => Buffer.from(`sat=${satoshi}`),
      'text/plain'
    );
    expect(inscription.satoshi).toBeTruthy();
  });

  test('threads targetSatoshi for reinscription', async () => {
    const bm = new BitcoinManager(config);
    const first = await bm.inscribeData(Buffer.from('v1'), 'text/plain');
    const second = await bm.inscribeData(Buffer.from('v2'), 'text/plain', undefined, {
      targetSatoshi: first.satoshi
    });
    expect(second.satoshi).toBe(first.satoshi);
  });
});
