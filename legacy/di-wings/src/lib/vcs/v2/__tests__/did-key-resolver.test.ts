import { expect, describe, it } from 'bun:test';
import { DIDKeyResolver } from '../identifiers/did-key-resolver';
import type { VerificationMethod } from '../common/verification-method';

describe('DIDKeyResolver', () => {
  it('should resolve a valid did:key identifier', async () => {
    const did = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    const result = await DIDKeyResolver.resolve(did);

    expect(result.id).toBe(did);
    expect(result['@context']).toContain('https://www.w3.org/ns/did/v1');
    expect(result.verificationMethod).toHaveLength(1);
    expect(result.verificationMethod![0].type).toBe('Multikey');
    expect((result.authentication![0] as VerificationMethod).id).toBe(`${did}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`);
    expect((result.assertionMethod![0] as VerificationMethod).id).toBe(`${did}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`);
    expect((result.capabilityInvocation![0] as VerificationMethod).id).toBe(`${did}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`);
    expect((result.capabilityDelegation![0] as VerificationMethod).id).toBe(`${did}#z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK`);
    expect((result.keyAgreement as VerificationMethod[]).length).toBe(0);
  });

  it('should resolve a valid did:key identifier for X25519', async () => {
    const did = 'did:key:z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc';
    const result = await DIDKeyResolver.resolve(did);

    expect(result.id).toBe(did);
    expect(result.verificationMethod![0].type).toBe('Multikey');
    expect((result.keyAgreement![0] as VerificationMethod).id).toBe(`${did}#z6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc`);
  });

  it('should throw an error for an invalid did:key format', async () => {
    const did = 'did:example:123';
    await expect(DIDKeyResolver.resolve(did)).rejects.toThrow('Invalid did:key format');
  });
});
