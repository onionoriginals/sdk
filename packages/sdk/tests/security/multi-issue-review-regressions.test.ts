/**
 * Regression tests for the multi-issue review sweep. Per CLAUDE.md,
 * security-sensitive code requires coverage under tests/security/ — these
 * exercise each fix from the attacker's / failure side. Broader behavioral
 * coverage lives in the unit suites.
 */

import { describe, test, expect } from 'bun:test';
import { DIDCache } from '../../src/did/DIDCache';
import { MultiSigManager } from '../../src/vc/MultiSigManager';
import { DIDManager } from '../../src/did/DIDManager';
import { KeyManager } from '../../src/did/KeyManager';
import { AuditLogger } from '../../src/migration/audit/AuditLogger';
import { validateAndNormalizeDomain } from '../../src/lifecycle/domainUtils';
import { validateSatoshiNumber, MAX_SATOSHI_SUPPLY } from '../../src/utils/satoshi-validation';
import { MetricsCollector } from '../../src/utils/MetricsCollector';
import type { DIDDocument } from '../../src/types';
import type { MultiSigPolicy, OriginalsConfig, VerifiableCredential } from '../../src/types';
import { MigrationStateEnum } from '../../src/migration/types';

describe('DID cache returns copies, not internal references (issue #291)', () => {
  test('mutating a resolved document does not poison the cache', async () => {
    const cache = new DIDCache();
    const doc: DIDDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:webvh:example.com:alice',
      verificationMethod: [{ id: '#k1', type: 'Multikey', controller: 'did:webvh:example.com:alice', publicKeyMultibase: 'zABC' }],
    } as unknown as DIDDocument;

    await cache.set('did:webvh:example.com:alice', doc);

    const first = await cache.get('did:webvh:example.com:alice');
    expect(first).not.toBeNull();
    // Attacker/caller mutates the object handed back by resolveDID.
    (first as unknown as { id: string }).id = 'did:webvh:evil.example:mallory';
    (first!.verificationMethod as unknown[]).length = 0;

    const second = await cache.get('did:webvh:example.com:alice');
    expect(second!.id).toBe('did:webvh:example.com:alice');
    expect((second!.verificationMethod as unknown[]).length).toBe(1);
  });

  test('mutating the object passed to set() does not alter the cached copy', async () => {
    const cache = new DIDCache();
    const doc: DIDDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:123',
    } as unknown as DIDDocument;
    await cache.set('did:peer:123', doc);
    (doc as unknown as { id: string }).id = 'did:peer:tampered';

    const cached = await cache.get('did:peer:123');
    expect(cached!.id).toBe('did:peer:123');
  });
});

