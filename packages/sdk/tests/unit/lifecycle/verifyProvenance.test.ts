import { describe, test, expect, spyOn } from 'bun:test';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { AssetResource, DIDDocument, VerifiableCredential } from '../../../src/types';

function buildDid(id: string): DIDDocument {
  return { '@context': ['https://www.w3.org/ns/did/v1'], id };
}

const resources: AssetResource[] = [
  {
    id: 'res1',
    type: 'text',
    content: 'hello',
    contentType: 'text/plain',
    hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  }
];

function makeCred(
  id: string,
  previous?: { id?: string; hash?: string }
): VerifiableCredential {
  const subject: Record<string, unknown> = { id: 'did:peer:subject' };
  if (previous) subject.previousCredential = previous;
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://originals.build/context'],
    type: ['VerifiableCredential', 'ResourceMigrated'],
    id,
    issuer: 'did:peer:issuer',
    validFrom: new Date().toISOString(),
    credentialSubject: subject,
    proof: {
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod: 'did:peer:issuer#key',
      proofPurpose: 'assertionMethod',
      proofValue: 'zabc'
    }
  } as VerifiableCredential;
}

function newCm() {
  const didManager = new DIDManager({} as any);
  return new CredentialManager({ defaultKeyType: 'ES256K', network: 'regtest' } as any, didManager);
}

describe('OriginalsAsset.verifyProvenance (#367)', () => {
  test('empty credential set verifies trivially and reports unlinked', async () => {
    const asset = new OriginalsAsset(resources, buildDid('did:peer:a'), []);
    const cm = newCm();
    const res = await asset.verifyProvenance({ credentialManager: cm });
    expect(res).toEqual({ valid: true, errors: [], verifiedCredentials: 0, chainLength: 0, chainLinked: false });
  });

  test('unlinked but individually-valid credentials verify with chainLinked=false', async () => {
    const cm = newCm();
    const spy = spyOn(cm, 'verifyCredential').mockResolvedValue(true);
    const creds = [makeCred('urn:1'), makeCred('urn:2')];
    const asset = new OriginalsAsset(resources, buildDid('did:peer:a'), creds);

    const res = await asset.verifyProvenance({ credentialManager: cm });
    expect(res.valid).toBe(true);
    expect(res.chainLinked).toBe(false);
    expect(res.verifiedCredentials).toBe(2);
    spy.mockRestore();
  });

  test('a correctly-linked chain verifies and is reported as linked, regardless of input order', async () => {
    const cm = newCm();
    const spy = spyOn(cm, 'verifyCredential').mockResolvedValue(true);

    const root = makeCred('urn:root');
    const rootHash = await cm.computeCredentialHash(root);
    const child = makeCred('urn:child', { id: 'urn:root', hash: rootHash });

    // Intentionally pass newest-first to prove reconstruction orders them.
    const asset = new OriginalsAsset(resources, buildDid('did:peer:a'), [child, root]);
    const res = await asset.verifyProvenance({ credentialManager: cm });

    expect(res.valid).toBe(true);
    expect(res.chainLinked).toBe(true);
    expect(res.chainLength).toBe(2);
    expect(res.errors).toEqual([]);
    spy.mockRestore();
  });

  test('a tampered previousCredential.hash breaks the chain', async () => {
    const cm = newCm();
    const spy = spyOn(cm, 'verifyCredential').mockResolvedValue(true);

    const root = makeCred('urn:root');
    const child = makeCred('urn:child', { id: 'urn:root', hash: 'deadbeef' }); // wrong hash
    const asset = new OriginalsAsset(resources, buildDid('did:peer:a'), [root, child]);

    const res = await asset.verifyProvenance({ credentialManager: cm });
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes("hash doesn't match"))).toBe(true);
    spy.mockRestore();
  });

  test('a dangling previousCredential.id (missing root) is reported', async () => {
    const cm = newCm();
    const spy = spyOn(cm, 'verifyCredential').mockResolvedValue(true);

    // child references a previous credential that is not present in the set
    const child = makeCred('urn:child', { id: 'urn:missing' });
    const other = makeCred('urn:other', { id: 'urn:also-missing' });
    const asset = new OriginalsAsset(resources, buildDid('did:peer:a'), [child, other]);

    const res = await asset.verifyProvenance({ credentialManager: cm });
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('single root'))).toBe(true);
    spy.mockRestore();
  });

  test('an individually-invalid credential fails provenance verification', async () => {
    const cm = newCm();
    const spy = spyOn(cm, 'verifyCredential').mockResolvedValue(false);
    const asset = new OriginalsAsset(resources, buildDid('did:peer:a'), [makeCred('urn:1')]);

    const res = await asset.verifyProvenance({ credentialManager: cm });
    expect(res.valid).toBe(false);
    expect(res.verifiedCredentials).toBe(0);
    spy.mockRestore();
  });
});
