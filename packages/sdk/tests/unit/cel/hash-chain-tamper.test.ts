/**
 * Tamper-detection regression tests for the CEL hash chain.
 *
 * These tests document the exact class of tampering that the OLD broken
 * serializer (`JSON.stringify(entry, Object.keys(entry).sort())`) silently
 * allowed — because that array-replacer acts as a key allowlist and drops
 * all nested fields not named after a top-level key.
 *
 * With the fixed `canonicalizeEvent` serializer every nested field is part
 * of the hash input, so any mutation of nested data breaks the chain.
 */

import { describe, test, expect } from 'bun:test';
import {
  createEventLog,
  updateEventLog,
  verifyEventLog,
} from '../../../src/cel/algorithms';
import type { DataIntegrityProof, CreateOptions, UpdateOptions } from '../../../src/cel/types';

// ---------------------------------------------------------------------------
// Stub signer — produces structurally valid DataIntegrityProofs for testing.
// Not cryptographically real; the defaultVerifier only checks structure.
// ---------------------------------------------------------------------------
function createStubSigner(keyId: string = 'did:key:z6MkTest#key-0') {
  return async (data: unknown): Promise<DataIntegrityProof> => {
    // Simple deterministic proof value so the structural verifier accepts it
    const dataStr = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < dataStr.length; i++) {
      hash = ((hash << 5) - hash) + dataStr.charCodeAt(i);
      hash = hash & hash;
    }
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      verificationMethod: keyId,
      proofPurpose: 'assertionMethod',
      // Prefix with 'z' (base58btc) so the structural check passes
      proofValue: `z${Math.abs(hash).toString(36)}stub`,
      created: new Date().toISOString(),
    };
  };
}

describe('CEL hash chain tamper detection', () => {
  const signer = createStubSigner();
  const createOptions: CreateOptions = { signer, verificationMethod: 'did:key:z6MkTest#key-0' };
  const updateOptions: UpdateOptions = { signer, verificationMethod: 'did:key:z6MkTest#key-0' };

  test('valid log verifies successfully (baseline)', async () => {
    const log0 = await createEventLog(
      { name: 'asset', resources: [{ id: 'r1', digestMultibase: 'uAbc' }] },
      createOptions,
    );
    const log1 = await updateEventLog(log0, { version: 2, note: 'first update' }, updateOptions);
    const log2 = await updateEventLog(log1, { version: 3, note: 'second update' }, updateOptions);

    const result = await verifyEventLog(log2);
    expect(result.verified).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('tampering a NESTED field of event 0 breaks the chain at event 1', async () => {
    const log0 = await createEventLog(
      { name: 'asset', resources: [{ id: 'r1', digestMultibase: 'uAbc' }] },
      createOptions,
    );
    const log1 = await updateEventLog(log0, { version: 2, note: 'first update' }, updateOptions);
    const log2 = await updateEventLog(log1, { version: 3, note: 'second update' }, updateOptions);

    // Deep-clone so we have a mutable copy
    const tampered = JSON.parse(JSON.stringify(log2));

    // Mutate a NESTED field of event 0's data — the field the old broken
    // serializer would silently drop from the hash input.
    const event0Data = tampered.events[0].data as { resources: { digestMultibase: string }[] };
    event0Data.resources[0].digestMultibase = 'uTAMPERED';

    const result = await verifyEventLog(tampered);

    // With the corrected canonicalization the chain must be broken at event 1
    expect(result.verified).toBe(false);
    expect(result.events[1].chainValid).toBe(false);
    expect(
      result.errors.some(e => e.includes('Hash chain broken') || e.includes('previousEvent')),
    ).toBe(true);
  });

  test('tampering proofValue inside event 0\'s proof breaks the chain at event 1', async () => {
    const log0 = await createEventLog(
      { name: 'asset', resources: [{ id: 'r1', digestMultibase: 'uAbc' }] },
      createOptions,
    );
    const log1 = await updateEventLog(log0, { version: 2, note: 'first update' }, updateOptions);
    const log2 = await updateEventLog(log1, { version: 3, note: 'second update' }, updateOptions);

    const tampered = JSON.parse(JSON.stringify(log2));

    // Mutate the proofValue inside event 0's proof array — previously dropped
    // by the broken array-allowlist serializer, so tampering went undetected.
    tampered.events[0].proof[0].proofValue = 'zTAMPEREDPROOF';

    const result = await verifyEventLog(tampered);

    // Chain must be detected as broken at event 1
    expect(result.verified).toBe(false);
    expect(result.events[1].chainValid).toBe(false);
  });

  test('tampering the top-level name field of event 0 also breaks the chain', async () => {
    const log0 = await createEventLog(
      { name: 'asset', resources: [{ id: 'r1', digestMultibase: 'uAbc' }] },
      createOptions,
    );
    const log1 = await updateEventLog(log0, { version: 2 }, updateOptions);

    const tampered = JSON.parse(JSON.stringify(log1));
    const event0Data = tampered.events[0].data as { name: string };
    event0Data.name = 'TAMPERED_NAME';

    const result = await verifyEventLog(tampered);

    expect(result.verified).toBe(false);
    expect(result.events[1].chainValid).toBe(false);
  });
});
