/**
 * SDK write side of sat-gated appends: a btco append signs with the CALLER's
 * configured signer (which does not have to be in the log), writes
 * data.author, refuses holder authenticity claims locally BEFORE paying for
 * an inscription, and surfaces live ownership on resolveAssetFromSat.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { KeyManager } from '../../../src/did/KeyManager';
import { signerFromKeyPair } from '../../../src/crypto/OriginalsSigner';
import { hashResource } from '../../../src/utils/validation';
import { replayProvenance } from '../../../src/lifecycle/replayProvenance';
import { ProvenanceQuery } from '../../../src/lifecycle/ProvenanceQuery';

const contentHash = (s: string) => hashResource(Buffer.from(s, 'utf8'));
const RES = () => [
  { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('v1'), content: 'v1' },
];

class CountingProvider extends OrdMockProvider {
  inscriptions = 0;
  async createInscription(params: never): Promise<never> {
    this.inscriptions += 1;
    return super.createInscription(params) as never;
  }
}

function makeSdk(provider: OrdMockProvider = new OrdMockProvider()) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore: new MockKeyStore(),
  });
}

describe('sat-gated appends (SDK write side)', () => {
  test('an append with a signer UNRELATED to the genesis controller succeeds (no CEL_NO_CONTROLLER)', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    const holderKp = await new KeyManager().generateKeyPair('Ed25519');
    const digest = await asset.appendStatement(
      { statement: 'in my collection' },
      { signer: signerFromKeyPair(holderKp) }
    );
    expect(digest).not.toBeNull();
    const head = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect((head.data as { author?: string }).author).toBe(`did:key:${holderKp.publicKey}`);
    // The reinscribed btco document announces the holder's appending key.
    const captured = (asset.serialize().didDocuments as { 'did:btco'?: { verificationMethod?: Array<{ publicKeyMultibase?: string }> } })['did:btco'];
    expect(captured?.verificationMethod?.[0]?.publicKeyMultibase).toBe(holderKp.publicKey);
    // And the whole log verifies: the sat gate, not the key set, authorized it.
    expect(await asset.verify({ ordinalsProvider: provider })).toBe(true);
  });

  test('a non-lineage signer with an authenticity field throws CEL_HOLDER_FIELD_NOT_PERMITTED before ANY inscription', async () => {
    const provider = new CountingProvider();
    const sdk = makeSdk(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const before = provider.inscriptions;
    const logBefore = asset.celLog!;

    const holderKp = await new KeyManager().generateKeyPair('Ed25519');
    let err: unknown;
    try {
      // addResourceVersion builds a resource-shaped update — a creator-only claim.
      await asset.addResourceVersion('art', 'forged', 'image/png', undefined, { signer: signerFromKeyPair(holderKp) });
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe('CEL_HOLDER_FIELD_NOT_PERMITTED');
    // The fee was never at risk: nothing appended, nothing inscribed.
    expect(asset.celLog).toBe(logBefore);
    expect(provider.inscriptions).toBe(before);
  });

  test('a caller-supplied data.author that is not the signer throws CEL_APPEND_FAILED before ANY inscription', async () => {
    // withCommittedAuthor preserves a caller's author verbatim, and the
    // verifier requires signer ≡ author — so a mismatch used to append AND
    // inscribe (fee paid) an entry that could never verify. The pre-flight
    // gate refuses it before anything mutates.
    const provider = new CountingProvider();
    const sdk = makeSdk(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const before = provider.inscriptions;
    const lengthBefore = asset.celLog!.events.length;

    const holderKp = await new KeyManager().generateKeyPair('Ed25519');
    const someoneElse = await new KeyManager().generateKeyPair('Ed25519');
    // appendStatement strips a caller `author` (allowlist build), so drive the
    // append path directly — the guard defends the internal seam every caller
    // shares.
    const append = (sdk.lifecycle as unknown as {
      appendCelEventOrSkip: (a: unknown, t: string, d: unknown, s?: unknown) => Promise<string | null>;
    }).appendCelEventOrSkip.bind(sdk.lifecycle);
    let err: unknown;
    try {
      await append(asset, 'update', { statement: 'held', author: `did:key:${someoneElse.publicKey}` }, signerFromKeyPair(holderKp));
    } catch (e) {
      err = e;
    }
    expect((err as { code?: string })?.code).toBe('CEL_APPEND_FAILED');
    expect(String((err as Error).message)).toMatch(/does\s+not match the signing key/);
    expect(asset.celLog!.events.length).toBe(lengthBefore);
    expect(provider.inscriptions).toBe(before);
  });

  test('transferOwnership still writes NOTHING to the log', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const before = asset.celLog!.events.length;
    await sdk.lifecycle.transferOwnership(asset, 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
    expect(asset.celLog!.events.length).toBe(before);
  });

  test('resolveAssetFromSat returns owner UNSET (not stale) when the provider exposes no owner index', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;

    // A lookup facade WITHOUT getSatOwnership: same chain, no owner index.
    const noIndex = {
      getInscriptionById: (id: string) => provider.getInscriptionById(id),
      getInscriptionsBySatoshi: (s: string) => provider.getInscriptionsBySatoshi(s),
      getAnchoringsForDidCel: (d: string) => provider.getAnchoringsForDidCel!(d),
    };
    const resolved = await sdk.lifecycle.resolveAssetFromSat(sat, { ordinalsProvider: noIndex });
    expect(resolved.verification?.verified).toBe(true);
    expect(resolved.owner).toBeUndefined();

    // With the full provider the owner is the LIVE mock index value.
    const withIndex = await sdk.lifecycle.resolveAssetFromSat(sat);
    expect(withIndex.owner?.address).toBeDefined();
  });

  test('replayProvenance folds a holder update into custody, never resourceUpdates — and the query surface reads it', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const holderKp = await new KeyManager().generateKeyPair('Ed25519');
    await asset.appendStatement({ statement: 'exhibited', occurredAt: 't1' }, { signer: signerFromKeyPair(holderKp) });

    const folded = replayProvenance(asset.celLog!);
    expect(folded.custody).toHaveLength(1);
    expect(folded.custody[0].author).toBe(`did:key:${holderKp.publicKey}`);
    expect(folded.custody[0].statement).toBe('exhibited');
    expect(folded.resourceUpdates).toHaveLength(0);

    // Round-trip through loadAsset: the restored provenance carries custody,
    // and ProvenanceQuery.custody() reads it.
    const { asset: restored } = await sdk.lifecycle.loadAsset(asset.serialize());
    const q = new ProvenanceQuery(restored.getProvenance());
    expect(q.custody().count()).toBe(1);
    expect(q.custody().byAuthor(`did:key:${holderKp.publicKey}`).first()?.statement).toBe('exhibited');
    expect(q.custody().byAuthor('did:key:zNobody').count()).toBe(0);
  });
});
