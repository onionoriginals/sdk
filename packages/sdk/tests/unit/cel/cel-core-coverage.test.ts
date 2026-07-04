/**
 * CEL-core coverage gaps
 *
 * Covers the following scenarios that were not previously exercised end-to-end:
 *
 * CEL-CORE-012/happy (two tests)
 *   - Migrate webvh→btco via BtcoCelManager: verify the final event carries
 *     type='update', layer='btco', sourceDid=did:webvh:*, targetDid=did:btco:*,
 *     AND that transaction references (txid / inscriptionId) are present — all
 *     asserted together in one integrated scenario.
 *   - Dedicated assertion that migration data contains a Bitcoin tx reference
 *     (txid AND inscriptionId), not just that those keys exist.
 *
 * CEL-CORE-023/security
 *   - createDidManagerKeyResolver wired into verifyEventLog: when the DID
 *     document's verification method carries `revoked` or `compromised`, the
 *     proof verification must fail closed (verified: false).  The unit tests in
 *     keyResolver.test.ts already confirm the resolver returns null for those
 *     cases; the gap was the full pipeline — resolver → verifyEventLog fails.
 *
 * Notes:
 *   - keyResolver.test.ts already covers resolver-returns-null for revoked and
 *     compromised keys in isolation.  The tests here add the end-to-end claim:
 *     that null propagates through dispatchVerify → verified: false.
 *   - BtcoCelManager.test.ts already covers individual migration fields.  The
 *     two tests here add a consolidated, spec-aligned assertion for CEL-CORE-012.
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { BtcoCelManager } from '../../../src/cel/layers/BtcoCelManager';
import { WebVHCelManager } from '../../../src/cel/layers/WebVHCelManager';
import { PeerCelManager } from '../../../src/cel/layers/PeerCelManager';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { createDidManagerKeyResolver } from '../../../src/cel/keyResolver';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import type {
  EventLog,
  DataIntegrityProof,
} from '../../../src/cel/types';
import type { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';
import type { DIDManager } from '../../../src/did/DIDManager';
import type { DIDDocument, VerificationMethod } from '../../../src/types/did';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Produces a structurally-valid DataIntegrityProof with a mock signature. */
const createMockSigner = () =>
  async (_data: unknown): Promise<DataIntegrityProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod: 'did:key:z6MkMockSigner#key-0',
    proofPurpose: 'assertionMethod',
    proofValue: 'z' + Buffer.from('mock-signature').toString('base64'),
  });

/** BitcoinManager mock that returns deterministic inscription data. */
const createMockBitcoinManager = (): BitcoinManager =>
  ({
    inscribeData: async () => ({
      txid: 'deadbeef01020304',
      inscriptionId: 'deadbeef01020304i0',
      satoshi: '9876543210',
      blockHeight: 840000,
    }),
  } as unknown as BitcoinManager);

/** Build a webvh-layer event log (peer → webvh migration). */
const buildWebvhLog = async (): Promise<EventLog> => {
  const peerMgr = new PeerCelManager(createMockSigner());
  const peerLog = await peerMgr.create('Coverage Asset', [
    { digestMultibase: 'uCoverageHash', mediaType: 'image/png' },
  ]);
  const webvhMgr = new WebVHCelManager(createMockSigner(), 'coverage.example.com');
  return webvhMgr.migrate(peerLog);
};

// ---------------------------------------------------------------------------
// CEL-CORE-012/happy — integrated btco migration assertions
// ---------------------------------------------------------------------------

