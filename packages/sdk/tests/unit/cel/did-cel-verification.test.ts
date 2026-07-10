/**
 * did:cel self-certification branch in verifyEventLog.
 *
 * New-shape genesis events carry the holder's key in `data.controller` and NO
 * `data.did` (the asset DID is DERIVED — did:cel). For these logs the root key
 * MUST be a key of `data.controller`, fail-closed with no trust-on-first-use
 * fallback. Legacy `data.did` logs keep their exact prior behavior.
 *
 * Uses REAL Ed25519 signing (the eddsa-jcs-2022 signer pattern from
 * event-log-authorization.test.ts), so cryptographic + authority checks run.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { deriveDidCel } from '../../../src/cel/celDid';

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

describe('did:cel self-certification', () => {
  test('valid did:cel log verifies and reports assetDid', async () => {
    const { signer, didKey, vm } = await makeRealSigner();
    const log = await createEventLog(
      { name: 'A', controller: didKey, resources: [], createdAt: '2026-07-10T00:00:00Z', nonce: 'u1111' },
      { signer, verificationMethod: vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
    expect(result.assetDid).toBe(deriveDidCel(log));
  });

  test('genesis signed by a key that is NOT the controller fails closed', async () => {
    const { didKey } = await makeRealSigner();          // controller A
    const other = await makeRealSigner();               // signer B
    const log = await createEventLog(
      { name: 'A', controller: didKey, resources: [], createdAt: 'x', nonce: 'u2222' },
      { signer: other.signer, verificationMethod: other.vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toMatch(/controller/i);
  });

  test('non-did:key controller fails closed (no TOFU on the did:cel branch)', async () => {
    const { signer, vm } = await makeRealSigner();
    const log = await createEventLog(
      { name: 'A', controller: 'did:webvh:x:example.com:a', resources: [], createdAt: 'x', nonce: 'u3333' },
      { signer, verificationMethod: vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
  });

  test('expectedDid mismatch fails; match passes (did:cel)', async () => {
    const { signer, didKey, vm } = await makeRealSigner();
    const log = await createEventLog(
      { name: 'A', controller: didKey, resources: [], createdAt: 'x', nonce: 'u4444' },
      { signer, verificationMethod: vm }
    );
    expect((await verifyEventLog(log, { expectedDid: deriveDidCel(log) })).verified).toBe(true);
    expect((await verifyEventLog(log, { expectedDid: 'did:cel:uEiAwrong' })).verified).toBe(false);
  });

  test('legacy data.did logs verify exactly as before and report assetDid', async () => {
    // Legacy shape: the asset DID is embedded in data.did (a self-certifying
    // did:key). This pins the dual-accept contract — legacy must stay green.
    const { signer, didKey, vm } = await makeRealSigner();
    const log = await createEventLog(
      { name: 'A', did: didKey, layer: 'peer', resources: [], creator: didKey, createdAt: '2020-01-01T00:00:00Z' },
      { signer, verificationMethod: vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
    expect(result.assetDid).toBe(didKey);
    // expectedDid on legacy is string equality.
    expect((await verifyEventLog(log, { expectedDid: didKey })).verified).toBe(true);
    expect((await verifyEventLog(log, { expectedDid: 'did:key:zWrong' })).verified).toBe(false);
  });
});
