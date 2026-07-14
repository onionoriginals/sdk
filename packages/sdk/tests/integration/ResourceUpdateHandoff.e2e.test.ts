import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { hashResource } from '../../src/utils/validation';
import type { CelAppendSkippedEvent } from '../../src/events/types';

const h = (s: string) => hashResource(Buffer.from(s, 'utf-8'));

describe('Resource-update handoff (e2e)', () => {
  test('honest round-trip: creator updates, buyer verifies offline with no keys', async () => {
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    await asset.addResourceVersion('note', 'v2', 'text/plain', 'edit');

    // The signed update landed on the log.
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(true);

    const envelope = asset.serialize();

    // Buyer loads with a FRESH, keyless SDK — verification is public-key-only.
    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const { asset: loaded, verification } = await buyer.lifecycle.loadAsset(envelope);
    expect(verification?.verified).toBe(true);
    // The folded current resource is v2.
    expect(loaded.getResourceVersion('note', 2)?.content).toBe('v2');
    expect(loaded.getProvenance().resourceUpdates.some(u => u.toVersion === 2)).toBe(true);
  });

  test('byte-light log: the update event carries no content, and log size is independent of content size', async () => {
    const mk = async (bytes: number) => {
      const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
      const asset = await creator.lifecycle.createAsset([
        { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
      ]);
      const big = 'x'.repeat(bytes);
      await asset.addResourceVersion('note', big, 'text/plain');
      return asset;
    };

    const small = await mk(10);
    const large = await mk(50_000);

    // The signed update event references content by hash only — no bytes.
    const ev = small.celLog!.events.find(e => e.type === 'update')!;
    expect((ev.data as Record<string, unknown>).content).toBeUndefined();
    expect(typeof (ev.data as { toHash?: unknown }).toHash).toBe('string');

    // The log serialization does not grow with content size (bytes live in the
    // content-addressed store, not the log) — the whole point of #407.
    const logSize = (a: typeof small) => JSON.stringify(a.serialize().eventLog).length;
    expect(Math.abs(logSize(large) - logSize(small))).toBeLessThan(200);
    // The envelope's resource BLOB, by contrast, does carry the large content.
    expect(large.serialize().resources.some(r => r.content && r.content.length >= 50_000)).toBe(true);
  });

  test('content-tamper in the envelope blob (hash(blob) != toHash) is rejected at load', async () => {
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    await asset.addResourceVersion('note', 'v2', 'text/plain');
    const envelope = asset.serialize();

    // The bytes no longer live in the log event (#407) — they travel as a
    // content-addressed blob in envelope.resources. Flip that blob (leaving the
    // signed toHash on the log untouched): hash(blob) != toHash → fail closed.
    const v2 = envelope.resources.find(r => r.id === 'note' && r.version === 2)!;
    v2.content = 'tampered';

    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    await expect(buyer.lifecycle.loadAsset(envelope)).rejects.toThrow();
  });

  test('forged post-genesis env.resource (self-consistent) is rejected at load even though the log verifies', async () => {
    // Greptile #401 gap: the LOG's update event keeps its genuine content (so
    // verifyEventLog passes), but the envelope's CAPTURED resource snapshot for
    // v2 is swapped for self-consistent forged content (content AND its own hash
    // both changed). Step-4 self-consistency passes; without the 4b post-genesis
    // binding, the buyer would restore forged content while the fold reports the
    // genuine hash. Must fail closed.
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    await asset.addResourceVersion('note', 'v2', 'text/plain');
    const envelope = asset.serialize();

    // Log update event is UNTOUCHED (still genuine → verifyEventLog passes).
    // Tamper ONLY the captured v2 resource snapshot, self-consistently.
    const v2 = envelope.resources.find(r => r.id === 'note' && r.version === 2)!;
    v2.content = 'forged-v2';
    v2.hash = h('forged-v2'); // self-consistent: content matches its own hash

    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    await expect(buyer.lifecycle.loadAsset(envelope)).rejects.toThrow(/does not match the verified log/);
  });

  test('unprovable (degraded) post-genesis version in an envelope is rejected at load', async () => {
    // A keyless creator advances v2 in-memory but appends NO update event. If it
    // serializes and hands off, that v2 is unprovable — indistinguishable from a
    // forgery. The buyer must not silently accept it (fail closed on a v≥2
    // resource with no backing verified update event).
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519' });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    await asset.addResourceVersion('note', 'v2', 'text/plain'); // degrades (no signer)
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(false);

    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    await expect(buyer.lifecycle.loadAsset(asset.serialize())).rejects.toThrow(/not backed by a verified update event/);
  });

  test('degrade: keyless creator emits cel:append-skipped and the update is not on the log', async () => {
    // No keyStore ⇒ createAsset drops the controller key ⇒ appends degrade.
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519' });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    const skipped: CelAppendSkippedEvent[] = [];
    creator.lifecycle.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));

    await asset.addResourceVersion('note', 'v2', 'text/plain');

    expect(asset.getResourceVersion('note', 2)?.content).toBe('v2'); // usable in-memory
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(false); // not provable
    expect(skipped.length).toBe(1);
    expect(asset.getProvenance().resourceUpdates.length).toBe(0);
  });

  test('degrade-then-provable does NOT poison the log (Finding 1)', async () => {
    // Real Finding-1 repro: a skipped update advances the in-memory head to v2
    // while the log stays at genesis; when the key becomes available and a
    // second update is attempted, chaining from the un-logged v2 would make the
    // log permanently unverifiable. The fix must degrade instead of poison.
    const ks = new MockKeyStore();
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: ks });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);

    // 1) Key temporarily unavailable → this update degrades (in-memory only).
    const saved = ks.getAllKeys();
    ks.clear();
    await asset.addResourceVersion('note', 'v2', 'text/plain');
    expect(asset.getResourceVersion('note', 2)?.content).toBe('v2'); // in-memory advanced
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(false); // nothing on log

    // 2) Key becomes available again; attempting a provable update now would
    //    chain from the un-logged v2. The base-check must catch the divergence.
    for (const [vm, sk] of saved) await ks.setPrivateKey(vm, sk);
    const skipped: CelAppendSkippedEvent[] = [];
    asset.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));
    await asset.addResourceVersion('note', 'v3', 'text/plain');

    // Degraded (not appended): exactly one skip with the new reason, no update event.
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toBe('UNPROVABLE_BASE');
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(false);

    // The log is still verifiable — no unverifiable event was ever appended.
    expect(await asset.verify()).toBe(true);
    // But the envelope now carries UNPROVABLE in-memory v2/v3 (degraded, never
    // logged); a buyer must fail closed rather than restore unverifiable
    // versions (#401 post-genesis binding). The log soundness is proven above.
    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    await expect(buyer.lifecycle.loadAsset(asset.serialize())).rejects.toThrow(/not backed by a verified update event/);
  });

  test('concurrent same-resource updates serialize into a valid chain (Finding 2)', async () => {
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);

    await Promise.all([
      asset.addResourceVersion('note', 'v2a', 'text/plain'),
      asset.addResourceVersion('note', 'v2b', 'text/plain')
    ]);

    // Both signed appends landed — neither was lost/clobbered.
    const updates = asset.celLog!.events.filter(e => e.type === 'update');
    expect(updates.length).toBe(2);
    const contents = asset.getAllVersions('note').map(r => r.content);
    expect(contents).toContain('v2a');
    expect(contents).toContain('v2b');

    // The resulting chain verifies (genesis → v2a → v2b, correctly serialized).
    expect(await asset.verify()).toBe(true);
    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const { verification } = await buyer.lifecycle.loadAsset(asset.serialize());
    expect(verification?.verified).toBe(true);
  });

  test('concurrent updates to different resources both land (Finding 2)', async () => {
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'a', type: 'text', content: 'a1', contentType: 'text/plain', hash: h('a1') },
      { id: 'b', type: 'text', content: 'b1', contentType: 'text/plain', hash: h('b1') }
    ]);

    await Promise.all([
      asset.addResourceVersion('a', 'a2', 'text/plain'),
      asset.addResourceVersion('b', 'b2', 'text/plain')
    ]);

    const updates = asset.celLog!.events.filter(e => e.type === 'update');
    expect(updates.length).toBe(2);
    expect(asset.getResourceVersion('a', 2)?.content).toBe('a2');
    expect(asset.getResourceVersion('b', 2)?.content).toBe('b2');
    expect(await asset.verify()).toBe(true);
  });
});
