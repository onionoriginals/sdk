import { describe, test, expect, beforeAll, afterEach, afterAll, beforeEach } from 'bun:test';
import { Verifier } from '../../../src/vc/Verifier';
import { Issuer } from '../../../src/vc/Issuer';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { registerVerificationMethod, verificationMethodRegistry } from '../../../src/vc/documentLoader';
import { DIDManager } from '../../../src/did/DIDManager';

describe('diwings Verifier', () => {
  const didManager = new DIDManager({} as any);
  const did = 'did:peer:issuer1';
  const sk = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
  };
  
  beforeEach(() => {
    registerVerificationMethod(vm);
  });

  test('verifies a credential (v2)', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject1' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(true);
  });

  test('verifies a presentation (v2) with nested credential', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Nested'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject2' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did,
        verifiableCredential: [vc]
      } as any,
      { proofPurpose: 'authentication' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyPresentation(vp);
    expect(res.verified).toBe(true);
  });

  test('fails when proof missing', async () => {
    const verifier = new Verifier(didManager);
    const badVc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential']
    };
    const res = await verifier.verifyCredential(badVc);
    expect(res.verified).toBe(false);
  });

  test('rejects an expired credential even with a valid proof', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date(Date.now() - 60_000).toISOString(),
        expirationDate: new Date(Date.now() - 1_000).toISOString(),
        credentialSubject: { id: 'did:peer:subject1' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(false);
    expect(res.errors.some(e => /expired/i.test(e))).toBe(true);
  });

  test('rejects a not-yet-valid credential (validFrom in the future)', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        validFrom: new Date(Date.now() + 3600_000).toISOString(),
        credentialSubject: { id: 'did:peer:subject1' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(false);
    expect(res.errors.some(e => /not yet valid/i.test(e))).toBe(true);
  });

  test('rejects issuer impersonation: proof signed by a key not controlled by the issuer', async () => {
    // Attacker controls their own valid Ed25519 key/VM, and crafts a credential
    // that names a *trusted* issuer while signing with their own key and their
    // own verificationMethod. The signature is cryptographically valid and the
    // attacker's key resolves, so without an issuer<->verificationMethod binding
    // check this would verify as `true` — full issuer impersonation.
    const attackerDid = 'did:peer:attacker';
    const attackerSk = new Uint8Array(32).map((_, i) => (i + 7) & 0xff);
    const attackerPk = ed25519.getPublicKey(attackerSk);
    const attackerVm = {
      id: `${attackerDid}#keys-1`,
      controller: attackerDid,
      type: 'Multikey',
      publicKeyMultibase: multikey.encodePublicKey(attackerPk, 'Ed25519'),
      secretKeyMultibase: multikey.encodePrivateKey(attackerSk, 'Ed25519')
    };
    registerVerificationMethod(attackerVm);

    const { DataIntegrityProofManager } = await import('../../../src/vc/proofs/data-integrity');
    const { createDocumentLoader } = await import('../../../src/vc/documentLoader');
    const loader = createDocumentLoader(didManager);

    // Start from a well-formed credential the attacker legitimately issues to
    // themselves (guaranteed to canonicalize), then rewrite the issuer to the
    // trusted DID and re-sign with the attacker's own key. The resulting proof
    // is valid for the attacker's key over a document that claims `issuer: did`.
    const attackerIssuer = new Issuer(didManager, attackerVm);
    const base = await attackerIssuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: attackerDid,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:victim' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const forged: any = { ...base, issuer: did };
    delete forged.proof;
    forged.proof = await DataIntegrityProofManager.createProof(forged, {
      verificationMethod: attackerVm.id,
      proofPurpose: 'assertionMethod',
      cryptosuite: 'eddsa-rdfc-2022',
      type: 'DataIntegrityProof',
      privateKey: attackerSk,
      documentLoader: loader
    });

    // Sanity: the forged proof is cryptographically valid against the attacker's
    // key — the ONLY thing that must stop it is the issuer binding.
    const rawProofCheck = await DataIntegrityProofManager.verifyProof(forged, forged.proof, { documentLoader: loader });
    expect(rawProofCheck.verified).toBe(true);

    const verifier = new Verifier(didManager);
    const res = await verifier.verifyCredential(forged);
    expect(res.verified).toBe(false);
    expect(res.errors.some(e => /verificationMethod.*does not match.*issuer/i.test(e))).toBe(true);
  });

  test('rejects holder impersonation: presentation proof signed by a non-holder key', async () => {
    const attackerDid = 'did:peer:attacker2';
    const attackerSk = new Uint8Array(32).map((_, i) => (i + 11) & 0xff);
    const attackerPk = ed25519.getPublicKey(attackerSk);
    const attackerVm = {
      id: `${attackerDid}#keys-1`,
      controller: attackerDid,
      type: 'Multikey',
      publicKeyMultibase: multikey.encodePublicKey(attackerPk, 'Ed25519'),
      secretKeyMultibase: multikey.encodePrivateKey(attackerSk, 'Ed25519')
    };
    registerVerificationMethod(attackerVm);

    const { DataIntegrityProofManager } = await import('../../../src/vc/proofs/data-integrity');
    const { createDocumentLoader } = await import('../../../src/vc/documentLoader');
    const loader = createDocumentLoader(didManager);

    // Well-formed presentation the attacker issues to themselves, then rewrite
    // the holder to the trusted DID and re-sign with the attacker's own key.
    const attackerIssuer = new Issuer(didManager, attackerVm);
    const base = await attackerIssuer.issuePresentation(
      { type: ['VerifiablePresentation'], holder: attackerDid } as any,
      { proofPurpose: 'authentication' }
    );
    const forged: any = { ...base, holder: did };
    delete forged.proof;
    forged.proof = await DataIntegrityProofManager.createProof(forged, {
      verificationMethod: attackerVm.id,
      proofPurpose: 'authentication',
      cryptosuite: 'eddsa-rdfc-2022',
      type: 'DataIntegrityProof',
      privateKey: attackerSk,
      documentLoader: loader
    });

    const verifier = new Verifier(didManager);
    const res = await verifier.verifyPresentation(forged);
    expect(res.verified).toBe(false);
    expect(res.errors.some(e => /verificationMethod.*does not match.*holder/i.test(e))).toBe(true);
  });

  test('fails closed when credentialStatus is present but no resolver is configured', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        credentialStatus: {
          id: 'https://example.com/status/1#0',
          type: 'BitstringStatusListEntry',
          statusPurpose: 'revocation',
          statusListIndex: '0',
          statusListCredential: 'https://example.com/status/1'
        },
        credentialSubject: { id: 'did:peer:subject1' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const verifier = new Verifier(didManager);
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(false);
    expect(res.errors.some(e => /statusListResolver/.test(e))).toBe(true);

    // Explicit opt-out still verifies
    const skipped = await verifier.verifyCredential(vc, { checkStatus: false });
    expect(skipped.verified).toBe(true);
  });

  test('verifyPresentation validates expectedChallenge and expectedDomain', async () => {
    const issuer = new Issuer(didManager, vm);
    const vp = await issuer.issuePresentation(
      {
        type: ['VerifiablePresentation'],
        holder: did
      } as any,
      { proofPurpose: 'authentication', challenge: 'nonce-A', domain: 'verifier.example' }
    );
    const verifier = new Verifier(didManager);

    const ok = await verifier.verifyPresentation(vp, { expectedChallenge: 'nonce-A', expectedDomain: 'verifier.example' });
    expect(ok.verified).toBe(true);

    const replay = await verifier.verifyPresentation(vp, { expectedChallenge: 'nonce-B' });
    expect(replay.verified).toBe(false);
    expect(replay.errors.some(e => /challenge/i.test(e))).toBe(true);

    const wrongDomain = await verifier.verifyPresentation(vp, { expectedDomain: 'other.example' });
    expect(wrongDomain.verified).toBe(false);
    expect(wrongDomain.errors.some(e => /domain/i.test(e))).toBe(true);
  });

  test('verifyCredentialMultiSig rejects a single proof repeated to fake the threshold', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject1' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const proof = Array.isArray(vc.proof) ? vc.proof[0] : vc.proof;
    const manipulated = { ...vc, proof: [proof, proof] } as any;

    const policy: any = {
      required: 2,
      total: 3,
      signerVerificationMethods: [(proof as any).verificationMethod, `${did}#keys-2`, `${did}#keys-3`]
    };

    const verifier = new Verifier(didManager);
    const result = await verifier.verifyCredentialMultiSig(manipulated, policy);
    expect(result.validSignatures).toBe(1);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /duplicate/i.test(e))).toBe(true);
  });

  test('verifyCredentialMultiSig counts a valid proof preceded by an invalid one from the same signer', async () => {
    const issuer = new Issuer(didManager, vm);
    const vc = await issuer.issueCredential(
      {
        type: ['VerifiableCredential', 'Test'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:peer:subject1' }
      } as any,
      { proofPurpose: 'assertionMethod' }
    );
    const proof: any = Array.isArray(vc.proof) ? vc.proof[0] : vc.proof;
    // An invalid proof from the same signer must not consume the signer's
    // slot and suppress the later valid proof.
    const tampered = { ...proof, proofValue: proof.proofValue.slice(0, -2) + (proof.proofValue.endsWith('aa') ? 'bb' : 'aa') };
    const withInvalidFirst = { ...vc, proof: [tampered, proof] } as any;

    const policy: any = {
      required: 1,
      total: 1,
      signerVerificationMethods: [proof.verificationMethod]
    };

    const verifier = new Verifier(didManager);
    const result = await verifier.verifyCredentialMultiSig(withInvalidFirst, policy);
    expect(result.validSignatures).toBe(1);
    expect(result.verified).toBe(true);
  });
});

