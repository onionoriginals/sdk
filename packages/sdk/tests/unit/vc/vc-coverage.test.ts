/**
 * vc-coverage.test.ts
 *
 * Closes coverage gaps in the VC layer. Tests are labelled with their scenario
 * IDs (VC-001 through VC-018) for traceability.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { MultiSigManager } from '../../../src/vc/MultiSigManager';
import { Verifier } from '../../../src/vc/Verifier';
import { StatusListManager } from '../../../src/vc/StatusListManager';
import { BBSCryptosuiteManager } from '../../../src/vc/cryptosuites/bbsCryptosuite';
import { KeyManager } from '../../../src/did/KeyManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { multikey } from '../../../src/crypto/Multikey';
import {
  verificationMethodRegistry,
  registerVerificationMethod,
} from '../../../src/vc/documentLoader';
import { PRELOADED_CONTEXTS } from '../../../src/utils/serialization';
import type {
  VerifiableCredential,
  EscrowPolicy,
  CorporatePolicy,
  MultiSigPolicy,
  OriginalsConfig,
} from '../../../src/types';

// ─── shared config ──────────────────────────────────────────────────────────

const config: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
};

/** Minimal document loader backed by the SDK's bundled context cache. */
const preloadedLoader = async (url: string) => {
  const doc = (PRELOADED_CONTEXTS as Record<string, unknown>)[url];
  if (doc) return { document: doc, documentUrl: url, contextUrl: null as null };
  // For DID URLs return a stub that satisfies the loader contract
  if (url.startsWith('did:')) return { document: { '@context': [] }, documentUrl: url, contextUrl: null as null };
  throw new Error(`Document not found in preloaded contexts: ${url}`);
};

// ─── VC-001 ──────────────────────────────────────────────────────────────────

describe('VC-001/error – credential with missing issuer fails verification', () => {
  const cm = new CredentialManager(config);

  test('createResourceCredential stores the issuer as-is (no validation at factory time)', () => {
    const vc = cm.createResourceCredential('ResourceCreated', { id: 'did:peer:s' }, '');
    // Factory does NOT throw – it just stores whatever was passed
    expect(vc.issuer).toBe('');
  });

  test('credential with empty issuer cannot be verified (signature binding is broken)', async () => {
    const km = new KeyManager();
    const { privateKey: sk, publicKey: pk } = await km.generateKeyPair('Ed25519');
    const correctDid = `did:key:${pk}`;

    // Create with correct issuer so signing succeeds
    const vc = cm.createResourceCredential('ResourceCreated', { id: correctDid }, correctDid);
    const signed = await cm.signCredential(vc, sk, correctDid);

    // Tamper: strip the issuer so verification key binding is broken
    const tampered = { ...signed, issuer: '' };
    const result = await cm.verifyCredential(tampered);
    expect(result).toBe(false);
  });
});

describe('VC-001/boundary – very large credentialSubject signs and can be hashed', () => {
  const cm = new CredentialManager(config);

  test('credential with 500-field subject is created and canonicalized without error', async () => {
    const subject: Record<string, unknown> = { id: 'did:peer:largesubject' };
    for (let i = 0; i < 500; i++) {
      subject[`field_${i}`] = `value_${'x'.repeat(50)}_${i}`;
    }

    const vc = cm.createResourceCredential('ResourceCreated', subject, 'did:peer:issuer');
    expect(Object.keys(vc.credentialSubject).length).toBe(501); // 500 fields + id

    // computeCredentialHash exercises canonicalization on the large document
    const hash = await cm.computeCredentialHash(vc);
    expect(hash).toHaveLength(64); // SHA-256 hex
  });
});

// ─── VC-003 ──────────────────────────────────────────────────────────────────

