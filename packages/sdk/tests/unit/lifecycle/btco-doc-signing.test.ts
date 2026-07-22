/**
 * #442 — the inscribed did:btco document is signed by the current controller's
 * Ed25519 key so it is self-authenticating, completing #402's competitor
 * authentication for HONEST anchorings.
 *
 * These are SDK-LEVEL tests: the docs are signed by LifecycleManager itself
 * (inscribe / rotate / authorizeSigner), NOT hand-signed by the test. The
 * legit-dupe regression relies on that: two honest anchorings of one did:cel on
 * different sats must now compete (NON_CANONICAL_ANCHOR) without any manual
 * signing — proving the vestigial gap #402 documented is closed.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { deriveDidCel } from '../../../src/cel/celDid';

/**
 * Independently re-checks a signed did:btco doc the exact way verifyEventLog's
 * `anchoringDocAuthenticated`/`dispatchVerify` does: Ed25519 over
 * `canonicalizeEvent(docWithoutProof)`, key extracted from the proof's did:key
 * verificationMethod. Returns the controller pubkey hex on success (so callers
 * can assert WHICH key signed), or null on any failure.
 */
async function verifyBtcoDocProof(doc: any): Promise<string | null> {
  const rawProof = doc?.proof;
  const proofs = Array.isArray(rawProof) ? rawProof : rawProof ? [rawProof] : [];
  const docWithoutProof = { ...doc };
  delete docWithoutProof.proof;
  for (const proof of proofs) {
    if (proof?.type !== 'DataIntegrityProof' || proof?.cryptosuite !== 'eddsa-jcs-2022') continue;
    if (proof?.proofPurpose !== 'assertionMethod') continue;
    const vm: string = proof.verificationMethod ?? '';
    if (!vm.startsWith('did:key:')) continue;
    const pubMb = vm.slice('did:key:'.length).split('#')[0];
    const { key: pub, type } = multikey.decodePublicKey(pubMb);
    if (type !== 'Ed25519') continue;
    const sig = multikey.decodeMultibase(proof.proofValue);
    const ok = await ed25519.verifyAsync(sig, canonicalizeEvent(docWithoutProof), pub);
    if (ok) return Buffer.from(pub).toString('hex');
  }
  return null;
}

const makeSDK = (provider: any) =>
  OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    keyStore: new MockKeyStore(),
  });

const RES = () => [{ id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }];

/**
 * Wraps an OrdMockProvider to pin each inscribe onto a chosen sat and stamp a
 * chosen confirmed block height (OrdMock hardcodes height 1 for all, which the
 * uniqueness ordering would read as a same-block tie). The plan is consumed in
 * createInscription call order (migrate #1, migrate #2, …).
 */
