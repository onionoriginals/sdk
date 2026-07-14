/**
 * DID-layer scenario tests
 *
 * Covers the following scenarios from the mission brief:
 *  DID-001  create did:peer with empty resources → valid DID doc
 *  DID-006  create did:webvh with mock external signer → proof present
 *  DID-007  update did:webvh → new VM + new log entry + signed proof; DID id constant
 *  DID-008  10 sequential key rotations → log grows to 11 entries
 *  DID-009  recovery credential tamper detection (signature verification fails)
 *  DID-010  loadDIDLog — file not found → error thrown or graceful null
 *  DID-011  ES256 keypair z-prefixed; unsupported key type → Error; batch generation
 *  DID-012  multiple rotations — audit trail (all rotated keys preserved; chronological revoke timestamps; newest active)
 *  DID-013  recovery marks compromised key with ISO-8601 timestamp
 *  DID-015  resolve did:btco on regtest network (correct prefix handling)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { DIDManager } from '../../../src/did/DIDManager';
import { WebVHManager } from '../../../src/did/WebVHManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { BtcoDidResolver } from '../../../src/did/BtcoDidResolver';
import type { ExternalSigner, ExternalVerifier, OriginalsConfig } from '../../../src/types';
import type { ResourceProviderLike } from '../../../src/did/BtcoDidResolver';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal config for DIDManager construction. */
const baseConfig: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

/** Create a temp directory and return its path + a cleanup function. */
async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'did-scenario-'));
  return {
    dir,
    cleanup: async () => {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// DID-001 — create did:peer with empty resources → valid DID doc
// ---------------------------------------------------------------------------

// DID-001 removed (did:peer purge, did:cel Phase 4·5/5): createDIDPeer and the
// did:peer creation path are gone; did:cel is the sole genesis layer.

// ---------------------------------------------------------------------------
// DID-006 — create did:webvh with mock external signer
// ---------------------------------------------------------------------------

describe('DID-006 — did:webvh with external (mock Turnkey-style) signer', () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: tempDir, cleanup } = await makeTempDir());
  });
  afterEach(async () => cleanup());

  /**
   * Build a mock external signer that:
   * - delegates actual signing to a real Ed25519 key pair so the result is
   *   cryptographically valid from didwebvh-ts's perspective, and
   * - tracks whether `sign()` was invoked.
   */
  async function buildMockExternalSigner(keyManager: KeyManager): Promise<{
    signer: ExternalSigner;
    verifier: ExternalVerifier;
    keyPair: { publicKey: string; privateKey: string };
    signCallCount: () => number;
  }> {
    // Generate real Ed25519 keypair for actual signing operations
    const keyPair = await keyManager.generateKeyPair('Ed25519');

    let calls = 0;

    // Import the Ed25519 signing infrastructure used internally
    const { Ed25519Signer } = await import('../../../src/crypto/Signer');
    const { multikey } = await import('../../../src/crypto/Multikey');
    const internalSigner = new Ed25519Signer();

    // We also need prepareDataForSigning from didwebvh-ts
    const mod = await import('didwebvh-ts') as unknown as {
      prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>;
    };
    const { prepareDataForSigning } = mod;

    const vmId = `did:key:${keyPair.publicKey}`;

    const signer: ExternalSigner = {
      getVerificationMethodId: () => vmId,
      async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }> {
        calls++;
        const dataToSign = await prepareDataForSigning(input.document, input.proof);
        const sig: Buffer = await internalSigner.sign(Buffer.from(dataToSign), keyPair.privateKey);
        const proofValue = multikey.encodeMultibase(sig);
        return { proofValue };
      },
    };

    const verifier: ExternalVerifier = {
      async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
        const pubMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
        return internalSigner.verify(Buffer.from(message), Buffer.from(signature), pubMultibase);
      },
    };

    return { signer, verifier, keyPair, signCallCount: () => calls };
  }

  test('creates did:webvh with external signer — proof signed by external signer; doc valid', async () => {
    const keyManager = new KeyManager();
    const { signer, verifier, keyPair, signCallCount } = await buildMockExternalSigner(keyManager);

    const manager = new WebVHManager();
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      externalSigner: signer,
      externalVerifier: verifier,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [`did:key:${keyPair.publicKey}`],
      outputDir: tempDir,
    });

    // DID document must be well-formed
    expect(result.did).toMatch(/^did:webvh:/);
    expect(result.didDocument.id).toBe(result.did);
    expect(Array.isArray(result.didDocument['@context'])).toBe(true);
    expect(result.didDocument['@context']).toContain('https://www.w3.org/ns/did/v1');

    // Log must exist with at least one entry
    expect(Array.isArray(result.log)).toBe(true);
    expect(result.log.length).toBeGreaterThan(0);

    // First log entry must carry a proof
    const firstEntry = result.log[0];
    expect(firstEntry.proof).toBeDefined();
    expect(Array.isArray(firstEntry.proof)).toBe(true);
    expect((firstEntry.proof as unknown[]).length).toBeGreaterThan(0);
    const proof = (firstEntry.proof as Record<string, unknown>[])[0];
    expect(typeof proof.proofValue).toBe('string');
    expect((proof.proofValue as string).length).toBeGreaterThan(0);

    // The external signer must have been called at least once
    expect(signCallCount()).toBeGreaterThan(0);

    // When using external signer, no internal keyPair is returned at all
    expect(result.keyPair).toBeUndefined();
  }, 20000);

  test('createDIDWebVH with external signer requires verificationMethods', async () => {
    const keyManager = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(keyManager);

    const manager = new WebVHManager();
    await expect(
      manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signer,
        externalVerifier: verifier,
        // verificationMethods intentionally omitted
        updateKeys: [`did:key:${keyPair.publicKey}`],
      })
    ).rejects.toThrow('verificationMethods are required when using externalSigner');
  }, 10000);

  test('createDIDWebVH with external signer requires updateKeys', async () => {
    const keyManager = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(keyManager);

    const manager = new WebVHManager();
    await expect(
      manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signer,
        externalVerifier: verifier,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
        // updateKeys intentionally omitted
      })
    ).rejects.toThrow('updateKeys are required when using externalSigner');
  }, 10000);
});

