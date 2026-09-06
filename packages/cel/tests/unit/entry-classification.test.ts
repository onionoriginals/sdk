/**
 * Creator entries vs holder entries (item 5): class is derived from the KEY,
 * not the authority path. Creator entries are the authenticity claim; holder
 * entries are chain of custody, carrying an ALLOWLISTED shape only — a holder
 * can add to the story and can never make a claim about what the work IS.
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
const SAT = '6161616161';

async function inscribe(provider: OrdMockProvider, headDigest: string, didCel: string, pubMb?: string) {
  const id = `did:btco:reg:${SAT}`;
  const doc = {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    alsoKnownAs: [didCel],
    ...(pubMb ? { verificationMethod: [{ id: `${id}#key-0`, type: 'Multikey', controller: id, publicKeyMultibase: pubMb }] } : {}),
    service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase: headDigest } }],
  };
  const res = await provider.createInscription({
    data: Buffer.from(JSON.stringify(doc)),
    contentType: 'application/did+json',
    targetSatoshi: SAT,
  });
  return { inscriptionId: res.inscriptionId, txid: res.txid };
}

function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessProof = {
    type: 'DataIntegrityProof',
    cryptosuite: 'bitcoin-ordinals-2024',
    created: '2026-08-23T00:00:01Z',
    verificationMethod: 'did:btco:witness',
    proofPurpose: 'assertionMethod',
    proofValue: `z${insc.inscriptionId}`,
    witnessedAt: '2026-08-23T00:00:01Z',
    txid: insc.txid,
    satoshi: SAT,
    inscriptionId: insc.inscriptionId,
  } as unknown as DataIntegrityProof;
  return { events: [...log.events.slice(0, -1), { ...last, proof: [...last.proof, witnessProof] }] };
}

async function makeAnchoredLog(provider: OrdMockProvider, a: Key, nonce = 'class-1') {
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: 'x', nonce },
    { signer: a.signer, verificationMethod: a.vm }
  );
  log = await appendEvent(
    log,
    'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const insc = await inscribe(provider, chainDigest(log.events[1]), deriveDidCel(log));
  return attachWitness(log, insc);
}

// Sat-gated append signed and authored by `signer` with extra data fields.
async function gatedAppend(log: EventLog, provider: OrdMockProvider, signer: Key, data: Record<string, unknown>) {
  const appended = await appendEvent(
    log, 'update', { author: signer.didKey, ...data },
    { signer: signer.signer, verificationMethod: signer.vm }
  );
  const insc = await inscribe(provider, chainDigest(appended.events[appended.events.length - 1]), deriveDidCel(log), signer.pubMb);
  return attachWitness(appended, insc);
}

const classes = (r: { events: Array<{ authorClass?: string }> }) => r.events.map(e => e.authorClass);

describe('entry classification (creator vs holder)', () => {
  test('pre-anchor log — genesis plus two creator updates: all creator, holders empty', async () => {
    const a = await makeKey();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'pre-1' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'update', { note: '1' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update', { note: '2' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
    expect(classes(result)).toEqual(['creator', 'creator', 'creator']);
    expect(result.holders).toEqual([]);
    expect(result.creatorKeys).toEqual([a.didKey]);
  });

  test('pre-anchor rotateKey then an update signed by the rotated key: creator (lineage, not just genesis)', async () => {
    const a = await makeKey();
    const a2 = await makeKey();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'pre-rot' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'rotateKey', { newController: a2.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update', { note: 'by rotated key' }, { signer: a2.signer, verificationMethod: a2.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
    expect(classes(result)).toEqual(['creator', 'creator', 'creator']);
    expect(result.creatorKeys).toEqual([a.didKey, a2.didKey]);
  });

  test('post-anchor append by buyer key B: holder, and holders is [B]', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const full = await gatedAppend(log, provider, b, { statement: 'held' });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.verified).toBe(true);
    expect(classes(result)).toEqual(['creator', 'creator', 'holder']);
    expect(result.holders).toEqual([b.didKey]);
  });

  test('CONSEQUENCE 2: post-anchor append by the CREATOR while they still hold the sat: creator, holders stays empty', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    // Creator entries keep the FULL shape — `name` is an authenticity claim.
    const full = await gatedAppend(log, provider, a, { name: 'Renamed by its creator', updatedAt: 'x' });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    expect(classes(result)).toEqual(['creator', 'creator', 'creator']);
    expect(result.holders).toEqual([]);
  });

  test('A, migrate, B appends, C appends, A appends after buying back: creator/creator/holder/holder/creator; holders [B, C]', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const c = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const withB = await gatedAppend(log, provider, b, { statement: 'B held it' });
    const withC = await gatedAppend(withB, provider, c, { statement: 'C held it' });
    const backToA = await gatedAppend(withC, provider, a, { name: 'Creator again', updatedAt: 'x' });
    const result = await verifyEventLog(backToA, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    expect(classes(result)).toEqual(['creator', 'creator', 'holder', 'holder', 'creator']);
    expect(result.holders).toEqual([b.didKey, c.didKey]);
  });

  test('holder entry setting `name`: FAILS with the holder-field error, log unverified', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const full = await gatedAppend(log, provider, b, { name: 'Untitled (attributed to someone else)' });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e =>
      /a holder entry may not set `name`; only a key in the creator's lineage can make authenticity claims about the work/.test(e)
    )).toBe(true);
  });

  test('holder entry setting `resources`: FAILS', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const full = await gatedAppend(log, provider, b, { resources: [{ id: 'x', digestMultibase: 'uEiA' }] });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /a holder entry may not set `resources`/.test(e))).toBe(true);
  });

  test('holder entry setting resourceId/previousVersionHash/toHash: FAILS — a holder cannot publish a new version of the work\'s bytes', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const full = await gatedAppend(log, provider, b, {
      resourceId: 'art', previousVersionHash: 'aa'.repeat(32), toHash: 'bb'.repeat(32)
    });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /a holder entry may not set `previousVersionHash`/.test(e))).toBe(true);
    expect(result.errors.some(e => /a holder entry may not set `resourceId`/.test(e))).toBe(true);
    expect(result.errors.some(e => /a holder entry may not set `toHash`/.test(e))).toBe(true);
  });

  test('holder entry with only author + statement + occurredAt: verifies, classifies holder', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const full = await gatedAppend(log, provider, b, { statement: 'in my collection', occurredAt: '2026-08-23T00:00:02Z' });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    expect(result.events[2].authorClass).toBe('holder');
  });

  test('holder entry with an unknown key `foo`: FAILS, and the error names foo', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const full = await gatedAppend(log, provider, b, { foo: 'bar' });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /a holder entry may not set `foo`/.test(e))).toBe(true);
  });

  test('post-anchor migrate: FAILS', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const migrated = await appendEvent(
      log, 'migrate', { sourceDid: 'x', layer: 'webvh', targetDid: 'did:webvh:x', migratedAt: 'x' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const result = await verifyEventLog(migrated, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /migrate is not permitted after the btco anchor/.test(e))).toBe(true);
  });

  test('custom-verifier path: every authorClass absent, creatorKeys/holders absent', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const log = await makeAnchoredLog(provider, a);
    const full = await gatedAppend(log, provider, b, { statement: 'held' });
    const result = await verifyEventLog(full, { verifier: async () => true });
    for (const ev of result.events) {
      expect(ev.authorClass).toBeUndefined();
      expect(ev.authorKey).toBeUndefined();
    }
    expect(result.creatorKeys).toBeUndefined();
    expect(result.holders).toBeUndefined();
  });

  test('unresolvable controller key: event fails AND classifies unattributed, never creator', async () => {
    const a = await makeKey();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'unres' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'update', { note: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    // Rewrite the update's proof VM to a resolver-backed method with no resolver.
    const last = log.events[1];
    const brokenProof = { ...last.proof[0], verificationMethod: 'did:webvh:host:abc#key-1' };
    const broken: EventLog = { events: [log.events[0], { ...last, proof: [brokenProof] }] };
    const result = await verifyEventLog(broken);
    expect(result.verified).toBe(false);
    expect(result.events[1].authorClass).toBe('unattributed');
  });
});
