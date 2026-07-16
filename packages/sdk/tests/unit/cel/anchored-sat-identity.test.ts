/**
 * Anchored-sat identity (design 2026-07-13, Part A): the verifier binds btco
 * identity to the SIGNED anchoring sat in the migrate body (data.to), not the
 * unsigned witness. Closes cross-sat fork + witness-stripping.
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
    created: '2026-07-13T00:00:00Z',
    verificationMethod: vm,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))),
  });
  return { signer, didKey, vm, pubMb };
}
type Key = Awaited<ReturnType<typeof makeKey>>;
const chainDigest = (e: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(e));

function btcoDoc(satoshi: string, headDigestMultibase: string, didCel?: string) {
  const id = `did:btco:reg:${satoshi}`;
  return { '@context': ['https://www.w3.org/ns/did/v1'], id, ...(didCel ? { alsoKnownAs: [didCel] } : {}), service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase } }] };
}
function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }, satoshi: string): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessProof = { type: 'DataIntegrityProof', cryptosuite: 'bitcoin-ordinals-2024', created: 'x', verificationMethod: 'did:btco:witness', proofPurpose: 'assertionMethod', proofValue: `z${insc.inscriptionId}`, witnessedAt: 'x', txid: insc.txid, satoshi, inscriptionId: insc.inscriptionId };
  return { events: [...log.events.slice(0, -1), { ...last, proof: [...last.proof, witnessProof] }] };
}
async function inscribeDoc(provider: OrdMockProvider, satoshi: string, headDigest: string, didCel?: string) {
  const res = await provider.createInscription({ data: Buffer.from(JSON.stringify(btcoDoc(satoshi, headDigest, didCel))), contentType: 'application/did+json', targetSatoshi: satoshi });
  return { inscriptionId: res.inscriptionId, txid: res.txid };
}
const SAT = '1234567890';

// create(a) -> signed btco migrate (to = did:btco:reg:SAT) -> witness on SAT.
async function makeAnchoredLog(provider: OrdMockProvider, a: Key, sat = SAT) {
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce: 'ai-1' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  log = await appendEvent(
    log, 'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: `did:btco:reg:${sat}`, migratedAt: '2026-07-13T00:00:00Z' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const insc = await inscribeDoc(provider, sat, chainDigest(log.events[log.events.length - 1]), deriveDidCel(log));
  return { log: attachWitness(log, insc, sat), inscriptionId: insc.inscriptionId };
}

describe('anchored-sat identity — signed-body binding', () => {
  test('honest round-trip: a signed-sat btco migrate verifies with a provider', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    const result = await verifyEventLog(log, { ordinalsProvider: provider });
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('UNBOUND_ANCHOR: a btco migrate with bare to:did:btco (no sat) fails closed', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce: 'ai-2' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    // Old-shape body: no parseable sat in `to`.
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', to: 'did:btco', migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const insc = await inscribeDoc(provider, SAT, chainDigest(log.events[1]));
    log = attachWitness(log, insc, SAT);
    const result = await verifyEventLog(log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /UNBOUND_ANCHOR/.test(e))).toBe(true);
  });

  test('cross-sat fork (repoint witness): witness sat != signed sat -> reject', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a); // signed + witnessed on SAT
    // Attacker inscribes an anchor doc on a sat THEY control, committing to the
    // public migrate digest, and repoints the witness to it.
    const ATT = '9999999999';
    const insc2 = await inscribeDoc(provider, ATT, chainDigest(log.events[1]));
    const forked = attachWitness({ events: [log.events[0], { ...log.events[1], proof: log.events[1].proof.filter((p: any) => p.cryptosuite !== 'bitcoin-ordinals-2024') }] } as EventLog, insc2, ATT);
    const result = await verifyEventLog(forked, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /does not match the signed anchoring sat/.test(e))).toBe(true);
  });

  test('cross-sat fork (rewrite signed to): controller signature no longer verifies', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    const { log } = await makeAnchoredLog(provider, a);
    // Tamper the SIGNED body to the attacker sat without re-signing.
    const tampered = { events: [log.events[0], { ...log.events[1], data: { ...(log.events[1].data as any), to: 'did:btco:reg:9999999999' } }] } as EventLog;
    const result = await verifyEventLog(tampered, { ordinalsProvider: provider });
    expect(result.verified).toBe(false); // migrate controller proof breaks
  });

  test('witness-stripping (witness removed), no provider -> fail closed, NOT never-anchored', async () => {
    const a = await makeKey();
    // Build the signed migrate WITHOUT any witness proof.
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce: 'ai-3' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log, {}); // no provider, no witness
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /no verifiable bitcoin witness proof/.test(e))).toBe(true);
  });

  test('witness-stripping (witness removed), WITH provider -> still fail closed (no on-chain witness to confirm)', async () => {
    const provider = new OrdMockProvider();
    const a = await makeKey();
    let log = await createEventLog(
      { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-07-13T00:00:00Z', nonce: 'ai-4' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'migrate', { sourceDid: 'did:cel:uP', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log, { ordinalsProvider: provider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /no verifiable bitcoin witness proof/.test(e))).toBe(true);
  });
});
