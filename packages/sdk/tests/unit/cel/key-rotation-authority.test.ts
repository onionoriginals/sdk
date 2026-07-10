/**
 * rotateKey authority evolution in verifyEventLog.
 *
 * A fully valid rotateKey event REPLACES the authorized key set with the new
 * controller's keys (hand-off semantics — design spec §2/§5; replace, not
 * union: keeping old keys would reopen the stale-key window). A rotation that
 * fails ANY check must not rotate; an unbindable newController fails the event
 * AND the log.
 *
 * Uses REAL Ed25519 signing (the eddsa-jcs-2022 signer pattern from
 * did-cel-verification.test.ts / event-log-authorization.test.ts).
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';

// A real eddsa-jcs-2022 signer exposing its holder did:key + canonical VM.
async function makeRealSigner() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2020-01-01T00:00:00Z',
    verificationMethod: vm,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(
      new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
    ),
  });
  return { signer, didKey, vm };
}

describe('rotateKey authority evolution', () => {
  test('post-rotation events signed by the NEW key verify; log reports verified', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u1' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update', { note: 'signed by new key' }, { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('OLD key signing AFTER rotation fails (replace, not union)', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u2' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update', { note: 'stale key' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.events[2].proofValid === false || result.errors.length > 0).toBe(true);
  });

  test('rotation signed by an UNAUTHORIZED key fails — and does NOT rotate', async () => {
    const a = await makeRealSigner(); const mallory = await makeRealSigner();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u3' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'rotateKey', { newController: mallory.didKey, rotatedAt: 'x' }, { signer: mallory.signer, verificationMethod: mallory.vm });
    expect((await verifyEventLog(log)).verified).toBe(false);

    // The failed rotation must not have swapped the set: mallory's would-be
    // "new" key stays unauthorized for subsequent events...
    const escalated = await appendEvent(log, 'update', { note: 'mallory escalates' }, { signer: mallory.signer, verificationMethod: mallory.vm });
    const escalatedResult = await verifyEventLog(escalated);
    expect(escalatedResult.verified).toBe(false);
    expect(escalatedResult.events[2].proofValid).toBe(false);

    // ...while the REAL controller remains authorized (its event verifies,
    // even though the log as a whole stays failed because of event 1).
    const recovered = await appendEvent(log, 'update', { note: 'a still controls' }, { signer: a.signer, verificationMethod: a.vm });
    const recoveredResult = await verifyEventLog(recovered);
    expect(recoveredResult.verified).toBe(false); // event 1 still poisons the log
    expect(recoveredResult.events[2].proofValid).toBe(true); // but a's key never rotated out
  });

  test('unbindable newController fails closed (event AND log)', async () => {
    const a = await makeRealSigner();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u4' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'rotateKey', { newController: 'did:webvh:unresolvable:example.com:x', rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.events[1].proofValid).toBe(false);
    expect(result.errors.some(e => /newController/.test(e))).toBe(true);
  });

  test('missing/non-string newController fails closed', async () => {
    const a = await makeRealSigner();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u4b' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'rotateKey', { rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /newController/.test(e))).toBe(true);
  });

  test('second rotation chains authority a→b→c; a and b both dead afterwards', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner(); const c = await makeRealSigner();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u5' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'rotateKey', { newController: c.didKey, rotatedAt: 'x' }, { signer: b.signer, verificationMethod: b.vm });
    log = await appendEvent(log, 'update', { note: 'c signs' }, { signer: c.signer, verificationMethod: c.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);

    const staleB = await appendEvent(log, 'update', { note: 'b tries again' }, { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(staleB)).verified).toBe(false);
    const staleA = await appendEvent(log, 'update', { note: 'a tries again' }, { signer: a.signer, verificationMethod: a.vm });
    expect((await verifyEventLog(staleA)).verified).toBe(false);
  });

  test('deactivate still seals the log regardless of rotation', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u6' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'deactivate', { deactivatedAt: 'x' }, { signer: b.signer, verificationMethod: b.vm });
    log = await appendEvent(log, 'update', { note: 'after seal' }, { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('migrate/transfer cause no authority change (old key keeps working)', async () => {
    const a = await makeRealSigner(); const b = await makeRealSigner();
    let log = await createEventLog(
      { name: 'A', controller: a.didKey, resources: [], createdAt: 'x', nonce: 'u7' },
      { signer: a.signer, verificationMethod: a.vm }
    );
    log = await appendEvent(log, 'transfer', { newController: b.didKey, transferredAt: 'x' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update', { note: 'a still signs' }, { signer: a.signer, verificationMethod: a.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);
    // transfer is NOT a key rotation: b's key does not become a log signer.
    const forged = await appendEvent(log, 'update', { note: 'b forges' }, { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(forged)).verified).toBe(false);
  });
});
