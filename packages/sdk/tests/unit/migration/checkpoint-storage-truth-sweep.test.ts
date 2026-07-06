/**
 * Storage-truth cleanup sweep: the durable checkpoint object itself is the
 * retry handle (#323 review, Greptile P1 "Lost cleanup marker").
 *
 * Previously, retrying a failed checkpoint deletion depended on a SECONDARY
 * durable handle: the pending-deletion marker written by deleteCheckpoint's
 * failure path. But during a TOTAL storage outage the marker write can ALSO
 * fail (it only logs and returns), and cleanupOldCheckpoints swept only the
 * in-memory map — empty after a restart. Net: an obsolete checkpoint could
 * linger in storage with no marker, no in-memory entry, and nothing that
 * would ever retry it.
 *
 * Contract under test:
 *  1. THE GREPTILE SCENARIO: both the durable delete AND the marker write
 *     fail (total outage), the process "restarts" (fresh CheckpointManager,
 *     empty in-memory state), storage recovers — the next
 *     cleanupOldCheckpoints discovers the stale checkpoint by enumerating
 *     the actual objects under checkpoints/ and durably deletes it. The
 *     checkpoint's own presence is the handle; there is no secondary handle
 *     left to lose.
 *  2. A recent (younger-than-cutoff) checkpoint is NOT swept.
 *  3. Tombstoned / unparseable / marker-subprefix keys are skipped without
 *     error (the sweep never throws into the GC path).
 *  4. A delete failure during the sweep is non-fatal, falls back to the
 *     pending-marker fast path, and the checkpoint (still enumerable) is
 *     reclaimed on the NEXT sweep.
 *  5. Opaque adapters (no native enumeration) keep the documented degraded
 *     marker/in-memory behavior: the sweep is a no-op and nothing throws.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { CheckpointManager } from '../../../src/migration/checkpoint/CheckpointManager';
import { CheckpointStorage } from '../../../src/migration/checkpoint/CheckpointStorage';
import { MIGRATION_STORAGE_DOMAIN } from '../../../src/migration/storage/MigrationStorage';
import { OriginalsSDK } from '../../../src';
import { MigrationManager } from '../../../src/migration';
import type { LogEntry } from '../../../src/utils/Logger';

const PENDING_PREFIX = 'checkpoints/pending-deletion/';
const TOMBSTONE = '__originals_deleted__';
const HOUR = 60 * 60 * 1000;

/**
 * Canonical StorageAdapter-shaped in-memory adapter (putObject/getObject/
 * listObjects — same shape as the shipped adapters) with per-key write
 * failure injection. Its Map survives across CheckpointManager instances,
 * mimicking durable storage across a process restart.
 */
class FlakyCanonicalAdapter {
  store = new Map<string, string>();
  /** Writes whose PATH matches this regex throw. null = healthy. */
  failWritesMatching: RegExp | null = null;

  private key(domain: string, path: string): string {
    return `${domain}::${path.replace(/^\/+/, '')}`;
  }

  async putObject(domain: string, path: string, content: Uint8Array | string): Promise<string> {
    if (this.failWritesMatching && this.failWritesMatching.test(path)) {
      throw new Error(`injected write failure for ${path}`);
    }
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    this.store.set(this.key(domain, path), text);
    return `mem://${domain}/${path}`;
  }

  async getObject(domain: string, path: string): Promise<{ content: Uint8Array } | null> {
    const text = this.store.get(this.key(domain, path));
    if (text === undefined) return null;
    return { content: new TextEncoder().encode(text) };
  }

  async listObjects(domain: string, prefix: string): Promise<string[]> {
    const domainPrefix = `${domain}::`;
    const cleanPrefix = prefix.replace(/^\/+/, '');
    const out: string[] = [];
    for (const k of this.store.keys()) {
      if (!k.startsWith(domainPrefix)) continue;
      const path = k.slice(domainPrefix.length);
      if (path.startsWith(cleanPrefix)) out.push(path);
    }
    return out;
  }

  /** Raw stored text at a migration-domain path (test helper). */
  raw(path: string): string | undefined {
    return this.store.get(this.key(MIGRATION_STORAGE_DOMAIN, path));
  }

  /** Overwrite raw stored text at a migration-domain path (test helper). */
  setRaw(path: string, text: string): void {
    this.store.set(this.key(MIGRATION_STORAGE_DOMAIN, path), text);
  }
}