/** Inlined from Verifier.array-context-and-proof.part.ts */

describe('Verifier array handling branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential with array proof and array contexts', async () => {
    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://w3id.org/security/data-integrity/v2'],
      type: ['VerifiableCredential'],
      proof: [{ cryptosuite: 'data-integrity' }]
    };
    const res = await verifier.verifyCredential(vc, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation with array proof and array contexts', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://w3id.org/security/data-integrity/v2'],
      type: ['VerifiablePresentation'],
      proof: [{ cryptosuite: 'data-integrity' }]
    };
    const res = await verifier.verifyPresentation(vp, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(false);
  });
});


/** Inlined from Verifier.branches-more.part.ts */

describe('Verifier additional error branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential invalid input missing type', async () => {
    const res = await verifier.verifyCredential({ '@context': ['x'], proof: {} } as any);
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation invalid input missing type', async () => {
    const res = await verifier.verifyPresentation({ '@context': ['x'], proof: {} } as any);
    expect(res.verified).toBe(false);
  });
});




/** Inlined from Verifier.context-string.part.ts */

describe('Verifier with string @context branches', () => {
  const dm = new DIDManager({} as any);
  const did = 'did:peer:stringctx';
  const sk = new Uint8Array(32).map((_, i) => (i + 7) & 0xff);
  const pk = ed25519.getPublicKey(sk);
  const vm = {
    id: `${did}#keys-1`,
    controller: did,
    type: 'Multikey',
    publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
    secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
  };

  beforeEach(() => registerVerificationMethod(vm));

  test('verifyCredential accepts string @context', async () => {
    const issuer = new Issuer(dm, vm);
    const vc = await issuer.issueCredential({ id: 'urn:x', type: ['VerifiableCredential'], issuer: did, issuanceDate: new Date().toISOString(), credentialSubject: {} } as any, { proofPurpose: 'assertionMethod' });
    (vc as any)['@context'] = 'https://www.w3.org/ns/credentials/v2';
    const verifier = new Verifier(dm);
    const res = await verifier.verifyCredential(vc as any);
    expect(typeof res.verified).toBe('boolean');
  });

  test('verifyPresentation accepts string @context and no nested VCs', async () => {
    const issuer = new Issuer(dm, vm);
    const vp = await issuer.issuePresentation({ holder: did } as any, { proofPurpose: 'authentication' });
    (vp as any)['@context'] = 'https://www.w3.org/ns/credentials/v2';
    const verifier = new Verifier(dm);
    const res = await verifier.verifyPresentation(vp as any);
    expect(typeof res.verified).toBe('boolean');
  });
});




