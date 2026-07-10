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

  test('never leaks the content-builder function into inscription.content', async () => {
    // Conformant provider: supports buildContent but omits `content` in its
    // response. The builder FUNCTION must not fall through into content.
    const provider = {
      async createInscription({ buildContent }: { buildContent: (s: string) => Buffer }) {
        const satoshi = '1000';
        buildContent(satoshi); // exercise the builder, discard its output
        return { inscriptionId: 'insc-1', txid: 'tx-1', satoshi };
      }
    };
    const bm = new BitcoinManager({ ...config, ordinalsProvider: provider } as never);
    const inscription = await bm.inscribeData(
      (satoshi: string) => Buffer.from(`sat=${satoshi}`),
      'text/plain'
    );
    expect(typeof (inscription as { content?: unknown }).content).not.toBe('function');
    expect((inscription as { content?: unknown }).content).toBeUndefined();
  });
});