// ---------------------------------------------------------------------------
// DID-007 — update did:webvh → new VM + new log entry + signed proof; DID id constant
// ---------------------------------------------------------------------------

describe('DID-007 — update did:webvh', () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: tempDir, cleanup } = await makeTempDir());
  });
  afterEach(async () => cleanup());

  test('update adds a new log entry with a valid proof', async () => {
    const manager = new WebVHManager();

    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      outputDir: tempDir,
    });

    const newService = {
      id: `${created.did}#website`,
      type: 'LinkedDomains',
      serviceEndpoint: 'https://example.com',
    };

    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { service: [newService] },
      signer: created.keyPair,
    });

    // Log grows by exactly one entry
    expect(updated.log.length).toBe(created.log.length + 1);

    // New entry carries a proof
    const newEntry = updated.log[updated.log.length - 1];
    expect(newEntry.proof).toBeDefined();
    expect(Array.isArray(newEntry.proof)).toBe(true);
    const proof = (newEntry.proof as Record<string, unknown>[])[0];
    expect(typeof proof.proofValue).toBe('string');

    // The new entry's state must actually contain the update (issue #338).
    expect((newEntry.state as { service?: unknown }).service).toEqual([newService]);
    expect(updated.didDocument.service).toEqual([newService]);
  }, 20000);

  test('update preserves DID identity (id constant across updates)', async () => {
    const manager = new WebVHManager();

    const created = await manager.createDIDWebVH({
      domain: 'example.com',
    });

    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { service: [{ id: `${created.did}#svc`, type: 'Service', serviceEndpoint: 'https://x.example' }] },
      signer: created.keyPair,
    });

    // The DID identifier must not change
    expect(updated.didDocument.id).toBe(created.did);
  }, 20000);

  test('update can introduce new service endpoints', async () => {
    const keyManager = new KeyManager();
    const manager = new WebVHManager();

    const created = await manager.createDIDWebVH({ domain: 'example.com' });
    const extraKey = await keyManager.generateKeyPair('Ed25519');

    // Add a service referencing new key as a proxy for injecting new VM info
    const extraService = {
      id: `${created.did}#extra`,
      type: 'ExtraService',
      serviceEndpoint: `did:key:${extraKey.publicKey}`,
    };
    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { service: [extraService] },
      signer: created.keyPair,
    });

    expect(updated.didDocument).toBeDefined();
    expect(updated.log.length).toBeGreaterThan(created.log.length);
    // The service must actually be applied (issue #338).
    expect(updated.didDocument.service).toEqual([extraService]);
  }, 20000);
});

