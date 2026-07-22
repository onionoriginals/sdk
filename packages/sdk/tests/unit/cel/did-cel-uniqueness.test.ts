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

// Controller-sign a btco doc so it counts as an authenticated competitor (#402):
// the proof is over the JCS of the doc WITHOUT its proof — exactly what
// verifyUniqueness re-checks. `signer` must be a key in the log's authorized-key
// history (genesis controller or a rotated-in controller).
async function signBtcoDoc(
  doc: Record<string, unknown>,
  signer: (data: unknown) => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const proof = await signer(doc);
  return { ...doc, proof };
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

// Inscribe a btco doc on `satoshi`. When `signer` is provided the doc is
// controller-signed (authenticated competitor, #402); when omitted the doc is
// a BARE back-link (the front-run attacker shape — must be ignored by uniqueness).
async function inscribeDoc(
  p: OrdMockProvider,
  satoshi: string,
  headDigest: string,
  didCel: string,
  opts?: { publicKeyMultibase?: string; signer?: (data: unknown) => Promise<Record<string, unknown>> }
) {
  let doc: Record<string, unknown> = btcoDoc(satoshi, headDigest, didCel, opts?.publicKeyMultibase);
  if (opts?.signer) doc = await signBtcoDoc(doc, opts.signer);
  const res = await p.createInscription({
    data: Buffer.from(JSON.stringify(doc)),
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
  // Controller-signed (by `a`, the genesis controller) so this anchoring counts
  // as an authenticated competitor when a DIFFERENT branch's log is verified.
  const insc = await inscribeDoc(p, sat, chainDigest(log.events[log.events.length - 1]), didCel, { signer: a.signer });
  log = attachWitness(log, insc, sat);
  return { log, inscriptionId: insc.inscriptionId };
}

// Wrap a provider to stamp per-inscription block heights onto BOTH
// getInscriptionById and getAnchoringsForDidCel. An UNMAPPED inscription has its
// blockHeight STRIPPED (not left at OrdMock's hardcoded 1), matching the sibling
// wrappers in head-freshness/non-cooperative-rotation: an unmapped mock must not
// silently participate in canonical ordering — it fails uniqueness closed.
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
    getAnchoringsForDidCel: async (didCel: string) => {
      const anchorings = await p.getAnchoringsForDidCel!(didCel);
      return anchorings.map((a) => {
        if (a.inscriptionId in heights) return { ...a, blockHeight: heights[a.inscriptionId] };
        const { blockHeight: _bh, ...rest } = a;
        return rest;
      });
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
    const rotInsc = await inscribeDoc(p, X, chainDigest(rotated.events[rotated.events.length - 1]), didCel, { publicKeyMultibase: b.pubMb, signer: b.signer });
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

    const yResult = await verifyEventLog(by.log, { ordinalsProvider: provider });
    expect(yResult.verified).toBe(false);
    expect(hasCode(yResult, 'AMBIGUOUS_CANONICAL')).toBe(true);

    // Symmetric: X-branch also cannot be canonical when tied at the same block.
    const xResult = await verifyEventLog(bx.log, { ordinalsProvider: provider });
    expect(xResult.verified).toBe(false);
    expect(hasCode(xResult, 'AMBIGUOUS_CANONICAL')).toBe(true);
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

  // #402: only CONTROLLER-authenticated competitors count. A non-controller who
  // inscribes a bare {alsoKnownAs:[didCel]} back-link on an earlier sat must NOT
  // be able to deny an honest mint (deny-only front-run). These are the
  // regression tests — they FAIL on origin/main (the honest mint trips
  // NON_CANONICAL_ANCHOR because the unauthenticated rival is counted).
  test('FRONT-RUN (bare back-link): an UNSIGNED earlier anchoring on a rival sat is IGNORED; the honest mint verifies', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-frontrun-bare');
    const S = '900000009'; // honest own sat
    const Z = '100000001'; // attacker's earlier sat

    // Honest controller mints on its own sat S (controller-signed via branch()).
    const honest = await branch(base, a, p, S, didCel);
    // Attacker front-runs: a BARE back-link doc on an EARLIER sat Z, NO controller
    // proof. It back-links the did:cel (so it IS enumerated) but authenticates to
    // nobody, so uniqueness must ignore it.
    const attackInsc = await inscribeDoc(p, Z, 'uATTACKERHEAD', didCel);

    // Attacker's Z anchored FIRST (block 100); honest S later (block 200).
    const provider = withHeights(p, { [honest.inscriptionId]: 200, [attackInsc.inscriptionId]: 100 });
    const result = await verifyEventLog(honest.log, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('FRONT-RUN (unauthorized signature): an earlier anchoring signed by a NON-controller key is IGNORED; the honest mint verifies', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const attacker = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-frontrun-badkey');
    const S = '900000009';
    const Z = '100000001';

    const honest = await branch(base, a, p, S, didCel);
    // The rival doc is signed — but by the ATTACKER's own key, which is not in
    // the log's authorized-key history, so it must not count.
    const attackInsc = await inscribeDoc(p, Z, 'uATTACKERHEAD', didCel, { signer: attacker.signer });

    const provider = withHeights(p, { [honest.inscriptionId]: 200, [attackInsc.inscriptionId]: 100 });
    const result = await verifyEventLog(honest.log, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('LEGIT DUPE PRESERVED: a CONTROLLER-signed earlier anchoring on a different sat STILL trips NON_CANONICAL_ANCHOR', async () => {
    const p = new OrdMockProvider();
    const a = await makeKey();
    const { base, didCel } = await genesis(a, 'uniq-legit-dupe');
    const X = '100000001'; // controller's earlier legit anchoring
    const S = '900000009'; // the branch under verification, later

    const legit = await branch(base, a, p, X, didCel); // controller-signed, earlier
    const mine = await branch(base, a, p, S, didCel); // controller-signed, later
    const provider = withHeights(p, { [legit.inscriptionId]: 100, [mine.inscriptionId]: 200 });

    const result = await verifyEventLog(mine.log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(hasCode(result, 'NON_CANONICAL_ANCHOR')).toBe(true);
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