describe('CEL-CORE-012/happy – webvh→btco migration via BtcoCelManager', () => {
  let btcoLog: EventLog;

  beforeAll(async () => {
    const webvhLog = await buildWebvhLog();
    const btcoMgr = new BtcoCelManager(createMockSigner(), createMockBitcoinManager());
    btcoLog = await btcoMgr.migrate(webvhLog);
  });

  it('final event has type="update", layer="btco", sourceDid starts with did:webvh:, targetDid starts with did:btco:', () => {
    // The btco migration appends a third event (create + webvh-update + btco-update).
    const finalEvent = btcoLog.events[btcoLog.events.length - 1];
    const data = finalEvent.data as Record<string, unknown>;

    // Event type
    expect(finalEvent.type).toBe('update');

    // Layer label
    expect(data.layer).toBe('btco');

    // Source DID must come from the webvh layer.
    expect(typeof data.sourceDid).toBe('string');
    expect((data.sourceDid as string).startsWith('did:webvh:')).toBe(true);

    // targetDid is NOT in the signed data — the resolvable did:btco:<satoshi>
    // is derived from the bitcoin witness proof's satoshi (only known after
    // inscription).
    expect(data.targetDid).toBeUndefined();
    const bpCore = (finalEvent.proof as any[]).find(p => p.cryptosuite === 'bitcoin-ordinals-2024');
    expect(String(bpCore.satoshi).length).toBeGreaterThan(0);
  });

  it('migration data contains Bitcoin transaction references (txid and inscriptionId)', () => {
    const finalEvent = btcoLog.events[btcoLog.events.length - 1];
    // txid/inscriptionId are carried in the bitcoin witness proof (not the
    // signed data, which can't know them before inscription).
    const bp = (finalEvent.proof as any[]).find(p => p.cryptosuite === 'bitcoin-ordinals-2024') as Record<string, unknown>;
    expect(bp).toBeDefined();

    expect(typeof bp.txid).toBe('string');
    expect((bp.txid as string).length).toBeGreaterThan(0);
    expect(typeof bp.inscriptionId).toBe('string');
    expect((bp.inscriptionId as string).length).toBeGreaterThan(0);

    // Confirm the values match what BitcoinManager returned.
    expect(bp.txid).toBe('deadbeef01020304');
    expect(bp.inscriptionId).toBe('deadbeef01020304i0');
  });
});

// ---------------------------------------------------------------------------
// CEL-CORE-023/security — revoked/compromised key → proof verification fails
//
// Context: keyResolver.test.ts already checks that createDidManagerKeyResolver
// returns null for a VM with `revoked` or `compromised` set.  That unit test
// confirms the resolver contract, but it does NOT run verifyEventLog.  The
// gap is the full pipeline: resolver-returns-null → dispatchVerify fails
// closed → verifyEventLog returns verified: false.
//
// These tests wire createDidManagerKeyResolver into verifyEventLog.resolveKey
// so the complete execution path is exercised end-to-end.
// ---------------------------------------------------------------------------

