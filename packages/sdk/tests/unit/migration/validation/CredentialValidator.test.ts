/**
 * CredentialValidator unit tests (issue #283)
 *
 * Before the fix the validator was VACUOUS: it read only
 * `options.metadata.credentials` (a key the migration flow never populated) and,
 * even when a credential was present, only checked that four W3C fields existed.
 * Any structurally-complete object — including a forged or tampered credential —
 * passed.
 *
 * The fix (a) reads the asset's real credentials from the typed
 * `options.credentials` channel and (b) cryptographically VERIFIES each signed
 * credential via CredentialManager, so a genuinely-invalid credential now fails.
 *
 * The `[proof-of-fix]` tests below assert exactly the input that PASSED under the
 * old behavior and now correctly FAILS.
 */

import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../../src';
import { CredentialValidator } from '../../../../src/migration/validation/CredentialValidator';
import { ValidationPipeline } from '../../../../src/migration/validation/ValidationPipeline';
import { CredentialManager } from '../../../../src/vc/CredentialManager';
import type { OriginalsConfig, VerifiableCredential } from '../../../../src/types';
import * as secp256k1 from '@noble/secp256k1';
import { multikey } from '../../../../src/crypto/Multikey';

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'ES256K',
  enableLogging: false,
};

const baseOptions = {
  sourceDid: 'did:peer:z6MkValid123',
  targetLayer: 'webvh' as const,
  domain: 'example.com',
};

// A structurally-complete, SIGNED-LOOKING credential (has all four W3C fields
// plus a proof). Under the old validator this always passed.
function structurallyValidSignedCredential(): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer: 'did:peer:z6MkValid123',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:z6MkValid123', resourceId: 'res-1' },
    proof: {
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod: 'did:peer:z6MkValid123#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'zForgedSignatureValue'
    }
  } as VerifiableCredential;
}

// Minimal CredentialManager stub whose verifyCredential result is controllable.
function credManagerReturning(verified: boolean): CredentialManager {
  return { verifyCredential: async () => verified } as unknown as CredentialManager;
}

async function signRealCredential() {
  const sdk = OriginalsSDK.create({ defaultKeyType: 'ES256K' });
  const sk = secp256k1.utils.randomSecretKey();
  const pk = secp256k1.getPublicKey(sk, true);
  const skMb = multikey.encodePrivateKey(sk, 'Secp256k1');
  const pkMb = multikey.encodePublicKey(pk, 'Secp256k1');
  const vc: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer: `did:key:${pkMb}`,
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:z6MkValid123', resourceId: 'res-1' } as any
  };
  const signed = await sdk.credentials.signCredential(vc, skMb, `did:key:${pkMb}`);
  return { sdk, signed };
}

describe('CredentialValidator (issue #283: vacuous credential check)', () => {
  test('[proof-of-fix] a structurally-complete but cryptographically-invalid credential now FAILS', async () => {
    // This input has all four W3C fields + a proof, so the OLD validator returned
    // valid=true. It must now fail because the signature does not verify.
    const validator = new CredentialValidator(baseConfig, credManagerReturning(false));

    const result = await validator.validate({
      ...baseOptions,
      credentials: [structurallyValidSignedCredential()]
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('CREDENTIAL_VERIFICATION_FAILED');
  });

  test('[proof-of-fix] a genuinely tampered credential fails real cryptographic verification', async () => {
    const { sdk, signed } = await signRealCredential();
    // Sanity: the untampered credential verifies.
    expect(await sdk.credentials.verifyCredential(signed)).toBe(true);

    // Tamper with the payload after signing.
    const tampered = {
      ...signed,
      credentialSubject: { ...(signed.credentialSubject as any), resourceId: 'res-EVIL' }
    } as VerifiableCredential;

    const validator = new CredentialValidator(baseConfig, sdk.credentials);
    const result = await validator.validate({ ...baseOptions, credentials: [tampered] });

    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('CREDENTIAL_VERIFICATION_FAILED');
  });

  test('[happy] a genuinely signed, untampered credential passes', async () => {
    const { sdk, signed } = await signRealCredential();
    const validator = new CredentialValidator(baseConfig, sdk.credentials);

    const result = await validator.validate({ ...baseOptions, credentials: [signed] });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('[structural] a credential missing mandatory W3C fields is a hard error', async () => {
    const validator = new CredentialValidator(baseConfig, credManagerReturning(true));

    const result = await validator.validate({
      ...baseOptions,
      // Missing issuer + credentialSubject.
      credentials: [{ '@context': ['x'], type: ['VerifiableCredential'] } as any]
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('MALFORMED_CREDENTIAL');
  });

  test('[unsigned] a credential with no proof is a warning, not an error', async () => {
    const validator = new CredentialValidator(baseConfig, credManagerReturning(false));
    const { proof, ...unsigned } = structurallyValidSignedCredential() as any;

    const result = await validator.validate({ ...baseOptions, credentials: [unsigned] });

    expect(result.valid).toBe(true);
    expect(result.warnings.map(w => w.code)).toContain('UNSIGNED_CREDENTIAL');
  });

  test('[skip] no credentials attached is valid (issuance happens post-migration)', async () => {
    const validator = new CredentialValidator(baseConfig, credManagerReturning(false));
    const result = await validator.validate({ ...baseOptions });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('[skip] credentialIssuance:false short-circuits even with an invalid credential', async () => {
    const validator = new CredentialValidator(baseConfig, credManagerReturning(false));
    const result = await validator.validate({
      ...baseOptions,
      credentialIssuance: false,
      credentials: [structurallyValidSignedCredential()]
    });
    expect(result.valid).toBe(true);
  });

  test('[compat] credentials on the legacy metadata.credentials channel are still validated', async () => {
    const validator = new CredentialValidator(baseConfig, credManagerReturning(false));
    const result = await validator.validate({
      ...baseOptions,
      metadata: { credentials: [structurallyValidSignedCredential()] }
    });
    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('CREDENTIAL_VERIFICATION_FAILED');
  });

  test('[fail-closed] a signed credential fails when no CredentialManager is injected to verify it', async () => {
    // Direct instantiation without a manager must NOT silently pass a proof it
    // cannot check — otherwise a forged credential slips through (Greptile P2).
    const validator = new CredentialValidator(baseConfig);

    const result = await validator.validate({
      ...baseOptions,
      credentials: [structurallyValidSignedCredential()]
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('CREDENTIAL_VERIFICATION_UNAVAILABLE');
  });
});

describe('ValidationPipeline wires real credential verification (issue #283)', () => {
  test('[wiring] an invalid signed credential fails the whole pipeline', async () => {
    const sdk = OriginalsSDK.create({ ...baseConfig });
    const pipeline = new ValidationPipeline(
      (sdk as any).config,
      sdk.did,
      credManagerReturning(false)
    );

    const result = await pipeline.validate({
      ...baseOptions,
      credentials: [structurallyValidSignedCredential()]
    });

    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('CREDENTIAL_VERIFICATION_FAILED');
  });
});
