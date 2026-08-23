/**
 * classifyLogEntries is a PURE fold: no provider, no I/O, no signature checks.
 * Its classes are CLAIMS (`verified: false`) — an unverified log can carry a
 * forged data.author, and only verifyEventLog (which checks signatures and the
 * reinscription sat gate) can promote a class to a trust statement. The paired
 * test below is the documentation of that difference; without it, someone will
 * use the pure fold for an access decision.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../../src/canonicalize';
import { computeDigestMultibase } from '../../src/hash';
import { verifyEventLog } from '../../src/algorithms/verifyEventLog';
import { classifyLogEntries } from '../../src/algorithms/classifyEntries';
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

const chainDigest = (e: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(e));
const SAT = '7272727272';

async function anchoredWithHolder() {
  const provider = new OrdMockProvider();
  const a = await makeKey();
  const b = await makeKey();
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'cls-1' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  log = await appendEvent(
    log, 'migrate',
    { sourceDid: 'did:cel:uPlaceholder', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const didCel = deriveDidCel(log);
  const inscribe = async (digest: string, pubMb?: string) => {
    const id = `did:btco:reg:${SAT}`;
    const res = await provider.createInscription({
      data: Buffer.from(JSON.stringify({
        '@context': ['https://www.w3.org/ns/did/v1'], id, alsoKnownAs: [didCel],
        ...(pubMb ? { verificationMethod: [{ id: `${id}#key-0`, type: 'Multikey', controller: id, publicKeyMultibase: pubMb }] } : {}),
        service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase: digest } }],
      })),
      contentType: 'application/did+json',
      targetSatoshi: SAT,
    });
    return res;
  };
  const attach = (l: EventLog, insc: { inscriptionId: string; txid: string }): EventLog => {
    const last = l.events[l.events.length - 1];
    return {
      events: [...l.events.slice(0, -1), {
        ...last,
        proof: [...last.proof, {
          type: 'DataIntegrityProof', cryptosuite: 'bitcoin-ordinals-2024', created: 'x',
          verificationMethod: 'did:btco:witness', proofPurpose: 'assertionMethod',
          proofValue: `z${insc.inscriptionId}`, witnessedAt: 'x', txid: insc.txid,
          satoshi: SAT, inscriptionId: insc.inscriptionId,
        } as unknown as DataIntegrityProof],
      }],
    };
  };
  log = attach(log, await inscribe(chainDigest(log.events[1])));
  // Sat-gated holder append by b.
  let full = await appendEvent(
    log, 'update', { author: b.didKey, statement: 'held' },
    { signer: b.signer, verificationMethod: b.vm }
  );
  full = attach(full, await inscribe(chainDigest(full.events[2]), b.pubMb));
  return { provider, a, b, log: full };
}

describe('classifyLogEntries (pure fold)', () => {
  test('classifies a verified-shaped log identically to verifyEventLog for the happy path', async () => {
    const { provider, log } = await anchoredWithHolder();
    const verified = await verifyEventLog(log, { ordinalsProvider: provider });
    expect(verified.verified).toBe(true);

    const classified = classifyLogEntries(log);
    expect(classified.map(c => c.authorClass)).toEqual(verified.events.map(e => e.authorClass!));
    expect(classified.every(c => c.verified === false)).toBe(true);
    expect(classified.map(c => c.index)).toEqual([0, 1, 2]);
  });

  test('a forged data.author (no valid reinscription) classifies `holder` UNVERIFIED, while verifyEventLog fails the event', async () => {
    const { provider, a, log } = await anchoredWithHolder();
    const liar = await makeKey();
    // An off-chain append whose data.author is a lie: no reinscription backs it.
    const forged = await appendEvent(
      log, 'update', { author: liar.didKey, statement: 'never held it' },
      { signer: liar.signer, verificationMethod: liar.vm }
    );

    const classified = classifyLogEntries(forged);
    const lastClass = classified[classified.length - 1];
    expect(lastClass.authorClass).toBe('holder'); // a CLAIM…
    expect(lastClass.verified).toBe(false);       // …and marked exactly that.
    expect(lastClass.authorKey).toBe(liar.didKey);

    const verified = await verifyEventLog(forged, { ordinalsProvider: provider });
    expect(verified.verified).toBe(false);        // the verifier is the authority
    expect(verified.errors.some(e => /post-anchor events must be inscribed on the anchoring satoshi/.test(e))).toBe(true);
    // The genesis controller's lineage is untouched by the lie.
    expect(verified.creatorKeys).toEqual([a.didKey]);
  });

  test('LEGACY genesis (no controller): lineage falls back to the create proof VM, so the creator\'s post-anchor entry classifies as creator', async () => {
    // A controller-only lineage read is empty on a legacy-shape genesis, and
    // an empty lineage labeled EVERY entry unattributed/holder — including the
    // creator's own post-anchor writes, disagreeing with the verifier.
    const a = await makeKey();
    const legacyCreate: LogEntry = {
      type: 'create',
      data: { name: 'Asset', did: 'did:webvh:legacy.example:abc', layer: 'peer', resources: [], creator: 'did:webvh:legacy.example:abc', createdAt: 'x' },
      proof: [await a.signer({ probe: true })],
    } as LogEntry;
    const log: EventLog = { events: [legacyCreate] };
    const withMigrate: EventLog = await appendEvent(
      log, 'migrate',
      { sourceDid: 'did:webvh:legacy.example:abc', layer: 'btco', network: 'regtest', to: `did:btco:reg:${SAT}`, migratedAt: 'x' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const full: EventLog = await appendEvent(
      withMigrate, 'update',
      { author: a.didKey, name: 'Renamed' },
      { signer: a.signer, verificationMethod: a.vm }
    );

    const classified = classifyLogEntries(full);
    expect(classified[0].authorClass).toBe('creator');
    expect(classified[2].authorClass).toBe('creator');
    expect(classified[2].authorKey).toBe(a.didKey);
  });
});
