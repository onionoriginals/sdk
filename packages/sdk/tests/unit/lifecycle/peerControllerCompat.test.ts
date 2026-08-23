/**
 * Long-form did:peer:4 controller compatibility (PR #508 review findings).
 *
 * The verifier accepts a SELF-CERTIFYING rotation target — did:key OR
 * long-form did:peer:4 — so a valid log can fold to a did:peer:4 current
 * controller. The SDK must not (1) reject such logs at load with a
 * did:key-only gate, nor (2) corrupt the announced key by slicing a did:key
 * prefix off a peer DID when reinscribing.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { KeyManager } from '../../../src/did/KeyManager';
import {
  createEventLog,
  appendEvent,
  celSignerFromKeyPair,
  currentControllerVm,
  deriveDidCel,
  hexSha256ToDigestMultibase,
  computeDigestMultibase,
  canonicalizeEntryForChain,
  verifyEventLog,
  multikey,
} from '@originals/cel';
import type { EventLog, LogEntry, DataIntegrityProof } from '@originals/cel';
import { hashResource } from '../../../src/utils/validation';

const contentHex = hashResource(Buffer.from('the-work', 'utf8'));
const SAT = '8383838383';

async function peerDidFor(publicKeyMultibase: string): Promise<string> {
  const mod = await import('@aviarytech/did-peer') as unknown as {
    createNumAlgo4: (vms: Array<{ type: string; publicKeyMultibase: string }>, services?: unknown, alsoKnownAs?: unknown) => Promise<string>;
  };
  return mod.createNumAlgo4([{ type: 'Multikey', publicKeyMultibase }], undefined, undefined);
}

function makeSdk(provider = new OrdMockProvider(), keyStore = new MockKeyStore()) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore,
  });
}

const chainDigest = (e: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(e));

async function inscribeAnchorDoc(provider: OrdMockProvider, headDigest: string, didCel: string, pubMb?: string) {
  const id = `did:btco:reg:${SAT}`;
  const res = await provider.createInscription({
    data: Buffer.from(JSON.stringify({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id,
      alsoKnownAs: [didCel],
      ...(pubMb ? { verificationMethod: [{ id: `${id}#key-0`, type: 'Multikey', controller: id, publicKeyMultibase: pubMb }] } : {}),
      service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase: headDigest } }],
    })),
    contentType: 'application/did+json',
    targetSatoshi: SAT,
  });
  return res;
}

function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessProof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'bitcoin-ordinals-2024',
    created: 'x',
    verificationMethod: 'did:btco:witness',
    proofPurpose: 'assertionMethod',
    proofValue: `z${insc.inscriptionId}`,
    witnessedAt: 'x',
    txid: insc.txid,
    satoshi: SAT,
    inscriptionId: insc.inscriptionId,
  } as unknown as DataIntegrityProof;
  return { events: [...log.events.slice(0, -1), { ...last, proof: [...last.proof, witnessProof] }] };
}

/** create(did:key A) → rotateKey(→ long-form did:peer:4 embedding K2). */
async function peerRotatedLog() {
  const km = new KeyManager();
  const genesisKp = await km.generateKeyPair('Ed25519');
  const rotatedKp = await km.generateKeyPair('Ed25519');
  const genesis = celSignerFromKeyPair({ publicKey: genesisKp.publicKey, privateKey: genesisKp.privateKey });
  const peerDid = await peerDidFor(rotatedKp.publicKey);

  let log = await createEventLog(
    {
      name: 'Peer-controlled asset',
      controller: genesis.controller,
      resources: [{ id: 'art', digestMultibase: hexSha256ToDigestMultibase(contentHex), mediaType: 'text/plain' }],
      createdAt: '2026-08-23T00:00:00Z',
      nonce: 'peer-compat',
    },
    { signer: genesis.signer, verificationMethod: genesis.verificationMethod }
  );
  log = await appendEvent(
    log,
    'rotateKey',
    { newController: peerDid, rotatedAt: '2026-08-23T00:00:01Z' },
    { signer: genesis.signer, verificationMethod: genesis.verificationMethod }
  );
  return { log, genesisKp, rotatedKp, peerDid };
}