describe('VC-003/happy – statusListResolver called during Verifier.checkCredentialStatus', () => {
  test('resolver is invoked and status check passes for an un-revoked credential', async () => {
    const dm = new DIDManager({} as any);
    const slMgr = new StatusListManager();
    const statusListVC = slMgr.createStatusListCredential({
      id: 'https://example.com/status/list-1',
      issuer: 'did:peer:issuer',
      statusPurpose: 'revocation',
    });
    // DI-labeled dummy proof: the trust check dispatches on cryptosuite, and
    // the DI path is stubbed below (see verifyCredential override).
    (statusListVC as any).proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', proofValue: 'zstub', verificationMethod: 'did:peer:issuer#key-0', proofPurpose: 'assertionMethod' };

    let resolverCallCount = 0;
    let resolvedUrl = '';

    const verifier = new Verifier(dm, {
      statusListResolver: async (url: string) => {
        resolverCallCount++;
        resolvedUrl = url;
        return statusListVC;
      },
    });
    // The status list fixture is unsigned; stub the proof check so this test
    // stays focused on resolver invocation (trust checks are covered in
    // Verifier status-list trust tests).
    (verifier as any).verifyCredential = async () => ({ verified: true, errors: [] });

    const entry = slMgr.allocateStatusEntry(
      'https://example.com/status/list-1',
      42,
      'revocation'
    );

    const credentialWithStatus: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
      credentialStatus: entry,
    };

    const result = await verifier.checkCredentialStatus(credentialWithStatus);

    // Resolver was called exactly once
    expect(resolverCallCount).toBe(1);
    expect(resolvedUrl).toBe('https://example.com/status/list-1');
    // Status bit 42 is not set → passes
    expect(result.verified).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('checkCredentialStatus returns not-verified when credential is revoked', async () => {
    const dm = new DIDManager({} as any);
    const slMgr = new StatusListManager();
    let statusListVC = slMgr.createStatusListCredential({
      id: 'https://example.com/status/list-rev',
      issuer: 'did:peer:issuer',
      statusPurpose: 'revocation',
    });
    (statusListVC as any).proof = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', proofValue: 'zstub', verificationMethod: 'did:peer:issuer#key-0', proofPurpose: 'assertionMethod' };
    // Revoke index 5
    statusListVC = slMgr.setStatus(statusListVC, 5, true);

    const verifier = new Verifier(dm, {
      statusListResolver: async () => statusListVC,
    });
    // Unsigned fixture — stub the status list proof check (see note above).
    (verifier as any).verifyCredential = async () => ({ verified: true, errors: [] });

    const entry = slMgr.allocateStatusEntry(
      'https://example.com/status/list-rev',
      5,
      'revocation'
    );

    const credentialWithStatus: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
      credentialStatus: entry,
    };

    const result = await verifier.checkCredentialStatus(credentialWithStatus);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => e.includes('revoked'))).toBe(true);
  });
});

// ─── VC-006 ──────────────────────────────────────────────────────────────────

describe('VC-006/happy – multi-sig session collects m-of-n and threshold passes', () => {
  const km = new KeyManager();
  let keys: Array<{ privateKey: string; publicKey: string }>;
  let vms: string[];
  let mgr: MultiSigManager;
  const baseVC: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject' },
  };

  beforeEach(async () => {
    keys = await Promise.all([
      km.generateKeyPair('Ed25519'),
      km.generateKeyPair('Ed25519'),
      km.generateKeyPair('Ed25519'),
    ]);
    vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    mgr = new MultiSigManager(config, new DIDManager(config));
  });

  test('2-of-3 session: create → collect 2 contributions → finalize → threshold verified', async () => {
    const policy: MultiSigPolicy = {
      required: 2,
      total: 3,
      signerVerificationMethods: vms,
    };

    const session = mgr.createSession(baseVC, policy);
    expect(session.status).toBe('collecting');
    expect(session.contributions).toHaveLength(0);

    // First signer contributes
    const c1 = await mgr.createContribution(session.id, keys[0].privateKey, vms[0]);
    const s1 = await mgr.addContribution(session.id, c1);
    expect(s1.status).toBe('collecting');
    expect(s1.contributions).toHaveLength(1);

    // Second signer hits threshold
    const c2 = await mgr.createContribution(session.id, keys[1].privateKey, vms[1]);
    const s2 = await mgr.addContribution(session.id, c2);
    expect(s2.status).toBe('threshold_met');
    expect(s2.contributions).toHaveLength(2);

    // Finalize produces credential with 2 proofs
    const finalized = mgr.finalizeSession(session.id);
    expect(Array.isArray(finalized.proof)).toBe(true);
    expect((finalized.proof as unknown[]).length).toBe(2);

    // Full verification against policy
    const result = await mgr.verifyMultiSig(finalized, policy);
    expect(result.verified).toBe(true);
    expect(result.validSignatures).toBe(2);
    expect(result.validSigners).toContain(vms[0]);
    expect(result.validSigners).toContain(vms[1]);
  });
});

