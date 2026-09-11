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
import { multikey } from '../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../src/canonicalize';
import { verifyEventLog } from '../../src/algorithms/verifyEventLog';
import { createEventLog } from '../../src/algorithms/createEventLog';
import { deriveDidCel } from '../../src/celDid';

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

  test('resolver-backed genesis forgery backstop: attacker key + victim VM string fails against an honest resolver', async () => {
    // VM-equality (root proof VM === data.controller) alone must never suffice
    // for a resolver-backed (non-did:key) controller: the resolved key must
    // also cryptographically verify the signature. An attacker who stamps the
    // victim's exact VM but signs with their own key must fail closed.
    const victimPriv = crypto.getRandomValues(new Uint8Array(32));
    const victimPub = await ed25519.getPublicKeyAsync(victimPriv);
    const attackerPriv = crypto.getRandomValues(new Uint8Array(32));
    const victimVm = 'did:webvh:example.com:victim#key-0';

    // Signs with the given private key but stamps an arbitrary claimed VM
    // (the "different key, claimed VM" pattern from event-log-authorization.test.ts).
    const vmSigner = (priv: Uint8Array, vm: string) => async (data: unknown) => ({
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: '2020-01-01T00:00:00Z',
      verificationMethod: vm,
      proofPurpose: 'assertionMethod',
      proofValue: multikey.encodeMultibase(
        new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
      ),
    });

    // Honest resolver: returns the VICTIM's real key for the victim's VM.
    const resolveKey = async (vm: string) => (vm === victimVm ? victimPub : null);

    const forgedLog = await createEventLog(
      { name: 'A', controller: 'did:webvh:example.com:victim', resources: [], createdAt: 'x', nonce: 'uForge1' },
      { signer: vmSigner(attackerPriv, victimVm) as any, verificationMethod: victimVm }
    );
    const forgedResult = await verifyEventLog(forgedLog, { resolveKey });
    expect(forgedResult.verified).toBe(false);

    // Sibling positive control: same genesis, same VM + resolver, but actually
    // signed by the victim's own key — must verify.
    const legitLog = await createEventLog(
      { name: 'A', controller: 'did:webvh:example.com:victim', resources: [], createdAt: 'x', nonce: 'uForge2' },
      { signer: vmSigner(victimPriv, victimVm) as any, verificationMethod: victimVm }
    );
    const legitResult = await verifyEventLog(legitLog, { resolveKey });
    expect(legitResult.verified).toBe(true);
  });

  test('#590 legacy genesis dispatch cannot substitute a controller for a non-self-certifying data.did', async () => {
    // Attack: forge a genesis whose legacy `data.did` names a victim's
    // non-self-certifying identifier (a did:webvh here — did:web, an old-scheme
    // did:cel string, etc. are the same shape), self-sign with an UNRELATED
    // did:key, and ask verifyEventLog to confirm the log backs that identifier.
    // Before the fix this passed: trust-on-first-use authorized the attacker's
    // key outright, and `expectedDid === legacyDid` was a bare string compare
    // against the attacker-supplied field with no authority behind it.
    const attacker = await makeRealSigner();
    const victimDid = 'did:webvh:example.com:victim';
    const forgedLog = await createEventLog(
      { name: 'A', did: victimDid, layer: 'peer', resources: [], creator: victimDid, createdAt: 'x' },
      { signer: attacker.signer, verificationMethod: attacker.vm }
    );
    const forgedResult = await verifyEventLog(forgedLog, { expectedDid: victimDid });
    expect(forgedResult.verified).toBe(false);

    // Even without an expectedDid check, the log itself must not verify: an
    // unauthenticated legacyDid claim is not a valid genesis, full stop.
    const forgedNoExpect = await verifyEventLog(forgedLog);
    expect(forgedNoExpect.verified).toBe(false);
  });

  test('#590 non-self-certifying legacy data.did binds via VM-DID equality + resolver, like the controller branch', async () => {
    // Positive control mirroring the resolver-backed `controller` test above:
    // a legacy genesis whose `data.did` is resolver-backed verifies when the
    // create proof's VM names that exact DID and the resolver vouches for the
    // signing key — and still fails when an attacker stamps the victim's VM
    // but signs with a different key.
    const victimPriv = crypto.getRandomValues(new Uint8Array(32));
    const victimPub = await ed25519.getPublicKeyAsync(victimPriv);
    const attackerPriv = crypto.getRandomValues(new Uint8Array(32));
    const victimDid = 'did:webvh:example.com:victim2';
    const victimVm = `${victimDid}#key-0`;

    const vmSigner = (priv: Uint8Array, vm: string) => async (data: unknown) => ({
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: '2020-01-01T00:00:00Z',
      verificationMethod: vm,
      proofPurpose: 'assertionMethod',
      proofValue: multikey.encodeMultibase(
        new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
      ),
    });
    const resolveKey = async (vm: string) => (vm === victimVm ? victimPub : null);

    const forgedLog = await createEventLog(
      { name: 'A', did: victimDid, layer: 'peer', resources: [], creator: victimDid, createdAt: 'x' },
      { signer: vmSigner(attackerPriv, victimVm) as any, verificationMethod: victimVm }
    );
    const forgedResult = await verifyEventLog(forgedLog, { expectedDid: victimDid, resolveKey });
    expect(forgedResult.verified).toBe(false);

    const legitLog = await createEventLog(
      { name: 'A', did: victimDid, layer: 'peer', resources: [], creator: victimDid, createdAt: 'x' },
      { signer: vmSigner(victimPriv, victimVm) as any, verificationMethod: victimVm }
    );
    const legitResult = await verifyEventLog(legitLog, { expectedDid: victimDid, resolveKey });
    expect(legitResult.verified).toBe(true);
    expect(legitResult.assetDid).toBe(victimDid);
  });

  test('#590 a genesis carrying both legacy data.did and data.controller is rejected as ambiguous', async () => {
    const { signer, didKey, vm } = await makeRealSigner();
    const log = await createEventLog(
      { name: 'A', did: didKey, controller: didKey, resources: [], createdAt: 'x' },
      { signer, verificationMethod: vm }
    );
    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toMatch(/ambiguous/i);
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
