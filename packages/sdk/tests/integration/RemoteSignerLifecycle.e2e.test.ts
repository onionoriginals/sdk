/**
 * Plan 039/040 headline: the full documented flow under a NON-EXPORTING
 * custody backend (MockRemoteSigner — signBytes only, no key export, no
 * keyStore configured anywhere).
 *
 * Before plan 039, a remote-custody caller doing everything right got a
 * published asset whose CEL was silently missing its migrate event
 * (`appendCelEventOrSkip` was keyStore-only), reported as success. These tests
 * pin the fix: every authorship event is signed by the remote signer and the
 * whole chain verifies.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockRemoteSigner } from '../../src/crypto/MockRemoteSigner';
import { assertSignerConformance } from '../../src/crypto/signerConformance';
import { canonicalDidKeyVm } from '../../src/crypto/OriginalsSigner';
import { verifyEventLog } from '@originals/cel';
import { createHash } from 'crypto';
import type { EventTypeMap } from '../../src/events/types';

const contentHash = (c: string) => createHash('sha256').update(c, 'utf8').digest('hex');

function makeSdk(opts?: { signer?: MockRemoteSigner; onAppendFailure?: 'throw' | 'skip' }) {
  const ordinalsProvider = new OrdMockProvider();
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider,
    storageAdapter: new MemoryStorageAdapter(),
    // Deliberately NO keyStore: custody never exports a key. That is the whole
    // point of this suite — nothing here may fall back to a local key.
    ...(opts?.signer ? { signer: opts.signer } : {}),
    ...(opts?.onAppendFailure ? { onAppendFailure: opts.onAppendFailure } : {}),
  });
  return { sdk, ordinalsProvider };
}

// Fresh per test: addResourceVersion mutates the resources array it was given.
const freshResources = () => [{
  id: 'art', type: 'image', contentType: 'image/png',
  hash: contentHash('remote-art'), content: 'remote-art',
}];

describe('remote-custody lifecycle (MockRemoteSigner, no keyStore)', () => {
  test('MockRemoteSigner passes the conformance harness', async () => {
    await assertSignerConformance(new MockRemoteSigner());
  });

  test('create -> publish -> inscribe -> rotate: every event signed remotely, chain verifies', async () => {
    const remote = new MockRemoteSigner();
    const { sdk, ordinalsProvider } = makeSdk();

    const skipped: EventTypeMap['cel:append-skipped'][] = [];
    const unpersisted: EventTypeMap['key:unpersisted'][] = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => { skipped.push(e); });
    sdk.lifecycle.on('key:unpersisted', (e) => { unpersisted.push(e); });

    // ---- create: the genesis is signed by the remote key; no key is
    // generated, so key:unpersisted must NOT fire. ----
    const asset = await sdk.lifecycle.createAsset(freshResources(), { signer: remote });
    await new Promise((r) => setTimeout(r, 0)); // flush the deferred asset:created turn
    expect(unpersisted).toHaveLength(0);
    expect(asset.currentLayer).toBe('did:cel');
    expect(asset.celLog!.events[0].proof[0].verificationMethod)
      .toBe(remote.verificationMethodId);
    expect(remote.signBytesCalls).toBeGreaterThan(0);

    // ---- publish: THE headline fix — the migrate event lands, signed
    // remotely, instead of degrading to cel:append-skipped. ----
    await sdk.lifecycle.publishToWeb(asset, 'example.com', { signer: remote });
    expect(asset.currentLayer).toBe('did:webvh');
    expect(skipped).toHaveLength(0);
    expect(asset.celLog!.events.map(e => e.type)).toEqual(['create', 'migrate']);
    // publish DOES emit key:unpersisted for the minted did:webvh UPDATE key
    // (separate honest signal about the webvh log, not the CEL) — tolerated.

    // ---- inscribe: btco migrate + witness acknowledgment, both remote-signed. ----
    await sdk.lifecycle.inscribeOnBitcoin(asset, { signer: remote });
    expect(asset.currentLayer).toBe('did:btco');
    expect(skipped).toHaveLength(0);
    expect(asset.celLog!.events.map(e => e.type))
      .toEqual(['create', 'migrate', 'migrate', 'update']);

    // ---- cooperative rotate to a SECOND remote key: the rotateKey is signed
    // by the OUTGOING remote controller. ----
    const remote2 = new MockRemoteSigner();
    await sdk.lifecycle.rotateBtcoKeys(
      asset, { publicKeyMultibase: remote2.publicKeyMultibase }, undefined, { signer: remote }
    );
    const rotate1 = asset.celLog!.events.find(e => e.type === 'rotateKey')!;
    expect(rotate1.proof[0].verificationMethod).toBe(remote.verificationMethodId);
    // The post-rotation witness ack folds to remote2, whose signer was not
    // supplied on THIS call — that single append degrades honestly.
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('NO_SIGNING_KEY');
    expect(asset.celLog!.events.map(e => e.type))
      .toEqual(['create', 'migrate', 'migrate', 'update', 'rotateKey']);

    // ---- the WHOLE chain verifies, including the rotation's bitcoin witness
    // proof, with zero private keys ever leaving custody. ----
    const result = await verifyEventLog(asset.celLog!, { expectedDid: asset.id, ordinalsProvider });
    expect(result.verified).toBe(true);
    expect(await asset.verify({ ordinalsProvider })).toBe(true);
  });

  test('config-level signer: OriginalsSDK.create({ signer }) is the ambient authorship signer', async () => {
    const remote = new MockRemoteSigner();
    const { sdk } = makeSdk({ signer: remote });

    const skipped: unknown[] = [];
    const unpersisted: unknown[] = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => { skipped.push(e); });
    sdk.lifecycle.on('key:unpersisted', (e) => { unpersisted.push(e); });

    // No per-call signer anywhere below — everything flows from config.
    const asset = await sdk.lifecycle.createAsset(freshResources());
    await new Promise((r) => setTimeout(r, 0));
    expect(unpersisted).toHaveLength(0);
    expect(asset.celLog!.events[0].proof[0].verificationMethod).toBe(remote.verificationMethodId);

    // addResourceVersion signs its update event through the config signer.
    await asset.addResourceVersion('art', 'remote-art-v2', 'image/png');
    expect(skipped).toHaveLength(0);
    expect(asset.celLog!.events.map(e => e.type)).toEqual(['create', 'update']);

    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(skipped).toHaveLength(0);
    expect(asset.celLog!.events.map(e => e.type)).toEqual(['create', 'update', 'migrate']);
    expect(await asset.verify()).toBe(true);
  });

  test('the minting signer is NOT retained — a later append with no signer degrades', async () => {
    // An asset holding a signer passed once is hidden state that outlives the
    // call: a session-backed signer goes stale inside it, and a reloaded asset
    // has no binding at all. Custody is explicit at every append.
    const remote = new MockRemoteSigner();
    const { sdk } = makeSdk({ onAppendFailure: 'skip' });
    const skipped: EventTypeMap['cel:append-skipped'][] = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => { skipped.push(e); });

    const asset = await sdk.lifecycle.createAsset(freshResources(), { signer: remote });
    await asset.addResourceVersion('art', 'remote-art-v2', 'image/png');

    expect(asset.celLog!.events.map(e => e.type)).toEqual(['create']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('NO_KEYSTORE');
  });

  test('the same append signs once the signer is passed explicitly', async () => {
    // A separate asset: once an update has degraded, that resource's in-memory
    // head has advanced past the on-log head and further appends are refused
    // (UNPROVABLE_BASE) rather than chained from a base no verifier can see.
    const remote = new MockRemoteSigner();
    const { sdk } = makeSdk();
    const asset = await sdk.lifecycle.createAsset(freshResources(), { signer: remote });

    await asset.addResourceVersion('art', 'remote-art-v2', 'image/png', undefined, { signer: remote });

    expect(asset.celLog!.events.map(e => e.type)).toEqual(['create', 'update']);
    expect(asset.celLog!.events[1].proof[0].verificationMethod)
      .toBe(canonicalDidKeyVm(remote.publicKeyMultibase));
    expect(await asset.verify()).toBe(true);
  });

  test('config.signer still serves later appends — explicit config, not carried state', async () => {
    const remote = new MockRemoteSigner();
    const { sdk } = makeSdk({ signer: remote });
    const asset = await sdk.lifecycle.createAsset(freshResources(), { signer: remote });

    await asset.addResourceVersion('art', 'remote-art-v2', 'image/png');
    expect(asset.celLog!.events.map(e => e.type)).toEqual(['create', 'update']);
    expect(await asset.verify()).toBe(true);
  });

  test('a non-Ed25519 signer is rejected loudly at createAsset (CEL is Ed25519-only)', async () => {
    const { sdk } = makeSdk();
    const { KeyManager } = await import('../../src/did/KeyManager');
    const { signerFromKeyPair } = await import('../../src/crypto/OriginalsSigner');
    const secp = signerFromKeyPair(await new KeyManager().generateKeyPair('ES256K'));
    await expect(sdk.lifecycle.createAsset(freshResources(), { signer: secp })).rejects.toThrow(/Ed25519/);
  });

  test('the degrade contract still exists, but only when opted into (plan 041)', async () => {
    // Pre-041 this was the default and publish silently lost its migrate event.
    // The behavior is unchanged — it is just no longer what you get by accident.
    const { sdk } = makeSdk({ onAppendFailure: 'skip' });
    const skipped: EventTypeMap['cel:append-skipped'][] = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => { skipped.push(e); });
    const asset = await sdk.lifecycle.createAsset(freshResources(), { controller: 'ephemeral' });
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('NO_KEYSTORE');
    expect(asset.celLog!.events.map(e => e.type)).toEqual(['create']);
  });
});
