/**
 * Renaming what a CEL proof CLAIMS, without changing what it signs.
 *
 * Two passes, same shape: plan 042 renamed the cryptosuite and bound the proof
 * configuration into the signature; the rename below does the same for `type`.
 * Both replaced a borrowed W3C label with an Originals one, both keep the old
 * label readable forever, and neither touches the cryptography.
 *
 * Plan 042 — renaming the CEL cryptosuite and binding the proof configuration.
 *
 * The old label was `eddsa-jcs-2022`, but the construction was not that suite:
 * no hashing step, and the proof configuration excluded from the signature. So
 * it promised interop it could not deliver, AND left `created`,
 * `verificationMethod`, `proofPurpose` and the suite label itself unattested —
 * freely editable metadata inside a structure whose entire purpose is
 * tamper-evidence.
 *
 * Logs sealed before the change cannot be re-signed, so they keep verifying
 * under their original rules. What must never happen is a proof being verified
 * under the OTHER construction's rules.
 */

import { describe, test, expect } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createEventLog } from '../../src/algorithms/createEventLog';
import { verifyEventLog } from '../../src/algorithms/verifyEventLog';
import {
  verifyDidKeyProof,
  CEL_CRYPTOSUITE,
  CEL_CRYPTOSUITE_LEGACY,
  CEL_PROOF_TYPE,
  CEL_PROOF_TYPE_LEGACY,
} from '../../src/proofVerification';
import { canonicalizeEvent } from '../../src/canonicalize';
import { multikey } from '../../src/crypto/Multikey';
import { createRealCelSigner } from '../fixtures/celSigner';
import type { DataIntegrityProof, EventLog } from '../../src/types';

/** A signer using the PRE-042 construction: the event alone, unhashed. */
function legacySigner() {
  const secret = ed25519.utils.randomSecretKey();
  const pub = multikey.encodePublicKey(ed25519.getPublicKey(secret), 'Ed25519');
  const verificationMethod = `did:key:${pub}#${pub}`;
  const signer = async (data: unknown): Promise<DataIntegrityProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: CEL_CRYPTOSUITE_LEGACY,
    created: new Date().toISOString(),
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(ed25519.sign(canonicalizeEvent(data), secret)),
  });
  return { signer, verificationMethod, controller: `did:key:${pub}` };
}

describe('the suites are distinct and both are recognised', () => {
  test('new logs are written with the bespoke suite, not the borrowed name', async () => {
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'a', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );
    expect(log.events[0].proof[0].cryptosuite).toBe(CEL_CRYPTOSUITE);
    expect(CEL_CRYPTOSUITE).not.toBe('eddsa-jcs-2022');
  });

  test('a log sealed before 042 still verifies under its original rules', async () => {
    const legacy = legacySigner();
    const log = await createEventLog(
      { name: 'a', controller: legacy.controller },
      { signer: legacy.signer, verificationMethod: legacy.verificationMethod }
    );

    expect(log.events[0].proof[0].cryptosuite).toBe(CEL_CRYPTOSUITE_LEGACY);
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('an unrecognised suite is still refused, naming both accepted ones', async () => {
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'a', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );
    log.events[0].proof[0].cryptosuite = 'eddsa-rdfc-2022';

    const result = await verifyEventLog(log);
    expect(result.verified).toBe(false);
    expect(result.errors.join('\n')).toContain(CEL_CRYPTOSUITE);
  });
});