describe('long-form did:peer:4 controller compatibility', () => {
  test('loadAsset accepts a log rotated to a did:peer:4 controller and announces its EMBEDDED key', async () => {
    const { log, genesisKp, rotatedKp, peerDid } = await peerRotatedLog();
    const sdk = makeSdk();

    const { asset, verification } = await sdk.lifecycle.loadAsset({
      format: 'originals/asset',
      version: 1,
      assetDid: deriveDidCel(log),
      eventLog: log,
      didDocuments: { 'did:cel': { '@context': ['https://www.w3.org/ns/did/v1'], id: deriveDidCel(log) } },
      resources: [{ id: 'art', type: 'text', contentType: 'text/plain', hash: contentHex, content: 'the-work' }],
    } as never);

    expect(verification?.verified).toBe(true);
    // The current controller IS the peer DID…
    expect(currentControllerVm(asset.celLog!).split('#')[0]).toBe(peerDid);
    // …and the derived document announces the key it EMBEDS (K2), not the
    // retired genesis key, and not a corrupted slice of the peer DID.
    const announced = asset.did.verificationMethod?.[0]?.publicKeyMultibase;
    expect(announced).toBe(rotatedKp.publicKey);
    expect(announced).not.toBe(genesisKp.publicKey);
    expect(() => multikey.decodePublicKey(announced!)).not.toThrow();
  });

  test('a keyStore append on a peer-controlled btco asset commits the PEER author and reinscribes the embedded key intact', async () => {
    const provider = new OrdMockProvider();
    const { log: rotated, rotatedKp, peerDid } = await peerRotatedLog();
    // Migrate to btco: signed by the peer controller's embedded key (its
    // did:key VM — authorization compares resolved KEYS, not DID strings).
    const rotatedSigner = celSignerFromKeyPair({ publicKey: rotatedKp.publicKey, privateKey: rotatedKp.privateKey });
    let log = await appendEvent(
      rotated,
      'migrate',
      { sourceDid: deriveDidCel(rotated), layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' },
      { signer: rotatedSigner.signer, verificationMethod: rotatedSigner.verificationMethod }
    );
    log = attachWitness(log, await inscribeAnchorDoc(provider, chainDigest(log.events[2]), deriveDidCel(log), rotatedKp.publicKey));

    const keyStore = new MockKeyStore();
    const sdk = makeSdk(provider, keyStore);
    const { asset } = await sdk.lifecycle.loadAsset({
      format: 'originals/asset',
      version: 1,
      assetDid: deriveDidCel(log),
      eventLog: log,
      didDocuments: { 'did:cel': { '@context': ['https://www.w3.org/ns/did/v1'], id: deriveDidCel(log) } },
      resources: [{ id: 'art', type: 'text', contentType: 'text/plain', hash: contentHex, content: 'the-work' }],
    } as never);

    // The keyStore path signs under the folded controller VM `<peer>#key-0`.
    const controllerVm = currentControllerVm(asset.celLog!);
    expect(controllerVm).toBe(`${peerDid}#key-0`);
    await keyStore.setPrivateKey(controllerVm, rotatedKp.privateKey);

    const digest = await asset.appendStatement({ statement: 'still curated' });
    expect(digest).not.toBeNull();

    // The committed author is the PEER DID (self-certifying — the verifier's
    // author binding accepts it), not silently omitted.
    const head = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect((head.data as { author?: string }).author).toBe(peerDid);

    // The reinscribed btco document announces the peer controller's EMBEDDED
    // key — decodable Multikey material, not a prefix-sliced peer DID.
    const onSat = await provider.getInscriptionsBySatoshi(SAT);
    const newest = await provider.getInscriptionById(onSat[onSat.length - 1].inscriptionId);
    const doc = (newest!.metadata as { didDocument?: { verificationMethod?: Array<{ publicKeyMultibase?: string }> } }).didDocument;
    const announcedKey = doc?.verificationMethod?.[0]?.publicKeyMultibase;
    expect(announcedKey).toBe(rotatedKp.publicKey);
    expect(() => multikey.decodePublicKey(announcedKey!)).not.toThrow();

    // And the whole log verifies once the peer VM is resolvable (test-local
    // resolver mapping the folded `<peer>#key-0` VM to its embedded key).
    const rotatedKeyBytes = multikey.decodePublicKey(rotatedKp.publicKey).key;
    const result = await verifyEventLog(asset.celLog!, {
      ordinalsProvider: provider,
      resolveKey: async (vm: string) => (vm === controllerVm ? rotatedKeyBytes : null),
    });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    expect(result.events[result.events.length - 1].authorClass).toBe('creator');
  });
});