describe('VC-006/error – finalize before threshold throws insufficient-signatures error', () => {
  const km = new KeyManager();
  let keys: Array<{ privateKey: string; publicKey: string }>;
  let vms: string[];
  let mgr: MultiSigManager;

  const baseVC: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject' },
  };

  beforeEach(async () => {
    keys = await Promise.all([km.generateKeyPair('Ed25519'), km.generateKeyPair('Ed25519'), km.generateKeyPair('Ed25519')]);
    vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    mgr = new MultiSigManager(config, new DIDManager(config));
  });

  test('finalizeSession with 1 of 2 required signatures throws "Cannot finalize"', async () => {
    const policy: MultiSigPolicy = {
      required: 2,
      total: 3,
      signerVerificationMethods: vms,
    };

    const session = mgr.createSession(baseVC, policy);
    const c1 = await mgr.createContribution(session.id, keys[0].privateKey, vms[0]);
    await mgr.addContribution(session.id, c1);
    // Only 1 contribution; threshold is 2

    expect(() => mgr.finalizeSession(session.id)).toThrow(/Cannot finalize/);
  });

  test('finalizeSession error message includes collected/required counts', async () => {
    const policy: MultiSigPolicy = {
      required: 3,
      total: 3,
      signerVerificationMethods: vms,
    };

    const session = mgr.createSession(baseVC, policy);
    // Zero contributions
    let caughtMessage = '';
    try {
      mgr.finalizeSession(session.id);
    } catch (e) {
      caughtMessage = (e as Error).message;
    }
    expect(caughtMessage).toMatch(/0\/3 signatures collected/);
  });
});

// ─── VC-007 ──────────────────────────────────────────────────────────────────

describe('VC-007/happy – escrow policy with release conditions passes validation', () => {
  let mgr: MultiSigManager;
  let vms: string[];

  beforeEach(async () => {
    const km = new KeyManager();
    const keys = await Promise.all([
      km.generateKeyPair('Ed25519'),
      km.generateKeyPair('Ed25519'),
      km.generateKeyPair('Ed25519'),
    ]);
    vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    mgr = new MultiSigManager(config, new DIDManager(config));
  });

  test('validateEscrowPolicy accepts a complete escrow policy', () => {
    const policy: EscrowPolicy = {
      required: 2,
      total: 3,
      signerVerificationMethods: vms,
      escrowAgent: vms[2],
      releaseConditions: 'Both parties sign and time-lock expires',
      escrowSignatureRequired: true,
    };
    expect(() => mgr.validateEscrowPolicy(policy)).not.toThrow();
  });

  test('validateEscrowPolicy accepts policy without mandatory escrow signature', () => {
    const policy: EscrowPolicy = {
      required: 1,
      total: 2,
      signerVerificationMethods: [vms[0], vms[1]],
      escrowAgent: vms[1],
      releaseConditions: 'Counter-party confirms delivery',
      escrowSignatureRequired: false,
    };
    expect(() => mgr.validateEscrowPolicy(policy)).not.toThrow();
  });
});

