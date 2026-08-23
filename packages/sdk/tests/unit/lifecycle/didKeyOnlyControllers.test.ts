/**
 * did:key-only controllers — did:peer support is removed ENTIRELY (maintainer
 * ruling, PR #508).
 *
 * There is no legacy read path left: the cel verifier refuses did:peer DIDs
 * outright (rotation targets, committed authors, genesis controllers, legacy
 * `data.did`), and the SDK refuses them loudly at load and before any append —
 * the earlier failure modes were a corrupted announced key (prefix-slicing a
 * peer DID) and a silently omitted `data.author` discovered only after the
 * inscription fee was burned. did:peer strings below are static fixtures; the
 * did-peer library is no longer a dependency and nothing resolves them.
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
  verifyEventLog,
} from '@originals/cel';
import type { EventLog, LogEntry, DataIntegrityProof, DIDDocument } from '@originals/cel';
import { hashResource } from '../../../src/utils/validation';

const contentHex = hashResource(Buffer.from('the-work', 'utf8'));
const SAT = '8383838383';

// Frozen, GENUINE long-form did:peer:4 (generated once with
// @aviarytech/did-peer, which is no longer a dependency) embedding
// ROTATED_KP's public key. Under the old legacy read path a log rotated to
// this DID verified; now the did:peer prefix is refused before any
// resolution could happen.
const PEER_DID = 'did:peer:4zQmdZX2kFmuSknngEjNgkPAijmakC9YcqfcS8cbMJRzsCBH:z2E3ApMRVSzHJcKffrpLi1ex4H6YDtwSuhNERf4QcAFcSQEZ2CA8o3wuTuHDhk1qPmXof4zgH9LtPMY1FhMT5yBjiSUQgDRrcC35e4HTG3YgWZ4Et8w19JAHuHQxsk9WkoshRpCj5MfTXwtbSSwH8LfwFAMHsAYfAbidTBaeRmNKFDTmUE42Y4rygYHXKHTJqPdczvk9SBoExqtEsAHprvPNWqtWcAU5CVzv1S6tmEBP1kpBCvuGkD41MKmdGX6YNyZBH8a5baiVx5UDaZk6VMrtDnegnATnNNZShXQ6UxpoRGQTDNjQu8thVe6HRdE9CqeBfH8MQZHw7Lg';
const ROTATED_KP = {
  publicKey: 'z6Mkvu7X4wxDXTpRTQgtMMpkedyJJgnXZYPnMVD9DjjbXFPD',
  privateKey: 'z3u2WxZ8zoixSwjPjKaB4K9sPp3kkFDjnvddozvHjRTvVMHT',
};

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

/** create(did:key A) → rotateKey(→ the frozen long-form did:peer:4). */
async function peerRotatedLog() {
  const km = new KeyManager();
  const genesisKp = await km.generateKeyPair('Ed25519');
  const rotatedKp = ROTATED_KP;
  const genesis = celSignerFromKeyPair({ publicKey: genesisKp.publicKey, privateKey: genesisKp.privateKey });

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
    { newController: PEER_DID, rotatedAt: '2026-08-23T00:00:01Z' },
    { signer: genesis.signer, verificationMethod: genesis.verificationMethod }
  );
  return { log, genesisKp, rotatedKp };
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

describe('did:key-only controllers (did:peer support removed entirely)', () => {
  test('the verifier refuses a rotateKey whose target is a did:peer — no legacy read path', async () => {
    const { log } = await peerRotatedLog();
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /unbindable newController/.test(e) && e.includes(PEER_DID))).toBe(true);
  });

  test('loadAsset refuses a peer-rotated log at verification', async () => {
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
    const verification = (thrown as { details?: { verification?: { errors?: string[] } } }).details?.verification
      ?? (thrown as { verification?: { errors?: string[] } }).verification;
    const errors = verification?.errors ?? [];
    expect(errors.some(e => /unbindable newController/.test(e))).toBe(true);
  });

  test('loadAsset refuses the same log under skipVerification — the did:key gate is not skippable', async () => {
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
    const { log: rotated, rotatedKp } = await peerRotatedLog();
    // Hand-built continuation: migrate to btco signed by the rotated key's
    // did:key VM. The log can no longer VERIFY (the peer rotation is refused),
    // but the append path folds the controller without verifying — exactly why
    // its own guard must refuse before mutating anything.
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

    const controllerVm = currentControllerVm(log);
    expect(controllerVm).toBe(`${PEER_DID}#key-0`);
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
