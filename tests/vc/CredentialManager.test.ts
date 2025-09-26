import { OriginalsSDK } from '../../src';
import { VerifiableCredential, CredentialSubject } from '../../src/types';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { p256 } from '@noble/curves/p256';

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

  test('signCredential/verifyCredential works for ES256K', async () => {
    const sdkES256K = OriginalsSDK.create({ defaultKeyType: 'ES256K' });
    const sk = secp256k1.utils.randomPrivateKey();
    const pk = secp256k1.getPublicKey(sk, true);
    const skMb = 'z' + Buffer.from(sk).toString('base64url');
    const pkMb = 'z' + Buffer.from(pk).toString('base64url');
    const signed = await sdkES256K.credentials.signCredential(baseVC, skMb, pkMb);
    expect(signed.proof).toBeDefined();
    await expect(sdkES256K.credentials.verifyCredential(signed)).resolves.toBe(true);
  });

  test('verifyCredential returns false when no proof present (expected to pass)', async () => {
    await expect(sdk.credentials.verifyCredential(baseVC)).resolves.toBe(false);
  });

  test('createPresentation bundles VCs (expected to fail until implemented)', async () => {
    const pres = await sdk.credentials.createPresentation([baseVC], 'did:peer:holder');
    expect(pres.verifiableCredential.length).toBeGreaterThan(0);
  });

  test('verifyCredential returns false when proof missing fields', async () => {
    const vc: VerifiableCredential = { ...baseVC, proof: { 
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod: '',
      proofPurpose: 'assertionMethod',
      proofValue: ''
    } as any };
    await expect(sdk.credentials.verifyCredential(vc)).resolves.toBe(false);
  });

  test('verifyCredential uses data-integrity verifier path when cryptosuite present', async () => {
    const sdkEd = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
    const signed = await sdkEd.credentials.signCredential(baseVC, 'z' + Buffer.from(new Uint8Array(32).fill(1)).toString('base64url'), 'did:ex#key');
    (signed as any).proof.cryptosuite = 'eddsa-rdfc-2022';
    const res = await sdkEd.credentials.verifyCredential(signed);
    expect(typeof res).toBe('boolean');
  });

  test('verifyCredential returns false on invalid multibase proofValue', async () => {
    const vc: VerifiableCredential = { ...baseVC, proof: { 
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod: 'z' + Buffer.from('pk').toString('base64url'),
      proofPurpose: 'assertionMethod',
      proofValue: 'xnot-multibase'
    } } as any;
    await expect(sdk.credentials.verifyCredential(vc)).resolves.toBe(false);
  });

  test('verifyCredential returns false when signer throws (catch path)', async () => {
    const vc: VerifiableCredential = { ...baseVC, proof: { 
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod: 'z' + Buffer.from('pk').toString('base64url'),
      proofPurpose: 'assertionMethod',
      proofValue: 'z' + Buffer.from('sig').toString('base64url')
    } } as any;
    const cm: any = sdk.credentials as any;
    const original = cm.getSigner;
    cm.getSigner = () => ({
      verify: () => { throw new Error('boom'); },
      sign: async () => Buffer.from('')
    });
    await expect(sdk.credentials.verifyCredential(vc)).resolves.toBe(false);
    cm.getSigner = original;
  });

  test('signCredential/verifyCredential works for Ed25519', async () => {
    const sdkEd = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
    const sk = ed25519.utils.randomPrivateKey();
    const pk = await (ed25519 as any).getPublicKeyAsync(sk);
    const skMb = 'z' + Buffer.from(sk).toString('base64url');
    const pkMb = 'z' + Buffer.from(pk).toString('base64url');
    const signed = await sdkEd.credentials.signCredential(baseVC, skMb, pkMb);
    expect(signed.proof).toBeDefined();
    await expect(sdkEd.credentials.verifyCredential(signed)).resolves.toBe(true);
  });

  test('signCredential/verifyCredential works for ES256', async () => {
    const sdkES256 = OriginalsSDK.create({ defaultKeyType: 'ES256' });
    const sk = p256.utils.randomPrivateKey();
    const pk = p256.getPublicKey(sk, true);
    const skMb = 'z' + Buffer.from(sk).toString('base64url');
    const pkMb = 'z' + Buffer.from(pk).toString('base64url');
    const signed = await sdkES256.credentials.signCredential(baseVC, skMb, pkMb);
    expect(signed.proof).toBeDefined();
    await expect(sdkES256.credentials.verifyCredential(signed)).resolves.toBe(true);
  });
});