function withControlledSats(inner: OrdMockProvider, plan: Array<{ satoshi: string; blockHeight: number }>) {
  const heights = new Map<string, number>();
  let i = 0;
  const overrides: Record<string, any> = {
    async createInscription(params: any) {
      const step = plan[Math.min(i++, plan.length - 1)];
      const res = await inner.createInscription({ ...params, targetSatoshi: step.satoshi });
      heights.set(res.inscriptionId, step.blockHeight);
      return res;
    },
    async getInscriptionById(id: string) {
      const rec = await inner.getInscriptionById(id);
      if (rec && heights.has(id)) return { ...rec, blockHeight: heights.get(id)! };
      return rec;
    },
    async getAnchoringsForDidCel(didCel: string) {
      const arr = await inner.getAnchoringsForDidCel!(didCel);
      return arr.map((a: any) => (heights.has(a.inscriptionId) ? { ...a, blockHeight: heights.get(a.inscriptionId)! } : a));
    },
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as string];
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

describe('#442 — self-authenticating did:btco document', () => {
  test('honest inscribeOnBitcoin signs the doc with the controller key; it self-authenticates and the log still verifies', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSDK(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const didCel = deriveDidCel(asset.celLog!);
    const anchorings = await (provider as any).getAnchoringsForDidCel(didCel);
    expect(anchorings.length).toBe(1);
    const inscribedDoc = anchorings[0].didDocument;

    // The on-chain doc carries a proof that verifies with the SAME primitive
    // the verifier uses — no manual signing anywhere in this test.
    expect(inscribedDoc.proof).toBeDefined();
    const signerKeyHex = await verifyBtcoDocProof(inscribedDoc);
    expect(signerKeyHex).not.toBeNull();

    // The signer is the genesis controller key (the same identity that signed
    // the migrate event).
    const genesisController = (asset.celLog!.events[0].data as any).controller as string;
    const genesisPubMb = genesisController.slice('did:key:'.length);
    expect(signerKeyHex).toBe(Buffer.from(multikey.decodePublicKey(genesisPubMb).key).toString('hex'));

    // Backward-compat: the #cel anchor is still present and the log still verifies.
    const celService = inscribedDoc.service.find((s: any) => s.type === 'OriginalsCelAnchor');
    expect(celService).toBeDefined();
    const result = await verifyEventLog(asset.celLog!, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);

    // The captured (serialized) btco doc matches the inscribed one — round-trips.
    expect((asset.serialize().didDocuments['did:btco'] as any).proof).toBeDefined();
  });

  test('legit-dupe: two honest anchorings of ONE did:cel on DIFFERENT sats — the later log trips NON_CANONICAL_ANCHOR without any manual signing', async () => {
    const inner = new OrdMockProvider();
    const X = '100000001';
    const Y = '200000002';
    const provider = withControlledSats(inner, [
      { satoshi: X, blockHeight: 100 }, // branch A (earlier → canonical)
      { satoshi: Y, blockHeight: 200 }, // branch B (later → dupe)
    ]);
    const sdk = makeSDK(provider);

    // Genesis, then TWO branches sharing that exact genesis (same did:cel).
    const assetA = await sdk.lifecycle.createAsset(RES());
    const envelope = assetA.serialize(); // pre-inscribe snapshot
    const didCel = deriveDidCel(assetA.celLog!);

    await sdk.lifecycle.inscribeOnBitcoin(assetA); // → sat X, block 100

    const { asset: assetB } = await sdk.lifecycle.loadAsset(envelope, { skipVerification: true });
    await sdk.lifecycle.inscribeOnBitcoin(assetB); // → sat Y, block 200

    // Sanity: both anchor the SAME did:cel on different sats, both auto-signed.
    const anchorings = await (provider as any).getAnchoringsForDidCel(didCel);
    expect(anchorings.map((a: any) => a.satoshi).sort()).toEqual([X, Y]);
    for (const a of anchorings) expect(await verifyBtcoDocProof(a.didDocument)).not.toBeNull();

    // Branch B (later, sat Y): branch A is now an AUTHENTICATED earlier
    // competitor on a different sat → non-canonical.
    const rB = await verifyEventLog(assetB.celLog!, { ordinalsProvider: provider });
    expect(rB.verified).toBe(false);
    expect(rB.errors.some((e) => e.includes('NON_CANONICAL_ANCHOR'))).toBe(true);

    // Branch A (earlier, sat X): canonical → verifies clean.
    const rA = await verifyEventLog(assetA.celLog!, { ordinalsProvider: provider });
    expect(rA.errors).toEqual([]);
    expect(rA.verified).toBe(true);
  });

  test('cooperative rotateBtcoKeys reinscribes a signed doc (authenticated by the outgoing controller key)', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSDK(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;
    const outgoingController = (asset.celLog!.events[0].data as any).controller as string;

    // New controller keypair (real Ed25519 so it derives + self-signs later appends).
    const priv = crypto.getRandomValues(new Uint8Array(32));
    const pub = await ed25519.getPublicKeyAsync(priv);
    const newKey = multikey.encodePublicKey(pub, 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, {
      publicKeyMultibase: newKey,
      privateKey: multikey.encodePrivateKey(priv, 'Ed25519'),
    });

    const rotatedDoc = asset.serialize().didDocuments['did:btco'] as any;
    const signerKeyHex = await verifyBtcoDocProof(rotatedDoc);
    expect(signerKeyHex).not.toBeNull();
    // Cooperative rotation: the doc is signed by the OUTGOING controller (the
    // rotateKey signer), whose key is in the log's authorized-key history.
    const outgoingPubMb = outgoingController.slice('did:key:'.length);
    expect(signerKeyHex).toBe(Buffer.from(multikey.decodePublicKey(outgoingPubMb).key).toString('hex'));

    // The rotated doc still resolves (proof does not break resolution).
    const resolved = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(resolved!.verificationMethod?.[0]?.publicKeyMultibase).toBe(newKey);
  });

  test('authorizeSigner reinscribes a signed doc (authenticated by the NEW self-certified key)', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSDK(provider);
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const priv = crypto.getRandomValues(new Uint8Array(32));
    const pub = await ed25519.getPublicKeyAsync(priv);
    const newKey = multikey.encodePublicKey(pub, 'Ed25519');
    await sdk.lifecycle.authorizeSigner(asset, {
      publicKeyMultibase: newKey,
      privateKey: multikey.encodePrivateKey(priv, 'Ed25519'),
    });

    const doc = asset.serialize().didDocuments['did:btco'] as any;
    const signerKeyHex = await verifyBtcoDocProof(doc);
    expect(signerKeyHex).not.toBeNull();
    // Non-cooperative: self-signed with the NEW key.
    expect(signerKeyHex).toBe(Buffer.from(pub).toString('hex'));

    // And the whole log still verifies with the provider.
    const result = await verifyEventLog(asset.celLog!, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });
});
