import { describe, test, expect, afterEach } from 'bun:test';
import { resumeInscribe, fetchHostedCel, fetchHostedResources } from './resume-inscribe';
import { installCel3Host, engineWithSigner, HOST } from '../sdk/cel3-test-helpers';

describe('cold CEL 3 inscription recovery gates', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());
  async function fixture() {
    host = installCel3Host('sub-1');
    const { engine } = engineWithSigner('sub-1');
    const png = Uint8Array.from([137, 80, 78, 71, 128, 255]);
    await engine.create('Title', 'Upload', { filename: 'mine.png', content: png, contentType: 'image/png' });
    await engine.publish();
    await engine.update('Changed', 'Upload', { filename: 'mine.png', content: Uint8Array.from([...png, 1]), contentType: 'image/png' });
    return { engine, did: engine.snapshot().webvhDid! };
  }
  test('fetches native history and every historical binary resource', async () => {
    const { engine, did } = await fixture();
    const cel = await fetchHostedCel(did, HOST);
    expect(cel).toEqual(engine.asset!.celLog);
    const content = await fetchHostedResources(did, cel, HOST);
    for (const resource of engine.asset!.resources) expect(content[resource.digestMultibase]).toEqual(resource.content!);
  });
  test('unavailable hosted identity fails before reading a deposit or signing', async () => {
    host = installCel3Host('sub-1');
    let reads = 0;
    const result = await resumeInscribe({ did: `did:webvh:uEiExample:${HOST}:published:accounts:sub-1:missing`, subOrgId: 'sub-1', fundingAddress: 'bc1qtest', signingClient: {} as never, loadDeposit: async () => { reads++; return null; } });
    expect(result.ok).toBe(false);
    expect(reads).toBe(0);
    expect(host.requests.some((path) => path.startsWith('/api/btc/'))).toBe(false);
  });
  test('a verified Original with insufficient or unreadable funds does not submit anything', async () => {
    const { did } = await fixture();
    for (const deposit of [null, { confirmedUtxos: [], estimatedCostSats: 10000 }, { confirmedUtxos: [{ txid: 'ab'.repeat(32), vout: 0, value: 500 }], estimatedCostSats: 10000 }]) {
      const result = await resumeInscribe({ did, subOrgId: 'sub-1', fundingAddress: 'bc1qtest', signingClient: {} as never, loadDeposit: async () => deposit as never });
      expect(result.ok).toBe(false);
    }
    expect(host.requests.some((path) => path.startsWith('/api/btc/'))).toBe(false);
  });
});
