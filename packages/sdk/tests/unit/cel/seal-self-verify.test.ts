/**
 * Plan 034 — seal-time self-verification.
 * Plan 035 — the structural whitelist matches what the dispatcher can verify.
 *
 * Before 034, `createEventLog`/`appendEvent` checked only that the signer
 * returned SOMETHING proof-shaped. A signer using the wrong preimage — the
 * classic remote-custody mistake — sealed a genesis whose did:cel derived fine
 * and whose log could never verify, with the failure surfacing arbitrarily far
 * from its cause.
 */

import { describe, test, expect } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { structuralCheckReason, CEL_CRYPTOSUITE } from '../../../src/cel/proofVerification';
import { multikey } from '../../../src/crypto/Multikey';
import { createRealCelSigner } from '../../fixtures/celSigner';
import type { DataIntegrityProof } from '../../../src/cel/types';

/**
 * A signer that signs the WRONG bytes: the event's `data` alone instead of the
 * committed `{ type, data, previousEvent? }`. Structurally perfect, and the
 * exact shape of a signer that picked its own canonicalization.
 */
function createWrongPreimageSigner() {
  const real = createRealCelSigner();
  const signer = async (event: unknown): Promise<DataIntegrityProof> => {
    const proof = await real.signer((event as { data: unknown }).data);
    return { ...proof, verificationMethod: real.verificationMethod };
  };
  return { signer, verificationMethod: real.verificationMethod };
}

describe('seal-time self-verification (plan 034)', () => {
  test('createEventLog rejects a proof over the wrong preimage', async () => {
    const { signer, verificationMethod } = createWrongPreimageSigner();

    const promise = createEventLog({ name: 'Asset' }, { signer, verificationMethod });

    await expect(promise).rejects.toThrow(/does not verify against its own verification method/);
    await expect(promise).rejects.toMatchObject({ code: 'CEL_PROOF_SELF_VERIFY_FAILED' });
  });

  test('appendEvent rejects a proof over the wrong preimage and leaves the log untouched', async () => {
    const good = createRealCelSigner();
    const log = await createEventLog(
      { name: 'Asset', controller: good.controller },
      { signer: good.signer, verificationMethod: good.verificationMethod }
    );

    const bad = createWrongPreimageSigner();
    await expect(
      appendEvent(log, 'update', { note: 'v2' }, {
        signer: bad.signer,
        verificationMethod: bad.verificationMethod,
      })
    ).rejects.toMatchObject({ code: 'CEL_PROOF_SELF_VERIFY_FAILED' });

    // The append is all-or-nothing: nothing was added to the source log.
    expect(log.events).toHaveLength(1);
  });

  test('a sealed log verifies — the seal-time check and read-time check agree', async () => {
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'Asset', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );

    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
    expect(result.events[0].cryptographicallyVerified).toBe(true);
  });

  test('verifyOnSign: false is an escape hatch for building invalid fixtures', async () => {
    const { signer, verificationMethod } = createWrongPreimageSigner();

    const log = await createEventLog({ name: 'Asset' }, {
      signer,
      verificationMethod,
      verifyOnSign: false,
    });

    expect(log.events).toHaveLength(1);
    // It defers the failure to read time; it cannot make the proof valid.
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('a non-did:key verification method is sealed unchecked (no resolver at sign time)', async () => {
    const real = createRealCelSigner();
    const webvhVm = 'did:webvh:example.com:alice#key-0';
    const signer = async (event: unknown): Promise<DataIntegrityProof> => ({
      ...(await real.signer(event)),
      verificationMethod: webvhVm,
    });

    const log = await createEventLog({ name: 'Asset' }, { signer, verificationMethod: webvhVm });
    expect(log.events[0].proof[0].verificationMethod).toBe(webvhVm);
  });

  test('a structurally incomplete proof still fails, with the pre-034 message', async () => {
    const signer = async (): Promise<DataIntegrityProof> =>
      ({ type: '', cryptosuite: '', proofValue: '' }) as unknown as DataIntegrityProof;

    await expect(
      createEventLog({ name: 'Asset' }, { signer, verificationMethod: 'did:key:z6Mk' })
    ).rejects.toMatchObject({ code: 'CEL_PROOF_INVALID' });
  });

  test('the error explains which bytes to sign', async () => {
    const { signer, verificationMethod } = createWrongPreimageSigner();
    const err = await createEventLog({ name: 'Asset' }, { signer, verificationMethod }).catch((e) => e);

    expect(err.message).toContain('canonicalizeEvent({ type, data, previousEvent? })');
  });
});

describe('cryptosuite whitelist matches the dispatcher (plan 035)', () => {
  test('structuralCheckReason rejects eddsa-rdfc-2022 and names it', () => {
    const proof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      created: new Date().toISOString(),
      verificationMethod: 'did:key:z6MkTest#z6MkTest',
      proofPurpose: 'assertionMethod',
      proofValue: 'zSomething',
    } as DataIntegrityProof;

    const reason = structuralCheckReason(proof);
    expect(reason).toContain('eddsa-rdfc-2022');
    expect(reason).toContain(CEL_CRYPTOSUITE);
  });

  test('structuralCheckReason accepts a well-formed eddsa-jcs-2022 proof', async () => {
    const real = createRealCelSigner();
    const proof = await real.signer({ type: 'create', data: {} });
    expect(structuralCheckReason(proof)).toBeNull();
  });

  test('verifyEventLog says WHY a proof failed, not just "Verification failed"', async () => {
    // Seal a valid log, then swap in a foreign key's signature.
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'Asset', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );

    const foreign = ed25519.utils.randomSecretKey();
    log.events[0].proof[0].proofValue = multikey.encodeMultibase(
      ed25519.sign(new TextEncoder().encode('other bytes'), foreign)
    );

    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join('\n')).toContain('signature mismatch');
  });

  test('an unresolvable non-did:key proof reports the verification method', async () => {
    const real = createRealCelSigner();
    const webvhVm = 'did:webvh:example.com:alice#key-0';
    const signer = async (event: unknown): Promise<DataIntegrityProof> => ({
      ...(await real.signer(event)),
      verificationMethod: webvhVm,
    });
    const log = await createEventLog({ name: 'Asset' }, {
      signer,
      verificationMethod: webvhVm,
      verifyOnSign: false,
    });

    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join('\n')).toContain(webvhVm);
  });
});
