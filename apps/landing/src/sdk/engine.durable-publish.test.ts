import { describe, test, expect, afterEach } from 'bun:test';
import { DemoEngine } from './engine';
import { installCel3Host, engineWithSigner } from './cel3-test-helpers';

describe('CEL 3 authenticated hosting', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());
  test('publishes separate histories and recovers every byte under the full account namespace', async () => {
    host = installCel3Host('sub-1');
    const { engine } = engineWithSigner('sub-1');
    await engine.create('Durable Piece', 'Upload', { filename: 'mine.png', content: Uint8Array.from([137, 80, 78, 71, 255]), contentType: 'image/png' });
    const state = await engine.publish();
    expect(state.webvhDid).toContain(':published:accounts:sub-1:');
    expect(host.store.list('sub-1')[0].did).toBe(state.webvhDid);
    expect(host.writes.every((path) => path.startsWith('/api/originals/host/demo.test/published/accounts/sub-1/'))).toBe(true);
    expect(host.writes.some((path) => path.endsWith('/did.jsonl'))).toBe(true);
    expect(host.writes.some((path) => path.endsWith('/cel.json'))).toBe(true);
    const cold = new DemoEngine({ authed: true, subOrgId: 'sub-1' });
    expect((await cold.hydrateFromWeb(state.webvhDid!)).resource.content).toEqual(state.resource.content);
  });
  test('authenticated creation without restored custody refuses before publishing', async () => {
    host = installCel3Host('sub-1');
    await expect(new DemoEngine({ authed: true }).create('Title', 'Upload', 'bytes')).rejects.toThrow(/Sign in again/);
    expect(host.writes).toEqual([]);
  });
});
