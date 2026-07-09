/**
 * Issue #303 — ONE shared keyed inscription lock across managers.
 *
 * Before this fix the double-inscription hazard was guarded by two independent,
 * per-instance in-memory Sets (LifecycleManager.inFlightAssets keyed by asset.id,
 * MigrationManager.inFlightSourceDids keyed by sourceDid) that never saw each
 * other — two managers inscribing the SAME underlying DID each passed their own
 * guard and both broadcast a paid commit/reveal pair. The shared OperationLock,
 * injected once via SDK config and claimed inside the money-spending
 * BitcoinManager.inscribeData keyed by the canonical DID, must block the second
 * regardless of which manager instance initiates it.
 *
 * NOTE (post-#395 rebase): the original test drove caller B through
 * MigrationManager.migrate. That experimental subsystem (unexported, guards no
 * production path — see CLAUDE.md) predates did:cel and now throws in
 * extractLayer on the did:cel identifier that createAsset produces, so it can no
 * longer reach the inscription path at all. Caller B is now a SECOND
 * BitcoinManager built from the SAME SDK config — proving the guarantee that
 * actually ships: the lock is shared via config injection (not per-instance
 * state), so a concurrent inscription of the same canonical DID from a different
 * manager instance is rejected before it can double-pay.
 */
import { describe, it, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OperationLock } from '../../src/utils/OperationLock';
import { BitcoinManager } from '../../src/bitcoin/BitcoinManager';
import { MockOrdinalsProvider } from '../mocks/adapters';
import type { OriginalsConfig } from '../../src/types';

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

const sampleResources = [
  {
    id: 'res-1',
    type: 'Image',
    contentType: 'image/png',
    hash: '3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7',
    content: 'data',
  },
];

/**
 * A provider whose createInscription blocks until released, exposing a promise
 * that resolves the moment it is first entered. This lets a test park the first
 * caller inside the lock (holding it) while a second caller races the guard —
 * making the cross-manager rejection deterministic rather than timing-dependent.
 */
class BlockingOrdinalsProvider extends MockOrdinalsProvider {
  public callCount = 0;
  public readonly entered: Promise<void>;
  private markEntered!: () => void;
  private release: Promise<void>;
  private doRelease!: () => void;

  constructor() {
    super();
    this.entered = new Promise((r) => (this.markEntered = r));
    this.release = new Promise((r) => (this.doRelease = r));
  }

  async createInscription(params: {
    data?: Buffer;
    buildContent?: (satoshi: string) => Buffer | Promise<Buffer>;
    contentType: string;
    feeRate?: number;
    targetSatoshi?: string;
  }) {
    this.callCount++;
    this.markEntered();
    await this.release;
    return super.createInscription(params);
  }

  unblock() {
    this.doRelease();
  }
}

describe('shared keyed inscription lock across managers (issue #303)', () => {
  it('a LifecycleManager inscribe and a second manager inscribing the SAME DID cannot both broadcast', async () => {
    const provider = new BlockingOrdinalsProvider();
    const sdk = OriginalsSDK.create({
      ...baseConfig,
      ordinalsProvider: provider,
    });

    // Both managers must share ONE OperationLock — injected via the SDK config.
    const config = (sdk as any).config as OriginalsConfig;
    expect(config.operationLock).toBeInstanceOf(OperationLock);

    // A SECOND, independent BitcoinManager built from the SAME config. If the
    // lock were per-instance state (the old broken design) this manager would
    // not see caller A's in-flight inscription; because it is injected via
    // config, both managers coordinate on the one shared keyed mutex.
    const otherManager = new BitcoinManager(config);

    const asset = await sdk.lifecycle.createAsset(sampleResources);
    const canonicalDid = asset.id; // did:cel — the SAME key both paths lock on

    // Caller A (LifecycleManager.inscribeOnBitcoin) enters inscribeData first and
    // parks inside the lock, holding it (createInscription blocks until unblock).
    const lifecyclePromise = sdk.lifecycle.inscribeOnBitcoin(asset);
    await provider.entered;
    expect(provider.callCount).toBe(1);

    // Caller B inscribes the SAME canonical DID via a different manager. The old
    // two-Set design let it through its own guard and broadcast a second paid
    // inscription; the shared lock must now reject it BEFORE any second
    // createInscription call.
    const rejection = await otherManager
      .inscribeData(Buffer.from('duplicate'), 'application/json', 2, { lockKey: canonicalDid })
      .then(() => null, (e) => e);
    expect(rejection).toBeTruthy();
    expect((rejection as any).code).toBe('OPERATION_IN_PROGRESS');
    // Only caller A ever reached the paid broadcast.
    expect(provider.callCount).toBe(1);

    // Release A and confirm it completed the (single) inscription cleanly.
    provider.unblock();
    const inscribed = await lifecyclePromise;
    expect(inscribed.currentLayer).toBe('did:btco');
    expect(provider.callCount).toBe(1);
  });

  it('once the lock is released a subsequent inscription of the same DID proceeds', async () => {
    // The guard must be released on completion so a later, non-overlapping
    // inscription of the same key is not falsely rejected.
    const lock = new OperationLock();
    expect(lock.tryAcquire('did:peer:x')).toBe(true);
    expect(lock.tryAcquire('did:peer:x')).toBe(false); // already held → rejected
    lock.release('did:peer:x');
    expect(lock.tryAcquire('did:peer:x')).toBe(true); // released → available again
  });

  it('runExclusive rejects a concurrent holder of the same key with OPERATION_IN_PROGRESS', async () => {
    const lock = new OperationLock();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));

    const first = lock.runExclusive('did:btco:reg:1', async () => {
      await gate;
      return 'first';
    });

    const rejection = await lock
      .runExclusive('did:btco:reg:1', async () => 'second')
      .then(() => null, (e) => e);
    expect(rejection).toBeTruthy();
    expect((rejection as any).code).toBe('OPERATION_IN_PROGRESS');

    // Different key is unaffected.
    await expect(lock.runExclusive('did:btco:reg:2', async () => 'other')).resolves.toBe('other');

    releaseFirst();
    await expect(first).resolves.toBe('first');
  });
});