/** Legacy duck-typed adapter (put/get only): opaque — cannot enumerate. */
class OpaqueLegacyAdapter {
  store = new Map<string, string>();
  failWritesMatching: RegExp | null = null;

  async put(key: string, data: Buffer | string): Promise<string> {
    if (this.failWritesMatching && this.failWritesMatching.test(key)) {
      throw new Error(`injected write failure for ${key}`);
    }
    this.store.set(key, typeof data === 'string' ? data : data.toString('utf8'));
    return key;
  }

  async get(key: string): Promise<{ content: Buffer } | null> {
    const text = this.store.get(key);
    return text === undefined ? null : { content: Buffer.from(text, 'utf8') };
  }
}

async function makeHarness(adapter: unknown): Promise<{
  sdk: OriginalsSDK;
  manager: CheckpointManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
  logEntries: LogEntry[];
}> {
  MigrationManager.resetInstance();
  const logEntries: LogEntry[] = [];
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageAdapter: adapter as any,
    logging: {
      level: 'debug',
      outputs: [{ write: (entry: LogEntry) => { logEntries.push(entry); } }]
    }
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = (sdk as any)['config'];
  const manager = new CheckpointManager(config, sdk.did, sdk.credentials);
  return { sdk, manager, config, logEntries };
}

async function createCheckpointFor(sdk: OriginalsSDK, manager: CheckpointManager, migrationId: string) {
  const peerDid = await sdk.did.createDIDPeer([
    { id: 'res-1', type: 'Image', contentType: 'image/png', hash: 'abc123', content: 'data' }
  ]);
  return manager.createCheckpoint(migrationId, {
    sourceDid: peerDid.id,
    targetLayer: 'webvh' as const,
    domain: 'example.com'
  });
}

/** Backdate a durably stored checkpoint so it falls past the 24h cutoff. */
function backdateStored(adapter: FlakyCanonicalAdapter, checkpointId: string, ageMs: number): void {
  const key = `checkpoints/${checkpointId}.json`;
  const parsed = JSON.parse(adapter.raw(key)!) as Record<string, unknown>;
  parsed.timestamp = Date.now() - ageMs;
  adapter.setRaw(key, JSON.stringify(parsed));
}

beforeEach(() => {
  MigrationManager.resetInstance();
});

