/**
 * Sat-gated appends: after the btco anchor, authority is sat control. An event
 * is authorized iff it commits its author in data.author, its single
 * controller proof is that author's key, and it carries a fully verified
 * bitcoin-ordinals-2024 witness proof on the anchoring sat whose inscription
 * strictly postdates the current anchor. The signer does NOT have to be in the
 * authorized key set, and appending never modifies it — before the migrate the
 * key decides; after the migrate the sat decides; neither can alter what is
 * already written.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../../src/canonicalize';
import { computeDigestMultibase } from '../../src/hash';
import { verifyEventLog } from '../../src/algorithms/verifyEventLog';
import { createEventLog } from '../../src/algorithms/createEventLog';
import { appendEvent } from '../../src/algorithms/appendEvent';
import { deriveDidCel } from '../../src/celDid';
import { OrdMockProvider } from '../../src/testing/OrdMockProvider';
import type { EventLog, LogEntry, DataIntegrityProof } from '../../src/types';

async function makeKey() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown): Promise<DataIntegrityProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-08-23T00:00:00Z',
    verificationMethod: vm,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(
      new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
    ),
  });
  return { signer, didKey, vm, pubMb };
}
type Key = Awaited<ReturnType<typeof makeKey>>;

const chainDigest = (e: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(e));
const SAT = '5150515051';

function anchorDoc(satoshi: string, headDigestMultibase: string, didCel: string, publicKeyMultibase?: string) {
  const id = `did:btco:reg:${satoshi}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    alsoKnownAs: [didCel],
    ...(publicKeyMultibase
      ? { verificationMethod: [{ id: `${id}#key-0`, type: 'Multikey', controller: id, publicKeyMultibase }] }
      : {}),
    service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase } }],
  };
}

async function inscribe(provider: OrdMockProvider, satoshi: string, headDigest: string, didCel: string, pubMb?: string) {
  const res = await provider.createInscription({
    data: Buffer.from(JSON.stringify(anchorDoc(satoshi, headDigest, didCel, pubMb))),
    contentType: 'application/did+json',
    targetSatoshi: satoshi,
  });
  return { inscriptionId: res.inscriptionId, txid: res.txid };
}

function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }, satoshi: string): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessedAt = '2026-08-23T00:00:01Z';
  const witnessProof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'bitcoin-ordinals-2024',
    created: witnessedAt,
    verificationMethod: 'did:btco:witness',
    proofPurpose: 'assertionMethod',
    proofValue: `z${insc.inscriptionId}`,
    witnessedAt,
    txid: insc.txid,
    satoshi,
    inscriptionId: insc.inscriptionId,
  } as unknown as DataIntegrityProof;
  return { events: [...log.events.slice(0, -1), { ...last, proof: [...last.proof, witnessProof] }] };
}

// create(a) → migrate(btco) by a, anchored on SAT.
async function makeAnchoredLog(provider: OrdMockProvider, a: Key, nonce = 'sat-gate-1') {
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-08-23T00:00:00Z', nonce },
    { signer: a.signer, verificationMethod: a.vm }
  );
  log = await appendEvent(
    log,
    'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: '2026-08-23T00:00:00Z' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const migrateInsc = await inscribe(provider, SAT, chainDigest(log.events[1]), deriveDidCel(log));
  return { log: attachWitness(log, migrateInsc, SAT), migrateInscriptionId: migrateInsc.inscriptionId };
}

// Sat-gated append: signed by `signer`, authored as `signer`, reinscribed on `sat`.
async function gatedAppend(
  log: EventLog,
  provider: OrdMockProvider,
  signer: Key,
  data?: Record<string, unknown>,
  sat = SAT
) {
  const appended = await appendEvent(
    log,
    'update',
    { author: signer.didKey, statement: 'held', ...(data ?? {}) },
    { signer: signer.signer, verificationMethod: signer.vm }
  );
  const insc = await inscribe(provider, sat, chainDigest(appended.events[appended.events.length - 1]), deriveDidCel(log), signer.pubMb);
  return { log: attachWitness(appended, insc, sat), inscriptionId: insc.inscriptionId };
}

/** Remap (or strip, when unmapped) per-inscription block heights. */
function withHeights(p: OrdMockProvider, heights: Record<string, number>) {
  return {
    getInscriptionById: async (id: string) => {
      const rec = await p.getInscriptionById(id);
      if (!rec) return null;
      if (id in heights) return { ...rec, blockHeight: heights[id] };
      const { blockHeight: _bh, ...rest } = rec as typeof rec & { blockHeight?: number };
      return rest as typeof rec;
    },
    getInscriptionsBySatoshi: (s: string) => p.getInscriptionsBySatoshi(s),
    getAnchoringsForDidCel: (d: string) => p.getAnchoringsForDidCel!(d),
  };
}

