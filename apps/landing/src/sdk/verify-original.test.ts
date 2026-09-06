import { describe, test, expect, afterEach } from 'bun:test';
import { verifyOriginal } from './verify-original';
import { installCel3Host, engineWithSigner } from './cel3-test-helpers';

describe('native hosted verification', () => {
  let host: ReturnType<typeof installCel3Host>;
  afterEach(() => host?.restore());
  async function fixture() {
    host = installCel3Host();
    const { engine } = engineWithSigner();
    await engine.create('Original', 'Text', { filename: 'file.txt', content: 'exact bytes', contentType: 'text/plain' });
    const state = await engine.publish();
    return { did: state.webvhDid!, logEntries: (await (await fetch(state.webvhLogUrl!)).text()).trim().split('\n').map((s) => JSON.parse(s)), celLog: engine.asset!.celLog, resourceBytes: new TextEncoder().encode('exact bytes'), declaredHash: state.resource.hash };
  }
  test('validates content, method history and controller history with their bidirectional binding', async () => {
    const input = await fixture();
    expect((await verifyOriginal(input)).every((c) => c.ok)).toBe(true);
  });
  test('rejects tampering or an unrelated DID without confusing the byte check', async () => {
    const input = await fixture();
    const changed = structuredClone(input);
    (changed.celLog.log[0].event.operation.data as { name: string }).name = 'forged';
    expect((await verifyOriginal(changed)).find((c) => c.id === 'cel')!.ok).toBe(false);
    const wrong = { ...input, did: input.did.replace('demo.test', 'other.test') };
    expect((await verifyOriginal(wrong)).filter((c) => c.id !== 'hash').every((c) => !c.ok)).toBe(true);
    expect((await verifyOriginal({ ...input, resourceBytes: new Uint8Array([1]) })).find((c) => c.id === 'hash')!.ok).toBe(false);
  });
});
