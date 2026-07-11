/**
 * Non-cooperative rotation — reinscription-attested authority hand-off (#366).
 *
 * After a sat transfer the NEW owner cannot produce a rotateKey signed by the
 * old controller. verifyEventLog accepts an UNAUTHORIZED rotateKey IFF ALL of:
 *  (a) it carries a bitcoin-ordinals-2024 witness proof on the log's anchored
 *      satoshi (set by the migrate event's verified gating witness proof) and
 *      that proof verifies IN FULL against THIS event's chain digest;
 *  (b) the inscribed DID document announces an Ed25519 key of newController;
 *  (c) the event's own controller-proof key is a key of newController
 *      (signer ≡ announced ≡ inscribed);
 *  (d) the rotation's inscription appears at a STRICTLY LATER index on the sat
 *      than the current anchor inscription.
 * Anything unverifiable fails closed — the event and log fail exactly as an
 * unauthorized event does today.
 *
 * Uses REAL Ed25519 signing (pattern from key-rotation-authority.test.ts) and
 * OrdMockProvider as the shared "chain" (targetSatoshi pins the sat; witness
 * proofs are hand-attached exactly as LifecycleManager.inscribeOnBitcoin does).
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../../../src/cel/canonicalize';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import type { EventLog, LogEntry } from '../../../src/cel/types';

// A real eddsa-jcs-2022 signer exposing its holder did:key + canonical VM + multikey.
async function makeKey() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-07-10T00:00:00Z',
    verificationMethod: vm,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(
      new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
    ),
  });
  return { signer, didKey, vm, pubMb };
}
type Key = Awaited<ReturnType<typeof makeKey>>;

const chainDigest = (event: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(event));

// The inscribed btco DID document: OriginalsCelAnchor commits to the event's
// chain digest; verificationMethod announces the (new) controller key.
function btcoDoc(satoshi: string, headDigestMultibase: string, publicKeyMultibase?: string) {
  const id = `did:btco:reg:${satoshi}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    ...(publicKeyMultibase
      ? { verificationMethod: [{ id: `${id}#key-0`, type: 'Multikey', controller: id, publicKeyMultibase }] }
      : {}),
    service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase } }],
  };
}

// Attach a bitcoin-ordinals-2024 witness proof to the LAST event, exactly as
// LifecycleManager.inscribeOnBitcoin constructs it (post-hoc, chain-safe).
function attachWitness(
  log: EventLog,
  insc: { inscriptionId: string; txid: string },
  satoshi: string
): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessedAt = '2026-07-10T00:00:01Z';
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
  };
  return { events: [...log.events.slice(0, -1), { ...last, proof: [...last.proof, witnessProof] }] };
}

async function inscribeDoc(
  provider: OrdMockProvider,
  satoshi: string,
  headDigest: string,
  publicKeyMultibase?: string
) {
  const res = await provider.createInscription({
    data: Buffer.from(JSON.stringify(btcoDoc(satoshi, headDigest, publicKeyMultibase))),
    contentType: 'application/did+json',
    targetSatoshi: satoshi,
  });
  return { inscriptionId: res.inscriptionId, txid: res.txid };
}

const SAT = '1234567890';

// create(a) → migrate(btco) by a, witnessed by the inscribed DID doc on SAT.
async function makeAnchoredLog(provider: OrdMockProvider, a: Key, sat = SAT) {
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-10T00:00:00Z', nonce: 'nc-1' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  log = await appendEvent(
    log,
    'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', migratedAt: '2026-07-10T00:00:00Z' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const migrateDigest = chainDigest(log.events[log.events.length - 1]);
  const insc = await inscribeDoc(provider, sat, migrateDigest);
  log = attachWitness(log, insc, sat);
  return { log, migrateInscriptionId: insc.inscriptionId };
}

// Append a rotateKey to newController.didKey signed by `signer` (default: the
// new controller), reinscribe the DID doc (announcing `announceMb`, default the
// new controller's key) on `inscribeSat`, and attach a witness claiming `claimSat`.
async function addNonCoopRotation(
  log: EventLog,
  provider: OrdMockProvider,
  newController: Key,
  opts: { signer?: Key; announceMb?: string | null; inscribeSat?: string; claimSat?: string; rotatedAt?: string } = {}
) {
  const signer = opts.signer ?? newController;
  const rotated = await appendEvent(
    log,
    'rotateKey',
    { newController: newController.didKey, rotatedAt: opts.rotatedAt ?? '2026-07-10T00:00:02Z' },
    { signer: signer.signer, verificationMethod: signer.vm }
  );
  const rotDigest = chainDigest(rotated.events[rotated.events.length - 1]);
  const announce = opts.announceMb === null ? undefined : (opts.announceMb ?? newController.pubMb);
  const insc = await inscribeDoc(provider, opts.inscribeSat ?? SAT, rotDigest, announce);
  return { log: attachWitness(rotated, insc, opts.claimSat ?? opts.inscribeSat ?? SAT), inscriptionId: insc.inscriptionId };
}

describe('non-cooperative rotation (reinscription-attested hand-off)', () => {
  test('happy path: new owner reinscribes on the anchored sat and rotates without the old key', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey(); // creator / old owner
    const b = await makeKey(); // buyer / new owner
    const { log } = await makeAnchoredLog(provider, a);
    const { log: rotatedLog, inscriptionId } = await addNonCoopRotation(log, provider, b);

    const result = await verifyEventLog(rotatedLog, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    // The rotation is reported as the non-cooperative acceptance it is.
    const rot = result.events[2];
    expect(rot.type).toBe('rotateKey');
    expect(rot.proofValid).toBe(true);
    expect(rot.nonCooperativeRotation?.inscriptionId).toBe(inscriptionId);
  });

  test('post-acceptance: the OLD key is dead, the NEW key authorizes', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b);

    const staleByOld = await appendEvent(rotatedLog, 'update', { note: 'stale' }, { signer: a.signer, verificationMethod: a.vm });
    const oldResult = await verifyEventLog(staleByOld, { ordinalsProvider: provider });
    expect(oldResult.verified).toBe(false);
    expect(oldResult.errors.some(e => /is not authorized/.test(e))).toBe(true);

    const freshByNew = await appendEvent(rotatedLog, 'update', { note: 'fresh' }, { signer: b.signer, verificationMethod: b.vm });
    const newResult = await verifyEventLog(freshByNew, { ordinalsProvider: provider });
    expect(newResult.errors).toEqual([]);
    expect(newResult.verified).toBe(true);
  });

  test('a SECOND non-cooperative rotation chains off the updated anchoredSat (later reinscription accepted)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const c = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: onceRotated } = await addNonCoopRotation(log, provider, b);
    const { log: twiceRotated } = await addNonCoopRotation(onceRotated, provider, c, { rotatedAt: '2026-07-10T00:00:03Z' });

    const result = await verifyEventLog(twiceRotated, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);

    // And the second hand-off is effective: only c can append now.
    const byC = await appendEvent(twiceRotated, 'update', { note: 'c' }, { signer: c.signer, verificationMethod: c.vm });
    expect((await verifyEventLog(byC, { ordinalsProvider: provider })).verified).toBe(true);
    const byB = await appendEvent(twiceRotated, 'update', { note: 'b' }, { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(byB, { ordinalsProvider: provider })).verified).toBe(false);
  });

  test('(d via updated anchor) a second rotation whose inscription PRECEDES the first rotation\'s is rejected', async () => {
    // On-sat order: I_mig, I_rot2, I_rot1. Rotation 1 (I_rot1, index 2 > 0)
    // is accepted and advances the anchor to I_rot1; rotation 2 rides I_rot2
    // (index 1), which is strictly later than I_mig but EARLIER than the
    // updated anchor — it must fail. This pins the anchoredSat update.
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const c = await makeKey();

    let log = (await makeAnchoredLog(provider, a)).log; // inscribes I_mig (index 0)
    // Build both rotate events (digests need no inscriptions), then inscribe out of order.
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 't1' }, { signer: b.signer, verificationMethod: b.vm });
    const rot1Digest = chainDigest(log.events[log.events.length - 1]);
    let log2 = await appendEvent(log, 'rotateKey', { newController: c.didKey, rotatedAt: 't2' }, { signer: c.signer, verificationMethod: c.vm });
    const rot2Digest = chainDigest(log2.events[log2.events.length - 1]);

    const iRot2 = await inscribeDoc(provider, SAT, rot2Digest, c.pubMb); // index 1
    const iRot1 = await inscribeDoc(provider, SAT, rot1Digest, b.pubMb); // index 2

    // Attach witnesses: rot1 gets iRot1, rot2 gets iRot2.
    const events = log2.events.slice();
    const mkWitness = (insc: { inscriptionId: string; txid: string }) => ({
      type: 'DataIntegrityProof',
      cryptosuite: 'bitcoin-ordinals-2024',
      created: '2026-07-10T00:00:01Z',
      verificationMethod: 'did:btco:witness',
      proofPurpose: 'assertionMethod',
      proofValue: `z${insc.inscriptionId}`,
      witnessedAt: '2026-07-10T00:00:01Z',
      txid: insc.txid,
      satoshi: SAT,
      inscriptionId: insc.inscriptionId,
    });
    events[2] = { ...events[2], proof: [...events[2].proof, mkWitness(iRot1)] };
    events[3] = { ...events[3], proof: [...events[3].proof, mkWitness(iRot2)] };
    const finalLog = { events };

    const result = await verifyEventLog(finalLog, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.events[2].proofValid).toBe(true);  // rotation 1 accepted
    expect(result.events[3].proofValid).toBe(false); // rotation 2 rejected (earlier index than updated anchor)
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('(a) foreign-sat witness: a reinscription on a DIFFERENT sat cannot rotate', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // Internally consistent witness proof (inscription really is on sat 999),
    // but 999 is not the asset's anchored sat.
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b, { inscribeSat: '999', claimSat: '999' });

    const result = await verifyEventLog(rotatedLog, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('(b) inscribed doc does NOT announce a key of newController: rejected', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const stranger = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // Signed by b, newController = b, but the reinscribed doc announces a stranger's key.
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b, { announceMb: stranger.pubMb });

    const result = await verifyEventLog(rotatedLog, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('(b) inscribed doc with NO verificationMethod at all: rejected', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b, { announceMb: null });

    const result = await verifyEventLog(rotatedLog, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('(c) inscribed doc announces X but the event is signed by Y: rejected (wrapped reinscription)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey(); // legitimate reinscriber (announced)
    const y = await makeKey(); // attacker wrapping b's reinscription
    const { log } = await makeAnchoredLog(provider, a);
    // newController = b, doc announces b, but the rotateKey is signed by y.
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b, { signer: y });

    const result = await verifyEventLog(rotatedLog, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('(d) rotation inscription at an EARLIER on-sat index than the anchor: rejected', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();

    // Build events first so digests exist, then inscribe ROTATION doc BEFORE
    // the migrate doc — on-sat order: I_rot (0), I_mig (1).
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'nc-d' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const migrateDigest = chainDigest(log.events[1]);
    let rotated = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: b.signer, verificationMethod: b.vm });
    const rotDigest = chainDigest(rotated.events[2]);

    const iRot = await inscribeDoc(provider, SAT, rotDigest, b.pubMb); // index 0
    const iMig = await inscribeDoc(provider, SAT, migrateDigest);      // index 1

    let events = rotated.events.slice();
    const witness = (insc: { inscriptionId: string; txid: string }) => ({
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
    });
    events[1] = { ...events[1], proof: [...events[1].proof, witness(iMig)] };
    events[2] = { ...events[2], proof: [...events[2].proof, witness(iRot)] };

    const result = await verifyEventLog({ events }, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('no ordinals provider: fails closed (nothing about the rotation is verifiable)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b);

    const result = await verifyEventLog(rotatedLog); // no provider
    expect(result.verified).toBe(false);
    // The unauthorized rotation must still be rejected (anchoredSat never
    // establishes without a verified migrate witness).
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('provider without getInscriptionsBySatoshi: (d) is unverifiable, fails closed', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b);

    // Lookup that can fetch inscriptions (satoshi echoed back → witness proofs
    // verify) but cannot enumerate a sat's inscriptions → ordering unprovable.
    const limited = { getInscriptionById: (id: string) => provider.getInscriptionById(id) };
    const result = await verifyEventLog(rotatedLog, { ordinalsProvider: limited });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('no anchoredSat (log never migrated): unauthorized rotation fails exactly as today', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'nc-na' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    // Even a perfectly witnessed reinscription cannot rotate a log with no
    // bitcoin-anchored authority to hand off.
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b);

    const result = await verifyEventLog(rotatedLog, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('candidacy is rotateKey-ONLY: an unauthorized update with a perfect witness proof still fails', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);

    // b signs an UPDATE (not rotateKey) and reinscribes on the anchored sat.
    const updated = await appendEvent(log, 'update', { note: 'hijack' }, { signer: b.signer, verificationMethod: b.vm });
    const updDigest = chainDigest(updated.events[updated.events.length - 1]);
    const insc = await inscribeDoc(provider, SAT, updDigest, b.pubMb);
    const witnessed = attachWitness(updated, insc, SAT);

    const result = await verifyEventLog(witnessed, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not authorized/.test(e))).toBe(true);
  });

  test('a failed candidacy must not rotate: subsequent events signed by the would-be new key fail too', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // Foreign-sat rotation (fails a) followed by an update signed by b.
    const { log: rotatedLog } = await addNonCoopRotation(log, provider, b, { inscribeSat: '999', claimSat: '999' });
    const followed = await appendEvent(rotatedLog, 'update', { note: 'b rides anyway' }, { signer: b.signer, verificationMethod: b.vm });

    const result = await verifyEventLog(followed, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    // BOTH the rotation and the follow-up must be unauthorized.
    expect(result.events[2].proofValid).toBe(false);
    expect(result.events[3].proofValid).toBe(false);
  });

  test('an INJECTED second witness proof on the migrate poisons the anchor: attacker cannot re-route authority to their own sat', async () => {
    // The proof array is unsigned. An attacker prepends a fully VERIFIED
    // witness proof — an inscription on a sat THEY control, committing to the
    // victim's public migrate digest — hoping first-proof extraction anchors
    // authority to their sat, where they can reinscribe and "rotate".
    // Ambiguity must poison the anchor entirely: the log still verifies, but
    // NO non-cooperative rotation is possible on EITHER sat.
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const attacker = await makeKey();
    const ATTACKER_SAT = '666';
    const { log } = await makeAnchoredLog(provider, a);

    // Attacker inscribes a commitment to the migrate digest on their own sat
    // and PREPENDS the (verifying!) witness proof to the migrate event.
    const migrateDigest = chainDigest(log.events[1]);
    const evil = await inscribeDoc(provider, ATTACKER_SAT, migrateDigest);
    const migrate = log.events[1];
    const evilProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bitcoin-ordinals-2024',
      created: '2026-07-10T00:00:01Z',
      verificationMethod: 'did:btco:witness',
      proofPurpose: 'assertionMethod',
      proofValue: `z${evil.inscriptionId}`,
      witnessedAt: '2026-07-10T00:00:01Z',
      txid: evil.txid,
      satoshi: ATTACKER_SAT,
      inscriptionId: evil.inscriptionId,
    };
    const controllerProof = migrate.proof[0];
    const victimWitness = migrate.proof[1];
    const tampered: EventLog = {
      events: [log.events[0], { ...migrate, proof: [controllerProof, evilProof, victimWitness] }],
    };
    // Sanity: the tampered log itself still verifies (both witness proofs pass).
    expect((await verifyEventLog(tampered, { ordinalsProvider: provider })).verified).toBe(true);

    // Rotation on the ATTACKER's sat must fail...
    const onAttackerSat = await addNonCoopRotation(tampered, provider, attacker, { inscribeSat: ATTACKER_SAT, claimSat: ATTACKER_SAT });
    const attackResult = await verifyEventLog(onAttackerSat.log, { ordinalsProvider: provider });
    expect(attackResult.verified).toBe(false);
    expect(attackResult.errors.some(e => /is not authorized/.test(e))).toBe(true);

    // ...and the ambiguity poisons the TRUE sat too (fail closed, no guessing).
    const onTrueSat = await addNonCoopRotation(tampered, provider, attacker);
    expect((await verifyEventLog(onTrueSat.log, { ordinalsProvider: provider })).verified).toBe(false);
  });

  test('cooperative rotation (old key signs) still works unchanged alongside the new arm', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const rotated = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });

    const result = await verifyEventLog(rotated, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    expect(result.events[2].nonCooperativeRotation).toBeUndefined();
  });
});