describe('sat-gated appends', () => {
  test('HEADLINE: a brand-new key B appends with a valid reinscription on the anchored sat — VERIFIES', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: full } = await gatedAppend(log, provider, b);

    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    expect(result.holders).toEqual([b.didKey]);
  });

  test('no witness proof: fails — the creator cannot write after selling, and neither can anyone else off-chain', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const offChain = await appendEvent(
      log, 'update', { author: b.didKey, statement: 'held' },
      { signer: b.signer, verificationMethod: b.vm }
    );
    const result = await verifyEventLog(offChain, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => new RegExp(`post-anchor events must be inscribed on the anchoring satoshi ${SAT}`).test(e))).toBe(true);
  });

  test('witness proof on a DIFFERENT sat: fails', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const OTHER_SAT = '9999999999';
    const { log: full } = await gatedAppend(log, provider, b, undefined, OTHER_SAT);

    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /post-anchor events must be inscribed on the anchoring satoshi/.test(e))).toBe(true);
  });

  test('witness inscription that PREDATES the current anchor: fails', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log, migrateInscriptionId } = await makeAnchoredLog(provider, a);
    const { log: full, inscriptionId } = await gatedAppend(log, provider, b);

    const misordered = withHeights(provider, { [migrateInscriptionId]: 100, [inscriptionId]: 50 });
    const result = await verifyEventLog(full, { ordinalsProvider: misordered });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /predates anchor inscription/.test(e))).toBe(true);
  });

  test('witness inscription with no confirmed block height: fails closed', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log, migrateInscriptionId } = await makeAnchoredLog(provider, a);
    const { log: full } = await gatedAppend(log, provider, b);

    // Anchor mapped; the append inscription's height is STRIPPED.
    const heightless = withHeights(provider, { [migrateInscriptionId]: 100 });
    const result = await verifyEventLog(full, { ordinalsProvider: heightless });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /block heights unavailable .* ordering is unprovable/.test(e))).toBe(true);
  });

  test('data.author missing: fails', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const appended = await appendEvent(
      log, 'update', { statement: 'held' },
      { signer: b.signer, verificationMethod: b.vm }
    );
    const insc = await inscribe(provider, SAT, chainDigest(appended.events[appended.events.length - 1]), deriveDidCel(log), b.pubMb);
    const result = await verifyEventLog(attachWitness(appended, insc, SAT), { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /post-anchor events must commit the appending key in data\.author/.test(e))).toBe(true);
  });

  test('FORGED AUTHOR: proof key is not data.author\'s key: fails', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const c = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // b signs, but the committed author names c.
    const appended = await appendEvent(
      log, 'update', { author: c.didKey, statement: 'held' },
      { signer: b.signer, verificationMethod: b.vm }
    );
    const insc = await inscribe(provider, SAT, chainDigest(appended.events[appended.events.length - 1]), deriveDidCel(log), b.pubMb);
    const result = await verifyEventLog(attachWitness(appended, insc, SAT), { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not a key of data\.author/.test(e))).toBe(true);
  });

  test('two controller proofs on a post-anchor append: fails', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: full } = await gatedAppend(log, provider, b);
    const last = full.events[full.events.length - 1];
    const controllerProof = last.proof.find(p => (p as { cryptosuite?: string }).cryptosuite === 'eddsa-jcs-2022')!;
    const doubled: EventLog = {
      events: [
        ...full.events.slice(0, -1),
        { ...last, proof: [...last.proof, { ...controllerProof, created: '2026-08-23T00:00:09Z' }] },
      ],
    };
    const result = await verifyEventLog(doubled, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /exactly one controller proof \(found 2\)/.test(e))).toBe(true);
  });

  test('RULING 3: a post-anchor rotateKey, otherwise perfectly formed and reinscribed, FAILS with the key-set message', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // Cooperative: signed by the CURRENT controller, reinscribed. Still rejected.
    const rotated = await appendEvent(
      log, 'rotateKey', { newController: b.didKey, rotatedAt: '2026-08-23T00:00:02Z' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const insc = await inscribe(provider, SAT, chainDigest(rotated.events[rotated.events.length - 1]), deriveDidCel(log), b.pubMb);
    const result = await verifyEventLog(attachWitness(rotated, insc, SAT), { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e =>
      /rotateKey is not permitted after the btco anchor; holding the sat grants the right to append, not control of the key set/.test(e)
    )).toBe(true);
  });

  test('post-anchor deactivate: fails', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const sealed = await appendEvent(
      log, 'deactivate', { deactivatedAt: '2026-08-23T00:00:02Z' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const result = await verifyEventLog(sealed, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /deactivate is not permitted after the btco anchor/.test(e))).toBe(true);
  });

  test('post-anchor v1 transfer (data.newController): fails', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const transferred = await appendEvent(
      log, 'transfer', { newController: b.didKey, transferredAt: '2026-08-23T00:00:02Z' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const result = await verifyEventLog(transferred, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /transfer events cannot assign a controller/.test(e))).toBe(true);
  });

  test('legacy v0 transfer on a pre-anchor log: verifies, no authority effect', async () => {
    const a = await makeKey();
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'v0-transfer' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(
      log, 'transfer', { previousOwner: 'bc1qa', newOwner: 'bc1qb', txid: 'a'.repeat(64), transferredAt: 'x' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    // a still signs afterwards — the transfer changed nothing about authority.
    log = await appendEvent(log, 'update', { note: 'still a' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log);
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('CHAINED HOLDERS: A pre-anchor, migrate, B appends, C appends — verifies, holder chain reads [B, C]', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const c = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: withB } = await gatedAppend(log, provider, b);
    const { log: withC } = await gatedAppend(withB, provider, c);

    const result = await verifyEventLog(withC, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    expect(result.holders).toEqual([b.didKey, c.didKey]);
    expect(result.creatorKeys).toEqual([a.didKey]);
  });

  test('pre-anchor events are untouched: an unauthorized append BEFORE the migrate still fails the old way', async () => {
    const a = await makeKey();
    const b = await makeKey();
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'pre-anchor' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'update', { note: 'not mine' }, { signer: b.signer, verificationMethod: b.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized by the log's create event/.test(e))).toBe(true);
  });

  test('TAMPER: swap a holder append\'s proof for a valid signature by another key over identical data — FAILS on the author check', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const forger = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: full } = await gatedAppend(log, provider, b);

    const last = full.events[full.events.length - 1];
    const witnessProof = last.proof.find(p => (p as { cryptosuite?: string }).cryptosuite === 'bitcoin-ordinals-2024')!;
    const forgedProof = await forger.signer({
      type: last.type,
      data: last.data,
      ...(last.previousEvent ? { previousEvent: last.previousEvent } : {}),
    });
    // Identical data (same chain digest — proofs are excluded from it), so the
    // ORIGINAL reinscription witness still verifies. Only data.author stops it.
    const forged: EventLog = {
      events: [...full.events.slice(0, -1), { ...last, proof: [forgedProof, witnessProof] }],
    };
    const result = await verifyEventLog(forged, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not a key of data\.author/.test(e))).toBe(true);
  });
});
