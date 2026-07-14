import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { hashResource } from '../../../src/utils/validation';
import { hexSha256ToDigestMultibase } from '../../../src/cel/signerAdapter';

// A real eddsa-jcs-2022 signer exposing its holder did:key + canonical VM.
// (Mirrors makeRealSigner in key-rotation-authority.test.ts.)
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

const hex = (s: string) => hashResource(Buffer.from(s, 'utf-8'));

// Genesis carrying ONE resource whose content is `content`.
async function genesisWith(content: string, signer: Awaited<ReturnType<typeof makeRealSigner>>) {
  return createEventLog(
    {
      name: 'r',
      controller: signer.didKey,
      resources: [{ digestMultibase: hexSha256ToDigestMultibase(hex(content)) }],
      createdAt: 'x',
      nonce: 'n-' + Math.random(),
    },
    { signer: signer.signer, verificationMethod: signer.vm }
  );
}

describe('verifyEventLog: resource-update events', () => {
  test('honest first update (prev=genesis hash) verifies', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(
      log,
      'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm }
    );
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('second update chains from the first derived hash', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v3', contentType: 'text/plain', previousVersionHash: hex('v2'), toVersion: 3 },
      { signer: a.signer, verificationMethod: a.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('chain-continuity attack: wrong previousVersionHash is rejected', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('not-the-genesis'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toContain('resource');
  });

  test('content-tamper: flipping content after signing breaks the proof', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });
    // Mutate the embedded content AFTER it was signed.
    (log.events[1].data as { content: string }).content = 'tampered';
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('unauthorized signer: an update from a non-controller is rejected', async () => {
    const a = await makeRealSigner();
    const mallory = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: mallory.signer, verificationMethod: mallory.vm });
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('no heuristic collision: generic and migration-ish updates are ignored by the branch', async () => {
    const a = await makeRealSigner();
    let log = await genesisWith('v1', a);
    log = await appendEvent(log, 'update', { note: 'generic' }, { signer: a.signer, verificationMethod: a.vm });
    log = await appendEvent(log, 'update',
      { sourceDid: 'did:cel:x', layer: 'webvh', migratedAt: 'x' },
      { signer: a.signer, verificationMethod: a.vm });
    // Neither carries resourceId+previousVersionHash, so continuity never engages.
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('authority-after-rotation: update by the NEW key verifies, by the OLD key fails', async () => {
    const a = await makeRealSigner();
    const b = await makeRealSigner();
    let base = await genesisWith('v1', a);
    base = await appendEvent(base, 'rotateKey', { newController: b.didKey, rotatedAt: 'x' },
      { signer: a.signer, verificationMethod: a.vm });

    const good = await appendEvent(base, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: b.signer, verificationMethod: b.vm });
    expect((await verifyEventLog(good)).verified).toBe(true);

    const bad = await appendEvent(base, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: a.signer, verificationMethod: a.vm });
    expect((await verifyEventLog(bad)).verified).toBe(false);
  });

  // Genesis carrying TWO resources, each ExternalReference BOUND to its own id (#401).
  async function genesisWithTwoIds(
    a: { id: string; content: string },
    b: { id: string; content: string },
    signer: Awaited<ReturnType<typeof makeRealSigner>>
  ) {
    return createEventLog(
      {
        name: 'r',
        controller: signer.didKey,
        resources: [
          { id: a.id, digestMultibase: hexSha256ToDigestMultibase(hex(a.content)) },
          { id: b.id, digestMultibase: hexSha256ToDigestMultibase(hex(b.content)) },
        ],
        createdAt: 'x',
        nonce: 'n-' + Math.random(),
      },
      { signer: signer.signer, verificationMethod: signer.vm }
    );
  }

  test('id-bound genesis: a first update for A chaining from B\'s genesis digest is REJECTED (#401)', async () => {
    const s = await makeRealSigner();
    let log = await genesisWithTwoIds({ id: 'A', content: 'a1' }, { id: 'B', content: 'b1' }, s);
    // First update for resourceId 'A', but previousVersionHash = B's genesis hash.
    // With per-id binding, A must chain from A's own genesis digest → rejected.
    log = await appendEvent(log, 'update',
      { resourceId: 'A', content: 'a2', contentType: 'text/plain', previousVersionHash: hex('b1'), toVersion: 2 },
      { signer: s.signer, verificationMethod: s.vm });
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toContain('resource');
  });

  test('id-bound genesis: a first update for A chaining from A\'s OWN genesis digest verifies (#401)', async () => {
    const s = await makeRealSigner();
    let log = await genesisWithTwoIds({ id: 'A', content: 'a1' }, { id: 'B', content: 'b1' }, s);
    log = await appendEvent(log, 'update',
      { resourceId: 'A', content: 'a2', contentType: 'text/plain', previousVersionHash: hex('a1'), toVersion: 2 },
      { signer: s.signer, verificationMethod: s.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('legacy id-less genesis still falls back to matching any genesis digest', async () => {
    // genesisWith emits an ExternalReference WITHOUT an id → flat-set fallback.
    const s = await makeRealSigner();
    let log = await genesisWith('v1', s);
    log = await appendEvent(log, 'update',
      { resourceId: 'r', content: 'v2', contentType: 'text/plain', previousVersionHash: hex('v1'), toVersion: 2 },
      { signer: s.signer, verificationMethod: s.vm });
    expect((await verifyEventLog(log)).verified).toBe(true);
  });
});
