/**
 * Head-freshness check — truncated-log detection (#366).
 *
 * `VerifyOptions.checkHeadFreshness` (default FALSE — pure-algorithm semantics
 * preserved) is the buyer's defense against being handed a pre-transfer /
 * pre-rotation prefix that verifies on its own. When set AND the walk anchored
 * the log to a satoshi, the NEWEST OriginalsCelAnchor DID document on that sat
 * must commit (via headDigestMultibase) to the chain digest of SOME event
 * PRESENT in the presented log; otherwise the log is STALE_LOG.
 *
 * Reuses the OrdMock-as-chain fixtures from non-cooperative-rotation.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../../../src/cel/canonicalize';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { deriveDidCel } from '../../../src/cel/celDid';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
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

function btcoDoc(satoshi: string, headDigestMultibase: string, publicKeyMultibase?: string, didCel?: string) {
  const id = `did:btco:reg:${satoshi}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    ...(didCel ? { alsoKnownAs: [didCel] } : {}),
    ...(publicKeyMultibase
      ? { verificationMethod: [{ id: `${id}#key-0`, type: 'Multikey', controller: id, publicKeyMultibase }] }
      : {}),
    service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase } }],
  };
}

function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }, satoshi: string): EventLog {
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

async function inscribeDoc(provider: OrdMockProvider, satoshi: string, headDigest: string, publicKeyMultibase?: string, didCel?: string) {
  const res = await provider.createInscription({
    data: Buffer.from(JSON.stringify(btcoDoc(satoshi, headDigest, publicKeyMultibase, didCel))),
    contentType: 'application/did+json',
    targetSatoshi: satoshi,
  });
  return { inscriptionId: res.inscriptionId, txid: res.txid };
}

const SAT = '1234567890';

// create(a) → migrate(btco) by a, witnessed by the inscribed anchor doc on SAT.
async function makeAnchoredLog(provider: OrdMockProvider, a: Key, sat = SAT) {
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-10T00:00:00Z', nonce: 'hf-1' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  log = await appendEvent(
    log,
    'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: `did:btco:reg:${sat}`, migratedAt: '2026-07-10T00:00:00Z' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const migrateDigest = chainDigest(log.events[log.events.length - 1]);
  const insc = await inscribeDoc(provider, sat, migrateDigest, undefined, deriveDidCel(log));
  log = attachWitness(log, insc, sat);
  return { log, migrateInscriptionId: insc.inscriptionId, migrateDigest };
}

// Append a non-cooperative rotateKey and reinscribe the rotated anchor doc on SAT.
async function addNonCoopRotation(log: EventLog, provider: OrdMockProvider, newController: Key) {
  const rotated = await appendEvent(
    log,
    'rotateKey',
    { newController: newController.didKey, rotatedAt: '2026-07-10T00:00:02Z' },
    { signer: newController.signer, verificationMethod: newController.vm }
  );
  const rotDigest = chainDigest(rotated.events[rotated.events.length - 1]);
  const insc = await inscribeDoc(provider, SAT, rotDigest, newController.pubMb, deriveDidCel(log));
  return { log: attachWitness(rotated, insc, SAT), inscriptionId: insc.inscriptionId, rotDigest };
}

const STALE = (r: { errors: string[] }) => r.errors.some(e => /STALE_LOG/.test(e));

describe('checkHeadFreshness — truncated-log detection', () => {
  test('honest anchored log: newest on-sat anchor commits to an in-log event → passes', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);

    const result = await verifyEventLog(log, { ordinalsProvider: provider, checkHeadFreshness: true });
    expect(result.verified).toBe(true);
    expect(STALE(result)).toBe(false);
  });

  test('TRUNCATION: a valid pre-rotation prefix fails STALE_LOG once the rotation is re-inscribed', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log: prefix } = await makeAnchoredLog(provider, a);
    // The buyer (b) reinscribes + rotates: the sat's newest anchor now commits
    // to the rotation. `prefix` (create, migrate) is a VALID prefix of the full
    // log — it omits the rotation event.
    await addNonCoopRotation(prefix, provider, b);

    // Without the flag the truncated prefix still verifies (pure-algorithm).
    const lenient = await verifyEventLog(prefix, { ordinalsProvider: provider });
    expect(lenient.verified).toBe(true);

    // With the flag it is caught: newest anchor commits to the sliced-off rotation.
    const strict = await verifyEventLog(prefix, { ordinalsProvider: provider, checkHeadFreshness: true });
    expect(strict.verified).toBe(false);
    expect(STALE(strict)).toBe(true);
  });

  test('the honest FULL log (rotation included) passes with the flag', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log: prefix } = await makeAnchoredLog(provider, a);
    const { log: full } = await addNonCoopRotation(prefix, provider, b);

    const result = await verifyEventLog(full, { ordinalsProvider: provider, checkHeadFreshness: true });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('MID-LOG match: a later local append not yet re-inscribed still passes (present-in-log, not is-the-head)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log: prefix } = await makeAnchoredLog(provider, a);
    const { log: full } = await addNonCoopRotation(prefix, provider, b);
    // b appends an update locally that has NOT been re-inscribed on the sat.
    const withLocalAppend = await appendEvent(full, 'update', { note: 'local' }, { signer: b.signer, verificationMethod: b.vm });

    const result = await verifyEventLog(withLocalAppend, { ordinalsProvider: provider, checkHeadFreshness: true });
    // Newest on-sat anchor = the rotation (a MID-log event now), which IS present.
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('FOREIGN anchor: newest on-sat anchor commits to a digest absent from the log → STALE_LOG', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // A newer anchor doc lands on the sat committing to a digest no event backs.
    const foreignDigest = computeDigestMultibase(new TextEncoder().encode('a-foreign-log-head'));
    await inscribeDoc(provider, SAT, foreignDigest);

    const result = await verifyEventLog(log, { ordinalsProvider: provider, checkHeadFreshness: true });
    expect(result.verified).toBe(false);
    expect(STALE(result)).toBe(true);
  });

  test('fail-closed: flag set but provider cannot enumerate the sat → STALE_LOG', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // Can fetch by id (so the migrate witness verifies and anchoredSat is set)
    // but cannot enumerate the sat — freshness is uncheckable → fail closed.
    const limited = { getInscriptionById: (id: string) => provider.getInscriptionById(id) };

    const result = await verifyEventLog(log, { ordinalsProvider: limited, checkHeadFreshness: true });
    expect(result.verified).toBe(false);
    expect(STALE(result)).toBe(true);
  });

  test('custom verifier + checkHeadFreshness → incompatible, fails closed (not a silent pass)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);

    const result = await verifyEventLog(log, {
      verifier: async () => true,
      ordinalsProvider: provider,
      checkHeadFreshness: true,
    });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /incompatible with a custom verifier/i.test(e))).toBe(true);
  });

  test('a migrate with a second witness on a NON-signed sat fails closed (witness must match the signed anchoring sat)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log: prefix, migrateDigest } = await makeAnchoredLog(provider, a);
    // Attacker adds a SECOND verified witness on a sat they control, committing
    // to the public migrate digest. Under the signed-anchor rule this witness
    // disagrees with the signed data.to (SAT) and rejects the migrate.
    const SAT2 = '9999999999';
    const insc2 = await inscribeDoc(provider, SAT2, migrateDigest);
    const twoWitness = attachWitness(prefix, insc2, SAT2);
    const result = await verifyEventLog(twoWitness, { ordinalsProvider: provider, checkHeadFreshness: true });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /does not match the signed anchoring sat/.test(e))).toBe(true);
  });

  // Ordering hardening (#395 sibling of Fix 1): the "newest anchor" must be
  // chosen by per-inscription block height, NOT list-tail position. A provider
  // returning inscriptions newest-first would otherwise make the tail-walk pick
  // the OLDEST anchor (present even in a truncated prefix) → STALE_LOG never
  // fires → fail-open.
  describe('newest-anchor selection is by block height, not list position', () => {
    // Wraps a provider: overrides each inscription's blockHeight (strips it when
    // unmapped) and reverses the sat list (contract-violating newest-first).
    function newestFirstWithHeights(provider: OrdMockProvider, heights: Record<string, number>) {
      return {
        async getInscriptionById(id: string) {
          const rec = await provider.getInscriptionById(id);
          if (!rec) return null;
          if (id in heights) return { ...rec, blockHeight: heights[id] };
          const { blockHeight: _bh, ...rest } = rec as Record<string, unknown> & { blockHeight?: number };
          return rest as typeof rec;
        },
        async getInscriptionsBySatoshi(satoshi: string) {
          const list = await provider.getInscriptionsBySatoshi(satoshi);
          return [...list].reverse();
        },
        // Delegate uniqueness enumeration, remapping blockHeight through `heights`
        // (unmapped → stripped) exactly as getInscriptionById does.
        async getAnchoringsForDidCel(didCel: string) {
          const list = await provider.getAnchoringsForDidCel!(didCel);
          return list.map((a) => {
            if (a.inscriptionId in heights) return { ...a, blockHeight: heights[a.inscriptionId] };
            const { blockHeight: _bh, ...rest } = a;
            return rest;
          });
        },
      };
    }

    test('newest-first provider + truncated log whose omitted head is the highest-block anchor → STALE_LOG (no fail-open)', async () => {
      const provider = new OrdMockProvider();
      const a = await makeKey();
      const b = await makeKey();
      const { log: prefix, migrateInscriptionId } = await makeAnchoredLog(provider, a); // I_mig
      const { inscriptionId: rotInscriptionId } = await addNonCoopRotation(prefix, provider, b); // I_rot, omitted from prefix

      // I_rot genuinely postdates I_mig (block 200 vs 100). Newest-first list is
      // [I_rot, I_mig]: a list-tail walk would pick I_mig (present in prefix) and
      // fail open. Height-based selection picks I_rot → its digest is absent → STALE.
      const misordered = newestFirstWithHeights(provider, {
        [migrateInscriptionId]: 100,
        [rotInscriptionId]: 200,
      });
      const result = await verifyEventLog(prefix, { ordinalsProvider: misordered, checkHeadFreshness: true });
      expect(result.verified).toBe(false);
      expect(STALE(result)).toBe(true);
    });

    test('newest-first provider + honest FULL log still verifies (height selection is order-independent)', async () => {
      const provider = new OrdMockProvider();
      const a = await makeKey();
      const b = await makeKey();
      const { log: prefix, migrateInscriptionId } = await makeAnchoredLog(provider, a);
      const { log: full, inscriptionId: rotInscriptionId } = await addNonCoopRotation(prefix, provider, b);

      const misordered = newestFirstWithHeights(provider, {
        [migrateInscriptionId]: 100,
        [rotInscriptionId]: 200,
      });
      const result = await verifyEventLog(full, { ordinalsProvider: misordered, checkHeadFreshness: true });
      expect(result.errors).toEqual([]);
      expect(result.verified).toBe(true);
    });
  });

  test('no anchoredSat (never btco-anchored): the flag is a no-op', async () => {
    const a = await makeKey();
    const log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'hf-noop' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const result = await verifyEventLog(log, { checkHeadFreshness: true });
    expect(result.verified).toBe(true);
    expect(STALE(result)).toBe(false);
  });

  test('default (flag omitted): a truncated prefix still verifies — zero behavior change for existing callers', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const b = await makeKey();
    const { log: prefix } = await makeAnchoredLog(provider, a);
    await addNonCoopRotation(prefix, provider, b);

    const result = await verifyEventLog(prefix, { ordinalsProvider: provider });
    expect(result.verified).toBe(true);
    expect(STALE(result)).toBe(false);
  });
});
