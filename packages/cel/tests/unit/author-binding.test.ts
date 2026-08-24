/**
 * Author binding: `data.author` commits the signer's identity INSIDE the
 * signed data (and therefore inside the chain digest, which excludes proofs).
 * Whenever an event declares an author, the verifier requires exactly one
 * controller proof, a self-certifying author DID, and that the proof's key IS
 * a key of the author. Presence is not yet required — the sat-gated authority
 * model requires it on post-anchor events.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../src/canonicalize';
import { verifyEventLog } from '../../src/algorithms/verifyEventLog';
import { createEventLog } from '../../src/algorithms/createEventLog';
import { appendEvent } from '../../src/algorithms/appendEvent';
import type { DataIntegrityProof, EventLog } from '../../src/types';

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

async function baseLog(a: Key): Promise<EventLog> {
  return createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-08-23T00:00:00Z', nonce: 'author-1' },
    { signer: a.signer, verificationMethod: a.vm }
  );
}

describe('data.author binding', () => {
  test('an update whose author IS the signer verifies', async () => {
    const a = await makeKey();
    const log = await appendEvent(
      await baseLog(a),
      'update',
      { note: 'hello', author: a.didKey },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const result = await verifyEventLog(log);
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('an update whose author names a DIFFERENT key fails the binding', async () => {
    const a = await makeKey();
    const other = await makeKey();
    const log = await appendEvent(
      await baseLog(a),
      'update',
      { note: 'hello', author: other.didKey },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /is not a key of data\.author/.test(e))).toBe(true);
  });

  test('a non-self-certifying author DID fails', async () => {
    const a = await makeKey();
    const log = await appendEvent(
      await baseLog(a),
      'update',
      { note: 'hello', author: 'did:webvh:abc123:example.com' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /not a self-certifying DID/.test(e))).toBe(true);
  });

  test('an authored event with two controller proofs fails', async () => {
    const a = await makeKey();
    const log = await appendEvent(
      await baseLog(a),
      'update',
      { note: 'hello', author: a.didKey },
      { signer: a.signer, verificationMethod: a.vm }
    );
    // A second controller proof by the SAME (authorized) key: passes the
    // key-set check, so the failure must come from the authored-event
    // one-proof rule.
    const last = log.events[log.events.length - 1];
    const doubled: EventLog = {
      events: [
        ...log.events.slice(0, -1),
        { ...last, proof: [...last.proof, { ...last.proof[0], created: '2026-08-23T00:00:09Z' }] },
      ],
    };
    const result = await verifyEventLog(doubled);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /exactly one controller proof \(found 2\)/.test(e))).toBe(true);
  });

  test('an event WITHOUT data.author is unchanged (presence not yet required)', async () => {
    const a = await makeKey();
    const log = await appendEvent(
      await baseLog(a),
      'update',
      { note: 'no author here' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const result = await verifyEventLog(log);
    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('tamper: re-signing identical authored data under another key cannot keep the original author', async () => {
    // The forged-author scenario data.author exists to close: strip the
    // holder's proof and re-sign the IDENTICAL data (same chain digest —
    // proofs are excluded from it) with a different key. The author field
    // rides inside the signed data, so the forged entry either keeps the
    // original author (binding check fails — asserted here) or changes it
    // (chain digest changes, breaking every later previousEvent link).
    const a = await makeKey();
    const forger = await makeKey();
    const log = await appendEvent(
      await baseLog(a),
      'update',
      { note: 'hello', author: a.didKey },
      { signer: a.signer, verificationMethod: a.vm }
    );
    const last = log.events[log.events.length - 1];
    const forgedProof = await forger.signer({
      type: last.type,
      data: last.data,
      ...(last.previousEvent ? { previousEvent: last.previousEvent } : {}),
    });
    const forged: EventLog = {
      events: [...log.events.slice(0, -1), { ...last, proof: [forgedProof] }],
    };
    const result = await verifyEventLog(forged);
    expect(result.verified).toBe(false);
    // Both the key-lineage check (still active pre-sat-gating) and the author
    // binding reject this; the author binding is what survives once the
    // sat-gated model replaces the key-set check post-anchor.
  });
});