describe('VC-007/error – escrow policy without escrow agent is rejected', () => {
  test('validateEscrowPolicy throws "must specify an escrow agent" when escrowAgent is empty', () => {
    const mgr = new MultiSigManager(config, new DIDManager(config));
    const policy: EscrowPolicy = {
      required: 1,
      total: 1,
      signerVerificationMethods: ['did:key:vm1'],
      escrowAgent: '',          // empty → invalid
      releaseConditions: 'On mutual agreement',
      escrowSignatureRequired: false,
    };
    expect(() => mgr.validateEscrowPolicy(policy)).toThrow(/must specify an escrow agent/);
  });

  test('validateEscrowPolicy throws when releaseConditions is empty', () => {
    const mgr = new MultiSigManager(config, new DIDManager(config));
    const policy: EscrowPolicy = {
      required: 1,
      total: 1,
      signerVerificationMethods: ['did:key:vm1'],
      escrowAgent: 'did:key:vm1',
      releaseConditions: '',    // empty → invalid
      escrowSignatureRequired: false,
    };
    expect(() => mgr.validateEscrowPolicy(policy)).toThrow(/release conditions/);
  });
});

// ─── VC-008 ──────────────────────────────────────────────────────────────────

describe('VC-008/happy – corporate policy with role-based signers passes validation', () => {
  let mgr: MultiSigManager;
  let vms: string[];

  beforeEach(async () => {
    const km = new KeyManager();
    const keys = await Promise.all([
      km.generateKeyPair('Ed25519'),
      km.generateKeyPair('Ed25519'),
      km.generateKeyPair('Ed25519'),
    ]);
    vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    mgr = new MultiSigManager(config, new DIDManager(config));
  });

  test('validateCorporatePolicy accepts a policy where all mandatory roles are assigned', () => {
    const policy: CorporatePolicy = {
      required: 2,
      total: 3,
      signerVerificationMethods: vms,
      roles: new Map([
        [vms[0], 'CEO'],
        [vms[1], 'CFO'],
        [vms[2], 'Legal'],
      ]),
      mandatoryRoles: ['CEO', 'CFO'],
    };
    expect(() => mgr.validateCorporatePolicy(policy)).not.toThrow();
  });

  test('validateCorporatePolicy accepts policy without mandatory roles', () => {
    const policy: CorporatePolicy = {
      required: 1,
      total: 2,
      signerVerificationMethods: [vms[0], vms[1]],
      roles: new Map([
        [vms[0], 'Admin'],
        [vms[1], 'User'],
      ]),
    };
    expect(() => mgr.validateCorporatePolicy(policy)).not.toThrow();
  });
});

describe('VC-008/error – corporate policy with unassigned mandatory role is rejected', () => {
  test('validateCorporatePolicy throws "Mandatory role not assigned to any signer"', async () => {
    const km = new KeyManager();
    const keys = await Promise.all([km.generateKeyPair('Ed25519'), km.generateKeyPair('Ed25519')]);
    const vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    const mgr = new MultiSigManager(config, new DIDManager(config));

    const policy: CorporatePolicy = {
      required: 1,
      total: 2,
      signerVerificationMethods: vms,
      roles: new Map([
        [vms[0], 'CEO'],
        [vms[1], 'CFO'],
      ]),
      mandatoryRoles: ['Legal'],   // not assigned to any signer
    };
    expect(() => mgr.validateCorporatePolicy(policy)).toThrow(/Mandatory role.*not assigned to any signer/);
  });

  test('error message names the unassigned role', async () => {
    const km = new KeyManager();
    const keys = await Promise.all([km.generateKeyPair('Ed25519')]);
    const vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    const mgr = new MultiSigManager(config, new DIDManager(config));

    const policy: CorporatePolicy = {
      required: 1,
      total: 1,
      signerVerificationMethods: vms,
      roles: new Map([[vms[0], 'CEO']]),
      mandatoryRoles: ['Treasurer'],
    };
    let msg = '';
    try { mgr.validateCorporatePolicy(policy); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('Mandatory role');
    expect(msg).toContain('Treasurer');
  });
});

// ─── VC-010 ──────────────────────────────────────────────────────────────────

describe('VC-010/happy – prepareSelectiveDisclosure with mandatory + selective pointers', () => {
  const cm = new CredentialManager(config);

  const credential: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: '2024-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:peer:subject',
      name: 'Alice',
      email: 'alice@example.com',
      age: 30,
    },
  };

  test('returns credential and pointer arrays without BBS+ key (metadata-only mode)', async () => {
    const result = await cm.prepareSelectiveDisclosure(credential, {
      mandatoryPointers: ['/issuer', '/issuanceDate', '/credentialSubject/id'],
      selectivePointers: ['/credentialSubject/name', '/credentialSubject/age'],
    });

    expect(result.credential).toBeDefined();
    expect(result.mandatoryPointers).toContain('/issuer');
    expect(result.mandatoryPointers).toContain('/issuanceDate');
    expect(result.mandatoryPointers).toContain('/credentialSubject/id');
    expect(result.selectivePointers).toContain('/credentialSubject/name');
    expect(result.selectivePointers).toContain('/credentialSubject/age');
    // email is neither mandatory nor selective — not in selectivePointers
    expect(result.selectivePointers).not.toContain('/credentialSubject/email');
  });

  test('works when selectivePointers is omitted (defaults to empty array)', async () => {
    const result = await cm.prepareSelectiveDisclosure(credential, {
      mandatoryPointers: ['/issuer'],
    });
    expect(result.selectivePointers).toHaveLength(0);
  });
});

