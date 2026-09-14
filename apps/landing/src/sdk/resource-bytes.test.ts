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
  test('rejects oversized and empty files', async () => {
    await expect(readAssetFile(new File([new Uint8Array(MAX_SOURCE_BYTES + 1)], 'large.png'))).rejects.toThrow('too-big');
    await expect(readAssetFile(new File([], 'empty.png'))).rejects.toThrow('empty');
  });
  test('rejects a whitespace-only text upload as empty, but not a whitespace-only binary payload', async () => {
    await expect(readAssetFile(new File(['   \n\t  '], 'blank.txt', { type: 'text/plain' }))).rejects.toThrow('empty');
    const whitespaceBytes = Uint8Array.from([0x20, 0x20, 0x20]);
    await expect(
      readAssetFile(new File([whitespaceBytes], 'blank.bin', { type: 'application/octet-stream' }))
    ).resolves.toBeTruthy();
  });
  test('a stranger brings their own bytes: arbitrary, non-PNG/SVG/text content is accepted verbatim', async () => {
    // Deliberately not a valid PNG (wrong magic bytes) despite the .png name,
    // and not decodable as clean UTF-8 text: the SDK 3.0.0 criterion is "any
    // bytes", not a whitelist of formats.
    const arbitrary = Uint8Array.from([0, 1, 2, 3, 255, 254, 253, 10, 0, 128, 7, 9]);
    const source = await readAssetFile(new File([arbitrary], 'payload.png'));
    expect(source.content).toEqual(arbitrary);
    expect(source.contentType).toBe('image/png'); // no magic-byte validation: file.type/extension is honored, not enforced
  });
  test('an unrecognized extension with no browser-supplied type falls back to application/octet-stream', async () => {
    const bytes = Uint8Array.from([9, 8, 7, 6, 5]);
    const source = await readAssetFile(new File([bytes], 'payload.bin'));
    expect(source.contentType).toBe('application/octet-stream');
    expect(source.content).toEqual(bytes);
  });
});

test('arbitrary binary upload (not PNG/SVG/text) preserves exact bytes through hash, deposit quote and hosted round-trip', async () => {
  const { inscriptionContentBytes } = await import('../components/demo-logic');
  const blob = Uint8Array.from([0, 1, 2, 3, 255, 254, 253, 10, 0, 128, 42, 7]);
  const source = await readAssetFile(new File([blob], 'payload.bin'));
  expect(source.contentType).toBe('application/octet-stream');

  const engine = new DemoEngine();
  const state = await engine.create('Mine', 'upload', source);
  expect(state.resource.content).toEqual(blob);
  expect(state.resource.hash).toBe(hex.encode(sha256(blob)));
  expect(state.resource.contentType).toBe('application/octet-stream');
  expect(inscriptionContentBytes(state)).toBeGreaterThanOrEqual(blob.length);

  const { hostedAssetEnvelope, hostedResourceRefs } = await import('./hosted-envelope');
  const { OriginalsSDK, createLocalSigner } = await import('@originals/sdk');
  const signer = createLocalSigner('Ed25519', new Uint8Array(32).fill(2));
  const sdk = OriginalsSDK.create({ signer, network: 'regtest', webvhNetwork: 'magby', defaultKeyType: 'Ed25519', enableLogging: false });
  const asset = await sdk.lifecycle.createAsset([{ id: 'payload.bin', mediaType: 'application/octet-stream', content: blob }]);
  const cel = JSON.parse(JSON.stringify(asset.celLog));
  const ref = hostedResourceRefs(cel)[0];
  const built = hostedAssetEnvelope(cel, { [ref.segment]: blob });
  if ('problem' in built) throw new Error(built.problem.message);
  expect(built.envelope.resources[0].content).toEqual({ encoding: 'base64', data: btoa(String.fromCharCode(...blob)) });
  const revived = await new DemoEngine().hydrate(JSON.parse(JSON.stringify(built.envelope)));
  expect(revived.resource.content).toEqual(blob);
  expect(revived.resource.hash).toBe(hex.encode(sha256(blob)));
});

test('hosted PNG bytes become a tagged base64 envelope that verifies in a fresh engine', async () => {
  const { OriginalsSDK, createLocalSigner } = await import('@originals/sdk');
  const { hostedAssetEnvelope, hostedResourceRefs } = await import('./hosted-envelope');
  const signer = createLocalSigner('Ed25519', new Uint8Array(32).fill(1));
  const sdk = OriginalsSDK.create({ signer, network: 'regtest', webvhNetwork: 'magby', defaultKeyType: 'Ed25519', enableLogging: false });
  const asset = await sdk.lifecycle.createAsset([{ id: 'mine.png', mediaType: 'image/png', content: png }]);
  const cel = JSON.parse(JSON.stringify(asset.celLog));
  const ref = hostedResourceRefs(cel)[0];
  const built = hostedAssetEnvelope(cel, { [ref.segment]: png });
  if ('problem' in built) throw new Error(built.problem.message);
  expect(built.envelope.version).toBe(4);
  expect(built.envelope.resources[0].content).toEqual({ encoding: 'base64', data: btoa(String.fromCharCode(...png)) });
  const engine = new DemoEngine();
  const revived = await engine.hydrate(JSON.parse(JSON.stringify(built.envelope)));
  expect(revived.resource.content).toEqual(png);
  expect(revived.resource.hash).toBe(hex.encode(sha256(png)));
});
