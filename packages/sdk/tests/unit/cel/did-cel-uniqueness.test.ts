/**
 * did:cel uniqueness — first-anchor-wins (follow-up to the signed-anchored-sat
 * spec). A btco-anchored did:cel log verifies only when its anchored sat is the
 * canonical one: the sat of the log's earliest on-chain anchoring (lowest
 * confirmed block height, grouped by sat). Non-canonical → NON_CANONICAL_ANCHOR.
 *
 * NOTE: soundness assumes Part A (signed anchored sat) has landed, so the
 * verifier's anchoredSat is the SIGNED sat, not the attacker-editable witness.
 * The mechanism below keys off the existing anchoredSat walk-state, so these
 * fixtures are runnable against the current tree.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../../../src/cel/canonicalize';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { deriveDidCel } from '../../../src/cel/celDid';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import type { EventLog, LogEntry } from '../../../src/cel/types';

async function makeKey() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-07-13T00:00:00Z',
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

// A btco DID document that back-links the did:cel (Task-2 writer shape).
function btcoDoc(satoshi: string, headDigestMultibase: string, didCel: string, publicKeyMultibase?: string) {
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

function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }, satoshi: string): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessedAt = '2026-07-13T00:00:01Z';
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

async function inscribeDoc(p: OrdMockProvider, satoshi: string, headDigest: string, didCel: string, publicKeyMultibase?: string) {
  const res = await p.createInscription({
    data: Buffer.from(JSON.stringify(btcoDoc(satoshi, headDigest, didCel, publicKeyMultibase))),
    contentType: 'application/did+json',
    targetSatoshi: satoshi,
  });
  return { inscriptionId: res.inscriptionId, txid: res.txid };
}

// Genesis by `a`; returns the shared base log and its derived did:cel.
async function genesis(a: Key, nonce: string) {
  const base = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce },
    { signer: a.signer, verificationMethod: a.vm }
  );
  return { base, didCel: deriveDidCel(base) };
}

// A controller-signed migrate-to-btco branch onto `sat`, inscribed + witnessed.
async function branch(base: EventLog, a: Key, p: OrdMockProvider, sat: string, didCel: string) {
  let log = await appendEvent(
    base,
    'migrate',
    { sourceDid: didCel, layer: 'btco', network: 'regtest', to: `did:btco:reg:${sat}`, migratedAt: '2026-07-13T00:00:00Z' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const insc = await inscribeDoc(p, sat, chainDigest(log.events[log.events.length - 1]), didCel);
  log = attachWitness(log, insc, sat);
  return { log, inscriptionId: insc.inscriptionId };
}

// Wrap a provider to stamp per-inscription block heights onto BOTH
// getInscriptionById and getAnchoringsForDidCel (OrdMock hardcodes height 1).
function withHeights(p: OrdMockProvider, heights: Record<string, number>) {
  return {
    getInscriptionById: async (id: string) => {
      const rec = await p.getInscriptionById(id);
      if (!rec) return null;
      return id in heights ? { ...rec, blockHeight: heights[id] } : rec;
    },
    getInscriptionsBySatoshi: (s: string) => p.getInscriptionsBySatoshi(s),
    getAnchoringsForDidCel: async (didCel: string) => {
      const anchorings = await p.getAnchoringsForDidCel!(didCel);
      return anchorings.map((a) => (a.inscriptionId in heights ? { ...a, blockHeight: heights[a.inscriptionId] } : a));
    },
  };
}

const hasCode = (r: { errors: string[] }, code: string) => r.errors.some((e) => e.includes(code));

describe('did:cel uniqueness — first-anchor-wins', () => {
  test('DUPING: two branches of one did:cel on sats X(100) and Y(200); Y-branch → NON_CANONICAL_ANCHOR, X-branch verifies', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-dupe');
    const X = '100000001';
    const Y = '200000002';
    const bx = await branch(base, a, p, X, didCel);
    const by = await branch(base, a, p, Y, didCel);
    const provider = withHeights(p, { [bx.inscriptionId]: 100, [by.inscriptionId]: 200 });

    // Bob holds the Y-branch: X anchored first (block 100) → Y is a dupe.
    const yResult = await verifyEventLog(by.log, { ordinalsProvider: provider });
    expect(yResult.verified).toBe(false);
    expect(hasCode(yResult, 'NON_CANONICAL_ANCHOR')).toBe(true);

    // Alice holds the canonical X-branch → verifies.
    const xResult = await verifyEventLog(bx.log, { ordinalsProvider: provider });
    expect(xResult.errors).toEqual([]);
    expect(xResult.verified).toBe(true);
  });

  test('ROTATION IS NOT A COMPETITOR: migrate + N reinscriptions on the SAME sat X still verify', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-rot');
    const X = '111000111';
    const bx = await branch(base, a, p, X, didCel);

    // A non-cooperative rotation reinscribes the SAME sat X (a second anchoring
    // for the same did:cel on the same sat — must NOT count as a rival sat).
    const rotated = await appendEvent(
      bx.log,
      'rotateKey',
      { newController: b.didKey, rotatedAt: '2026-07-13T00:00:02Z' },
      { signer: b.signer, verificationMethod: b.vm }
    );
    const rotInsc = await inscribeDoc(p, X, chainDigest(rotated.events[rotated.events.length - 1]), didCel, b.pubMb);
    const full = attachWitness(rotated, rotInsc, X);

    // Migrate at block 100, rotation reinscription at block 200 — both on X.
    const provider = withHeights(p, { [bx.inscriptionId]: 100, [rotInsc.inscriptionId]: 200 });
    const result = await verifyEventLog(full, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('SAME-BLOCK AMBIGUITY: X and Y both anchored at block 100 → AMBIGUOUS_CANONICAL', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-tie');
    const X = '100000001';
    const Y = '200000002';
    const bx = await branch(base, a, p, X, didCel);
    const by = await branch(base, a, p, Y, didCel);
    const provider = withHeights(p, { [bx.inscriptionId]: 100, [by.inscriptionId]: 100 });

    const result = await verifyEventLog(by.log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'AMBIGUOUS_CANONICAL')).toBe(true);
  });

  test('PROVIDER POSTURE: btco-anchored log + provider WITHOUT getAnchoringsForDidCel → UNIQUENESS_UNVERIFIABLE', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-noenum');
    const X = '100000001';
    const bx = await branch(base, a, p, X, didCel);

    // Enough to verify the migrate witness (getInscriptionById) but NOT to
    // enumerate anchorings — uniqueness must fail closed.
    const limited = { getInscriptionById: (id: string) => p.getInscriptionById(id) };
    const result = await verifyEventLog(bx.log, { ordinalsProvider: limited });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'UNIQUENESS_UNVERIFIABLE')).toBe(true);
  });

  test('PROVIDER POSTURE: an anchoring missing a blockHeight → UNIQUENESS_UNVERIFIABLE', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-noheight');
    const X = '100000001';
    const bx = await branch(base, a, p, X, didCel);

    // Strip blockHeight from the enumeration only (witness still verifies).
    const provider = {
      getInscriptionById: (id: string) => p.getInscriptionById(id),
      getInscriptionsBySatoshi: (s: string) => p.getInscriptionsBySatoshi(s),
      getAnchoringsForDidCel: async (dc: string) =>
        (await p.getAnchoringsForDidCel!(dc)).map(({ blockHeight: _bh, ...rest }) => rest),
    };
    const result = await verifyEventLog(bx.log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'UNIQUENESS_UNVERIFIABLE')).toBe(true);
  });

  test('EMPTY ENUMERATION: provider HAS getAnchoringsForDidCel but returns [] → UNIQUENESS_UNVERIFIABLE', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-empty');
    const X = '100000001';
    const bx = await branch(base, a, p, X, didCel);

    // Witness still verifies (getInscriptionById/getInscriptionsBySatoshi delegate
    // to the real provider); enumeration returns [] — must fail closed, not treat
    // the anchoring as unopposed/canonical.
    const provider = {
      getInscriptionById: (id: string) => p.getInscriptionById(id),
      getInscriptionsBySatoshi: (s: string) => p.getInscriptionsBySatoshi(s),
      getAnchoringsForDidCel: async (_dc: string) => [],
    };
    const result = await verifyEventLog(bx.log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'UNIQUENESS_UNVERIFIABLE')).toBe(true);
  });

  test('THROWING PROVIDER: getAnchoringsForDidCel throws → UNIQUENESS_UNVERIFIABLE', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-throw');
    const X = '100000001';
    const bx = await branch(base, a, p, X, didCel);

    const provider = {
      getInscriptionById: (id: string) => p.getInscriptionById(id),
      getInscriptionsBySatoshi: (s: string) => p.getInscriptionsBySatoshi(s),
      getAnchoringsForDidCel: async (_dc: string): Promise<never> => {
        throw new Error('index down');
      },
    };
    const result = await verifyEventLog(bx.log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'UNIQUENESS_UNVERIFIABLE')).toBe(true);
  });
});