describe('VC-010/invalid-input – invalid JSON Pointer in selective or mandatory pointer list', () => {
  const cm = new CredentialManager(config);
  const credential: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: '2024-01-01T00:00:00Z',
    credentialSubject: { id: 'did:peer:subject' },
  };

  test('rejects selective pointer missing leading slash with "Invalid JSON Pointer"', async () => {
    await expect(
      cm.prepareSelectiveDisclosure(credential, {
        mandatoryPointers: ['/issuer'],
        selectivePointers: ['credentialSubject/name'],  // missing /
      })
    ).rejects.toThrow(/Invalid JSON Pointer/);
  });

  test('rejects mandatory pointer missing leading slash with "Invalid JSON Pointer"', async () => {
    await expect(
      cm.prepareSelectiveDisclosure(credential, {
        mandatoryPointers: ['issuer'],   // missing /
      })
    ).rejects.toThrow(/Invalid JSON Pointer/);
  });
});

// ─── VC-011 ──────────────────────────────────────────────────────────────────

describe('VC-011/happy – deriveSelectiveProof (fallback without real BBS+ base proof)', () => {
  // NOTE: BbsSimple.sign/createProof is not yet implemented (throws "not implemented").
  // The fallback path in deriveSelectiveProof is exercised when the credential
  // lacks a bbs-2023 proof — it returns the credential unchanged with field lists.
  const cm = new CredentialManager(config);

  const credential: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: '2024-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:peer:subject',
      name: 'Alice',
      email: 'alice@example.com',
    },
  };

  test('disclosedFields matches the provided pointer list', async () => {
    const result = await cm.deriveSelectiveProof(credential, [
      '/issuer',
      '/credentialSubject/name',
    ]);

    expect(result.disclosedFields).toContain('/issuer');
    expect(result.disclosedFields).toContain('/credentialSubject/name');
    expect(result.hiddenFields).toContain('/credentialSubject/email');
    expect(result.credential).toBeDefined();
  });

  test('hiddenFields and disclosedFields are disjoint', async () => {
    const result = await cm.deriveSelectiveProof(credential, ['/issuer']);
    const disclosedSet = new Set(result.disclosedFields);
    for (const f of result.hiddenFields) {
      expect(disclosedSet.has(f)).toBe(false);
    }
  });

  test('throws "Invalid JSON Pointer" for field path without leading slash', async () => {
    await expect(
      cm.deriveSelectiveProof(credential, ['issuer'])
    ).rejects.toThrow(/Invalid JSON Pointer/);
  });
});

describe('VC-011/boundary – deriveSelectiveProof with only mandatory fields (empty selective)', () => {
  const cm = new CredentialManager(config);

  const credential: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: '2024-01-01T00:00:00Z',
    credentialSubject: { id: 'did:peer:subject', name: 'Alice' },
  };

  test('empty disclosure list → zero disclosedFields, all fields in hiddenFields', async () => {
    const result = await cm.deriveSelectiveProof(credential, []);
    expect(result.disclosedFields).toHaveLength(0);
    expect(result.hiddenFields.length).toBeGreaterThan(0);
  });

  test('disclosing all top-level paths → none appear in hiddenFields', async () => {
    const allPaths = [
      '/@context',
      '/type',
      '/issuer',
      '/issuanceDate',
      '/credentialSubject',
      '/credentialSubject/id',
      '/credentialSubject/name',
    ];
    const result = await cm.deriveSelectiveProof(credential, allPaths);
    const hiddenSet = new Set(result.hiddenFields);
    for (const p of allPaths) {
      expect(hiddenSet.has(p)).toBe(false);
    }
  });
});