describe('Multi-sig sessions reject unverified contributions (issue #287)', () => {
  const config: OriginalsConfig = { network: 'regtest', defaultKeyType: 'Ed25519' };
  const baseVC: VerifiableCredential = {
    '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer',
    issuanceDate: new Date().toISOString(),
    credentialSubject: { id: 'did:peer:subject' },
  } as unknown as VerifiableCredential;

  test('a garbage proof is rejected and does not consume the signer slot', async () => {
    const km = new KeyManager();
    const keys = await Promise.all([km.generateKeyPair('Ed25519'), km.generateKeyPair('Ed25519')]);
    const vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    const mgr = new MultiSigManager(config, new DIDManager(config));

    const policy: MultiSigPolicy = { required: 1, total: 2, signerVerificationMethods: vms };
    const session = mgr.createSession(baseVC, policy);

    // A well-formed contribution shape whose proofValue is garbage.
    const garbage = {
      proof: {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-rdfc-2022',
        proofPurpose: 'assertionMethod',
        verificationMethod: vms[0],
        proofValue: 'z' + 'A'.repeat(80),
      },
      signerIndex: 0,
      signedAt: new Date().toISOString(),
    } as never;

    await expect(mgr.addContribution(session.id, garbage)).rejects.toThrow(/invalid proof/i);
    // The garbage never landed, so the session is not falsely finalized...
    expect(mgr.getSession(session.id)!.contributions.length).toBe(0);

    // ...and the same signer can still submit a genuine contribution.
    const good = await mgr.createContribution(session.id, keys[0].privateKey, vms[0]);
    const updated = await mgr.addContribution(session.id, good);
    expect(updated.contributions.length).toBe(1);
    expect(updated.status).toBe('threshold_met');
  });

  test('concurrent contributions from the same signer cannot both land (TOCTOU)', async () => {
    const km = new KeyManager();
    const keys = await Promise.all([km.generateKeyPair('Ed25519'), km.generateKeyPair('Ed25519')]);
    const vms = keys.map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    const mgr = new MultiSigManager(config, new DIDManager(config));

    const policy: MultiSigPolicy = { required: 2, total: 2, signerVerificationMethods: vms };
    const session = mgr.createSession(baseVC, policy);

    // Two valid contributions from the SAME signer, submitted concurrently.
    // The async verify step opens a window between the duplicate check and the
    // push; the re-check must ensure only one survives so a single key cannot
    // count twice toward the threshold.
    const c1 = await mgr.createContribution(session.id, keys[0].privateKey, vms[0]);
    const c2 = await mgr.createContribution(session.id, keys[0].privateKey, vms[0]);

    const results = await Promise.allSettled([
      mgr.addContribution(session.id, c1),
      mgr.addContribution(session.id, c2),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    expect(fulfilled).toBe(1);
    expect(mgr.getSession(session.id)!.contributions.length).toBe(1);
    expect(mgr.getSession(session.id)!.status).toBe('collecting');
  });
});

describe('Migration audit log is tamper-resistant (issue #281)', () => {
  const config = { network: 'regtest' } as unknown as OriginalsConfig;

  const makeRecord = (sourceDid: string, targetDid: string) => ({
    migrationId: 'mig-1',
    timestamp: 1_700_000_000_000,
    initiator: 'tester',
    sourceDid,
    sourceLayer: 'peer' as const,
    targetDid,
    targetLayer: 'webvh' as const,
    finalState: MigrationStateEnum.COMPLETED,
    validationResults: { valid: true, errors: [] } as never,
    costActual: {} as never,
    duration: 5,
    errors: [],
    metadata: {},
  });

  test('getMigrationHistory returns copies; caller mutation cannot corrupt the log', async () => {
    const logger = new AuditLogger(config);
    await logger.logMigration(makeRecord('did:peer:src', 'did:webvh:example.com:dst') as never);

    const history = await logger.getMigrationHistory('did:peer:src');
    expect(history.length).toBe(1);
    // Tamper with the returned records.
    history.pop();
    const again = await logger.getMigrationHistory('did:peer:src');
    expect(again.length).toBe(1);

    again[0].finalState = MigrationStateEnum.FAILED;
    const third = await logger.getMigrationHistory('did:peer:src');
    expect(third[0].finalState).toBe(MigrationStateEnum.COMPLETED);
  });

  test('records are not shared between the source and target DID histories', async () => {
    const logger = new AuditLogger(config);
    await logger.logMigration(makeRecord('did:peer:src', 'did:webvh:example.com:dst') as never);

    const srcHistory = await logger.getMigrationHistory('did:peer:src');
    srcHistory[0].targetDid = 'did:webvh:evil:pwned';

    const dstHistory = await logger.getMigrationHistory('did:webvh:example.com:dst');
    expect(dstHistory[0].targetDid).toBe('did:webvh:example.com:dst');
  });
});

describe('Domain validation rejects malformed IPv4 (issue #292)', () => {
  test('out-of-range octets are rejected', () => {
    expect(() => validateAndNormalizeDomain('999.999.999.999')).toThrow(/0-255|Invalid domain/);
    expect(() => validateAndNormalizeDomain('256.1.1.1')).toThrow(/0-255|Invalid domain/);
  });

  test('valid IPv4 and hostnames still pass', () => {
    expect(validateAndNormalizeDomain('192.168.1.1')).toBe('192.168.1.1');
    expect(validateAndNormalizeDomain('example.com')).toBe('example.com');
    expect(validateAndNormalizeDomain('localhost')).toBe('localhost');
  });
});

describe('Satoshi upper bound excludes non-existent ordinals (issue #292)', () => {
  test('the nominal 21M-BTC figure is now rejected', () => {
    expect(MAX_SATOSHI_SUPPLY).toBe(2_099_999_997_689_999);
    expect(validateSatoshiNumber('2100000000000000').valid).toBe(false);
  });

  test('the true last ordinal is accepted', () => {
    expect(validateSatoshiNumber('2099999997689999').valid).toBe(true);
  });
});

describe('publishToWeb rejects path-traversal in did:webvh (issue #274)', () => {
  test('a did:webvh whose path segments contain ".." is rejected', async () => {
    const { OriginalsSDK } = await import('../../src');
    const { MemoryStorageAdapter } = await import('../../src/storage/MemoryStorageAdapter');
    const sdk = OriginalsSDK.create({ storageAdapter: new MemoryStorageAdapter(), network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r1', type: 'text', content: 'hello', contentType: 'text/plain', hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
    ]);

    // A crafted SCID-form DID with traversal segments after the domain.
    const malicious = 'did:webvh:QmSCIDplaceholderplaceholderplaceholder:example.com:..:..:etc';
    await expect(sdk.lifecycle.publishToWeb(asset, malicious)).rejects.toThrow(/path segment|Invalid did:webvh/i);
  });

  test('a domain that percent-decodes to a traversal path is rejected', async () => {
    const { OriginalsSDK } = await import('../../src');
    const { MemoryStorageAdapter } = await import('../../src/storage/MemoryStorageAdapter');
    const sdk = OriginalsSDK.create({ storageAdapter: new MemoryStorageAdapter(), network: 'regtest' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r1', type: 'text', content: 'hello', contentType: 'text/plain', hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' },
    ]);

    // did:webvh:{SCID}:{domain} where the domain decodes to '../../etc'.
    const malicious = 'did:webvh:QmSCIDplaceholderplaceholderplaceholder:..%2F..%2Fetc';
    await expect(sdk.lifecycle.publishToWeb(asset, malicious)).rejects.toThrow(/Invalid domain|Invalid did:webvh/i);
  });
});

describe('did:btco resolution rejects cross-network DIDs (issue #267)', () => {
  test('a regtest DID resolved against a mainnet provider is rejected before querying', async () => {
    const { OrdMockProvider } = await import('../../src/adapters/providers/OrdMockProvider');
    const provider = new OrdMockProvider();
    const dm = new DIDManager({ network: 'mainnet', ordinalsProvider: provider } as unknown as OriginalsConfig);

    await expect(dm.resolveDID('did:btco:reg:12345')).rejects.toThrow(/network/i);
  });

  test('a matching-network DID is not rejected by the cross-network guard', async () => {
    const { OrdMockProvider } = await import('../../src/adapters/providers/OrdMockProvider');
    const provider = new OrdMockProvider();
    const dm = new DIDManager({ network: 'regtest', ordinalsProvider: provider } as unknown as OriginalsConfig);

    // No inscription exists, so this resolves to null — but it must NOT throw a
    // network-mismatch error (the guard should pass for a regtest DID on a
    // regtest-configured SDK).
    const doc = await dm.resolveDID('did:btco:reg:12345');
    expect(doc).toBeNull();
  });
});

describe('Prometheus label values are escaped (issue #292)', () => {
  test('an error code containing a quote/backslash/newline cannot break exposition', () => {
    const metrics = new MetricsCollector();
    metrics.recordError('bad"code\\with\nnewline');
    const out = metrics.export('prometheus');
    const line = out.split('\n').find(l => l.startsWith('originals_errors_total{'));
    expect(line).toBeDefined();
    // The raw control/quote characters must not appear unescaped in the label.
    expect(line).toContain('code="bad\\"code\\\\with\\nnewline"');
    expect(line).not.toContain('\n' + 'newline');
  });

  test('an operation name with a newline does not split the # HELP line', () => {
    const metrics = new MetricsCollector();
    metrics.recordOperation('op\ninjected', 5, true);
    const out = metrics.export('prometheus');
    // The per-operation HELP lines must carry the escaped name on one physical
    // line (raw newline replaced with the literal \n escape).
    const perOpHelp = out.split('\n').filter(l => l.startsWith('# HELP originals_operation_op_injected'));
    expect(perOpHelp.length).toBeGreaterThan(0);
    for (const line of perOpHelp) {
      expect(line).toContain('op\\ninjected');
    }
    // The injected fragment must not appear as its own stray line.
    expect(out.split('\n').some(l => l === 'injected operations')).toBe(false);
  });
});