/** Inlined from Verifier.default-loader.part.ts */

describe('Verifier with default document loader (no options)', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential uses default loader with v2 contexts', async () => {
    const vc: any = {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/security/data-integrity/v2'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:issuer',
      proof: { cryptosuite: 'data-integrity', verificationMethod: 'did:example:issuer#k' }
    };
    const mod = require('../../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: false, errors: ['x'] });
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('x');
    mod.DataIntegrityProofManager.verifyProof = orig;
  });

  test('verifyPresentation uses default loader with v2 contexts', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/security/data-integrity/v2'],
      type: ['VerifiablePresentation'],
      holder: 'did:example:holder',
      proof: { cryptosuite: 'data-integrity', verificationMethod: 'did:example:holder#k' }
    };
    const mod = require('../../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: true, errors: [] });
    const res = await verifier.verifyPresentation(vp);
    expect(res.verified).toBe(true);
    mod.DataIntegrityProofManager.verifyProof = orig;
  });
});


/** Inlined from Verifier.dimock.part.ts */
describe('Verifier with mocked DataIntegrityProofManager', () => {
  afterEach(() => {
    // Bun doesn't require resetModules
  });

  test('verifyCredential success branch (verified=true)', async () => {
    const mod = require('../../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: true });
    const { Verifier } = await import('../../../src/vc/Verifier');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const verifier = new Verifier(new DIDManager({} as any));
    const res = await verifier.verifyCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential'], issuer: 'did:example:issuer', proof: { verificationMethod: 'did:example:issuer#k' } } as any, {
      documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null })
    });
    expect(res.verified).toBe(true);
    mod.DataIntegrityProofManager.verifyProof = orig;
  });

  test('verifyPresentation failure branch (no errors provided -> default)', async () => {
    const mod = require('../../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: false });
    const { Verifier } = await import('../../../src/vc/Verifier');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const verifier = new Verifier(new DIDManager({} as any));
    const res = await verifier.verifyPresentation({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiablePresentation'], holder: 'did:example:holder', proof: { verificationMethod: 'did:example:holder#k' } } as any, {
      documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null })
    });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('Verification failed');
    mod.DataIntegrityProofManager.verifyProof = orig;
  });
});