// ─── VC-013 ──────────────────────────────────────────────────────────────────

describe('VC-013/happy – BBSCryptosuiteManager.createProof (selective-disclosure baseline)', () => {
  // NOTE: BbsSimple.sign is not yet implemented ("BbsSimple.sign is not implemented").
  // This test documents the ACTUAL behavior: createProof throws "not implemented"
  // when a real BLS12-381 key pair is supplied. The test also verifies correct
  // error handling for missing private key.

  test('createProof with Uint8Array BLS12-381 key pair throws "not implemented" (BbsSimple stub)', async () => {
    const sk = bls.utils.randomSecretKey();
    const pk = bls.shortSignatures.getPublicKey(sk).toBytes();

    await expect(
      BBSCryptosuiteManager.createProof(
        {
          '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
          type: ['VerifiableCredential'],
          issuer: 'did:peer:issuer',
          issuanceDate: '2024-01-01T00:00:00Z',
          credentialSubject: { id: 'did:peer:subject' },
        },
        {
          verificationMethod: 'did:peer:issuer#bbs-1',
          proofPurpose: 'assertionMethod',
          privateKey: sk,
          publicKey: pk,
          documentLoader: preloadedLoader,
          mandatoryPointers: ['/issuer', '/issuanceDate'],
        }
      )
    ).rejects.toThrow(/not implemented/i);
  });

  test('createProof without private key throws "Private key required"', async () => {
    await expect(
      BBSCryptosuiteManager.createProof(
        {
          '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
          type: ['VerifiableCredential'],
          issuer: 'did:peer:issuer',
          issuanceDate: '2024-01-01T00:00:00Z',
          credentialSubject: { id: 'did:peer:subject' },
        },
        {
          verificationMethod: 'did:peer:issuer#bbs-1',
          proofPurpose: 'assertionMethod',
          // No privateKey provided
          documentLoader: preloadedLoader,
          mandatoryPointers: ['/issuer'],
        }
      )
    ).rejects.toThrow(/Private key required/);
  });
});

// ─── VC-016 ──────────────────────────────────────────────────────────────────

describe('VC-016/boundary – verifyPresentation with string (non-array) @context', () => {
  // The verifier's context-loading loop converts a string @context to [string]
  // and proceeds without throwing. This exercises the `String(vpContext)` branch.

  const dm = new DIDManager({} as any);

  test('verifyPresentation processes string @context without crashing', async () => {
    const did = 'did:peer:vc016';
    const sk = new Uint8Array(32).map((_, i) => (i + 16) & 0xff);
    const pk = ed25519.getPublicKey(sk);
    const vm = {
      id: `${did}#keys-1`,
      controller: did,
      type: 'Multikey',
      publicKeyMultibase: multikey.encodePublicKey(pk, 'Ed25519'),
      secretKeyMultibase: multikey.encodePrivateKey(sk, 'Ed25519'),
    };
    registerVerificationMethod(vm);

    const { Issuer } = await import('../../../src/vc/Issuer');
    const issuer = new Issuer(dm, vm);
    const vp = await issuer.issuePresentation(
      { type: ['VerifiablePresentation'], holder: did } as any,
      { proofPurpose: 'authentication' }
    );

    // Mutate @context to a plain string (the boundary condition)
    (vp as any)['@context'] = 'https://www.w3.org/ns/credentials/v2';

    const verifier = new Verifier(dm);
    const res = await verifier.verifyPresentation(vp as any);

    // The branch executes (no throw); result is a properly structured object
    expect(typeof res.verified).toBe('boolean');
    expect(Array.isArray(res.errors)).toBe(true);
  });
});

// ─── VC-017 ──────────────────────────────────────────────────────────────────

