import { OriginalsSDK } from '../../src';
import { VerifiableCredential, CredentialSubject } from '../../src/types';

describe('CredentialManager', () => {
  const sdk = OriginalsSDK.create();
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const subject: CredentialSubject = {
    id: 'did:peer:subject',
    resourceId: 'res1',
    resourceType: 'text',
    createdAt: new Date().toISOString(),
    creator: 'did:peer:issuer'
  } as any;

  const baseVC: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer: 'did:peer:issuer',
    issuanceDate: new Date().toISOString(),
    credentialSubject: subject
  };

  test('createResourceCredential builds VC for each type (expected to fail until implemented)', async () => {
    const created = await sdk.credentials.createResourceCredential('ResourceCreated', subject, 'did:peer:issuer');
    expect(created.type).toContain('ResourceCreated');

    const updated = await sdk.credentials.createResourceCredential('ResourceUpdated', subject, 'did:peer:issuer');
    expect(updated.type).toContain('ResourceUpdated');

    const migrated = await sdk.credentials.createResourceCredential('ResourceMigrated', subject, 'did:peer:issuer');
    expect(migrated.type).toContain('ResourceMigrated');
  });

  test('signCredential attaches proof (partial pass expected) then verifyCredential validates (expected to fail until implemented)', async () => {
    const spy = jest.spyOn(sdk.credentials as any, 'generateProofValue').mockResolvedValue('zproof');
    const signed = await sdk.credentials.signCredential(baseVC, 'zpriv', 'did:peer:issuer#key-1');
    expect(signed.proof).toBeDefined();
    await expect(sdk.credentials.verifyCredential(signed)).resolves.toBe(true);
    spy.mockRestore();
  });

  test('verifyCredential returns false when no proof present (expected to pass)', async () => {
    await expect(sdk.credentials.verifyCredential(baseVC)).resolves.toBe(false);
  });

  test('createPresentation bundles VCs (expected to fail until implemented)', async () => {
    const pres = await sdk.credentials.createPresentation([baseVC], 'did:peer:holder');
    expect(pres.verifiableCredential.length).toBeGreaterThan(0);
  });

  test('generateProofValue throws (coverage for private throw)', async () => {
    const cm: any = sdk.credentials as any;
    await expect(cm["generateProofValue"](baseVC, 'zpriv')).rejects.toThrow('Not implemented');
  });
});