describe('storage-truth sweep: lost marker cannot strand an obsolete checkpoint', () => {
  it('reclaims a stale checkpoint after BOTH the delete and the marker write failed and the process restarted (Greptile P1)', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager, config } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_greptile_001');
    const id = checkpoint.checkpointId;
    // Older than the 24h retention cutoff.
    backdateStored(adapter, id, 25 * HOUR);

    // TOTAL storage outage: the tombstone/native delete AND the
    // pending-deletion marker write both fail. deleteCheckpoint resolves
    // non-fatally — and NO durable marker exists.
    adapter.failWritesMatching = /.*/;
    await expect(manager.deleteCheckpoint(id)).resolves.toBeUndefined();
    expect(adapter.raw(`${PENDING_PREFIX}${id}.json`)).toBeUndefined();
    // The checkpoint object itself survived the outage, un-tombstoned.
    expect(
      (JSON.parse(adapter.raw(`checkpoints/${id}.json`)!) as Record<string, unknown>)[TOMBSTONE]
    ).toBeUndefined();

    // Storage recovers; the process "restarts": a FRESH manager with an
    // empty in-memory map and no marker anywhere.
    adapter.failWritesMatching = null;
    const freshManager = new CheckpointManager(config, sdk.did, sdk.credentials);
    await expect(freshManager.cleanupOldCheckpoints()).resolves.toBeUndefined();

    // The sweep found the stale checkpoint by its OWN durable key and
    // durably deleted it: a fresh reader no longer sees it.
    const freshStorage = new CheckpointStorage(config);
    expect(await freshStorage.get(id)).toBeNull();
    expect(
      (JSON.parse(adapter.raw(`checkpoints/${id}.json`)!) as Record<string, unknown>)[TOMBSTONE]
    ).toBe(true);
  });

  it('does NOT sweep a checkpoint younger than the retention cutoff', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager, config } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_recent_001');
    const id = checkpoint.checkpointId;
    // Old enough to prove backdating works, young enough to keep (1h < 24h).
    backdateStored(adapter, id, 1 * HOUR);

    const freshManager = new CheckpointManager(config, sdk.did, sdk.credentials);
    await freshManager.cleanupOldCheckpoints();

    const freshStorage = new CheckpointStorage(config);
    const kept = await freshStorage.get(id);
    expect(kept).not.toBeNull();
    expect(kept!.checkpointId).toBe(id);
  });

  it('skips tombstoned, unparseable, and pending-marker keys without error', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { manager } = await makeHarness(adapter);

    // Already-deleted checkpoint (tombstone) — must be treated as absent.
    adapter.setRaw('checkpoints/chk_gone.json', JSON.stringify({ [TOMBSTONE]: true }));
    // Corrupt object under the checkpoint prefix — must not break the sweep.
    adapter.setRaw('checkpoints/chk_corrupt.json', 'not json {');
    // A stray pending-deletion marker for a checkpoint that no longer
    // exists — it lives under the marker subprefix and must NOT be parsed
    // as a checkpoint by the sweep.
    adapter.setRaw(
      `${PENDING_PREFIX}chk_absent.json`,
      JSON.stringify({ checkpointId: 'chk_absent', recordedAt: Date.now() - 48 * HOUR, reason: 'x' })
    );

    await expect(manager.cleanupOldCheckpoints()).resolves.toBeUndefined();

    // Tombstone untouched (still reads as deleted), corrupt entry untouched.
    expect(
      (JSON.parse(adapter.raw('checkpoints/chk_gone.json')!) as Record<string, unknown>)[TOMBSTONE]
    ).toBe(true);
    expect(adapter.raw('checkpoints/chk_corrupt.json')).toBe('not json {');
  });

  it('falls back to the pending marker when a sweep delete fails, and reclaims on the NEXT sweep', async () => {
    const adapter = new FlakyCanonicalAdapter();
    const { sdk, manager, config } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_sweepfail_001');
    const id = checkpoint.checkpointId;
    backdateStored(adapter, id, 25 * HOUR);

    // Partial outage: checkpoint-object writes (the tombstone delete) fail,
    // but marker writes succeed.
    adapter.failWritesMatching = /^checkpoints\/chk_/;
    const freshManager = new CheckpointManager(config, sdk.did, sdk.credentials);
    await expect(freshManager.cleanupOldCheckpoints()).resolves.toBeUndefined();

    // Non-fatal fallback: marker recorded, checkpoint still present.
    expect(adapter.raw(`${PENDING_PREFIX}${id}.json`)).toBeDefined();

    // Storage recovers: the next sweep reclaims it (marker fast path or
    // enumeration — either way the checkpoint is durably gone).
    adapter.failWritesMatching = null;
    await freshManager.cleanupOldCheckpoints();
    const freshStorage = new CheckpointStorage(config);
    expect(await freshStorage.get(id)).toBeNull();
  });

  it('opaque adapter (no native enumeration): sweep is a no-op and existing behavior is preserved', async () => {
    const adapter = new OpaqueLegacyAdapter();
    const { sdk, manager, config } = await makeHarness(adapter);
    const checkpoint = await createCheckpointFor(sdk, manager, 'mig_opaque_sweep_001');
    const id = checkpoint.checkpointId;

    // Total outage: neither delete nor marker write lands.
    adapter.failWritesMatching = /.*/;
    await expect(manager.deleteCheckpoint(id)).resolves.toBeUndefined();
    expect(adapter.store.get(`${PENDING_PREFIX}${id}.json`)).toBeUndefined();

    // Restart + recovery: an opaque adapter cannot enumerate, so the sweep
    // degrades to a documented no-op — the checkpoint object survives
    // untombstoned and nothing throws.
    adapter.failWritesMatching = null;
    const freshManager = new CheckpointManager(config, sdk.did, sdk.credentials);
    await expect(freshManager.cleanupOldCheckpoints()).resolves.toBeUndefined();
    const stored = adapter.store.get(`checkpoints/${id}.json`);
    expect(stored).toBeDefined();
    expect((JSON.parse(stored!) as Record<string, unknown>)[TOMBSTONE]).toBeUndefined();

    // The degraded path still works: a later explicit deleteCheckpoint of
    // this id durably deletes it.
    await freshManager.deleteCheckpoint(id);
    expect(
      (JSON.parse(adapter.store.get(`checkpoints/${id}.json`)!) as Record<string, unknown>)[TOMBSTONE]
    ).toBe(true);
  });
});
