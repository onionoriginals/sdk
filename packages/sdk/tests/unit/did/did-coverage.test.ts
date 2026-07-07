/**
 * DID-layer coverage gap tests
 *
 * Covers the following scenarios:
 *  DID-001  Create did:peer with ES256K key type → ES256K key material encoded
 *  DID-002  Migrate did:peer→did:webvh with default domain from network config
 *  DID-003  Migrate to did:btco regtest → did:btco:reg:<sat>
 *  DID-006  Create did:webvh with external signer (mock); assert no internal key leaked
 *  DID-006  Create did:webvh with custom keypair
 *  DID-007  Update did:webvh with new service endpoint → new signed log entry
 *  DID-007  Update with external signer requires verifier (mock signer+verifier)
 *  DID-010  Save with multiple path segments → nested dir structure (tmp dir)
 *  DID-011  Load corrupted JSONL file → JSON parse error
 *  DID-019  Ed25519 verification fails with invalid (corrupted) signature → false
 *  DID-019  Ed25519 verification fails with wrong public key → false
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { DIDManager } from '../../../src/did/DIDManager';
import { WebVHManager } from '../../../src/did/WebVHManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { Ed25519Signer } from '../../../src/crypto/Signer';
import { multikey } from '../../../src/crypto/Multikey';
import type { ExternalSigner, ExternalVerifier, OriginalsConfig } from '../../../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'did-cov-'));
  return {
    dir,
    cleanup: async () => {
      try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/**
 * Build a mock external signer/verifier pair backed by a real Ed25519 key so
 * didwebvh-ts's cryptographic validation passes.
 */
