import { describe, test, expect, beforeAll } from 'bun:test';
import { MultiSigManager } from '../../../src/vc/MultiSigManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { OriginalsSDK } from '../../../src';
import type {
  VerifiableCredential,
  MultiSigPolicy,
  EscrowPolicy,
  CorporatePolicy,
  OriginalsConfig,
} from '../../../src/types';

describe('MultiSigManager', () => {
  const config: OriginalsConfig = {
    network: 'regtest',
    defaultKeyType: 'Ed25519',
  };

  const keyManager = new KeyManager();
  let keys: Array<{ privateKey: string; publicKey: string }>;
  let vms: string[];
  let manager: MultiSigManager;
  let baseVC: VerifiableCredential;

  beforeAll(async () => {
    // Generate 5 key pairs for testing
    keys = await Promise.all([
      keyManager.generateKeyPair('Ed25519'),
      keyManager.generateKeyPair('Ed25519'),
      keyManager.generateKeyPair('Ed25519'),
      keyManager.generateKeyPair('Ed25519'),
      keyManager.generateKeyPair('Ed25519'),
    ]);

    // Verification methods are did:key:<publicKey>
    vms = keys.map(k => `did:key:${k.publicKey}`);

    manager = new MultiSigManager(config);

    baseVC = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'ResourceCreated'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: 'did:peer:subject',
        resourceId: 'res1',
        resourceType: 'text',
        creator: 'did:peer:issuer',
        createdAt: new Date().toISOString(),
      },
    };
  });

  // ===== Policy Validation =====

  describe('validatePolicy', () => {
    test('accepts valid 2-of-3 policy', () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };
      expect(() => manager.validatePolicy(policy)).not.toThrow();
    });

    test('accepts valid 1-of-1 policy', () => {
      const policy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
      };
      expect(() => manager.validatePolicy(policy)).not.toThrow();
    });

    test('rejects required > total', () => {
      const policy: MultiSigPolicy = {
        required: 3,
        total: 2,
        signerVerificationMethods: [vms[0], vms[1]],
      };
      expect(() => manager.validatePolicy(policy)).toThrow(/required cannot exceed total/);
    });

    test('rejects required < 1', () => {
      const policy: MultiSigPolicy = {
        required: 0,
        total: 2,
        signerVerificationMethods: [vms[0], vms[1]],
      };
      expect(() => manager.validatePolicy(policy)).toThrow(/at least 1 signature/);
    });

    test('rejects mismatched VM count', () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1]], // only 2, not 3
      };
      expect(() => manager.validatePolicy(policy)).toThrow(/signer verification methods but total is/);
    });

    test('rejects duplicate VMs', () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[0], vms[1]],
      };
      expect(() => manager.validatePolicy(policy)).toThrow(/duplicate/);
    });

    test('accepts policy with valid timelock', () => {
      const now = new Date();
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        timelockStart: now.toISOString(),
        timelockEnd: new Date(now.getTime() + 86400000).toISOString(),
      };
      expect(() => manager.validatePolicy(policy)).not.toThrow();
    });

    test('rejects timelock with start >= end', () => {
      const now = new Date();
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        timelockStart: now.toISOString(),
        timelockEnd: new Date(now.getTime() - 1000).toISOString(),
      };
      expect(() => manager.validatePolicy(policy)).toThrow(/start must be before end/);
    });
  });

  // ===== Timelock =====

  describe('isTimelockValid', () => {
    test('returns true when no timelock set', () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };
      expect(manager.isTimelockValid(policy)).toBe(true);
    });

    test('returns false before timelock start', () => {
      const future = new Date(Date.now() + 86400000);
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        timelockStart: future.toISOString(),
      };
      expect(manager.isTimelockValid(policy)).toBe(false);
    });

    test('returns false after timelock end', () => {
      const past = new Date(Date.now() - 86400000);
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        timelockEnd: past.toISOString(),
      };
      expect(manager.isTimelockValid(policy)).toBe(false);
    });

    test('returns true within timelock window', () => {
      const past = new Date(Date.now() - 86400000);
      const future = new Date(Date.now() + 86400000);
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        timelockStart: past.toISOString(),
        timelockEnd: future.toISOString(),
      };
      expect(manager.isTimelockValid(policy)).toBe(true);
    });
  });

  // ===== Signing =====

  describe('signCredentialMultiSig', () => {
    test('signs with 2-of-3 threshold', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const privateKeys = new Map([
        [vms[0], keys[0].privateKey],
        [vms[1], keys[1].privateKey],
      ]);

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys,
      });

      expect(signed.proof).toBeDefined();
      expect(Array.isArray(signed.proof)).toBe(true);
      expect((signed.proof as any[]).length).toBe(2);
    });

    test('signs with 3-of-5 threshold', async () => {
      const policy: MultiSigPolicy = {
        required: 3,
        total: 5,
        signerVerificationMethods: vms,
      };

      const privateKeys = new Map([
        [vms[0], keys[0].privateKey],
        [vms[1], keys[1].privateKey],
        [vms[2], keys[2].privateKey],
      ]);

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys,
      });

      expect(Array.isArray(signed.proof)).toBe(true);
      expect((signed.proof as any[]).length).toBe(3);
    });

    test('signs with 1-of-1 (single signer)', async () => {
      const policy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([[vms[0], keys[0].privateKey]]),
      });

      expect(signed.proof).toBeDefined();
      expect(Array.isArray(signed.proof)).toBe(true);
      expect((signed.proof as any[]).length).toBe(1);
    });

    test('throws when not enough authorized signers', async () => {
      const policy: MultiSigPolicy = {
        required: 3,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const privateKeys = new Map([
        [vms[0], keys[0].privateKey],
        [vms[1], keys[1].privateKey],
      ]);

      await expect(
        manager.signCredentialMultiSig(baseVC, { policy, privateKeys })
      ).rejects.toThrow(/Not enough authorized signers/);
    });

    test('throws when signing outside timelock', async () => {
      const past = new Date(Date.now() - 86400000);
      const policy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
        timelockEnd: past.toISOString(),
      };

      await expect(
        manager.signCredentialMultiSig(baseVC, {
          policy,
          privateKeys: new Map([[vms[0], keys[0].privateKey]]),
        })
      ).rejects.toThrow(/outside the allowed timelock window/);
    });

    test('ignores unauthorized signers', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 2,
        signerVerificationMethods: [vms[0], vms[1]],
      };

      // Include an unauthorized signer key - it should be ignored
      const privateKeys = new Map([
        [vms[0], keys[0].privateKey],
        [vms[1], keys[1].privateKey],
        [vms[3], keys[3].privateKey], // not in policy
      ]);

      const signed = await manager.signCredentialMultiSig(baseVC, { policy, privateKeys });
      expect((signed.proof as any[]).length).toBe(2);
    });

    test('signs with external signers', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const mockSigner1 = {
        sign: async () => ({ proofValue: 'u' + Buffer.from('sig1').toString('base64') }),
        getVerificationMethodId: () => vms[0],
      };
      const mockSigner2 = {
        sign: async () => ({ proofValue: 'u' + Buffer.from('sig2').toString('base64') }),
        getVerificationMethodId: () => vms[1],
      };

      const externalSigners = new Map([
        [vms[0], mockSigner1],
        [vms[1], mockSigner2],
      ]);

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        externalSigners,
      });

      expect(Array.isArray(signed.proof)).toBe(true);
      expect((signed.proof as any[]).length).toBe(2);
    });
  });

  // ===== Verification =====

  describe('verifyMultiSig', () => {
    test('verifies 2-of-3 correctly signed credential', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [vms[0], keys[0].privateKey],
          [vms[1], keys[1].privateKey],
        ]),
      });

      const result = await manager.verifyMultiSig(signed, policy);
      expect(result.verified).toBe(true);
      expect(result.validSignatures).toBe(2);
      expect(result.validSigners).toEqual([vms[0], vms[1]]);
      expect(result.errors.length).toBe(0);
    });

    test('rejects when threshold not met', async () => {
      const policy: MultiSigPolicy = {
        required: 3,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      // Only sign with 2, but need 3
      const signPolicy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy: signPolicy,
        privateKeys: new Map([
          [vms[0], keys[0].privateKey],
          [vms[1], keys[1].privateKey],
        ]),
      });

      const result = await manager.verifyMultiSig(signed, policy);
      expect(result.verified).toBe(false);
      expect(result.validSignatures).toBe(2);
      expect(result.errors).toContain('Threshold not met: 2/3 valid signatures');
    });

    test('rejects credential with no proofs', async () => {
      const policy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
      };

      const result = await manager.verifyMultiSig(baseVC, policy);
      expect(result.verified).toBe(false);
      expect(result.errors).toContain('Credential has no proofs');
    });

    test('detects unauthorized signers', async () => {
      const signPolicy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy: signPolicy,
        privateKeys: new Map([[vms[0], keys[0].privateKey]]),
      });

      // Verify with a policy that doesn't include vms[0]
      const verifyPolicy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[1]],
      };

      const result = await manager.verifyMultiSig(signed, verifyPolicy);
      expect(result.verified).toBe(false);
      expect(result.invalidSigners).toContain(vms[0]);
    });

    test('rejects when timelock expired', async () => {
      const past = new Date(Date.now() - 86400000);
      const farPast = new Date(Date.now() - 172800000);

      // Sign without timelock
      const signPolicy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy: signPolicy,
        privateKeys: new Map([[vms[0], keys[0].privateKey]]),
      });

      // Verify with expired timelock
      const verifyPolicy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
        timelockStart: farPast.toISOString(),
        timelockEnd: past.toISOString(),
      };

      const result = await manager.verifyMultiSig(signed, verifyPolicy);
      expect(result.verified).toBe(false);
      expect(result.timelockValid).toBe(false);
    });

    test('handles tampered credential (changed issuer)', async () => {
      const policy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([[vms[0], keys[0].privateKey]]),
      });

      // Tamper with the issuer (changes the canonicalized document)
      const tampered = {
        ...signed,
        issuer: 'did:peer:attacker',
      };

      const result = await manager.verifyMultiSig(tampered, policy);
      expect(result.verified).toBe(false);
    });
  });

  // ===== Escrow =====

  describe('escrow policies', () => {
    test('validates escrow policy', () => {
      const policy: EscrowPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        escrowAgent: vms[2],
        releaseConditions: 'Both parties agree',
        escrowSignatureRequired: true,
      };
      expect(() => manager.validateEscrowPolicy(policy)).not.toThrow();
    });

    test('rejects escrow without release conditions', () => {
      const policy: EscrowPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        escrowAgent: vms[2],
        releaseConditions: '',
        escrowSignatureRequired: true,
      };
      expect(() => manager.validateEscrowPolicy(policy)).toThrow(/release conditions/);
    });

    test('rejects escrow agent not in signers when required', () => {
      const policy: EscrowPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        escrowAgent: vms[4], // not in signerVerificationMethods
        releaseConditions: 'Both parties agree',
        escrowSignatureRequired: true,
      };
      expect(() => manager.validateEscrowPolicy(policy)).toThrow(/must be in signerVerificationMethods/);
    });

    test('verifies escrow with required escrow signature', async () => {
      const policy: EscrowPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        escrowAgent: vms[2],
        releaseConditions: 'Both parties agree',
        escrowSignatureRequired: true,
      };

      // Sign with parties + escrow agent
      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [vms[0], keys[0].privateKey],
          [vms[2], keys[2].privateKey], // escrow agent
        ]),
      });

      const result = await manager.verifyEscrow(signed, policy);
      expect(result.verified).toBe(true);
      expect(result.validSigners).toContain(vms[2]);
    });

    test('rejects escrow without escrow agent signature when required', async () => {
      const policy: EscrowPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        escrowAgent: vms[2],
        releaseConditions: 'Both parties agree',
        escrowSignatureRequired: true,
      };

      // Sign with only the parties, not escrow agent
      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [vms[0], keys[0].privateKey],
          [vms[1], keys[1].privateKey],
        ]),
      });

      const result = await manager.verifyEscrow(signed, policy);
      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('Escrow agent'))).toBe(true);
    });
  });

  // ===== Corporate =====

  describe('corporate policies', () => {
    test('validates corporate policy', () => {
      const policy: CorporatePolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        roles: new Map([
          [vms[0], 'CEO'],
          [vms[1], 'CFO'],
          [vms[2], 'CTO'],
        ]),
        mandatoryRoles: ['CEO'],
      };
      expect(() => manager.validateCorporatePolicy(policy)).not.toThrow();
    });

    test('rejects corporate with unassigned mandatory role', () => {
      const policy: CorporatePolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        roles: new Map([
          [vms[0], 'CEO'],
          [vms[1], 'CFO'],
          [vms[2], 'CTO'],
        ]),
        mandatoryRoles: ['Legal'], // not assigned to anyone
      };
      expect(() => manager.validateCorporatePolicy(policy)).toThrow(/Mandatory role "Legal"/);
    });

    test('verifies corporate with mandatory role present', async () => {
      const policy: CorporatePolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        roles: new Map([
          [vms[0], 'CEO'],
          [vms[1], 'CFO'],
          [vms[2], 'CTO'],
        ]),
        mandatoryRoles: ['CEO'],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [vms[0], keys[0].privateKey], // CEO
          [vms[1], keys[1].privateKey], // CFO
        ]),
      });

      const result = await manager.verifyCorporate(signed, policy);
      expect(result.verified).toBe(true);
    });

    test('rejects corporate without mandatory role signature', async () => {
      const policy: CorporatePolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        roles: new Map([
          [vms[0], 'CEO'],
          [vms[1], 'CFO'],
          [vms[2], 'CTO'],
        ]),
        mandatoryRoles: ['CEO'],
      };

      // Sign without CEO
      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [vms[1], keys[1].privateKey], // CFO
          [vms[2], keys[2].privateKey], // CTO
        ]),
      });

      const result = await manager.verifyCorporate(signed, policy);
      expect(result.verified).toBe(false);
      expect(result.errors.some(e => e.includes('Mandatory role "CEO"'))).toBe(true);
    });
  });

  // ===== Session-based async signing =====

  describe('sessions', () => {
    test('creates a session', () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const session = manager.createSession(baseVC, policy);
      expect(session.id).toBeDefined();
      expect(session.status).toBe('collecting');
      expect(session.contributions.length).toBe(0);
    });

    test('adds contributions and tracks threshold', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const session = manager.createSession(baseVC, policy);

      // First contribution
      const c1 = await manager.createContribution(session.id, keys[0].privateKey, vms[0]);
      const updated1 = manager.addContribution(session.id, c1);
      expect(updated1.status).toBe('collecting');
      expect(updated1.contributions.length).toBe(1);

      // Second contribution - meets threshold
      const c2 = await manager.createContribution(session.id, keys[1].privateKey, vms[1]);
      const updated2 = manager.addContribution(session.id, c2);
      expect(updated2.status).toBe('threshold_met');
      expect(updated2.contributions.length).toBe(2);
    });

    test('rejects duplicate contributions from same signer', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const session = manager.createSession(baseVC, policy);
      const c1 = await manager.createContribution(session.id, keys[0].privateKey, vms[0]);
      manager.addContribution(session.id, c1);

      // Try to add another contribution from the same signer
      const c1dup = await manager.createContribution(session.id, keys[0].privateKey, vms[0]);
      expect(() => manager.addContribution(session.id, c1dup)).toThrow(/already contributed/);
    });

    test('rejects unauthorized signer contribution', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 2,
        signerVerificationMethods: [vms[0], vms[1]],
      };

      const session = manager.createSession(baseVC, policy);

      // Try to contribute with unauthorized signer
      await expect(
        manager.createContribution(session.id, keys[2].privateKey, vms[2])
      ).rejects.toThrow(/not authorized/);
    });

    test('finalizes session and produces signed credential', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const session = manager.createSession(baseVC, policy);

      const c1 = await manager.createContribution(session.id, keys[0].privateKey, vms[0]);
      manager.addContribution(session.id, c1);

      const c2 = await manager.createContribution(session.id, keys[1].privateKey, vms[1]);
      manager.addContribution(session.id, c2);

      const signed = manager.finalizeSession(session.id);
      expect(signed.proof).toBeDefined();
      expect(Array.isArray(signed.proof)).toBe(true);
      expect((signed.proof as any[]).length).toBe(2);

      // Verify the finalized credential
      const result = await manager.verifyMultiSig(signed, policy);
      expect(result.verified).toBe(true);
    });

    test('rejects finalization before threshold met', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const session = manager.createSession(baseVC, policy);
      const c1 = await manager.createContribution(session.id, keys[0].privateKey, vms[0]);
      manager.addContribution(session.id, c1);

      expect(() => manager.finalizeSession(session.id)).toThrow(/1\/2 signatures collected/);
    });

    test('rejects contribution to expired session', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        timelockEnd: new Date(Date.now() - 1000).toISOString(), // already expired
      };

      const session = manager.createSession(baseVC, policy);
      const c1 = await manager.createContribution(session.id, keys[0].privateKey, vms[0]);

      expect(() => manager.addContribution(session.id, c1)).toThrow(/expired/);
    });

    test('rejects contribution to finalized session', async () => {
      const policy: MultiSigPolicy = {
        required: 1,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const session = manager.createSession(baseVC, policy);
      const c1 = await manager.createContribution(session.id, keys[0].privateKey, vms[0]);
      manager.addContribution(session.id, c1);
      manager.finalizeSession(session.id);

      const c2 = await manager.createContribution(session.id, keys[1].privateKey, vms[1]);
      expect(() => manager.addContribution(session.id, c2)).toThrow(/finalized/);
    });

    test('getSession returns undefined for unknown session', () => {
      expect(manager.getSession('nonexistent')).toBeUndefined();
    });

    test('getSession detects expired session', () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
        timelockEnd: new Date(Date.now() - 1000).toISOString(),
      };

      const session = manager.createSession(baseVC, policy);
      const retrieved = manager.getSession(session.id);
      expect(retrieved?.status).toBe('expired');
    });

    test('createContribution throws for unknown session', async () => {
      await expect(
        manager.createContribution('nonexistent', keys[0].privateKey, vms[0])
      ).rejects.toThrow(/not found/);
    });
  });

  // ===== CredentialManager integration =====

  describe('CredentialManager multi-sig integration', () => {
    test('signCredentialMultiSig via CredentialManager', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const signed = await sdk.credentials.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [vms[0], keys[0].privateKey],
          [vms[1], keys[1].privateKey],
        ]),
      });

      expect(Array.isArray(signed.proof)).toBe(true);
      expect((signed.proof as any[]).length).toBe(2);
    });

    test('verifyCredentialMultiSig via CredentialManager', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const signed = await sdk.credentials.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [vms[0], keys[0].privateKey],
          [vms[1], keys[1].privateKey],
        ]),
      });

      const result = await sdk.credentials.verifyCredentialMultiSig(signed, policy);
      expect(result.verified).toBe(true);
      expect(result.validSignatures).toBe(2);
    });

    test('multiSig() returns a MultiSigManager instance', () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
      const msm = sdk.credentials.multiSig();
      expect(msm).toBeInstanceOf(MultiSigManager);
    });
  });

  // ===== Key type compatibility =====

  describe('key type support', () => {
    test('works with ES256K keys', async () => {
      const es256kConfig: OriginalsConfig = { network: 'regtest', defaultKeyType: 'ES256K' };
      const es256kManager = new MultiSigManager(es256kConfig);

      const es256kKeys = await Promise.all([
        keyManager.generateKeyPair('ES256K'),
        keyManager.generateKeyPair('ES256K'),
      ]);
      const es256kVMs = es256kKeys.map(k => `did:key:${k.publicKey}`);

      const policy: MultiSigPolicy = {
        required: 2,
        total: 2,
        signerVerificationMethods: es256kVMs,
      };

      const signed = await es256kManager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [es256kVMs[0], es256kKeys[0].privateKey],
          [es256kVMs[1], es256kKeys[1].privateKey],
        ]),
      });

      const result = await es256kManager.verifyMultiSig(signed, policy);
      expect(result.verified).toBe(true);
      expect(result.validSignatures).toBe(2);
    });

    test('works with ES256 keys', async () => {
      const es256Config: OriginalsConfig = { network: 'regtest', defaultKeyType: 'ES256' };
      const es256Manager = new MultiSigManager(es256Config);

      const es256Keys = await Promise.all([
        keyManager.generateKeyPair('ES256'),
        keyManager.generateKeyPair('ES256'),
      ]);
      const es256VMs = es256Keys.map(k => `did:key:${k.publicKey}`);

      const policy: MultiSigPolicy = {
        required: 2,
        total: 2,
        signerVerificationMethods: es256VMs,
      };

      const signed = await es256Manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [es256VMs[0], es256Keys[0].privateKey],
          [es256VMs[1], es256Keys[1].privateKey],
        ]),
      });

      const result = await es256Manager.verifyMultiSig(signed, policy);
      expect(result.verified).toBe(true);
      expect(result.validSignatures).toBe(2);
    });
  });

  // ===== Edge cases & security =====

  describe('security edge cases', () => {
    test('rejects signature reordering attack (still valid if all sigs present)', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 3,
        signerVerificationMethods: [vms[0], vms[1], vms[2]],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy,
        privateKeys: new Map([
          [vms[0], keys[0].privateKey],
          [vms[1], keys[1].privateKey],
        ]),
      });

      // Reverse the proof order
      const proofs = [...(signed.proof as any[])];
      const reordered = { ...signed, proof: proofs.reverse() };

      const result = await manager.verifyMultiSig(reordered, policy);
      // Should still verify - order doesn't matter for threshold
      expect(result.verified).toBe(true);
    });

    test('detects proof count manipulation (single proof repeated)', async () => {
      const policy: MultiSigPolicy = {
        required: 2,
        total: 2,
        signerVerificationMethods: [vms[0], vms[1]],
      };

      // Sign with one key but duplicate the proof
      const signPolicy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
      };

      const signed = await manager.signCredentialMultiSig(baseVC, {
        policy: signPolicy,
        privateKeys: new Map([[vms[0], keys[0].privateKey]]),
      });

      // Duplicate the proof to try to meet threshold
      const proofs = signed.proof as any[];
      const manipulated = { ...signed, proof: [proofs[0], proofs[0]] };

      const result = await manager.verifyMultiSig(manipulated, policy);
      // Should fail - only 1 unique valid authorized signer
      expect(result.validSignatures).toBeLessThanOrEqual(1);
    });

    test('handles empty proof array', async () => {
      const policy: MultiSigPolicy = {
        required: 1,
        total: 1,
        signerVerificationMethods: [vms[0]],
      };

      const noProofs = { ...baseVC, proof: [] as any };
      const result = await manager.verifyMultiSig(noProofs, policy);
      expect(result.verified).toBe(false);
    });
  });
});
