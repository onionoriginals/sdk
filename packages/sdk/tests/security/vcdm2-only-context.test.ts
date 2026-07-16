import { describe, test, expect } from 'bun:test';
import { validateCredential } from '../../src/utils/validation';
import { deserializeCredential } from '../../src/utils/serialization';
import type { VerifiableCredential } from '../../src/types';

/**
 * Issue #300: the SDK standardizes on W3C VCDM 2.0 and no longer accepts the
 * VCDM 1.1 (`https://www.w3.org/2018/credentials/v1`) context. This reverses the
 * 1.1 acceptance added in #264. These tests approach it from the caller/attacker
 * side: a credential presenting only the 1.1 context must be rejected at every
 * structural acceptance boundary (validateCredential, deserializeCredential, and
 * OriginalsAsset.addCredential, which both call validateCredential).
 */
describe('VCDM 2.0-only context enforcement (issue #300)', () => {
  const wellFormedExceptContext = {
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    credentialSubject: { id: 'did:peer:subject' },
  };

  test('validateCredential rejects a VCDM 1.1-only credential', () => {
    const v1Cred = {
      ...wellFormedExceptContext,
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      issuanceDate: new Date().toISOString(),
    } as unknown as VerifiableCredential;
    expect(validateCredential(v1Cred)).toBe(false);
  });

  test('validateCredential accepts the equivalent VCDM 2.0 credential', () => {
    const v2Cred = {
      ...wellFormedExceptContext,
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      validFrom: new Date().toISOString(),
    } as unknown as VerifiableCredential;
    expect(validateCredential(v2Cred)).toBe(true);
  });

  test('deserializeCredential refuses a VCDM 1.1-only credential', () => {
    const json = JSON.stringify({
      ...wellFormedExceptContext,
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      issuanceDate: '2024-01-01T00:00:00Z',
    });
    expect(() => deserializeCredential(json)).toThrow('Invalid Verifiable Credential JSON');
  });

  test('a 1.1 context mixed only with non-credentials contexts is still rejected', () => {
    const mixed = {
      ...wellFormedExceptContext,
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
      issuanceDate: new Date().toISOString(),
    } as unknown as VerifiableCredential;
    expect(validateCredential(mixed)).toBe(false);
  });
});