describe('VC-017 – getFieldByPointer', () => {
  const cm = new CredentialManager(config);

  const credential: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: '2024-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:peer:subject',
      profile: {
        name: 'Alice',
        address: {
          city: 'New York',
          zip: '10001',
        },
      },
    },
  };

  test('happy – retrieves top-level field with JSON Pointer', () => {
    expect(cm.getFieldByPointer(credential, '/issuer')).toBe('did:peer:issuer');
    expect(cm.getFieldByPointer(credential, '/issuanceDate')).toBe('2024-01-01T00:00:00Z');
  });

  test('happy – retrieves nested field via JSON Pointer', () => {
    expect(cm.getFieldByPointer(credential, '/credentialSubject/profile/name')).toBe('Alice');
    expect(cm.getFieldByPointer(credential, '/credentialSubject/profile/address/city')).toBe('New York');
    expect(cm.getFieldByPointer(credential, '/credentialSubject/profile/address/zip')).toBe('10001');
  });

  test('invalid-input – rejects pointer missing leading slash', () => {
    expect(() => cm.getFieldByPointer(credential, 'issuer')).toThrow('JSON Pointer must start with /');
    expect(() => cm.getFieldByPointer(credential, 'credentialSubject/id')).toThrow('JSON Pointer must start with /');
  });

  test('boundary – escaped characters ~0 (tilde) and ~1 (slash) handled correctly', () => {
    const specialCred: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: '2024-01-01T00:00:00Z',
      credentialSubject: {
        id: 'did:peer:subject',
        'a/b': 'slash-value',   // key contains literal /
        'c~d': 'tilde-value',   // key contains literal ~
      },
    };

    // RFC 6901: ~1 in a pointer token decodes to /
    expect(cm.getFieldByPointer(specialCred, '/credentialSubject/a~1b')).toBe('slash-value');
    // RFC 6901: ~0 in a pointer token decodes to ~
    expect(cm.getFieldByPointer(specialCred, '/credentialSubject/c~0d')).toBe('tilde-value');
  });

  test('returns undefined for non-existent path', () => {
    expect(cm.getFieldByPointer(credential, '/nonexistent')).toBeUndefined();
    expect(cm.getFieldByPointer(credential, '/credentialSubject/noField')).toBeUndefined();
  });
});

// ─── VC-018 ──────────────────────────────────────────────────────────────────

describe('VC-018/performance – verification method caching (behavioral, not wall-clock)', () => {
  // The verificationMethodRegistry is a module-level Map. Once a VM is registered,
  // every subsequent lookup returns the same object reference — O(1) Map.get.
  // This test asserts the caching property (identity equality on repeated lookups).

  test('registered VM returns same object reference on repeated lookups', () => {
    const vmId = `did:peer:cache-vm-test#key-${Date.now()}`;
    const vm = {
      id: vmId,
      type: 'Multikey',
      controller: 'did:peer:cache-vm-test',
      publicKeyMultibase: 'zPubKey',
    };

    registerVerificationMethod(vm);

    const first = verificationMethodRegistry.get(vmId);
    const second = verificationMethodRegistry.get(vmId);
    const third = verificationMethodRegistry.get(vmId);

    // Same reference every time — no re-creation on repeated access
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first?.id).toBe(vmId);
  });

  test('cache stores the exact registered object (no defensive copy)', () => {
    const vmId = `did:peer:cache-exact-${Date.now()}`;
    const vm: Record<string, unknown> & { id: string } = {
      id: vmId,
      type: 'Multikey',
      controller: 'did:peer:cache-exact',
      publicKeyMultibase: 'zExactPubKey',
    };

    registerVerificationMethod(vm);

    const cached = verificationMethodRegistry.get(vmId);
    // The stored value is the same object that was passed in
    expect(cached).toBe(vm);
  });

  test('different VMs are cached independently under their own IDs', () => {
    const vm1Id = `did:peer:cache-a-${Date.now()}`;
    const vm2Id = `did:peer:cache-b-${Date.now()}`;

    const vm1 = { id: vm1Id, type: 'Multikey', controller: 'did:peer:a', publicKeyMultibase: 'zKey1' };
    const vm2 = { id: vm2Id, type: 'Multikey', controller: 'did:peer:b', publicKeyMultibase: 'zKey2' };

    registerVerificationMethod(vm1);
    registerVerificationMethod(vm2);

    expect(verificationMethodRegistry.get(vm1Id)).toBe(vm1);
    expect(verificationMethodRegistry.get(vm2Id)).toBe(vm2);
    expect(verificationMethodRegistry.get(vm1Id)).not.toBe(verificationMethodRegistry.get(vm2Id));
  });
});