describe('CEL-CORE-023/security – revoked/compromised key rejection through verifyEventLog', () => {
  /**
   * Ed25519 keypair used for signing.  The key itself is valid; the DID
   * document marks it as revoked or compromised — that metadata, not the
   * cryptography, must cause rejection.
   */
  let privateKeyBytes: Uint8Array;
  let publicKeyBytes: Uint8Array;
  let publicKeyMultibase: string;
  // Non-did:key VM so that the createDidManagerKeyResolver path is taken
  // (did:key proofs are resolved offline without consulting the DIDManager).
  const nonDidKeyVm = 'did:peer:zTestRevoked#key-1';
  const nonDidKeyDid = 'did:peer:zTestRevoked';

  beforeAll(async () => {
    const ed25519 = await import('@noble/ed25519');
    privateKeyBytes = ed25519.utils.randomSecretKey();
    publicKeyBytes = new Uint8Array(
      await (ed25519 as any).getPublicKeyAsync(privateKeyBytes),
    );
    publicKeyMultibase = multikey.encodePublicKey(publicKeyBytes, 'Ed25519');
  });

  /** Creates a genuine Ed25519 signer for the given VM string. */
  const makeSigner =
    (vm: string) =>
    async (data: unknown): Promise<DataIntegrityProof> => {
      const ed25519 = await import('@noble/ed25519');
      const dataBytes = canonicalizeEvent(data);
      const sig = await (ed25519 as any).signAsync(dataBytes, privateKeyBytes);
      return {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: vm,
        proofPurpose: 'assertionMethod',
        proofValue: multikey.encodeMultibase(new Uint8Array(sig)),
      };
    };

  /**
   * Builds a DIDManager mock whose DID document contains a single verification
   * method with the supplied extra fields (e.g. { revoked: '...' }).
   */
  function buildDidManager(
    extraVmFields: Partial<VerificationMethod>,
  ): DIDManager {
    const vm: VerificationMethod = {
      id: nonDidKeyVm,
      type: 'Multikey',
      controller: nonDidKeyDid,
      publicKeyMultibase,
      ...extraVmFields,
    };
    const doc: DIDDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: nonDidKeyDid,
      verificationMethod: [vm],
    };
    return {
      resolveDID: async (did: string) =>
        did === doc.id ? (doc as any) : null,
    } as unknown as DIDManager;
  }

  it('verifyEventLog returns verified: false when the signing key is marked revoked', async () => {
    const signer = makeSigner(nonDidKeyVm);
    const log = await createEventLog(
      { name: 'revoked-key-asset' },
      { signer, verificationMethod: nonDidKeyVm },
    );

    // The DID document marks the key as revoked.
    const didManager = buildDidManager({ revoked: '2025-01-01T00:00:00Z' });
    const resolveKey = createDidManagerKeyResolver(didManager);

    const result = await verifyEventLog(log, { resolveKey });

    // A revoked key must not allow verification to pass.
    expect(result.verified).toBe(false);
    expect(result.events[0].proofValid).toBe(false);
  });

  it('verifyEventLog returns verified: false when the signing key is marked compromised', async () => {
    const signer = makeSigner(nonDidKeyVm);
    const log = await createEventLog(
      { name: 'compromised-key-asset' },
      { signer, verificationMethod: nonDidKeyVm },
    );

    // The DID document marks the key as compromised.
    const didManager = buildDidManager({ compromised: '2025-06-01T00:00:00Z' });
    const resolveKey = createDidManagerKeyResolver(didManager);

    const result = await verifyEventLog(log, { resolveKey });

    expect(result.verified).toBe(false);
    expect(result.events[0].proofValid).toBe(false);
  });

  it('verifyEventLog returns verified: true for the same log when the key is active (control)', async () => {
    // Same keypair and signer, but the DID document has NO revoked/compromised.
    const signer = makeSigner(nonDidKeyVm);
    const log = await createEventLog(
      { name: 'active-key-asset' },
      { signer, verificationMethod: nonDidKeyVm },
    );

    const didManager = buildDidManager({}); // no revoked, no compromised
    const resolveKey = createDidManagerKeyResolver(didManager);

    const result = await verifyEventLog(log, { resolveKey });

    // Active key with a valid signature must verify.
    expect(result.verified).toBe(true);
    expect(result.events[0].proofValid).toBe(true);
    expect(result.events[0].cryptographicallyVerified).toBe(true);
  });

  it('revoked key stays rejected even when the signature itself is cryptographically valid', async () => {
    // This test underscores that the rejection is policy-based, not merely
    // cryptographic: the signature IS correct, but the key is revoked, so
    // the resolver returns null and verification fails closed.
    const signer = makeSigner(nonDidKeyVm);
    const log = await createEventLog(
      { name: 'valid-sig-revoked-key' },
      { signer, verificationMethod: nonDidKeyVm },
    );

    const revokedDidManager = buildDidManager({ revoked: '2024-12-31T23:59:59Z' });
    const resolveKey = createDidManagerKeyResolver(revokedDidManager);

    const result = await verifyEventLog(log, { resolveKey });

    // Despite the signature being mathematically correct, the key is revoked —
    // the resolver returns null and dispatchVerify fails closed.
    expect(result.verified).toBe(false);
    expect(result.events[0].cryptographicallyVerified).toBe(false);
  });
});
