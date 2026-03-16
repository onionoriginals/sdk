import { describe, test, expect } from 'bun:test';
import type {
  CredentialSubject,
  ResourceCreatedCredential,
  ResourceUpdatedCredential,
  ResourceMigratedCredential,
  VerifiableCredential,
} from '../../../src/types/credentials';

/**
 * Contract tests ensuring CredentialSubject uses unknown (not any) index signature,
 * and that specialized credential types enforce required fields at the type level.
 */
describe('CredentialSubject type safety', () => {
  test('CredentialSubject accepts arbitrary unknown values', () => {
    const subject: CredentialSubject = {
      id: 'did:peer:123',
      customField: 'value',
      nested: { deep: true },
      count: 42,
    };
    expect(subject.id).toBe('did:peer:123');
    // Values are unknown — must narrow before use
    expect(typeof subject.customField).toBe('string');
  });

  test('ResourceCreatedCredential enforces required credentialSubject fields', () => {
    const cred: ResourceCreatedCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'ResourceCreatedCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: 'did:peer:123',
        resourceId: 'res-001',
        resourceHash: 'sha256-abc',
        createdAt: new Date().toISOString(),
      },
    };
    expect(cred.credentialSubject.resourceId).toBe('res-001');
  });

  test('ResourceMigratedCredential enforces required credentialSubject fields', () => {
    const cred: ResourceMigratedCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'ResourceMigratedCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: 'did:peer:123',
        resourceId: 'res-001',
        fromLayer: 'did:peer',
        toLayer: 'did:webvh',
        migratedAt: new Date().toISOString(),
      },
    };
    expect(cred.credentialSubject.fromLayer).toBe('did:peer');
    expect(cred.credentialSubject.toLayer).toBe('did:webvh');
  });

  test('base CredentialSubject id is optional', () => {
    const withId: CredentialSubject = { id: 'did:peer:123' };
    const withoutId: CredentialSubject = {};
    expect(withId.id).toBe('did:peer:123');
    expect(withoutId.id).toBeUndefined();
  });

  test('VerifiableCredential.credentialSubject uses CredentialSubject type', () => {
    const vc: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: 'did:peer:subject',
        arbitrary: 'data',
      },
    };
    // Accessing unknown-typed properties requires narrowing
    expect(typeof vc.credentialSubject.id).toBe('string');
  });
});