describe('the two constructions cannot be swapped — both directions fail closed', () => {
  async function newLog(): Promise<{ log: EventLog }> {
    const real = createRealCelSigner();
    return {
      log: await createEventLog(
        { name: 'a', controller: real.controller },
        { signer: real.signer, verificationMethod: real.verificationMethod }
      ),
    };
  }

  test('relabelling a legacy proof to the new suite fails: it never covered the config', async () => {
    const legacy = legacySigner();
    const log = await createEventLog(
      { name: 'a', controller: legacy.controller },
      { signer: legacy.signer, verificationMethod: legacy.verificationMethod }
    );

    log.events[0].proof[0].cryptosuite = CEL_CRYPTOSUITE;
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('downgrading a new proof to the legacy suite fails: that is not what was signed', async () => {
    const { log } = await newLog();

    log.events[0].proof[0].cryptosuite = CEL_CRYPTOSUITE_LEGACY;
    expect((await verifyEventLog(log)).verified).toBe(false);
  });
});

describe('the proof configuration is attested (the point of the change)', () => {
  test('backdating `created` on a new proof invalidates it', async () => {
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'a', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );

    log.events[0].proof[0].created = '2001-01-01T00:00:00Z';
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('changing `proofPurpose` on a new proof invalidates it', async () => {
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'a', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );

    log.events[0].proof[0].proofPurpose = 'authentication';
    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('the same edits go UNDETECTED on a legacy proof — the weakness being retired', async () => {
    // Documented, not endorsed: this is exactly why the construction changed,
    // and exactly why pre-042 logs cannot be treated as strongly as new ones.
    const legacy = legacySigner();
    const log = await createEventLog(
      { name: 'a', controller: legacy.controller },
      { signer: legacy.signer, verificationMethod: legacy.verificationMethod }
    );

    log.events[0].proof[0].created = '2001-01-01T00:00:00Z';
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('the event itself is still covered under both constructions', async () => {
    for (const make of [createRealCelSigner, legacySigner]) {
      const s = make();
      const log = await createEventLog(
        { name: 'a', controller: s.controller },
        { signer: s.signer, verificationMethod: s.verificationMethod }
      );
      (log.events[0].data as { name: string }).name = 'tampered';
      expect((await verifyEventLog(log)).verified).toBe(false);
    }
  });
});

describe('seal-time self-verification covers the new construction', () => {
  test('a signer that signs the OLD preimage but claims the new suite is caught at seal', async () => {
    const secret = ed25519.utils.randomSecretKey();
    const pub = multikey.encodePublicKey(ed25519.getPublicKey(secret), 'Ed25519');
    const verificationMethod = `did:key:${pub}#${pub}`;
    // Claims the new suite, signs the pre-042 bytes — the exact mistake an
    // un-migrated implementation would make.
    const stale = async (data: unknown): Promise<DataIntegrityProof> => ({
      type: 'DataIntegrityProof',
      cryptosuite: CEL_CRYPTOSUITE,
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: multikey.encodeMultibase(ed25519.sign(canonicalizeEvent(data), secret)),
    });

    await expect(
      createEventLog({ name: 'a' }, { signer: stale, verificationMethod })
    ).rejects.toMatchObject({ code: 'CEL_PROOF_SELF_VERIFY_FAILED' });
  });

  test('verifyDidKeyProof reports the suite mismatch reason', async () => {
    const proof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'made-up-suite',
      created: new Date().toISOString(),
      verificationMethod: 'did:key:zAbc#zAbc',
      proofPurpose: 'assertionMethod',
      proofValue: 'zSig',
    } as DataIntegrityProof;

    const { verified, reason } = await verifyDidKeyProof(proof, { type: 'create', data: {} });
    expect(verified).toBe(false);
    expect(reason).toContain('made-up-suite');
  });
});

/**
 * The same move, applied to the `type` field.
 *
 * `DataIntegrityProof` is W3C's type, and carrying it asserted that a
 * conforming Data Integrity implementation could verify these proofs. None
 * can: the suite is bespoke and unregistered, so a conforming verifier reads
 * the cryptosuite, fails to recognise it, and rejects. Naming the envelope
 * after the spec only moved that discovery one field later.
 *
 * Renaming a label that already-sealed logs carry is only safe if those logs
 * keep verifying — the mainnet asset among them — and if accepting both labels
 * opens no door. Both are asserted here.
 */
describe('the proof type names an Originals construction, not a W3C one', () => {
  test('new proofs are written with the honest type', async () => {
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'a', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );
    expect(log.events[0].proof[0].type).toBe(CEL_PROOF_TYPE);
    expect(CEL_PROOF_TYPE).not.toBe('DataIntegrityProof');
  });

  test('a log sealed under the old type still verifies — nothing already minted breaks', async () => {
    // The property that made the rename shippable at one mainnet asset.
    const legacy = legacySigner();
    const log = await createEventLog(
      { name: 'a', controller: legacy.controller },
      { signer: legacy.signer, verificationMethod: legacy.verificationMethod }
    );

    expect(log.events[0].proof[0].type).toBe(CEL_PROOF_TYPE_LEGACY);
    expect((await verifyEventLog(log)).verified).toBe(true);
  });

  test('a made-up type is still refused', async () => {
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'a', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );
    log.events[0].proof[0].type = 'SomeOtherProof';

    expect((await verifyEventLog(log)).verified).toBe(false);
  });

  test('accepting both types opens no door: the type is inside the signature', async () => {
    // Why dual-accept is safe rather than a downgrade. `type` is part of the
    // proof configuration the new construction signs, so relabelling a
    // current-suite proof to the legacy type breaks it, even though the
    // verifier would otherwise accept that label.
    const real = createRealCelSigner();
    const log = await createEventLog(
      { name: 'a', controller: real.controller },
      { signer: real.signer, verificationMethod: real.verificationMethod }
    );
    log.events[0].proof[0].type = CEL_PROOF_TYPE_LEGACY;

    expect((await verifyEventLog(log)).verified).toBe(false);
  });
});
