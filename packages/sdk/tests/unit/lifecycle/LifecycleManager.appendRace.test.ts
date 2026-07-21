import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { hashResource } from '../../../src/utils/validation';

/**
 * Regression for #400: a per-asset CEL-log append from addResourceVersion
 * (serialized by OriginalsAsset.#appendChain) and a lifecycle migrate/rotate
 * append (serialized only by LifecycleManager.inFlightAssets) were guarded by
 * TWO independent locks that could not see each other. Both do a
 * read(head)→sign→_replaceCelLog cycle; when their windows overlap the second
 * writer clobbers the first signed append (an event is silently dropped).
 *
 * This test FORCES the overlapping-window interleaving deterministically via a
 * keyStore gate: it blocks the two CEL-signing getPrivateKey calls (each runs
 * one line AFTER its op has already captured the current log head) until BOTH
 * have arrived, then releases them together — guaranteeing both signed from the
 * SAME genesis head. Pre-fix that drops one event; post-fix the shared lock
 * serializes them so both land. A timeout fallback releases a lone waiter so
 * the (correctly serialized) post-fix run never deadlocks.
 */
class TwoArrivalGate extends MockKeyStore {
  private targetVm: string | null = null;
  private waiters: Array<() => void> = [];
  private armed = false;

  /** Gate getPrivateKey calls for `vm` until 2 have arrived (or the fallback). */
  arm(vm: string): void {
    this.targetVm = vm;
    this.armed = true;
  }

  override async getPrivateKey(verificationMethodId: string): Promise<string | null> {
    const key = await super.getPrivateKey(verificationMethodId);
    if (this.armed && verificationMethodId === this.targetVm) {
      await this.#waitTurn();
    }
    return key;
  }

  #waitTurn(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      if (this.waiters.length >= 2) {
        // Both ops have captured the head and are parked here — release together.
        this.#releaseAll();
      } else {
        // Fallback: a correctly serialized (post-fix) run only ever parks one
        // waiter; release it so the test cannot deadlock.
        setTimeout(() => this.#releaseAll(), 200);
      }
    });
  }

  #releaseAll(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }
}

const RES = [
  { id: 'res-1', type: 'data', contentType: 'text/plain', hash: hashResource(Buffer.from('v1', 'utf-8')) }
];

describe('#400: addResourceVersion vs lifecycle append race', () => {
  beforeEach(() => {
    MemoryStorageAdapter.clear();
  });

  test('concurrent addResourceVersion + publishToWeb both land in the CEL log', async () => {
    const keyStore = new TwoArrivalGate();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
      keyStore,
      storageAdapter: new MemoryStorageAdapter()
    } as any);

    const asset = await sdk.lifecycle.createAsset(RES);
    expect(asset.celLog!.events.map((e) => e.type)).toEqual(['create']);

    // Both CEL appends sign with the genesis controller (folded from the log
    // head 'create'). Arm the gate on that VM so both park after reading the
    // head but before writing it back.
    const genesisVm = keyStore.getAllVerificationMethodIds().find((id) => id.startsWith('did:key:'))!;
    keyStore.arm(genesisVm);

    // Fire both per-asset CEL mutations concurrently.
    const [version] = await Promise.all([
      asset.addResourceVersion('res-1', 'v2', 'text/plain'),
      sdk.lifecycle.publishToWeb(asset, 'example.com')
    ]);

    expect(version.version).toBe(2);

    // Both signed appends must survive: create + update + migrate.
    const types = asset.celLog!.events.map((e) => e.type);
    expect(asset.celLog!.events.length).toBe(3);
    expect(types).toContain('update');
    expect(types).toContain('migrate');

    // The chain must still verify end-to-end (a clobbered/stale-chained append
    // would break continuity).
    expect(await asset.verify()).toBe(true);
  });

  // The end-to-end publish variant proves one op's wiring against a real clobber.
  // The other three wrapped ops (inscribe/rotate/authorize) can't be guarded the
  // same way: they migrate to did:btco, after which addResourceVersion takes a
  // different per-event-inscription path (event count varies with lock order)
  // and btco verify() needs an ordinalsProvider — so a full end-to-end race
  // asserts nothing deterministic. Instead, lock down the shared primitive every
  // op wraps: if runExclusive stops serializing, ALL four ops regress.
  test('runExclusive serializes concurrent critical sections (mutual exclusion + FIFO)', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
      keyStore: new MockKeyStore(),
      storageAdapter: new MemoryStorageAdapter()
    } as any);
    const asset = await sdk.lifecycle.createAsset(RES);

    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const critical = (label: string, delayMs: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`${label}:start`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`${label}:end`);
      active--;
      return label;
    };

    // A runs longest but is enqueued first — FIFO must still run A→B→C to
    // completion each, never overlapping (a broken lock would interleave).
    const results = await Promise.all([
      asset.runExclusive(critical('A', 30)),
      asset.runExclusive(critical('B', 5)),
      asset.runExclusive(critical('C', 5))
    ]);

    expect(maxActive).toBe(1); // never two critical sections in flight at once
    expect(order).toEqual(['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end']);
    expect(results).toEqual(['A', 'B', 'C']);

    // A rejected turn must not wedge the chain: the next acquirer still runs.
    await expect(asset.runExclusive(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await asset.runExclusive(async () => 'after')).toBe('after');
  });
});