// ---------------------------------------------------------------------------
// DID-008 — 10 sequential key rotations → log grows to 11 entries
// ---------------------------------------------------------------------------

describe('DID-008 — key rotation: log consistency after 10 sequential rotations', () => {
  // DEFECT-FOUND: rotateDIDWebVHKeys fails on the 3rd sequential rotation
  // (i.e. when log already has 2 entries and we attempt a 3rd).
  // didwebvh-ts rejects the signing key as "not authorized to update" because
  // appendKeyChange does not correctly propagate the new authorized updateKey
  // into the chain beyond 2 sequential rotations.
  // The existing test in WebVHManager.rotation.test.ts only tests up to 3 log
  // entries (2 rotations) which passes.
  // Reported defect: sequential rotateDIDWebVHKeys fails at rotation index 2+.
  test('10 sequential rotations grow log to 11 entries with valid proofs', async () => {
    const manager = new WebVHManager();

    const created = await manager.createDIDWebVH({ domain: 'example.com' });
    expect(created.log.length).toBe(1);

    let log = created.log;
    let currentKeyPair = created.keyPair;
    const did = created.did;

    for (let i = 0; i < 10; i++) {
      const rotated = await manager.rotateDIDWebVHKeys({
        did,
        currentLog: log,
        currentKeyPair,
      });
      log = rotated.log;
      currentKeyPair = rotated.newKeyPair;
    }

    // 1 create + 10 rotations = 11 entries
    expect(log.length).toBe(11);

    // Each entry must have a version ID and proof
    for (const entry of log) {
      expect(typeof entry.versionId).toBe('string');
      expect(entry.versionId.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.proof)).toBe(true);
      expect((entry.proof as unknown[]).length).toBeGreaterThan(0);
    }

    // Version IDs must all be unique (no duplicate log entries)
    const versionIds = log.map(e => e.versionId);
    const unique = new Set(versionIds);
    expect(unique.size).toBe(log.length);
  }, 180000);

  // Verifies the actual current behavior: 2 sequential rotations work, 3 fails.
  test('2 sequential rotations produce a log of 3 entries (current working boundary)', async () => {
    const manager = new WebVHManager();
    const created = await manager.createDIDWebVH({ domain: 'example.com' });

    const r1 = await manager.rotateDIDWebVHKeys({ did: created.did, currentLog: created.log, currentKeyPair: created.keyPair });
    const r2 = await manager.rotateDIDWebVHKeys({ did: created.did, currentLog: r1.log, currentKeyPair: r1.newKeyPair });

    expect(r2.log.length).toBe(3);

    // All entries have version IDs and proofs
    for (const entry of r2.log) {
      expect(typeof entry.versionId).toBe('string');
      expect(Array.isArray(entry.proof)).toBe(true);
    }

    const ids = new Set(r2.log.map(e => e.versionId));
    expect(ids.size).toBe(3);
  }, 60000);
});

// ---------------------------------------------------------------------------
// DID-009 — recovery credential tamper detection
// ---------------------------------------------------------------------------

