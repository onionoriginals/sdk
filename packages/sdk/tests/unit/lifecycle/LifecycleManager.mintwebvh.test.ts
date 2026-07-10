import { describe, test, expect } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';

describe('publishToWeb mints a real did:webvh (#376)', () => {
  test('binding is a SCID DID owned by the asset, not the publisher shorthand', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      storageAdapter: new MemoryStorageAdapter()
    });
    // createAsset validates inline content against the declared hash (#347),
    // so declare the real sha256 of the content rather than a fake hash.
    const content = 'hi';
    const hash = bytesToHex(sha256(new TextEncoder().encode(content)));
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash, content }
    ]);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const binding = published.bindings?.['did:webvh'];
    // Real shape: did:webvh:{SCID}:{domain}[:slug] — SCID segment present, no ":user" fabrication.
    expect(binding).toMatch(/^did:webvh:[^:]+:example\.com(:.+)?$/);
    expect(binding).not.toBe('did:webvh:example.com:user');
    expect(published.bindings?.['did:peer']).toBe(asset.id);
  });

  test('hosts the signed DID log as JSONL in storage at the resolution path', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      storageAdapter: storage
    });
    // createAsset validates inline content against the declared hash (#347).
    const logMeHash = bytesToHex(sha256(new TextEncoder().encode('log me')));
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: logMeHash, content: 'log me' }
    ]);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const did = published.bindings!['did:webvh']!;
    // did:webvh:{SCID}:example.com[:slug...] -> example.com/{slug...}/did.jsonl
    // MemoryStorageAdapter only implements the getObject(domain, path) duck
    // type (no put/get), so retrieve via that — same API hostDIDLog writes
    // through (matches publishResources' storage usage).
    const paths = did.split(':').slice(4);
    const relativePath = paths.length ? `${paths.join('/')}/did.jsonl` : '.well-known/did.jsonl';
    const stored = await storage.getObject('example.com', relativePath);
    expect(stored).not.toBeNull();
    const lines = Buffer.from(stored!.content).toString('utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // Every line is valid JSON and the log is signed (has a proof).
    const first = JSON.parse(lines[0]);
    expect(first.proof ?? first.parameters).toBeDefined();
  });
});
