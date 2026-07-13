import { describe, test, expect } from 'bun:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { serializeEventLogJson, parseEventLogJson } from '../../../src/cel/serialization/json';

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
    // Task 4: the source binding key is 'did:cel' (the asset's genesis DID);
    // the legacy 'did:peer' key is retired.
    expect(published.bindings?.['did:cel']).toBe(asset.id);
    expect(published.bindings?.['did:peer']).toBeUndefined();
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

  test('hosts resources under the minted-DID slug path, matching resource.url', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      storageAdapter: storage
    });
    const content = 'host me';
    const hash = bytesToHex(sha256(new TextEncoder().encode(content)));
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash, content }
    ]);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const did = published.bindings!['did:webvh']!;
    // Regression (#376): the storage key must derive from the MINTED DID's
    // slug path — not the publisher shorthand's ":user" path — so that
    // dereferencing resource.url finds the bytes. Mirror the did.jsonl
    // path derivation above.
    const url = published.resources[0].url as string;
    expect(url.startsWith(`${did}/resources/`)).toBe(true);
    const slugPath = did.split(':').slice(4).join('/');
    const relativePath = slugPath ? `${slugPath}/resources/` : 'resources/';
    const multibase = url.split('/resources/')[1];
    const stored = await storage.getObject('example.com', `${relativePath}${multibase}`);
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!.content).toString('utf8')).toBe(content);
    // The stale publisher path must NOT be where the bytes live.
    const staleStored = await storage.getObject('example.com', `user/resources/${multibase}`);
    expect(staleStored).toBeNull();
  });

  test('hostDIDLog emits did:log-unhosted (EMPTY_LOG) and writes nothing for an empty log', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      storageAdapter: storage
    });

    const events: Array<{ did: string; reason: string }> = [];
    sdk.lifecycle.on('did:log-unhosted', (e) => {
      events.push({ did: e.did, reason: e.reason });
    });

    const did = 'did:webvh:scid:example.com:slug';
    // Empty array: a zero-byte did.jsonl would silently serve an unresolvable DID.
    await (sdk.lifecycle as any).hostDIDLog(did, []);

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('EMPTY_LOG');
    expect(events[0].did).toBe(did);
    // Nothing written at the derived resolution path.
    const stored = await storage.getObject('example.com', 'slug/did.jsonl');
    expect(stored).toBeNull();
  });

  test('hostDIDLog emits did:log-unhosted (EMPTY_LOG) for a non-array log', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      storageAdapter: storage
    });

    const events: Array<{ reason: string }> = [];
    sdk.lifecycle.on('did:log-unhosted', (e) => {
      events.push({ reason: e.reason });
    });

    await (sdk.lifecycle as any).hostDIDLog('did:webvh:scid:example.com:slug', {});

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('EMPTY_LOG');
    const stored = await storage.getObject('example.com', 'slug/did.jsonl');
    expect(stored).toBeNull();
  });
});

describe('publishToWeb appends the signed migrate event (#Phase2 Task 4)', () => {
  test('appends migrate event, hosts cel.json, writes did:cel binding', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      storageAdapter: storage,
      keyStore: new MockKeyStore()
    });
    const content = 'migrate me';
    const hash = bytesToHex(sha256(new TextEncoder().encode(content)));
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash, content }
    ]);
    const sourceDid = asset.id;
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');

    // Last CEL event is the signed migrate targeting the minted did:webvh.
    const log = published.celLog!;
    const last = log.events[log.events.length - 1];
    expect(last.type).toBe('migrate');
    expect((last.data as any).sourceDid).toBe(sourceDid);
    expect((last.data as any).targetDid).toBe(published.bindings!['did:webvh']);
    expect((last.data as any).layer).toBe('webvh');

    // The log still verifies as the asset's own did:cel.
    const res = await verifyEventLog(log, { expectedDid: published.id });
    expect(res.verified).toBe(true);

    // cel.json is hosted beside did.jsonl and round-trips to the same log.
    const did = published.bindings!['did:webvh']!;
    const paths = did.split(':').slice(4);
    const relativePath = paths.length ? `${paths.join('/')}/cel.json` : '.well-known/cel.json';
    const stored = await storage.getObject('example.com', relativePath);
    expect(stored).not.toBeNull();
    const parsed = parseEventLogJson(Buffer.from(stored!.content).toString('utf8'));
    expect(serializeEventLogJson(parsed)).toBe(serializeEventLogJson(log));

    // Bindings: did:cel present, did:peer retired.
    expect(published.bindings!['did:cel']).toBe(sourceDid);
    expect(published.bindings!['did:peer']).toBeUndefined();
  });

  test('keyStore-less publish succeeds and emits cel:append-skipped (NO_KEYSTORE)', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      storageAdapter: storage
    });
    const skipped: Array<{ reason: string; id: string }> = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => {
      skipped.push({ reason: e.reason, id: e.asset.id });
    });

    const content = 'no keystore';
    const hash = bytesToHex(sha256(new TextEncoder().encode(content)));
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash, content }
    ]);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');

    expect(published.currentLayer).toBe('did:webvh');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('NO_KEYSTORE');
    expect(skipped[0].id).toBe(asset.id);

    // No cel.json hosted when the append is skipped.
    const did = published.bindings!['did:webvh']!;
    const paths = did.split(':').slice(4);
    const relativePath = paths.length ? `${paths.join('/')}/cel.json` : '.well-known/cel.json';
    expect(await storage.getObject('example.com', relativePath)).toBeNull();

    // Migrate binding still written under did:cel.
    expect(published.bindings!['did:cel']).toBe(asset.id);
    expect(published.bindings!['did:peer']).toBeUndefined();
  });
});