async function buildMockExternalSigner(keyManager: KeyManager): Promise<{
  signer: ExternalSigner;
  verifier: ExternalVerifier;
  keyPair: { publicKey: string; privateKey: string };
  signCallCount: () => number;
}> {
  const keyPair = await keyManager.generateKeyPair('Ed25519');

  let calls = 0;
  const internalSigner = new Ed25519Signer();

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
      return { proofValue: multikey.encodeMultibase(sig) };
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

// ---------------------------------------------------------------------------
// DID-001 — Create did:peer with ES256K key type → ES256K key material encoded
// ---------------------------------------------------------------------------

describe('DID-001 — createDIDPeer with ES256K key type', () => {
  test('ES256K public key encoded in verificationMethod (Secp256k1 multicodec)', async () => {
    const manager = new DIDManager({ ...baseConfig, defaultKeyType: 'ES256K' });

    const didDoc = await manager.createDIDPeer([]);

    expect(didDoc.id).toMatch(/^did:peer:/);
    expect(Array.isArray(didDoc.verificationMethod)).toBe(true);
    expect((didDoc.verificationMethod ?? []).length).toBeGreaterThan(0);

    const vm = didDoc.verificationMethod![0];
    expect(vm.type).toBe('Multikey');
    expect(vm.publicKeyMultibase).toMatch(/^z/);

    // Decode: must be a Secp256k1 key
    const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
    expect(decoded.type).toBe('Secp256k1');
    expect(decoded.key instanceof Uint8Array).toBe(true);
    // Compressed secp256k1 public key is 33 bytes
    expect(decoded.key.length).toBe(33);
  }, 15000);

  test('returnKeyPair=true returns keyPair with Secp256k1 encoding', async () => {
    const manager = new DIDManager({ ...baseConfig, defaultKeyType: 'ES256K' });

    const result = await manager.createDIDPeer([], true);
    expect(result.keyPair.publicKey).toMatch(/^z/);
    expect(result.keyPair.privateKey).toMatch(/^z/);

    // Public key round-trips as Secp256k1
    const decoded = multikey.decodePublicKey(result.keyPair.publicKey);
    expect(decoded.type).toBe('Secp256k1');
  }, 15000);
});

// ---------------------------------------------------------------------------
// DID-002 — Migrate did:peer→did:webvh with default domain from network config
// ---------------------------------------------------------------------------

describe('DID-002 — migrateToDIDWebVH uses configured network domain', () => {
  test('magby config → migrated DID contains magby.originals.build', async () => {
    const manager = new DIDManager({
      ...baseConfig,
      webvhNetwork: 'magby',
    });

    const peerDoc = await manager.createDIDPeer([]);
    const webDoc = (await manager.migrateToDIDWebVH(peerDoc)).didDocument; // no explicit domain

    expect(webDoc.id).toMatch(/^did:webvh:/);
    expect(webDoc.id).toContain('magby.originals.build');
  }, 15000);

  test('cleffa config → migrated DID contains cleffa.originals.build', async () => {
    const manager = new DIDManager({
      ...baseConfig,
      webvhNetwork: 'cleffa',
    });

    const peerDoc = await manager.createDIDPeer([]);
    const webDoc = (await manager.migrateToDIDWebVH(peerDoc)).didDocument;

    expect(webDoc.id).toMatch(/^did:webvh:/);
    expect(webDoc.id).toContain('cleffa.originals.build');
  }, 15000);

  test('pichu config (production default) → migrated DID contains pichu.originals.build', async () => {
    const manager = new DIDManager({
      ...baseConfig,
      webvhNetwork: 'pichu',
    });

    const peerDoc = await manager.createDIDPeer([]);
    const webDoc = (await manager.migrateToDIDWebVH(peerDoc)).didDocument;

    expect(webDoc.id).toMatch(/^did:webvh:/);
    expect(webDoc.id).toContain('pichu.originals.build');
  }, 15000);

  test('explicit domain overrides network config', async () => {
    const manager = new DIDManager({
      ...baseConfig,
      webvhNetwork: 'magby',
    });

    const peerDoc = await manager.createDIDPeer([]);
    const webDoc = (await manager.migrateToDIDWebVH(peerDoc, 'custom.example.com')).didDocument;

    expect(webDoc.id).toContain('custom.example.com');
    expect(webDoc.id).not.toContain('magby.originals.build');
  }, 15000);
});

// ---------------------------------------------------------------------------
// DID-003 — Migrate to did:btco regtest → did:btco:reg:<sat>
// ---------------------------------------------------------------------------

describe('DID-003 — migrateToDIDBTCO on regtest produces did:btco:reg prefix', () => {
  test('webvhNetwork=magby → did:btco:reg:<sat>', async () => {
    const manager = new DIDManager({
      ...baseConfig,
      webvhNetwork: 'magby', // magby → regtest
    });

    const km = new KeyManager();
    const kp = await km.generateKeyPair('Ed25519');

    const peerDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:test-btco-reg',
      verificationMethod: [{
        id: 'did:peer:test-btco-reg#keys-0',
        type: 'Multikey',
        controller: 'did:peer:test-btco-reg',
        publicKeyMultibase: kp.publicKey,
      }],
      authentication: ['did:peer:test-btco-reg#keys-0'],
    };

    const btcoDoc = await manager.migrateToDIDBTCO(peerDoc, '98765432100');

    expect(btcoDoc.id).toMatch(/^did:btco:reg:/);
    expect(btcoDoc.id).toContain('98765432100');
  });

  test('explicit network=regtest (no webvhNetwork) → did:btco:reg:<sat>', async () => {
    const manager = new DIDManager({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      enableLogging: false,
      // no webvhNetwork — falls back to explicit network
    });

    const peerDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:reg-test-2',
    };

    const btcoDoc = await manager.migrateToDIDBTCO(peerDoc, '12000000000');

    expect(btcoDoc.id).toMatch(/^did:btco:reg:/);
  });

  test('webvhNetwork=cleffa (signet) → did:btco:sig:<sat>', async () => {
    // No explicit `network`: an explicitly configured Bitcoin network takes
    // precedence over the webvhNetwork mapping (issue #247), so the mapping
    // only applies when `network` is absent.
    const manager = new DIDManager({
      defaultKeyType: 'Ed25519',
      enableLogging: false,
      webvhNetwork: 'cleffa',
    } as OriginalsConfig);

    const peerDoc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:test-btco-sig',
    };

    const btcoDoc = await manager.migrateToDIDBTCO(peerDoc, '50000000001');

    expect(btcoDoc.id).toMatch(/^did:btco:sig:/);
  });
});

// ---------------------------------------------------------------------------
// DID-006 — Create did:webvh with external signer (mock) — no internal key leaked
// ---------------------------------------------------------------------------

