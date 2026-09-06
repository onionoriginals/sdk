import { describe, test, expect, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { installCel3Host, engineWithSigner } from './cel3-test-helpers';

describe('CEL 3 inscription entry gates', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());
  test('anonymous publishing does not manufacture an inscription or contact Bitcoin', async () => {
    host = installCel3Host();
    const engine = new DemoEngine({ networkFlag: 'mainnet' });
    await engine.create('Title', 'Text', 'exact');
    await engine.publish();
    await expect(engine.inscribe()).rejects.toThrow(/funded, signed-in/);
    expect(engine.snapshot().layer).toBe('did:webvh');
    expect(engine.snapshot().inscription).toBeUndefined();
    expect(host.requests.some((path) => path.startsWith('/api/btc/'))).toBe(false);
  });
  test('empty funding cannot silently choose a mock transaction', async () => {
    host = installCel3Host('sub-1');
    const { engine } = engineWithSigner('sub-1');
    await engine.create('Title', 'Text', 'exact');
    await engine.publish();
    await expect(engine.inscribe({ funding: { fundingUtxos: [], changeAddress: 'bc1qtest', signingClient: {} as never } })).rejects.toThrow(/at least one UTXO/);
    expect(host.requests.some((path) => path.startsWith('/api/btc/'))).toBe(false);
  });
});