describe('DID-009 — recovery credential is tamper-evident (W3C VC)', () => {
  /**
   * Strategy:
   * 1. Use KeyManager.recoverFromCompromise() to get a recovery credential.
   * 2. Sign its canonical JSON with an Ed25519 key.
   * 3. Mutate a field in credentialSubject.
   * 4. Verify the signature against the mutated credential — must fail.
   */
  test('mutating recovery credential makes its signature invalid', async () => {
    const km = new KeyManager();

    // Build a minimal DID document with one key
    const originalKeyPair = await km.generateKeyPair('Ed25519');
    const didDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:test-recovery-tamper',
      verificationMethod: [{
        id: 'did:peer:test-recovery-tamper#keys-0',
        type: 'Multikey',
        controller: 'did:peer:test-recovery-tamper',
        publicKeyMultibase: originalKeyPair.publicKey,
      }],
      authentication: ['did:peer:test-recovery-tamper#keys-0'],
    };

    // Perform recovery
    const result = await km.recoverFromCompromise(didDoc);
    const cred = result.recoveryCredential;

    // Verify the credential has the expected W3C VC shape
    expect(cred['@context']).toContain('https://www.w3.org/ns/credentials/v2');
    expect(cred.type).toContain('VerifiableCredential');
    expect(cred.type).toContain('KeyRecoveryCredential');
    expect(cred.issuer).toBe('did:peer:test-recovery-tamper');

    // Sign the canonical JSON representation with an Ed25519 signing key
    const { Ed25519Signer } = await import('../../../src/crypto/Signer');
    const signer = new Ed25519Signer();
    const signerKeyPair = await km.generateKeyPair('Ed25519');

    const canonicalOriginal = JSON.stringify(cred);
    const originalBytes = Buffer.from(canonicalOriginal, 'utf8');
    const signature: Buffer = await signer.sign(originalBytes, signerKeyPair.privateKey);

    // Verify that the untampered credential verifies correctly
    const verifyOk = await signer.verify(originalBytes, signature, signerKeyPair.publicKey);
    expect(verifyOk).toBe(true);

    // Now tamper with the credential: change the recoveryReason
    const tamperedCred = {
      ...cred,
      credentialSubject: {
        ...cred.credentialSubject,
        recoveryReason: 'TAMPERED_VALUE',
      },
    };
    const tamperedBytes = Buffer.from(JSON.stringify(tamperedCred), 'utf8');

    // The signature must NOT verify against the tampered data
    const tamperResult = await signer.verify(tamperedBytes, signature, signerKeyPair.publicKey);
    expect(tamperResult).toBe(false);
  });

  test('mutating validFrom of recovery credential invalidates signature', async () => {
    const km = new KeyManager();
    const kp = await km.generateKeyPair('Ed25519');

    const didDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:tamper-date-test',
      verificationMethod: [{ id: 'did:peer:tamper-date-test#keys-0', type: 'Multikey', controller: 'did:peer:tamper-date-test', publicKeyMultibase: kp.publicKey }],
      authentication: ['did:peer:tamper-date-test#keys-0'],
    };

    const result = await km.recoverFromCompromise(didDoc);
    const cred = result.recoveryCredential;

    const { Ed25519Signer } = await import('../../../src/crypto/Signer');
    const signer = new Ed25519Signer();
    const signerKP = await km.generateKeyPair('Ed25519');

    const originalBytes = Buffer.from(JSON.stringify(cred), 'utf8');
    const sig: Buffer = await signer.sign(originalBytes, signerKP.privateKey);

    // Tamper: change validFrom
    const tampered = { ...cred, validFrom: '1970-01-01T00:00:00Z' };
    const tamperedBytes = Buffer.from(JSON.stringify(tampered), 'utf8');

    expect(await signer.verify(tamperedBytes, sig, signerKP.publicKey)).toBe(false);
    // Sanity: original still verifies
    expect(await signer.verify(originalBytes, sig, signerKP.publicKey)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DID-010 — loadDIDLog — file not found → error thrown or graceful null
// ---------------------------------------------------------------------------

describe('DID-010 — loadDIDLog file not found', () => {
  test('loadDIDLog throws or rejects when the file does not exist', async () => {
    const manager = new WebVHManager();
    const nonExistentPath = '/tmp/does-not-exist-did-scenario-test/did.jsonl';

    // The API must signal failure — either throw synchronously or reject the promise
    await expect(manager.loadDIDLog(nonExistentPath)).rejects.toBeDefined();
  });

  test('loadDIDLog on a missing path produces a rejected Promise (not a silent null)', async () => {
    const manager = new WebVHManager();
    let threw = false;

    try {
      await manager.loadDIDLog('/no/such/path/did.jsonl');
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DID-011 — ES256 keypair; unsupported key type; batch generation
// ---------------------------------------------------------------------------

describe('DID-011 — KeyManager key generation', () => {
  const km = new KeyManager();

  test('ES256 (P-256) generates both keys with z-prefixed multibase encoding', async () => {
    const kp = await km.generateKeyPair('ES256');

    expect(kp.publicKey).toMatch(/^z/);
    expect(kp.privateKey).toMatch(/^z/);

    // Keys must decode back without error
    const decoded = km.decodePublicKeyMultibase(kp.publicKey);
    expect(decoded.type).toBe('ES256');
  });

  test('Ed25519 generates both keys with z-prefixed multibase encoding', async () => {
    const kp = await km.generateKeyPair('Ed25519');
    expect(kp.publicKey).toMatch(/^z/);
    expect(kp.privateKey).toMatch(/^z/);
  });

  test('ES256K generates both keys with z-prefixed multibase encoding', async () => {
    const kp = await km.generateKeyPair('ES256K');
    expect(kp.publicKey).toMatch(/^z/);
    expect(kp.privateKey).toMatch(/^z/);
  });

  test('unsupported key type throws Error containing "Unsupported key type"', async () => {
    await expect(
      km.generateKeyPair('RSA2048' as 'ES256K')
    ).rejects.toThrow('Unsupported key type');
  });

  test('batch: generating 5 ES256 key pairs all succeed without error', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => km.generateKeyPair('ES256'))
    );

    expect(results).toHaveLength(5);
    for (const kp of results) {
      expect(kp.publicKey).toMatch(/^z/);
      expect(kp.privateKey).toMatch(/^z/);
    }

    // All public keys must be unique (no collision)
    const pubs = new Set(results.map(kp => kp.publicKey));
    expect(pubs.size).toBe(5);
  });

  test('batch: generating 5 Ed25519 key pairs all succeed without error', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => km.generateKeyPair('Ed25519'))
    );

    expect(results).toHaveLength(5);
    const pubs = new Set(results.map(kp => kp.publicKey));
    expect(pubs.size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// DID-012 — multiple rotations create audit trail
// ---------------------------------------------------------------------------

describe('DID-012 — key rotation audit trail (KeyManager.rotateKeys)', () => {
  test('rotated keys are preserved; revoke timestamps present; newest key is active', async () => {
    const km = new KeyManager();

    // Build initial DID document
    const key0 = await km.generateKeyPair('Ed25519');
    let didDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:audit-trail-test',
      verificationMethod: [{
        id: 'did:peer:audit-trail-test#keys-0',
        type: 'Multikey',
        controller: 'did:peer:audit-trail-test',
        publicKeyMultibase: key0.publicKey,
      }],
      authentication: ['did:peer:audit-trail-test#keys-0'],
    };

    const key1 = await km.generateKeyPair('Ed25519');
    await new Promise(r => setTimeout(r, 2)); // ensure distinct timestamps
    didDoc = km.rotateKeys(didDoc, key1) as typeof didDoc;

    const key2 = await km.generateKeyPair('Ed25519');
    await new Promise(r => setTimeout(r, 2));
    didDoc = km.rotateKeys(didDoc, key2) as typeof didDoc;

    const key3 = await km.generateKeyPair('Ed25519');
    didDoc = km.rotateKeys(didDoc, key3) as typeof didDoc;

    // After 3 rotations, there should be 4 VMs: keys-0,1,2 (revoked) + keys-3 (active)
    expect(didDoc.verificationMethod).toHaveLength(4);

    // All previous keys must be revoked
    const revoked = didDoc.verificationMethod.slice(0, 3);
    const active = didDoc.verificationMethod[3];

    for (const vm of revoked) {
      expect(vm.revoked).toBeDefined();
      expect(vm.revoked).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    }

    // Newest key must NOT be revoked
    expect(active.revoked).toBeUndefined();
    expect(active.publicKeyMultibase).toBe(key3.publicKey);

    // authentication and assertionMethod must reference only the active key
    expect(didDoc.authentication).toContain('did:peer:audit-trail-test#keys-3');
    expect(didDoc.assertionMethod).toContain('did:peer:audit-trail-test#keys-3');

    // Revoke timestamps: each ts[i] >= ts[0] (at minimum, non-decreasing from start)
    const ts = revoked.map(vm => new Date(vm.revoked!).getTime());
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeGreaterThanOrEqual(ts[0]);
    }
  });
});

// ---------------------------------------------------------------------------
// DID-013 — recovery marks compromised key with ISO-8601 timestamp
// ---------------------------------------------------------------------------

describe('DID-013 — recovery marks compromised key with ISO-8601 timestamp', () => {
  test('recoverFromCompromise marks all existing keys with "compromised" ISO-8601 timestamp', async () => {
    const km = new KeyManager();

    const kp = await km.generateKeyPair('Ed25519');
    const didDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:compromise-ts-test',
      verificationMethod: [{
        id: 'did:peer:compromise-ts-test#keys-0',
        type: 'Multikey',
        controller: 'did:peer:compromise-ts-test',
        publicKeyMultibase: kp.publicKey,
      }],
      authentication: ['did:peer:compromise-ts-test#keys-0'],
    };

    const beforeRecovery = new Date();
    const result = await km.recoverFromCompromise(didDoc);
    const afterRecovery = new Date();

    const vms = result.didDocument.verificationMethod ?? [];
    // Original key must be marked as compromised
    const compromisedVm = vms.find(vm => vm.publicKeyMultibase === kp.publicKey);
    expect(compromisedVm).toBeDefined();
    expect(compromisedVm!.compromised).toBeDefined();

    // Must be valid ISO-8601
    const ts = compromisedVm!.compromised as string;
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // Timestamp must be within the test's execution window
    const tsDate = new Date(ts);
    expect(tsDate.getTime()).toBeGreaterThanOrEqual(beforeRecovery.getTime() - 1000);
    expect(tsDate.getTime()).toBeLessThanOrEqual(afterRecovery.getTime() + 1000);

    // New key must NOT be compromised
    const newVm = vms[vms.length - 1];
    expect(newVm.compromised).toBeUndefined();
    expect(newVm.publicKeyMultibase).toBe(result.newKeyPair.publicKey);
  });

  test('recovery credential credentialSubject.recoveredAt is ISO-8601', async () => {
    const km = new KeyManager();

    const kp = await km.generateKeyPair('ES256K');
    const didDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:recovery-ts-cred',
      verificationMethod: [{
        id: 'did:peer:recovery-ts-cred#keys-0',
        type: 'Multikey',
        controller: 'did:peer:recovery-ts-cred',
        publicKeyMultibase: kp.publicKey,
      }],
      authentication: ['did:peer:recovery-ts-cred#keys-0'],
    };

    const result = await km.recoverFromCompromise(didDoc);
    const cred = result.recoveryCredential;

    // recoveredAt on the credential subject must be ISO-8601
    expect(cred.credentialSubject.recoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // validFrom must also be ISO-8601
    expect(cred.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// DID-015 — resolve did:btco on regtest network (correct prefix handling)
// ---------------------------------------------------------------------------

describe('DID-015 — did:btco regtest prefix handling', () => {
  /**
   * Build a mock ResourceProviderLike that serves a synthetic did:btco:reg:<sat>
   * document when queried with the correct regtest DID prefix.
   */
  function buildRegtestProvider(satNumber: string): ResourceProviderLike {
    const inscriptionId = `regtest-inscription-${satNumber}i0`;
    const mockContentUrl = `http://localhost:8080/content/${inscriptionId}`;

    return {
      async getSatInfo(_sat: string) {
        return { inscription_ids: [inscriptionId] };
      },
      async resolveInscription(id: string) {
        return {
          id,
          sat: parseInt(satNumber),
          content_type: 'text/plain',
          content_url: mockContentUrl,
        };
      },
      async getMetadata(_id: string) {
        // Off-chain metadata is non-authoritative; the document lives in content.
        return null;
      },
    };
  }

  test('resolves did:btco:reg:<sat> — uses "reg" prefix for regtest DIDs', async () => {
    const satNumber = '4999999999';
    const did = `did:btco:reg:${satNumber}`;
    const provider = buildRegtestProvider(satNumber);
    const mockDoc = { '@context': ['https://www.w3.org/ns/did/v1'], id: did };

    // Mock fetch to return the authoritative DID document as the inscription
    // content (the resolver must parse the document from content, not metadata).
    const originalFetch = (global as unknown as { fetch: unknown }).fetch;
    (global as unknown as { fetch: unknown }).fetch = async (_url: string) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => `BTCO DID: ${JSON.stringify(mockDoc)}`,
    });

    try {
      const resolver = new BtcoDidResolver({ provider });
      const result = await resolver.resolve(did);

      // Must resolve to a non-null document
      expect(result.didDocument).not.toBeNull();
      expect(result.didDocument?.id).toBe(did);

      // Network metadata must reflect "reg"
      expect(result.resolutionMetadata.network).toBe('reg');
    } finally {
      (global as unknown as { fetch: unknown }).fetch = originalFetch;
    }
  });

  test('parseBtcoDid correctly extracts regtest network from did:btco:reg:<sat>', () => {
    const resolver = new BtcoDidResolver();
    // Access the private method via type assertion for testing
    const parsed = (resolver as unknown as {
      parseBtcoDid: (did: string) => { satNumber: string; network: string; path?: string } | null
    }).parseBtcoDid('did:btco:reg:12345');

    expect(parsed).not.toBeNull();
    expect(parsed!.satNumber).toBe('12345');
    expect(parsed!.network).toBe('reg');
  });

  test('getDidPrefix returns "did:btco:reg" for regtest variants', () => {
    const resolver = new BtcoDidResolver();
    const getPrefix = (resolver as unknown as { getDidPrefix: (n: string) => string }).getDidPrefix;

    expect(getPrefix.call(resolver, 'reg')).toBe('did:btco:reg');
    expect(getPrefix.call(resolver, 'regtest')).toBe('did:btco:reg');
  });

  test('did:btco:reg DID with no inscriptions returns notFound error', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { return { inscription_ids: [] }; },
      async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: `http://local/${id}` }; },
      async getMetadata() { return null as unknown as Record<string, unknown>; },
    };

    const resolver = new BtcoDidResolver({ provider });
    const result = await resolver.resolve('did:btco:reg:9999');

    expect(result.didDocument).toBeNull();
    expect(result.resolutionMetadata.error).toBe('notFound');
    // Note: when createErrorResult is returned (early exit paths), the network field
    // is NOT populated — only error and message are set. This is the actual behavior.
    expect(result.resolutionMetadata.network).toBeUndefined();
  });

  test('DIDManager.migrateToDIDBTCO produces did:btco:reg: prefix when webvhNetwork is magby (dev→regtest)', async () => {
    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      webvhNetwork: 'magby', // magby maps to regtest
    };
    const manager = new DIDManager(config);

    const km = new KeyManager();
    const kp = await km.generateKeyPair('Ed25519');

    const didDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:migrate-to-btco-test',
      verificationMethod: [{
        id: 'did:peer:migrate-to-btco-test#keys-0',
        type: 'Multikey',
        controller: 'did:peer:migrate-to-btco-test',
        publicKeyMultibase: kp.publicKey,
      }],
      authentication: ['did:peer:migrate-to-btco-test#keys-0'],
    };

    const btcoDoc = await manager.migrateToDIDBTCO(didDoc, '12345678901');

    // magby→regtest must produce the reg: prefix
    expect(btcoDoc.id).toMatch(/^did:btco:reg:/);
    expect(btcoDoc.id).toContain('12345678901');
  });
});