describe('DID-006 — createDIDWebVH with external signer', () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: tempDir, cleanup } = await makeTempDir());
  });
  afterEach(async () => cleanup());

  test('external signer is invoked; no keyPair is returned (no leaked internal key)', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair, signCallCount } = await buildMockExternalSigner(km);

    const manager = new WebVHManager();
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      externalSigner: signer,
      externalVerifier: verifier,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [`did:key:${keyPair.publicKey}`],
      outputDir: tempDir,
    });

    // DID is well-formed
    expect(result.did).toMatch(/^did:webvh:/);
    expect(result.didDocument.id).toBe(result.did);

    // External signer was actually called
    expect(signCallCount()).toBeGreaterThan(0);

    // No internal key is present — the field is omitted entirely (no fake
    // empty keyPair a caller might dutifully "persist")
    expect(result.keyPair).toBeUndefined();
  }, 20000);

  test('external signer without verificationMethods → throws', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);

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

  test('external signer without updateKeys → throws', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);

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

  test('external signer with a non-Ed25519 verification method is accepted when updateKeys are Ed25519', async () => {
    // Only updateKeys must be Ed25519 (they sign the DID log, which resolution
    // verifies with Ed25519). A document may validly publish non-Ed25519
    // verification methods for other purposes (e.g. key agreement).
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const secpKP = await km.generateKeyPair('ES256K');

    const manager = new WebVHManager();
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      externalSigner: signer,
      externalVerifier: verifier,
      verificationMethods: [
        { type: 'Multikey', publicKeyMultibase: keyPair.publicKey },
        { type: 'Multikey', publicKeyMultibase: secpKP.publicKey, purpose: 'keyAgreement' },
      ],
      updateKeys: [`did:key:${keyPair.publicKey}`],
    });
    expect(result.did).toMatch(/^did:webvh:/);
  }, 20000);

  test('external signer with non-Ed25519 updateKey → throws (did:webvh is Ed25519-only)', async () => {
    const km = new KeyManager();
    const { signer, verifier, keyPair } = await buildMockExternalSigner(km);
    const secpKP = await km.generateKeyPair('ES256K');

    const manager = new WebVHManager();
    await expect(
      manager.createDIDWebVH({
        domain: 'example.com',
        externalSigner: signer,
        externalVerifier: verifier,
        verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
        updateKeys: [secpKP.publicKey],
      })
    ).rejects.toThrow('did:webvh only supports Ed25519 keys');
  }, 10000);
});

// ---------------------------------------------------------------------------
// DID-006 — Create did:webvh with custom keypair
// ---------------------------------------------------------------------------

describe('DID-006 — createDIDWebVH with custom keypair', () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: tempDir, cleanup } = await makeTempDir());
  });
  afterEach(async () => cleanup());

  test('custom Ed25519 keypair is used verbatim (publicKey round-trips)', async () => {
    const km = new KeyManager();
    const customKP = await km.generateKeyPair('Ed25519');

    const manager = new WebVHManager();
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      keyPair: customKP,
      outputDir: tempDir,
    });

    // The returned keyPair must match the provided one exactly
    expect(result.keyPair.publicKey).toBe(customKP.publicKey);
    expect(result.keyPair.privateKey).toBe(customKP.privateKey);

    // The DID document should include the custom public key in a VM
    const vms = result.didDocument.verificationMethod ?? [];
    const hasCustomKey = vms.some((vm) => vm.publicKeyMultibase === customKP.publicKey);
    expect(hasCustomKey).toBe(true);
  }, 20000);

  test('generated keypair when no keypair provided has z-prefixed multibase keys', async () => {
    const manager = new WebVHManager();
    const result = await manager.createDIDWebVH({
      domain: 'example.com',
    });

    expect(result.keyPair.publicKey).toMatch(/^z/);
    expect(result.keyPair.privateKey).toMatch(/^z/);
  }, 20000);
});

// ---------------------------------------------------------------------------
// DID-007 — Update did:webvh with new service endpoint → new signed log entry
// ---------------------------------------------------------------------------

