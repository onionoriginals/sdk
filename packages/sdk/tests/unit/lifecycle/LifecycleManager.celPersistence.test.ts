import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { parseEventLogJson, serializeEventLogJson } from '../../../src/cel/serialization/json';
import { multikey } from '../../../src/crypto/Multikey';

// Conventional layer-agnostic storage location for an asset's CEL:
// canonical adapters: putObject('cel', '<suffix>.json'); legacy: put('cel/<suffix>.json').
const celStoragePath = (didCel: string) => `${didCel.slice('did:cel:'.length)}.json`;

const RES = [{ id: 'res-1', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }];

function makeSdk(overrides: Record<string, unknown> = {}) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
    keyStore: new MockKeyStore(),
    storageAdapter: new MemoryStorageAdapter(),
    ...overrides
  } as any);
}

describe('CEL storage persistence (#Phase3 Task 3)', () => {
  beforeEach(() => {
    MemoryStorageAdapter.clear();
  });

  test('createAsset persists cel/<suffix>.json containing the genesis log', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = makeSdk({ storageAdapter: storage });
    const asset = await sdk.lifecycle.createAsset(RES);

    const stored = await storage.getObject('cel', celStoragePath(asset.id));
    expect(stored).not.toBeNull();
    const log = parseEventLogJson(Buffer.from(stored!.content).toString('utf8'));
    expect(log.events).toHaveLength(1);
    expect(log.events[0].type).toBe('create');
    expect(serializeEventLogJson(log)).toBe(serializeEventLogJson(asset.celLog!));
  });

  test('inscribeOnBitcoin refreshes the stored copy: it carries the btco migrate event', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = makeSdk({ storageAdapter: storage });
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const stored = await storage.getObject('cel', celStoragePath(asset.id));
    expect(stored).not.toBeNull();
    const log = parseEventLogJson(Buffer.from(stored!.content).toString('utf8'));
    // Last event is the acknowledgeWitness update (map §5.1); the btco migrate
    // it acknowledges is present just before it.
    const last = log.events[log.events.length - 1];
    expect(last.type).toBe('update');
    expect((last.data as any).operation).toBe('acknowledgeWitness');
    const migrate = log.events.find(e => e.type === 'migrate' && (e.data as any).layer === 'btco');
    expect(migrate).toBeDefined();
  });

  test('post-publish appends refresh the webvh-hosted cel.json (not frozen at publish time)', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = makeSdk({ storageAdapter: storage });
    const asset = await sdk.lifecycle.createAsset(RES);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const webvhDid = published.bindings!['did:webvh']!;
    const paths = webvhDid.split(':').slice(4);
    const celJsonPath = paths.length ? `${paths.join('/')}/cel.json` : '.well-known/cel.json';

    // Publish-time snapshot: last event is the webvh migrate.
    const before = parseEventLogJson(
      Buffer.from((await storage.getObject('example.com', celJsonPath))!.content).toString('utf8')
    );
    expect(before.events[before.events.length - 1].type).toBe('migrate');
    expect((before.events[before.events.length - 1].data as any).layer).toBe('webvh');

    await sdk.lifecycle.inscribeOnBitcoin(asset);

    // The hosted copy is refreshed by the append choke point.
    const after = parseEventLogJson(
      Buffer.from((await storage.getObject('example.com', celJsonPath))!.content).toString('utf8')
    );
    // inscribe appends the btco migrate AND its acknowledgeWitness update.
    expect(after.events.some(e => e.type === 'migrate' && (e.data as any).layer === 'btco')).toBe(true);
    expect(after.events[after.events.length - 1].type).toBe('update');
    expect(after.events.length).toBe(before.events.length + 2);
  });

  test('legacy put-shaped adapters receive the cel/<suffix>.json key', async () => {
    const puts: Array<{ key: string; data: Buffer; contentType?: string }> = [];
    const legacy = {
      put: async (key: string, data: Buffer, options: { contentType: string }) => {
        puts.push({ key, data, contentType: options?.contentType });
        return `mem://${key}`;
      }
    };
    const sdk = makeSdk({ storageAdapter: legacy });
    const asset = await sdk.lifecycle.createAsset(RES);

    const expectedKey = `cel/${celStoragePath(asset.id)}`;
    const write = puts.find(p => p.key === expectedKey);
    expect(write).toBeDefined();
    const log = parseEventLogJson(write!.data.toString('utf8'));
    expect(log.events[0].type).toBe('create');
    expect(write!.contentType).toBe('application/json');
  });

  test('adapter-less SDK: create + inscribe succeed with no cel:host-failed', async () => {
    const sdk = makeSdk({ storageAdapter: undefined });
    const failed: unknown[] = [];
    sdk.lifecycle.on('cel:host-failed', (e) => { failed.push(e); });

    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    expect(asset.currentLayer).toBe('did:btco');
    expect(failed).toHaveLength(0);
  });

  test('a throwing storage adapter never gates the lifecycle op and emits cel:host-failed', async () => {
    const throwing = {
      putObject: async () => { throw new Error('disk on fire'); },
      getObject: async () => null,
      exists: async () => false
    };
    const sdk = makeSdk({ storageAdapter: throwing });
    const failed: Array<{ target: string; error: string; assetId: string }> = [];
    sdk.lifecycle.on('cel:host-failed', (e) => {
      failed.push({ target: e.target, error: e.error, assetId: e.asset.id });
    });

    const asset = await sdk.lifecycle.createAsset(RES);
    expect(asset.id.startsWith('did:cel:')).toBe(true);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0].assetId).toBe(asset.id);
    expect(failed[0].error).toContain('disk on fire');

    // Appending ops (inscribe) also survive the throwing adapter.
    failed.length = 0;
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    expect(asset.currentLayer).toBe('did:btco');
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  test('transferOwnership refreshes the stored copy with the transfer event', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = makeSdk({ storageAdapter: storage });
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    await sdk.lifecycle.transferOwnership(asset, 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');

    const stored = await storage.getObject('cel', celStoragePath(asset.id));
    expect(stored).not.toBeNull();
    const log = parseEventLogJson(Buffer.from(stored!.content).toString('utf8'));
    expect(log.events[log.events.length - 1].type).toBe('transfer');
  });

  test('rotateBtcoKeys refreshes the stored copy with the rotateKey event', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = makeSdk({ storageAdapter: storage });
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });

    const stored = await storage.getObject('cel', celStoragePath(asset.id));
    const log = parseEventLogJson(Buffer.from(stored!.content).toString('utf8'));
    const last = log.events[log.events.length - 1];
    expect(last.type).toBe('rotateKey');
    expect((last.data as any).newController).toBe(`did:key:${newKey}`);
    // The refresh happens post-append, so the earlier btco migrate event's
    // witness proof (attached before rotation) is present in the stored copy.
    const migrate = log.events.find(e => e.type === 'migrate');
    expect(migrate!.proof.some((p: any) => p.cryptosuite === 'bitcoin-ordinals-2024')).toBe(true);
  });
});
