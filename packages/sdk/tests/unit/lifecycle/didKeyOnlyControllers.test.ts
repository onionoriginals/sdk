/**
 * did:key-only forward paths (PR #508 review follow-up, maintainer ruling).
 *
 * The VERIFIER keeps a legacy READ path for pre-existing long-form did:peer:4
 * logs, but the SDK's forward paths are did:key-only: a log whose controller
 * folded to a did:peer:4 DID is refused LOUDLY at load (never silently
 * mis-derived), and a post-anchor append under a non-did:key verification
 * method is refused BEFORE anything is appended or inscribed — the earlier
 * failure modes were a corrupted announced key (prefix-slicing a peer DID) and
 * a silently omitted `data.author` discovered only after the inscription fee
 * was burned.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';
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
} from '@originals/cel';
import type { EventLog, LogEntry, DataIntegrityProof, DIDDocument } from '@originals/cel';
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
  return provider.createInscription({
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
      nonce: 'peer-refusal',
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

function envelopeFor(log: EventLog) {
  return {
    format: 'originals/asset',
    version: 1,
    assetDid: deriveDidCel(log),
    eventLog: log,
    didDocuments: { 'did:cel': { '@context': ['https://www.w3.org/ns/did/v1'], id: deriveDidCel(log) } },
    resources: [{ id: 'art', type: 'text', contentType: 'text/plain', hash: contentHex, content: 'the-work' }],
  } as never;
}

describe('did:key-only forward paths (did:peer is a legacy verifier read path only)', () => {
  test('loadAsset refuses a log rotated to a did:peer:4 controller — loudly, naming did:key', async () => {
    const { log } = await peerRotatedLog();
    const sdk = makeSdk();

    let thrown: unknown;
    try {
      await sdk.lifecycle.loadAsset(envelopeFor(log));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
    expect(String((thrown as Error).message)).toMatch(/did:key/);
    expect(String((thrown as Error).message)).toMatch(/did:peer/);
  });

  test('loadAsset refuses the same log under skipVerification — the gate is not skippable', async () => {
    const { log } = await peerRotatedLog();
    const sdk = makeSdk();

    let thrown: unknown;
    try {
      await sdk.lifecycle.loadAsset(envelopeFor(log), { skipVerification: true });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
    expect(String((thrown as Error).message)).toMatch(/did:key/);
  });

  test('a post-anchor keyStore append under a peer controller VM refuses BEFORE appending', async () => {
    const provider = new OrdMockProvider();
    const { log: rotated, rotatedKp, peerDid } = await peerRotatedLog();
    // Anchor on btco: the migrate is signed by the peer controller's embedded
    // key via its did:key VM (pre-anchor authorization compares resolved KEYS).
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

    // loadAsset refuses peer-controlled logs, so build the asset directly —
    // the guard under test sits in the append path itself.
    const controllerVm = currentControllerVm(log);
    expect(controllerVm).toBe(`${peerDid}#key-0`);
    await keyStore.setPrivateKey(controllerVm, rotatedKp.privateKey);
    const btcoDoc: DIDDocument = { '@context': ['https://www.w3.org/ns/did/v1'], id: `did:btco:reg:${SAT}` };
    const asset = new OriginalsAsset(
      [{ id: 'art', type: 'text', contentType: 'text/plain', hash: contentHex, content: 'the-work' }],
      btcoDoc,
      [],
      log
    );

    const lengthBefore = asset.celLog!.events.length;
    const satBefore = (await provider.getInscriptionsBySatoshi(SAT)).length;
    const append = (sdk.lifecycle as unknown as {
      appendCelEventOrSkip: (a: OriginalsAsset, t: string, d: unknown) => Promise<string | null>;
    }).appendCelEventOrSkip.bind(sdk.lifecycle);

    let thrown: unknown;
    try {
      await append(asset, 'update', { statement: 'still curated' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe('CEL_APPEND_FAILED');
    expect(String((thrown as Error).message)).toMatch(/did:key/);
    // Refused BEFORE any mutation: the log did not grow and nothing was inscribed.
    expect(asset.celLog!.events.length).toBe(lengthBefore);
    expect((await provider.getInscriptionsBySatoshi(SAT)).length).toBe(satBefore);
  });
});