describe('DID-007 — updateDIDWebVH adds new service endpoint with signed log entry', () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: tempDir, cleanup } = await makeTempDir());
  });
  afterEach(async () => cleanup());

  test('update introduces service endpoint; log grows by one entry', async () => {
    const manager = new WebVHManager();

    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      outputDir: tempDir,
    });
    const initialLogLength = created.log.length;

    const newService = {
      id: `${created.did}#web`,
      type: 'LinkedDomains',
      serviceEndpoint: 'https://example.com',
    };

    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { service: [newService] },
      signer: created.keyPair,
      outputDir: tempDir,
    });

    // Log has exactly one more entry
    expect(updated.log.length).toBe(initialLogLength + 1);

    // New entry carries a proof
    const newEntry = updated.log[updated.log.length - 1];
    expect(Array.isArray(newEntry.proof)).toBe(true);
    expect((newEntry.proof as unknown[]).length).toBeGreaterThan(0);

    const proof = (newEntry.proof as Record<string, unknown>[])[0];
    expect(typeof proof.proofValue).toBe('string');
    expect((proof.proofValue as string).length).toBeGreaterThan(0);

    // The update must actually be APPLIED — not a signed no-op re-stating the
    // previous document (issue #338): the service must appear both in the
    // returned document and in the new log entry's state.
    expect(updated.didDocument.service).toEqual([newService]);
    expect((newEntry.state as { service?: unknown }).service).toEqual([newService]);

    // DID id must be unchanged
    expect(updated.didDocument.id).toBe(created.did);
  }, 30000);

  test('update with external signer+verifier adds signed entry (mock pair)', async () => {
    const km = new KeyManager();
    const { signer: extSigner, verifier: extVerifier, keyPair } = await buildMockExternalSigner(km);

    const manager = new WebVHManager();

    // Create with external signer first
    const created = await manager.createDIDWebVH({
      domain: 'example.com',
      externalSigner: extSigner,
      externalVerifier: extVerifier,
      verificationMethods: [{ type: 'Multikey', publicKeyMultibase: keyPair.publicKey }],
      updateKeys: [`did:key:${keyPair.publicKey}`],
    });

    // Build update signer authorized by the same key as creation
    const internalSigner2 = new Ed25519Signer();
    const mod = await import('didwebvh-ts') as unknown as {
      prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>;
    };
    const { prepareDataForSigning } = mod;
    let updateCalls = 0;
    const authorizedSigner: ExternalSigner = {
      getVerificationMethodId: () => `did:key:${keyPair.publicKey}`,
      async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }): Promise<{ proofValue: string }> {
        updateCalls++;
        const dataToSign = await prepareDataForSigning(input.document, input.proof);
        const sig: Buffer = await internalSigner2.sign(Buffer.from(dataToSign), keyPair.privateKey);
        return { proofValue: multikey.encodeMultibase(sig) };
      },
    };
    const authorizedVerifier: ExternalVerifier = {
      async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
        const pubMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
        return internalSigner2.verify(Buffer.from(message), Buffer.from(signature), pubMultibase);
      },
    };

    const extService = { id: `${created.did}#svc`, type: 'ExampleService', serviceEndpoint: 'https://svc.example.com' };
    const updated = await manager.updateDIDWebVH({
      did: created.did,
      currentLog: created.log,
      updates: { service: [extService] },
      signer: authorizedSigner,
      verifier: authorizedVerifier,
    });

    expect(updated.log.length).toBe(created.log.length + 1);
    expect(updateCalls).toBeGreaterThan(0);
    expect(updated.didDocument.id).toBe(created.did);

    // The update must actually be applied (issue #338), in both the returned
    // document and the appended log entry's state.
    expect(updated.didDocument.service).toEqual([extService]);
    const lastEntry = updated.log[updated.log.length - 1];
    expect((lastEntry.state as { service?: unknown }).service).toEqual([extService]);
  }, 30000);
});

// ---------------------------------------------------------------------------
// DID-010 — saveDIDLog with multiple path segments → nested dir structure
// ---------------------------------------------------------------------------

describe('DID-010 — saveDIDLog with multiple path segments creates nested dirs', () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: tempDir, cleanup } = await makeTempDir());
  });
  afterEach(async () => cleanup());

  test('three path segments → nested directory structure under baseDir/did/', async () => {
    const manager = new WebVHManager();

    const result = await manager.createDIDWebVH({
      domain: 'example.com',
      paths: ['org', 'dept', 'user'],
      outputDir: tempDir,
    });

    expect(result.logPath).toBeDefined();

    // File must exist
    const exists = await fs.promises.access(result.logPath!).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // Path must be inside tempDir
    expect(result.logPath!.startsWith(tempDir)).toBe(true);

    // Must contain the nested path segments
    expect(result.logPath!).toContain(path.join('org', 'dept', 'user'));
    expect(result.logPath!).toContain('did.jsonl');

    // The intermediate directories must also exist
    const dirPath = path.dirname(result.logPath!);
    const dirExists = await fs.promises.access(dirPath).then(() => true).catch(() => false);
    expect(dirExists).toBe(true);
  }, 20000);

  test('saveDIDLog directly with nested paths writes valid JSONL', async () => {
    const manager = new WebVHManager();

    // Create without saving; then save manually to verify path structure
    const created = await manager.createDIDWebVH({ domain: 'example.com', paths: ['a', 'b', 'c'] });

    const logPath = await manager.saveDIDLog(
      created.did,
      created.log,
      tempDir
    );

    expect(logPath).toBeDefined();
    expect(logPath.startsWith(tempDir)).toBe(true);
    expect(logPath).toContain(path.join('a', 'b', 'c'));
    expect(logPath.endsWith('did.jsonl')).toBe(true);

    // Content must be valid JSONL
    const content = await fs.promises.readFile(logPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(created.log.length);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 20000);
});