// ─── Issue #239 — multi-sig verification paths ───────────────────────────────

describe('Issue #239 – multi-sig Data Integrity proofs verify across both verify paths and non-did:key signers', () => {
  const km = new KeyManager();
  const config: OriginalsConfig = { network: 'regtest', defaultKeyType: 'Ed25519', enableLogging: false };
  const baseVC: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject' },
  };

  test('the same multi-sig credential verifies at its threshold through BOTH verify paths', async () => {
    const keys = await Promise.all([km.generateKeyPair('Ed25519'), km.generateKeyPair('Ed25519')]);
    const vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    const dm = new DIDManager(config);
    const mgr = new MultiSigManager(config, dm);
    const policy: MultiSigPolicy = { required: 2, total: 2, signerVerificationMethods: vms };

    const signed = await mgr.signCredentialMultiSig(baseVC, {
      policy,
      privateKeys: new Map([[vms[0], keys[0].privateKey], [vms[1], keys[1].privateKey]]),
    });

    // The same credential must verify at its threshold through BOTH paths
    const viaManager = await mgr.verifyMultiSig(signed, policy);
    expect(viaManager.verified).toBe(true);

    const verifier = new Verifier(dm);
    const viaVerifier = await verifier.verifyCredentialMultiSig(signed, policy);
    expect(viaVerifier.verified).toBe(true);
    expect(viaVerifier.validSignatures).toBe(2);
  });

  test('MultiSigManager verifies signers whose verification methods are not did:key', async () => {
    const key = await km.generateKeyPair('Ed25519');
    const signerDid = 'did:webvh:QmScidExample:signers.example.com:alice';
    const vmId = `${signerDid}#key-0`;

    const dm = new DIDManager(config);
    // Stub DID resolution: the signer's did:webvh document publishes the key
    (dm as any).resolveDID = async (did: string) =>
      did === signerDid
        ? {
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: signerDid,
            verificationMethod: [
              { id: vmId, type: 'Multikey', controller: signerDid, publicKeyMultibase: key.publicKey }
            ]
          }
        : null;

    const mgr = new MultiSigManager(config, dm);
    const policy: MultiSigPolicy = { required: 1, total: 1, signerVerificationMethods: [vmId] };

    const signed = await mgr.signCredentialMultiSig(baseVC, {
      policy,
      privateKeys: new Map([[vmId, key.privateKey]]),
    });

    const result = await mgr.verifyMultiSig(signed, policy);
    expect(result.verified).toBe(true);
    expect(result.validSigners).toContain(vmId);
  });

  test('unsupported cryptosuites fail closed instead of being checked against the wrong digest', async () => {
    const key = await km.generateKeyPair('Ed25519');
    const vm = `did:key:${key.publicKey}#${key.publicKey}`;
    const dm = new DIDManager(config);
    const mgr = new MultiSigManager(config, dm);
    const policy: MultiSigPolicy = { required: 1, total: 1, signerVerificationMethods: [vm] };

    const signed = await mgr.signCredentialMultiSig(baseVC, {
      policy,
      privateKeys: new Map([[vm, key.privateKey]]),
    });
    // Relabel the valid legacy proof with a bogus cryptosuite
    const tampered = {
      ...signed,
      proof: (Array.isArray(signed.proof) ? signed.proof : [signed.proof]).map(p => ({
        ...(p as object), cryptosuite: 'ecdsa-jcs-2019'
      }))
    } as VerifiableCredential;

    const result = await mgr.verifyMultiSig(tampered, policy);
    expect(result.verified).toBe(false);
  });
});