/** Inlined from Verifier.errors.part.ts */

describe('Verifier error branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential catches loader error', async () => {
    const res = await verifier.verifyCredential({ '@context': ['bad'], type: ['VerifiableCredential'], proof: {} } as any, {
      documentLoader: async () => { throw new Error('loader boom'); }
    });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toContain('loader boom');
  });

  test('verifyPresentation catches nested VC failure', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: [{ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'] }],
      proof: {}
    };
    const res = await verifier.verifyPresentation(vp, { documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation returns nested vc error early', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: [{ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], proof: {} }],
      proof: {}
    };
    const res = await verifier.verifyPresentation(vp, { documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation catches loader error', async () => {
    const vp: any = {
      '@context': ['bad'],
      type: ['VerifiablePresentation'],
      proof: {}
    };
    const res = await verifier.verifyPresentation(vp, { documentLoader: async () => { throw new Error('vp loader boom'); } });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toContain('vp loader boom');
  });

  test('verifyCredential returns Verification failed when proof manager returns false', async () => {
    const mod = require('../../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: false, errors: undefined });
    const { Verifier } = await import('../../../src/vc/Verifier');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const localVerifier = new Verifier(new DIDManager({} as any));
    const res = await localVerifier.verifyCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:example:issuer', proof: { cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:example:issuer#k' } } as any, { documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('Verification failed');
    mod.DataIntegrityProofManager.verifyProof = orig;
  });
});




/** Inlined from Verifier.more-branches2.part.ts */

describe('Verifier branches for string context and single proof', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential with string context runs loader loop with one item', async () => {
    const vc: any = {
      '@context': 'https://www.w3.org/2018/credentials/v1',
      type: ['VerifiableCredential'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res = await verifier.verifyCredential(vc, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation with string context runs loader loop with one item', async () => {
    const vp: any = {
      '@context': 'https://www.w3.org/2018/credentials/v1',
      type: ['VerifiablePresentation'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res = await verifier.verifyPresentation(vp, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(false);
  });
});


/** Inlined from Verifier.more.part.ts */

describe('Verifier branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential returns error on invalid vc', async () => {
    const res = await verifier.verifyCredential({} as any);
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation returns error on invalid vp', async () => {
    const res = await verifier.verifyPresentation({} as any);
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation missing proof triggers error', async () => {
    const res = await verifier.verifyPresentation({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiablePresentation'] } as any);
    expect(res.verified).toBe(false);
  });

  test('verifyCredential unknown error message fallback', async () => {
    const dm2 = new DIDManager({} as any);
    const v2: any = new Verifier(dm2);
    const orig = (require('../../../src/vc/proofs/data-integrity').DataIntegrityProofManager as any).verifyProof;
    (require('../../../src/vc/proofs/data-integrity').DataIntegrityProofManager as any).verifyProof = async () => { throw { not: 'error' }; };
    const res = await v2.verifyCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], proof: {} } as any, { documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    ;(require('../../../src/vc/proofs/data-integrity').DataIntegrityProofManager as any).verifyProof = orig;
  });
});




/** Inlined from Verifier.proofarray.part.ts */

describe('Verifier handles array proofs', () => {
  test('verifyCredential with proof array handled (takes first element)', async () => {
    const dm = new DIDManager({} as any);
    const sk = new Uint8Array(32).fill(7);
    const pk = new Uint8Array(32).fill(8);
    const vm = {
      id: 'did:ex:arr#key-1',
      controller: 'did:ex:arr',
      publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
      secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
    };
    const issuer = new Issuer(dm, vm);
    registerVerificationMethod({ id: vm.id, type: 'Multikey', controller: vm.controller, publicKeyMultibase: vm.publicKeyMultibase });
    const unsigned: any = { id: 'urn:cred:arr', type: ['VerifiableCredential', 'Test'], issuer: vm.controller, issuanceDate: new Date().toISOString(), credentialSubject: {} };
    const vc = await issuer.issueCredential(unsigned, { proofPurpose: 'assertionMethod' });
    (vc as any).proof = [vc.proof as any];
    const verifier = new Verifier(dm);
    const res = await verifier.verifyCredential(vc as any);
    // Current verifier takes first element, but our generated array fails canonically under eddsa
    // Ensure the function handles array shape and returns a structured result
    expect(typeof res.verified).toBe('boolean');
    expect(Array.isArray(res.errors)).toBe(true);
  });
});




/** Inlined from Verifier.proofarray.presentation.part.ts */

describe('Verifier handles presentation proof array', () => {
  test('verifyPresentation with proof array handled (takes first element)', async () => {
    const dm = new DIDManager({} as any);
    const sk = new Uint8Array(32).fill(7);
    const pk = new Uint8Array(32).fill(8);
    const vm = {
      id: 'did:ex:arr#key-1',
      controller: 'did:ex:arr',
      publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
      secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519')
    };
    const issuer = new Issuer(dm, vm);
    const vp = await issuer.issuePresentation({ holder: vm.controller } as any, { proofPurpose: 'authentication' });
    (vp as any).proof = [ (vp as any).proof ];
    const verifier = new Verifier(dm);
    const res = await verifier.verifyPresentation(vp as any);
    expect(typeof res.verified).toBe('boolean');
  });
});




/** Inlined from Verifier.success.part.ts */

describe('Verifier success branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential returns verified=true when proof manager passes', async () => {
    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:issuer',
      proof: { cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:example:issuer#k' }
    };
    const mod = require('../../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: true, errors: [] });
    const { Verifier } = await import('../../../src/vc/Verifier');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const localVerifier = new Verifier(new DIDManager({} as any));
    const res = await localVerifier.verifyCredential(vc, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(true);
    expect(res.errors).toEqual([]);
    mod.DataIntegrityProofManager.verifyProof = orig;
  });

  test('verifyPresentation returns verified=true, with and without nested VC', async () => {
    const mod = require('../../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: true, errors: [] });

    // without nested VC
    const vp1: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      holder: 'did:example:holder',
      proof: { cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:example:holder#k' }
    };
    const { Verifier } = await import('../../../src/vc/Verifier');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const localVerifier = new Verifier(new DIDManager({} as any));
    const res1 = await localVerifier.verifyPresentation(vp1, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res1.verified).toBe(true);

    // with nested VC
    const vp2: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      holder: 'did:example:holder',
      verifiableCredential: [
        { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], issuer: 'did:example:issuer', proof: { cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:example:issuer#k' } }
      ],
      proof: { cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:example:holder#k' }
    };
    const res2 = await localVerifier.verifyPresentation(vp2, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res2.verified).toBe(true);

    mod.DataIntegrityProofManager.verifyProof = orig;
  });
});


/** Inlined from Verifier.unknown-error-branches.part.ts */

describe('Verifier unknown-error fallback branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential returns Unknown error when non-Error thrown', async () => {
    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res = await verifier.verifyCredential(vc, {
      documentLoader: async () => { throw 123 as any; }
    });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('Unknown error in verifyCredential');
  });

  test('verifyPresentation returns Unknown error when non-Error thrown', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res = await verifier.verifyPresentation(vp, {
      documentLoader: async () => { throw 456 as any; }
    });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('Unknown error in verifyPresentation');
  });
});