// ---------------------------------------------------------------------------
// DID-011 — Load corrupted JSONL file → JSON parse error
// ---------------------------------------------------------------------------

describe('DID-011 — loadDIDLog with corrupted JSONL content throws JSON parse error', () => {
  let tempDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ dir: tempDir, cleanup } = await makeTempDir());
  });
  afterEach(async () => cleanup());

  test('corrupted JSONL (invalid JSON line) causes loadDIDLog to throw a SyntaxError', async () => {
    const manager = new WebVHManager();

    // Write a file that contains corrupt JSON
    const corruptFile = path.join(tempDir, 'did.jsonl');
    await fs.promises.writeFile(corruptFile, 'not valid json\n{"versionId": "1"}', 'utf8');

    await expect(manager.loadDIDLog(corruptFile)).rejects.toThrow(SyntaxError);
  });

  test('partially corrupted JSONL (second line invalid) also throws', async () => {
    const manager = new WebVHManager();

    const corruptFile = path.join(tempDir, 'did2.jsonl');
    const validLine = JSON.stringify({ versionId: '1-abc', versionTime: new Date().toISOString(), parameters: {}, state: {} });
    await fs.promises.writeFile(corruptFile, `${validLine}\n{broken json here`, 'utf8');

    await expect(manager.loadDIDLog(corruptFile)).rejects.toThrow(SyntaxError);
  });

  test('empty file leads to JSON parse error (empty string is not valid JSON)', async () => {
    const manager = new WebVHManager();

    const emptyFile = path.join(tempDir, 'empty.jsonl');
    await fs.promises.writeFile(emptyFile, '', 'utf8');

    // An empty file trims to '' → JSON.parse('') throws SyntaxError
    await expect(manager.loadDIDLog(emptyFile)).rejects.toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// DID-019 — Ed25519 verification fails with invalid signature / wrong key → false
// ---------------------------------------------------------------------------

describe('DID-019 — Ed25519 signature negative verification tests', () => {
  const km = new KeyManager();
  const signer = new Ed25519Signer();

  test('verification fails with corrupted signature (bit flip) → returns false', async () => {
    const kp = await km.generateKeyPair('Ed25519');
    const message = Buffer.from('hello, world!', 'utf8');

    // Produce a valid signature
    const validSig = await signer.sign(message, kp.privateKey);
    expect(validSig.length).toBeGreaterThan(0);

    // Corrupt it: flip one byte in the middle of the signature
    const corruptSig = Buffer.from(validSig);
    const midIdx = Math.floor(corruptSig.length / 2);
    corruptSig[midIdx] = corruptSig[midIdx] ^ 0xff;

    // Verify with the corrupted signature must return false
    const result = await signer.verify(message, corruptSig, kp.publicKey);
    expect(result).toBe(false);
  });

  test('verification fails with wrong public key → returns false', async () => {
    const kp1 = await km.generateKeyPair('Ed25519');
    const kp2 = await km.generateKeyPair('Ed25519');
    const message = Buffer.from('authenticate me', 'utf8');

    // Sign with kp1
    const sig = await signer.sign(message, kp1.privateKey);

    // Verify with kp2's public key — must fail
    const result = await signer.verify(message, sig, kp2.publicKey);
    expect(result).toBe(false);
  });

  test('verification passes for correctly matched key+signature (sanity check)', async () => {
    const kp = await km.generateKeyPair('Ed25519');
    const message = Buffer.from('this should pass', 'utf8');

    const sig = await signer.sign(message, kp.privateKey);
    const result = await signer.verify(message, sig, kp.publicKey);
    expect(result).toBe(true);
  });

  test('verification fails when message is tampered after signing → returns false', async () => {
    const kp = await km.generateKeyPair('Ed25519');
    const originalMessage = Buffer.from('original message', 'utf8');
    const tamperedMessage = Buffer.from('tampered message!', 'utf8');

    const sig = await signer.sign(originalMessage, kp.privateKey);

    const result = await signer.verify(tamperedMessage, sig, kp.publicKey);
    expect(result).toBe(false);
  });

  test('verification fails with all-zero signature → returns false', async () => {
    const kp = await km.generateKeyPair('Ed25519');
    const message = Buffer.from('test message', 'utf8');

    // Ed25519 signatures are 64 bytes
    const zeroSig = Buffer.alloc(64, 0);

    const result = await signer.verify(message, zeroSig, kp.publicKey);
    expect(result).toBe(false);
  });
});
