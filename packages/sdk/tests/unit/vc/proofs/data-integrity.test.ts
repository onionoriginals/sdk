/** Canonical test aggregator created by combine-tests script. */

/** Inlined from data-integrity.branches.part.ts */
import { describe, test, expect } from 'bun:test';
import { DataIntegrityProofManager } from '../../../../src/vc/proofs/data-integrity';

describe('DataIntegrityProofManager branches', () => {
  test('unsupported cryptosuite on create throws', async () => {
    await expect(DataIntegrityProofManager.createProof({ id: 'x' }, {
      verificationMethod: 'did:ex#key-1',
      proofPurpose: 'assertionMethod',
      type: 'DataIntegrityProof',
      cryptosuite: 'unknown'
    } as any)).rejects.toThrow('Unsupported cryptosuite');
  });

  // bbs-2023 is parked (#591): createProof must refuse it by name so the
  // caller learns the suite is disabled, not that they misspelled it.
  test('bbs-2023 on create is rejected as disabled', async () => {
    await expect(DataIntegrityProofManager.createProof(
      { '@context': [], id: 'x', issuer: 'did:example:issuer' },
      {
        verificationMethod: 'did:example:issuer#k',
        proofPurpose: 'assertionMethod',
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        privateKey: new Uint8Array(32)
      } as any
    )).rejects.toThrow('Cryptosuite bbs-2023 is disabled');
  });

  test('unsupported cryptosuite on verify returns false', async () => {
    const res = await DataIntegrityProofManager.verifyProof({ id: 'x' }, {
      type: 'DataIntegrityProof', cryptosuite: 'unknown', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z'
    } as any, { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('Unsupported cryptosuite');
  });

  test('non-DataIntegrityProof proof type on verify returns false', async () => {
    const res = await DataIntegrityProofManager.verifyProof({ id: 'x' }, {
      type: 'Ed25519Signature2020', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z'
    } as any, { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('Unsupported proof type');
  });

  test('missing proof type on verify returns false', async () => {
    const res = await DataIntegrityProofManager.verifyProof({ id: 'x' }, {
      cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z'
    } as any, { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('Unsupported proof type');
  });

  test('non-DataIntegrityProof type on create throws', async () => {
    await expect(DataIntegrityProofManager.createProof({ id: 'x' }, {
      verificationMethod: 'did:ex#key-1',
      proofPurpose: 'assertionMethod',
      type: 'Ed25519Signature2020',
      cryptosuite: 'eddsa-rdfc-2022'
    } as any)).rejects.toThrow('Unsupported proof type');
  });

  // #320 review: EdDSACryptosuiteManager.createProof always synthesized
  // type: 'DataIntegrityProof', so callers omitting `type` used to succeed.
  // createProof must default a MISSING type rather than throw, while a WRONG
  // explicit type still throws and verifyProof stays strict.
  test('createProof with type omitted defaults to DataIntegrityProof', async () => {
    const { DIDManager } = await import('../../../../src/did/DIDManager');
    const { createDocumentLoader } = await import('../../../../src/vc/documentLoader');
    const didManager = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519' } as any);
    const loader = createDocumentLoader(didManager);
    const privateKey = new Uint8Array(32).map((_, i) => (i + 11) & 0xff);
    const proof = await DataIntegrityProofManager.createProof(
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        credentialSubject: { id: 'did:example:subject' }
      },
      {
        verificationMethod: 'did:example:issuer#key-1',
        proofPurpose: 'assertionMethod',
        cryptosuite: 'eddsa-rdfc-2022',
        privateKey,
        documentLoader: loader
      } as any
    );
    expect(proof.type).toBe('DataIntegrityProof');
    expect(proof.cryptosuite).toBe('eddsa-rdfc-2022');
    expect(typeof proof.proofValue).toBe('string');
    expect(proof.proofValue.startsWith('z')).toBe(true);
  });

  // #604: EdDSACryptosuiteManager.createProofConfiguration() used to always
  // stamp its own `created`, silently discarding a caller-supplied value with
  // no way for the caller to tell. It must now honor an explicit timestamp.
  test('createProof honors a caller-supplied created timestamp instead of silently discarding it', async () => {
    const { DIDManager } = await import('../../../../src/did/DIDManager');
    const { createDocumentLoader } = await import('../../../../src/vc/documentLoader');
    const didManager = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519' } as any);
    const loader = createDocumentLoader(didManager);
    const privateKey = new Uint8Array(32).map((_, i) => (i + 11) & 0xff);
    const created = '2020-01-01T00:00:00.000Z';
    const proof = await DataIntegrityProofManager.createProof(
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        credentialSubject: { id: 'did:example:subject' }
      },
      {
        verificationMethod: 'did:example:issuer#key-1',
        proofPurpose: 'assertionMethod',
        cryptosuite: 'eddsa-rdfc-2022',
        created,
        privateKey,
        documentLoader: loader
      } as any
    );
    expect(proof.created).toBe(created);
  });

  // Omitting `created` must still fall back to the current time, not throw
  // or leave the field unset.
  test('createProof defaults created to the current time when omitted', async () => {
    const { DIDManager } = await import('../../../../src/did/DIDManager');
    const { createDocumentLoader } = await import('../../../../src/vc/documentLoader');
    const didManager = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519' } as any);
    const loader = createDocumentLoader(didManager);
    const privateKey = new Uint8Array(32).map((_, i) => (i + 11) & 0xff);
    const before = Date.now();
    const proof = await DataIntegrityProofManager.createProof(
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        issuer: 'did:example:issuer',
        credentialSubject: { id: 'did:example:subject' }
      },
      {
        verificationMethod: 'did:example:issuer#key-1',
        proofPurpose: 'assertionMethod',
        cryptosuite: 'eddsa-rdfc-2022',
        privateKey,
        documentLoader: loader
      } as any
    );
    const createdMs = Date.parse(proof.created as string);
    expect(Number.isNaN(createdMs)).toBe(false);
    expect(createdMs).toBeGreaterThanOrEqual(before - 1000);
    expect(createdMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('createProof rejects a caller-supplied previousProof', async () => {
    await expect(DataIntegrityProofManager.createProof({ id: 'x' }, {
      verificationMethod: 'did:ex#key-1',
      proofPurpose: 'assertionMethod',
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      previousProof: 'urn:uuid:prior-proof',
      privateKey: new Uint8Array(32)
    } as any)).rejects.toThrow('ProofOptions.previousProof is not supported');
  });

  // bbs-2023 is parked (#591): verifyProof fails closed on the suite itself,
  // before any key resolution, so no base or derived BBS proof can verify.
  test('bbs-2023 on verify is rejected as disabled', async () => {
    const res = await DataIntegrityProofManager.verifyProof(
      { id: 'x', issuer: 'did:example:issuer' },
      {
        type: 'DataIntegrityProof', cryptosuite: 'bbs-2023',
        verificationMethod: 'did:example:issuer#k', proofPurpose: 'assertionMethod', proofValue: 'u'
      } as any,
      { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) }
    );
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('Cryptosuite bbs-2023 is disabled');
  });
});
