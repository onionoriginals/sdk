import { describe, expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { DemoEngine } from './engine';
import { contentBytes, contentByteLength, resourceDataUrl, resourceMatchesSource } from './resource-view';
import { MAX_SOURCE_BYTES, readAssetFile } from './source-file';

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));

describe('binary creator resources', () => {
  test('PNG upload, engine creation, preview and snapshot preserve exact bytes', async () => {
    const source = await readAssetFile(new File([png], 'mine.png', { type: 'image/png' }));
    expect(source.content).toEqual(png);
    const engine = new DemoEngine();
    const state = await engine.create('Mine', 'upload', source);
    expect(state.resource.content).toBeInstanceOf(Uint8Array);
    expect(state.resource.content).toEqual(png);
    expect(state.resource.hash).toBe(hex.encode(sha256(png)));
    expect(contentByteLength(state.resource.content)).toBe(png.length);
    const encoded = resourceDataUrl(state.resource.content, state.resource.contentType).split(',')[1];
    expect(Uint8Array.from(atob(encoded), c => c.charCodeAt(0))).toEqual(png);
    (source.content as Uint8Array).fill(0);
    (state.resource.content as Uint8Array).fill(1);
    expect(engine.snapshot().resource.content).toEqual(png);
  });
  test('equal binary input is a no-op revision; changed bytes append once', async () => {
    const engine = new DemoEngine();
    const source = { content: png, filename: 'mine.png', contentType: 'image/png' };
    const original = await engine.create('Mine', 'upload', source);
    const same = await engine.update('Mine', 'upload', { ...source, content: new Uint8Array(png) });
    expect(same.celLog.length).toBe(original.celLog.length);
    const changed = new Uint8Array(png); changed[changed.length - 1] = 2;
    const updated = await engine.update('Mine', 'upload', { ...source, content: changed });
    expect(updated.resource.version).toBe(2);
    expect(contentBytes(updated.resource.content)).toEqual(changed);
  });
  test('uploaded text keeps the supplied UTF-8 bytes', async () => {
    const bytes = new TextEncoder().encode('漢字 😀\r\n');
    const source = await readAssetFile(new File([bytes], 'mine.txt', { type: 'text/plain' }));
    expect(source.content).toEqual(bytes);
  });
  test('text display normalization does not turn unchanged source bytes into a revision', async () => {
    for (const bytes of [new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), new Uint8Array([0xff, 0x41])]) {
      const engine = new DemoEngine();
      const source = { content: bytes, filename: 'mine.txt', contentType: 'text/plain' };
      const original = await engine.create('Mine', 'upload', source);
      expect(contentBytes(original.resource.content)).toEqual(bytes);
      expect(resourceMatchesSource(source, original.resource)).toBe(true);
      const updated = await engine.update('Mine', 'upload', source);
      expect(updated.celLog.length).toBe(original.celLog.length);
      expect(updated.resource.hash).toBe(original.resource.hash);
    }
  });
  test('rejects oversized, empty and falsely labelled PNG files', async () => {
    await expect(readAssetFile(new File([new Uint8Array(MAX_SOURCE_BYTES + 1)], 'large.png'))).rejects.toThrow('too-big');
    await expect(readAssetFile(new File([], 'empty.png'))).rejects.toThrow('empty');
    await expect(readAssetFile(new File(['not a PNG'], 'wrong.png'))).rejects.toThrow('wrong-type');
  });
});

test('hosted PNG bytes become a tagged base64 envelope that verifies in a fresh engine', async () => {
  const { OriginalsSDK, KeyManager, signerFromKeyPair } = await import('@originals/sdk');
  const { hostedAssetEnvelope, hostedResourceRefs } = await import('./hosted-envelope');
  const signer = signerFromKeyPair(await new KeyManager().generateKeyPair('Ed25519'));
  const sdk = OriginalsSDK.create({ signer, network: 'regtest', webvhNetwork: 'magby', defaultKeyType: 'Ed25519', enableLogging: false });
  const asset = await sdk.lifecycle.createAsset([{ id: 'mine.png', contentType: 'image/png', type: 'image', hash: hex.encode(sha256(png)), content: png }]);
  const cel = JSON.parse(JSON.stringify(asset.celLog));
  const ref = hostedResourceRefs(cel)[0];
  const built = hostedAssetEnvelope(cel, { [ref.segment]: png });
  if ('problem' in built) throw new Error(built.problem.message);
  expect(built.envelope.version).toBe(2);
  expect(built.envelope.resources[0].content).toEqual({ encoding: 'base64', data: btoa(String.fromCharCode(...png)) });
  const engine = new DemoEngine();
  const revived = await engine.hydrate(JSON.parse(JSON.stringify(built.envelope)));
  expect(revived.resource.content).toEqual(png);
  expect(revived.resource.hash).toBe(hex.encode(sha256(png)));
});
