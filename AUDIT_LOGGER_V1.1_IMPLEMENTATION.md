# Production AuditLogger Implementation - v1.1 Feature

**Feature:** Production-ready AuditLogger with Ed25519 Digital Signatures
**Version:** v1.1.0
**Priority:** High
**Estimated Effort:** 1-2 days

---

## Overview

Implement a production-ready AuditLogger with proper Ed25519 digital signatures for migration audit records. This will replace the temporary SHA256 hash-based integrity checking with cryptographically verifiable signatures that provide both **integrity** and **authenticity**.

The implementation should follow the **same pattern as WebVHManager's external signer support**, allowing for:
- SDK-managed key signing (default)
- External signer integration (Turnkey, AWS KMS, HSM)

---

## Current Status

**File:** `/home/user/sdk/packages/sdk/src/migration/audit/AuditLogger.ts`

**Current Implementation (Lines 81-102):**
- Uses SHA256 hash for integrity verification
- ✅ Detects tampering
- ❌ Cannot prove authenticity (who created the record)
- ❌ Not suitable for compliance/legal use cases

**Status in v1.0:**
- AuditLogger is **disabled** in `MigrationManager.ts`
- All calls to `auditLogger.logMigration()` are commented out
- `getMigrationHistory()` returns empty array

---

## Requirements

### Functional Requirements

1. **Digital Signature Support**
   - Sign audit records with Ed25519 (primary)
   - Support ES256K (secp256k1) for Bitcoin compatibility
   - Support ES256 (secp256r1) for enterprise systems

2. **External Signer Integration**
   - Support `ExternalSigner` interface (same as did:webvh)
   - Allow Turnkey, AWS KMS, HSM integration
   - Fallback to SDK-managed keys

3. **Verification**
   - Verify signatures using public keys
   - Support external verifier for signature validation
   - Reject tampered or invalid signatures

4. **Storage**
   - Persist signed audit records to storage adapter
   - Append-only (never overwrite)
   - Queryable by DID, migration ID, timestamp

5. **Backward Compatibility**
   - Support migration of existing unsigned records
   - Clear upgrade path from v1.0

### Non-Functional Requirements

1. **Performance:** Signing should add <10ms overhead
2. **Security:** Private keys never persisted in audit records
3. **Compliance:** Audit records should be legally defensible
4. **Auditability:** Full chain of custody for all migrations

---

## Architecture

### Pattern: Follow WebVHManager External Signer Design

The implementation should mirror `/home/user/sdk/packages/sdk/src/did/WebVHManager.ts` (lines 54-115):

**WebVHManager Pattern:**
```typescript
class OriginalsWebVHSigner implements Signer {
  private privateKeyMultibase: string;
  private signer: Ed25519Signer;

  async sign(input: SigningInput): Promise<SigningOutput> {
    const dataToSign = await this.prepareDataForSigning(input.document, input.proof);
    const signature = await this.signer.sign(Buffer.from(dataToSign), this.privateKeyMultibase);
    return { proofValue: multikey.encodeMultibase(signature) };
  }

  getVerificationMethodId(): string {
    return `did:key:${this.verificationMethod?.publicKeyMultibase}`;
  }
}
```

**Apply to AuditLogger:**
```typescript
class OriginalsAuditSigner {
  private privateKeyMultibase: string;
  private signer: Ed25519Signer;
  private signerDid: string;  // did:webvh, did:peer, or did:btco

  async sign(record: MigrationAuditRecord): Promise<string> {
    const canonical = this.prepareRecordForSigning(record);
    const signature = await this.signer.sign(canonical, this.privateKeyMultibase);
    return multikey.encodeMultibase(signature);
  }

  async verify(record: MigrationAuditRecord, didDocument: DIDDocument): Promise<boolean> {
    const canonical = this.prepareRecordForSigning(record);
    const verificationMethod = didDocument.verificationMethod?.[0];
    return this.signer.verify(canonical, record.signature, verificationMethod.publicKeyMultibase);
  }

  getSignerId(): string {
    return this.signerDid;  // Returns did:webvh:..., did:peer:..., or did:btco:...
  }
}
```

---

## Implementation Steps

### Step 1: Update AuditLogger Interface

**File:** `/home/user/sdk/packages/sdk/src/migration/types.ts`

Add new interfaces for audit signing:

```typescript
/**
 * Audit signer interface - mirrors ExternalSigner pattern
 * NOTE: signerId should be a fully-qualified Originals DID:
 * - did:webvh:example.com:alice (most common - production deployments)
 * - did:peer:abc123 (development/testing)
 * - did:btco:123456 (Bitcoin-anchored for maximum security)
 */
export interface AuditSigner {
  sign(record: Omit<MigrationAuditRecord, 'signature'>): Promise<{ signature: string }>;
  getSignerId(): Promise<string> | string;  // Returns did:webvh:..., did:peer:..., or did:btco:...
}

/**
 * Audit verifier interface
 * Verification requires resolving the signer's DID to get verification methods
 */
export interface AuditVerifier {
  verify(record: MigrationAuditRecord, signerDidDocument: DIDDocument): Promise<boolean>;
}

/**
 * Audit configuration options
 */
export interface AuditConfig {
  signer?: AuditSigner;           // External signer (Turnkey, AWS KMS, etc.)
  verifier?: AuditVerifier;       // External verifier
  signerDid?: string;             // DID of the signer (did:webvh:..., did:peer:..., or did:btco:...)
  keyPair?: KeyPair;              // SDK-managed key pair (only if signerDid is did:peer)
  autoGenerate?: boolean;         // Auto-generate did:peer if none provided (default: true)
}
```

**Update MigrationAuditRecord:**

```typescript
export interface MigrationAuditRecord {
  migrationId: string;
  timestamp: number;
  initiator: string;
  sourceDid: string;
  sourceLayer: DIDLayer;
  targetDid: string | null;
  targetLayer: DIDLayer;
  finalState: MigrationStateEnum;
  validationResults: MigrationValidationResult;
  costActual: CostEstimate;
  duration: number;
  checkpointId?: string;
  errors: MigrationError[];
  metadata: Record<string, any>;

  // NEW: Signature fields
  signature?: string;              // Multibase-encoded signature
  signerId?: string;               // Full DID of signer (did:webvh:..., did:peer:..., or did:btco:...)
  signerVerificationMethod?: string; // Specific verification method used (e.g., did:webvh:example.com:alice#key-1)
  signatureAlgorithm?: 'Ed25519' | 'ES256K' | 'ES256'; // Algorithm used
}
```

---

### Step 2: Create OriginalsAuditSigner

**File:** `/home/user/sdk/packages/sdk/src/migration/audit/OriginalsAuditSigner.ts` (NEW FILE)

```typescript
import { Ed25519Signer } from '../../crypto/Signer';
import { multikey } from '../../crypto/Multikey';
import { MigrationAuditRecord, AuditSigner, AuditVerifier } from '../types';
import { KeyPair } from '../../types';

/**
 * SDK-managed audit signer using Ed25519
 * Mirrors OriginalsWebVHSigner pattern from WebVHManager
 *
 * Uses Originals DIDs (did:webvh, did:peer, did:btco) instead of did:key
 */
export class OriginalsAuditSigner implements AuditSigner, AuditVerifier {
  private privateKeyMultibase: string;
  private publicKeyMultibase: string;
  private signer: Ed25519Signer;
  private signerDid: string;
  private verificationMethodId: string;

  constructor(
    keyPair: KeyPair,
    signerDid: string,
    verificationMethodId?: string
  ) {
    this.privateKeyMultibase = keyPair.privateKey;
    this.publicKeyMultibase = keyPair.publicKey;
    this.signer = new Ed25519Signer();

    // Use provided Originals DID (did:webvh, did:peer, or did:btco)
    this.signerDid = signerDid;

    // Default to #key-1 if not specified
    this.verificationMethodId = verificationMethodId || `${signerDid}#key-1`;
  }

  /**
   * Sign an audit record
   */
  async sign(record: Omit<MigrationAuditRecord, 'signature'>): Promise<{ signature: string }> {
    // Create canonical representation (deterministic JSON)
    const canonical = this.prepareRecordForSigning(record);

    // Sign with Ed25519
    const signatureBuffer = await this.signer.sign(
      Buffer.from(canonical, 'utf8'),
      this.privateKeyMultibase
    );

    // Encode as multibase
    const signature = multikey.encodeMultibase(signatureBuffer);

    return { signature };
  }

  /**
   * Verify an audit record signature
   * Requires the signer's DID document to extract verification methods
   */
  async verify(record: MigrationAuditRecord, signerDidDocument: DIDDocument): Promise<boolean> {
    if (!record.signature) {
      return false;
    }

    // Extract public key from DID document's verification method
    const verificationMethod = record.signerVerificationMethod
      ? signerDidDocument.verificationMethod?.find(vm => vm.id === record.signerVerificationMethod)
      : signerDidDocument.verificationMethod?.[0];

    if (!verificationMethod || !verificationMethod.publicKeyMultibase) {
      throw new Error('Cannot find verification method in DID document');
    }

    // Reconstruct canonical representation
    const canonical = this.prepareRecordForSigning(record);

    // Decode signature
    const signatureBuffer = multikey.decodeMultibase(record.signature);

    // Verify
    return this.signer.verify(
      Buffer.from(canonical, 'utf8'),
      signatureBuffer,
      verificationMethod.publicKeyMultibase
    );
  }

  /**
   * Get signer identifier (Originals DID)
   */
  getSignerId(): string {
    return this.signerDid;  // Returns did:webvh:..., did:peer:..., or did:btco:...
  }

  /**
   * Get verification method ID
   */
  getVerificationMethodId(): string {
    return this.verificationMethodId;
  }

  /**
   * Get public key for verification
   */
  getPublicKey(): string {
    return this.publicKeyMultibase;
  }

  /**
   * Prepare record for signing using JSON Canonicalization Scheme (JCS)
   * This ensures deterministic serialization for signature verification
   */
  private prepareRecordForSigning(record: Omit<MigrationAuditRecord, 'signature'> | MigrationAuditRecord): string {
    // Remove signature field if present
    const { signature, signerId, signerPublicKey, signatureAlgorithm, ...recordWithoutSig } = record as any;

    // Sort keys alphabetically for deterministic output
    const sortedRecord = this.sortObjectKeys(recordWithoutSig);

    // Serialize to JSON
    return JSON.stringify(sortedRecord);
  }

  /**
   * Recursively sort object keys for deterministic serialization
   */
  private sortObjectKeys(obj: any): any {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObjectKeys(item));
    }

    const sorted: any = {};
    Object.keys(obj).sort().forEach(key => {
      sorted[key] = this.sortObjectKeys(obj[key]);
    });

    return sorted;
  }
}

/**
 * Example usage patterns
 */

// Pattern 1: Using did:webvh (recommended for production)
const webvhKeyPair = keyManager.generateKeyPair('Ed25519');
const webvhDid = 'did:webvh:example.com:audit-signer';
const webvhSigner = new OriginalsAuditSigner(webvhKeyPair, webvhDid, `${webvhDid}#key-1`);

// Pattern 2: Using did:peer (development/testing)
const peerKeyPair = keyManager.generateKeyPair('Ed25519');
const peerDid = 'did:peer:abc123';
const peerSigner = new OriginalsAuditSigner(peerKeyPair, peerDid);

// Pattern 3: Using did:btco (maximum security, Bitcoin-anchored)
const btcoKeyPair = keyManager.generateKeyPair('ES256K');
const btcoDid = 'did:btco:123456789';
const btcoSigner = new OriginalsAuditSigner(btcoKeyPair, btcoDid, `${btcoDid}#key-1`);
}
```

---

### Step 3: Update AuditLogger Class

**File:** `/home/user/sdk/packages/sdk/src/migration/audit/AuditLogger.ts`

**Replace lines 81-102 with production implementation:**

```typescript
import { KeyManager } from '../../did/KeyManager';
import { DIDManager } from '../../did/DIDManager';
import { OriginalsAuditSigner } from './OriginalsAuditSigner';
import { AuditConfig, AuditSigner, AuditVerifier } from '../types';

export class AuditLogger implements IAuditLogger {
  private auditRecords: Map<string, MigrationAuditRecord[]>;
  private signer: AuditSigner;
  private verifier?: AuditVerifier;
  private keyManager: KeyManager;
  private didManager: DIDManager;

  constructor(
    private config: OriginalsConfig,
    didManager: DIDManager,
    auditConfig?: AuditConfig
  ) {
    this.auditRecords = new Map();
    this.keyManager = new KeyManager();
    this.didManager = didManager;

    // Initialize signer (SDK-managed or external)
    this.signer = this.initializeSigner(auditConfig);
    this.verifier = auditConfig?.verifier;
  }

  /**
   * Initialize signer based on configuration
   * Mirrors WebVHManager's createDIDWebVH logic
   *
   * Priority order:
   * 1. External signer (Turnkey, AWS KMS, HSM)
   * 2. Existing DID with key pair (did:webvh, did:peer, did:btco)
   * 3. Auto-generate did:peer (default)
   */
  private async initializeSigner(auditConfig?: AuditConfig): Promise<AuditSigner> {
    // Option 1: External signer provided (Turnkey, AWS KMS, HSM)
    if (auditConfig?.signer) {
      return auditConfig.signer;
    }

    // Option 2: Existing DID with key pair provided
    if (auditConfig?.signerDid && auditConfig?.keyPair) {
      return new OriginalsAuditSigner(
        auditConfig.keyPair,
        auditConfig.signerDid,
        `${auditConfig.signerDid}#key-1`
      );
    }

    // Option 3: Auto-generate did:peer (default)
    if (auditConfig?.autoGenerate !== false) {
      const keyPair = this.keyManager.generateKeyPair('Ed25519');
      const peerResult = await this.didManager.createDIDPeer({ keyPair });

      console.warn('AuditLogger: Auto-generated did:peer for audit signing. Store this securely:', {
        did: peerResult.did,
        publicKey: keyPair.publicKey,
        privateKey: '***REDACTED***'  // Never log private keys
      });

      return new OriginalsAuditSigner(keyPair, peerResult.did);
    }

    throw new Error('AuditLogger requires signer, signerDid+keyPair, or autoGenerate enabled');
  }

  /**
   * Log a migration audit record with digital signature
   */
  async logMigration(record: MigrationAuditRecord): Promise<void> {
    // Remove existing signature if present (re-signing)
    const { signature, signerId, signerPublicKey, signatureAlgorithm, ...unsignedRecord } = record;

    // Sign the audit record
    const { signature: newSignature } = await this.signer.sign(unsignedRecord);
    const signerIdValue = await this.signer.getSignerId();

    // Get signer verification method
    const signerVerificationMethodValue = this.signer instanceof OriginalsAuditSigner
      ? this.signer.getVerificationMethodId()
      : undefined;

    const signedRecord: MigrationAuditRecord = {
      ...unsignedRecord,
      signature: newSignature,
      signerId: signerIdValue,
      signerVerificationMethod: signerVerificationMethodValue,
      signatureAlgorithm: 'Ed25519' // TODO: Detect from signer
    };

    // Store by source DID
    const existingRecords = this.auditRecords.get(record.sourceDid) || [];
    existingRecords.push(signedRecord);
    this.auditRecords.set(record.sourceDid, existingRecords);

    // Also store by target DID if available
    if (record.targetDid) {
      const targetRecords = this.auditRecords.get(record.targetDid) || [];
      targetRecords.push(signedRecord);
      this.auditRecords.set(record.targetDid, targetRecords);
    }

    // Persist to storage (append-only)
    await this.persistAuditRecord(signedRecord);
  }

  /**
   * Verify an audit record signature
   * Returns true if signature is valid and authentic
   *
   * Verification process:
   * 1. Resolve signer's DID (did:webvh, did:peer, or did:btco)
   * 2. Extract verification method from DID document
   * 3. Verify signature using public key from verification method
   */
  async verifyAuditRecord(record: MigrationAuditRecord): Promise<boolean> {
    if (!record.signature || !record.signerId) {
      return false;
    }

    try {
      // Resolve the signer's DID to get verification methods
      const signerDidDocument = await this.didManager.resolveDID(record.signerId);

      // Use external verifier if provided
      if (this.verifier) {
        return this.verifier.verify(record, signerDidDocument);
      }

      // Use default verifier with DID document
      if (this.signer instanceof OriginalsAuditSigner) {
        return this.signer.verify(record, signerDidDocument);
      }

      // Cannot verify without appropriate verifier
      return false;
    } catch (error) {
      console.error('Failed to verify audit record:', error);
      return false;
    }
  }

  // ... rest of existing methods (getMigrationHistory, getSystemMigrationLogs, etc.)
}
```

---

### Step 4: Update MigrationManager Integration

**File:** `/home/user/sdk/packages/sdk/src/migration/MigrationManager.ts`

**Uncomment and update AuditLogger initialization:**

```typescript
// BEFORE (v1.0 - disabled):
// TODO: AuditLogger temporarily disabled for v1.0 release
// this.auditLogger = new AuditLogger(config);

// AFTER (v1.1 - enabled with signing):
import { AuditLogger } from './audit/AuditLogger';

// In constructor:
this.auditLogger = new AuditLogger(config, didManager, {
  autoGenerate: true,  // Auto-generate did:peer for audit signing
  // OR provide explicit DID:
  // signerDid: 'did:webvh:example.com:audit-signer',
  // keyPair: config.auditKeyPair,
  // OR use external signer:
  // signer: config.auditSigner,
});
```

**Uncomment all auditLogger calls:**

```typescript
// Line 187 - After successful migration:
await this.auditLogger.logMigration(auditRecord);

// Line 260 - Get migration history:
async getMigrationHistory(did: string): Promise<any[]> {
  return await this.auditLogger.getMigrationHistory(did);
}

// Line 406 - After migration failure:
await this.auditLogger.logMigration(auditRecord);
```

---

### Step 5: Update OriginalsConfig Type

**File:** `/home/user/sdk/packages/sdk/src/types/common.ts`

Add audit configuration to SDK config:

```typescript
export interface OriginalsConfig {
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  defaultKeyType?: KeyType;
  ordinalsProvider?: OrdinalsProvider;
  feeOracle?: FeeOracleAdapter;
  storageAdapter?: StorageAdapter;
  enableLogging?: boolean;
  logging?: LoggingConfig;
  telemetry?: TelemetryConfig;

  // NEW: Audit logging configuration
  auditConfig?: {
    enabled?: boolean;           // Enable/disable audit logging (default: true)
    signer?: AuditSigner;        // External audit signer (Turnkey, AWS KMS, etc.)
    verifier?: AuditVerifier;    // External audit verifier
    signerDid?: string;          // DID of audit signer (did:webvh:..., did:peer:..., or did:btco:...)
    keyPair?: KeyPair;           // SDK-managed key pair (required if signerDid provided)
    autoGenerate?: boolean;      // Auto-generate did:peer if no signer provided (default: true)
  };
}
```

---

### Step 6: Add Tests

**File:** `/home/user/sdk/packages/sdk/tests/unit/migration/audit/AuditLogger.test.ts` (NEW FILE)

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { AuditLogger } from '../../../../src/migration/audit/AuditLogger';
import { OriginalsAuditSigner } from '../../../../src/migration/audit/OriginalsAuditSigner';
import { KeyManager } from '../../../../src/did/KeyManager';
import { MigrationAuditRecord, MigrationStateEnum } from '../../../../src/migration/types';
import { OriginalsConfig } from '../../../../src/types';

describe('AuditLogger with Digital Signatures', () => {
  let config: OriginalsConfig;
  let auditLogger: AuditLogger;
  let keyManager: KeyManager;

  beforeEach(() => {
    config = {
      network: 'testnet',
      enableLogging: false
    };
    keyManager = new KeyManager();
  });

  describe('Signature Generation', () => {
    test('should sign audit records with Ed25519', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      auditLogger = new AuditLogger(config, { keyPair });

      const record: MigrationAuditRecord = {
        migrationId: 'test-migration-1',
        timestamp: Date.now(),
        initiator: 'test-user',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer',
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh',
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 25, networkFees: 0, totalCost: 25, currency: 'USD' },
        duration: 1500,
        errors: [],
        metadata: {}
      };

      await auditLogger.logMigration(record);

      const history = await auditLogger.getMigrationHistory('did:peer:123');
      expect(history).toHaveLength(1);
      expect(history[0].signature).toBeDefined();
      expect(history[0].signerId).toBeDefined();
      expect(history[0].signerPublicKey).toBeDefined();
      expect(history[0].signatureAlgorithm).toBe('Ed25519');
    });

    test('should create deterministic signatures', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signer = new OriginalsAuditSigner(keyPair);

      const record = {
        migrationId: 'test-migration-1',
        timestamp: 1234567890,
        initiator: 'test-user',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer' as const,
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh' as const,
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 25, networkFees: 0, totalCost: 25, currency: 'USD' },
        duration: 1500,
        errors: [],
        metadata: {}
      };

      const { signature: sig1 } = await signer.sign(record);
      const { signature: sig2 } = await signer.sign(record);

      expect(sig1).toBe(sig2);
    });
  });

  describe('Signature Verification', () => {
    test('should verify valid signatures', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      auditLogger = new AuditLogger(config, { keyPair });

      const record: MigrationAuditRecord = {
        migrationId: 'test-migration-1',
        timestamp: Date.now(),
        initiator: 'test-user',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer',
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh',
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 25, networkFees: 0, totalCost: 25, currency: 'USD' },
        duration: 1500,
        errors: [],
        metadata: {}
      };

      await auditLogger.logMigration(record);
      const history = await auditLogger.getMigrationHistory('did:peer:123');

      const isValid = await auditLogger.verifyAuditRecord(history[0]);
      expect(isValid).toBe(true);
    });

    test('should reject tampered records', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      auditLogger = new AuditLogger(config, { keyPair });

      const record: MigrationAuditRecord = {
        migrationId: 'test-migration-1',
        timestamp: Date.now(),
        initiator: 'test-user',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer',
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh',
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 25, networkFees: 0, totalCost: 25, currency: 'USD' },
        duration: 1500,
        errors: [],
        metadata: {}
      };

      await auditLogger.logMigration(record);
      const history = await auditLogger.getMigrationHistory('did:peer:123');

      // Tamper with the record
      history[0].duration = 9999;

      const isValid = await auditLogger.verifyAuditRecord(history[0]);
      expect(isValid).toBe(false);
    });
  });

  describe('External Signer Integration', () => {
    test('should support external signers (Turnkey pattern)', async () => {
      // Mock external signer (like Turnkey)
      const mockExternalSigner = {
        async sign(record: any) {
          // Simulate Turnkey signing
          return { signature: 'uMOCK_SIGNATURE_FROM_TURNKEY' };
        },
        getSignerId: () => 'did:key:turnkey123'
      };

      auditLogger = new AuditLogger(config, { signer: mockExternalSigner });

      const record: MigrationAuditRecord = {
        migrationId: 'test-migration-1',
        timestamp: Date.now(),
        initiator: 'test-user',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer',
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh',
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 25, networkFees: 0, totalCost: 25, currency: 'USD' },
        duration: 1500,
        errors: [],
        metadata: {}
      };

      await auditLogger.logMigration(record);
      const history = await auditLogger.getMigrationHistory('did:peer:123');

      expect(history[0].signature).toBe('uMOCK_SIGNATURE_FROM_TURNKEY');
      expect(history[0].signerId).toBe('did:key:turnkey123');
    });
  });

  describe('Auto-generate Keys', () => {
    test('should auto-generate keys when no config provided', async () => {
      auditLogger = new AuditLogger(config, { autoGenerate: true });

      const record: MigrationAuditRecord = {
        migrationId: 'test-migration-1',
        timestamp: Date.now(),
        initiator: 'test-user',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer',
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh',
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 25, networkFees: 0, totalCost: 25, currency: 'USD' },
        duration: 1500,
        errors: [],
        metadata: {}
      };

      await auditLogger.logMigration(record);
      const history = await auditLogger.getMigrationHistory('did:peer:123');

      expect(history[0].signature).toBeDefined();
      expect(history[0].signerId).toMatch(/^did:key:/);
    });
  });
});
```

**File:** `/home/user/sdk/packages/sdk/tests/unit/migration/audit/OriginalsAuditSigner.test.ts` (NEW FILE)

```typescript
import { describe, test, expect } from 'bun:test';
import { OriginalsAuditSigner } from '../../../../src/migration/audit/OriginalsAuditSigner';
import { KeyManager } from '../../../../src/did/KeyManager';
import { MigrationStateEnum } from '../../../../src/migration/types';

describe('OriginalsAuditSigner', () => {
  const keyManager = new KeyManager();

  describe('sign()', () => {
    test('should generate valid Ed25519 signatures', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signer = new OriginalsAuditSigner(keyPair);

      const record = {
        migrationId: 'test-1',
        timestamp: Date.now(),
        initiator: 'system',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer' as const,
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh' as const,
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
        duration: 1000,
        errors: [],
        metadata: {}
      };

      const { signature } = await signer.sign(record);

      expect(signature).toBeDefined();
      expect(signature).toMatch(/^u/); // Multibase prefix for base64url
    });

    test('should produce deterministic signatures for same input', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signer = new OriginalsAuditSigner(keyPair);

      const record = {
        migrationId: 'test-1',
        timestamp: 1234567890,
        initiator: 'system',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer' as const,
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh' as const,
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
        duration: 1000,
        errors: [],
        metadata: {}
      };

      const { signature: sig1 } = await signer.sign(record);
      const { signature: sig2 } = await signer.sign(record);

      expect(sig1).toBe(sig2);
    });
  });

  describe('verify()', () => {
    test('should verify valid signatures', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signer = new OriginalsAuditSigner(keyPair);

      const record = {
        migrationId: 'test-1',
        timestamp: Date.now(),
        initiator: 'system',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer' as const,
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh' as const,
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
        duration: 1000,
        errors: [],
        metadata: {}
      };

      const { signature } = await signer.sign(record);
      const signedRecord = { ...record, signature };

      const isValid = await signer.verify(signedRecord);
      expect(isValid).toBe(true);
    });

    test('should reject tampered records', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signer = new OriginalsAuditSigner(keyPair);

      const record = {
        migrationId: 'test-1',
        timestamp: Date.now(),
        initiator: 'system',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer' as const,
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh' as const,
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
        duration: 1000,
        errors: [],
        metadata: {}
      };

      const { signature } = await signer.sign(record);
      const signedRecord = { ...record, signature };

      // Tamper with the record
      signedRecord.duration = 9999;

      const isValid = await signer.verify(signedRecord);
      expect(isValid).toBe(false);
    });

    test('should verify with external public key', async () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signer = new OriginalsAuditSigner(keyPair);

      const record = {
        migrationId: 'test-1',
        timestamp: Date.now(),
        initiator: 'system',
        sourceDid: 'did:peer:123',
        sourceLayer: 'peer' as const,
        targetDid: 'did:webvh:example.com',
        targetLayer: 'webvh' as const,
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: { valid: true, errors: [], warnings: [], estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' }, estimatedDuration: 0 },
        costActual: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
        duration: 1000,
        errors: [],
        metadata: {}
      };

      const { signature } = await signer.sign(record);
      const signedRecord = { ...record, signature };

      // Verify using public key
      const isValid = await signer.verify(signedRecord, keyPair.publicKey);
      expect(isValid).toBe(true);
    });
  });

  describe('getSignerId()', () => {
    test('should return Originals DID identifier (not did:key)', () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signerDid = 'did:webvh:example.com:audit';
      const signer = new OriginalsAuditSigner(keyPair, signerDid);

      const signerId = signer.getSignerId();

      expect(signerId).toBe('did:webvh:example.com:audit');
      expect(signerId).not.toMatch(/^did:key:/);
    });

    test('should support did:peer for development', () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signerDid = 'did:peer:abc123';
      const signer = new OriginalsAuditSigner(keyPair, signerDid);

      const signerId = signer.getSignerId();

      expect(signerId).toBe('did:peer:abc123');
    });

    test('should support did:btco for Bitcoin-anchored audit', () => {
      const keyPair = keyManager.generateKeyPair('ES256K');
      const signerDid = 'did:btco:123456789';
      const signer = new OriginalsAuditSigner(keyPair, signerDid);

      const signerId = signer.getSignerId();

      expect(signerId).toBe('did:btco:123456789');
    });
  });

  describe('getPublicKey()', () => {
    test('should return multibase-encoded public key', () => {
      const keyPair = keyManager.generateKeyPair('Ed25519');
      const signer = new OriginalsAuditSigner(keyPair);

      const publicKey = signer.getPublicKey();

      expect(publicKey).toBe(keyPair.publicKey);
      expect(publicKey).toMatch(/^z/); // Multibase z prefix
    });
  });
});
```

---

### Step 7: Integration Tests

**File:** `/home/user/sdk/packages/sdk/tests/integration/audit-e2e.test.ts` (NEW FILE)

```typescript
import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { OrdMockProvider } from '../../src/bitcoin/adapters/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { KeyManager } from '../../src/did/KeyManager';

describe('AuditLogger End-to-End', () => {
  let sdk: OriginalsSDK;
  let keyManager: KeyManager;

  beforeEach(() => {
    keyManager = new KeyManager();

    const auditKeyPair = keyManager.generateKeyPair('Ed25519');

    sdk = OriginalsSDK.create({
      network: 'testnet',
      ordinalsProvider: new OrdMockProvider(),
      storageAdapter: new MemoryStorageAdapter(),
      enableLogging: false,
      auditConfig: {
        enabled: true,
        keyPair: auditKeyPair,
        autoGenerate: false
      }
    });
  });

  test('should create signed audit records for peer→webvh migration', async () => {
    // Create did:peer
    const peerResult = await sdk.did.createDIDPeer();

    // Migrate to did:webvh
    const webvhResult = await sdk.did.migrateToDIDWebVH({
      sourceDid: peerResult.did,
      domain: 'example.com'
    });

    // Get audit history
    const history = await sdk.migration.getMigrationHistory(peerResult.did);

    expect(history).toHaveLength(1);
    expect(history[0].signature).toBeDefined();
    expect(history[0].signerId).toMatch(/^did:key:/);
    expect(history[0].sourceDid).toBe(peerResult.did);
    expect(history[0].targetDid).toBe(webvhResult.did);
  });

  test('should verify audit record signatures', async () => {
    // Create and migrate
    const peerResult = await sdk.did.createDIDPeer();
    await sdk.did.migrateToDIDWebVH({
      sourceDid: peerResult.did,
      domain: 'example.com'
    });

    // Get audit history
    const history = await sdk.migration.getMigrationHistory(peerResult.did);

    // Verify signature (would use auditLogger.verifyAuditRecord in real code)
    const isValid = await sdk.migration['auditLogger'].verifyAuditRecord(history[0]);
    expect(isValid).toBe(true);
  });

  test('should detect tampered audit records', async () => {
    // Create and migrate
    const peerResult = await sdk.did.createDIDPeer();
    await sdk.did.migrateToDIDWebVH({
      sourceDid: peerResult.did,
      domain: 'example.com'
    });

    // Get audit history
    const history = await sdk.migration.getMigrationHistory(peerResult.did);

    // Tamper with record
    history[0].duration = 99999;

    // Verify should fail
    const isValid = await sdk.migration['auditLogger'].verifyAuditRecord(history[0]);
    expect(isValid).toBe(false);
  });
});
```

---

### Step 8: Documentation

**File:** `/home/user/sdk/docs/AUDIT_LOGGING.md` (NEW FILE)

Create comprehensive documentation covering:
- Overview of audit logging
- Configuration options (SDK-managed vs external signer)
- Example: Using with Turnkey
- Example: Using with AWS KMS
- Example: Using with HSM
- Signature verification
- Compliance and legal considerations
- Troubleshooting

---

## Acceptance Criteria

### Must Have ✅

- [ ] Ed25519 signature generation works correctly
- [ ] Signature verification detects tampering
- [ ] Deterministic signatures (same input → same signature)
- [ ] External signer interface compatible with Turnkey/AWS KMS
- [ ] All tests pass (unit + integration)
- [ ] No performance regression (<10ms overhead per record)
- [ ] Backward compatible with v1.0 (gracefully handles unsigned records)

### Should Have 📋

- [ ] ES256K (secp256k1) support for Bitcoin-native signing
- [ ] ES256 (secp256r1) support for enterprise systems
- [ ] Documentation with Turnkey integration example
- [ ] Migration guide from v1.0 unsigned records

### Nice to Have 💡

- [ ] Batch verification for performance
- [ ] Merkle tree support for efficient batch proofs
- [ ] Export audit trail as W3C Verifiable Presentation
- [ ] Query API for audit records (by date range, state, etc.)

---

## Testing Checklist

- [ ] Unit tests for OriginalsAuditSigner (sign, verify, determinism)
- [ ] Unit tests for AuditLogger (logMigration, getMigrationHistory, verifyAuditRecord)
- [ ] Integration tests for full migration flow with audit logging
- [ ] Security tests for tamper detection
- [ ] Performance tests (<10ms signature overhead)
- [ ] External signer mock tests (Turnkey pattern)
- [ ] Backward compatibility tests (handle unsigned records from v1.0)

---

## Performance Requirements

- Signature generation: **< 5ms** per record
- Signature verification: **< 3ms** per record
- Memory overhead: **< 100 bytes** per record (excluding signature)
- Storage overhead: **< 200 bytes** per record (with signature)

---

## Security Considerations

1. **Private Key Protection**
   - Never log or persist private keys
   - Warn users to store audit keys securely
   - Support external signers for production deployments

2. **Signature Algorithm**
   - Ed25519 for performance and security
   - ES256K for Bitcoin compatibility
   - ES256 for enterprise HSM compatibility

3. **Canonicalization**
   - Use deterministic JSON serialization (JCS)
   - Sort object keys alphabetically
   - Handle edge cases (null, undefined, nested objects)

4. **Verification**
   - Always verify signatures before trusting audit records
   - Reject records without signatures (in production mode)
   - Support external verifiers for compliance

---

## Migration from v1.0

**For users upgrading from v1.0:**

1. **Auto-generate did:peer** (default - for development):
   ```typescript
   const sdk = OriginalsSDK.create({
     network: 'mainnet',
     auditConfig: {
       autoGenerate: true  // Creates did:peer automatically
     }
   });
   ```

2. **Use did:webvh** (recommended for production):
   ```typescript
   // First, create a did:webvh for audit signing
   const auditKeyPair = keyManager.generateKeyPair('Ed25519');
   const auditDid = await sdk.did.createDIDWebVH({
     domain: 'your-company.com',
     paths: ['audit', 'signer'],
     keyPair: auditKeyPair
   });
   // Result: did:webvh:your-company.com:audit:signer

   const sdk = OriginalsSDK.create({
     network: 'mainnet',
     auditConfig: {
       signerDid: auditDid.did,
       keyPair: auditKeyPair
     }
   });
   ```

3. **Use did:btco** (maximum security - Bitcoin-anchored):
   ```typescript
   // First, inscribe a did:btco for audit signing
   const auditKeyPair = keyManager.generateKeyPair('ES256K');
   const auditDid = await sdk.bitcoin.inscribeDID({
     keyPair: auditKeyPair,
     satoshi: '123456789'
   });
   // Result: did:btco:123456789

   const sdk = OriginalsSDK.create({
     network: 'mainnet',
     auditConfig: {
       signerDid: auditDid.did,
       keyPair: auditKeyPair
     }
   });
   ```

4. **Use external signer with did:webvh** (enterprise production):
   ```typescript
   // External signer (Turnkey) manages the private key
   // But the DID is still did:webvh (not did:key)
   const turnkeyAuditSigner = {
     async sign(record) {
       const canonical = JSON.stringify(sortKeys(record));
       const signature = await turnkeyClient.sign({
         organizationId: 'your-org',
         keyId: 'audit-key-id',
         payload: canonical
       });
       return { signature };
     },
     getSignerId: () => 'did:webvh:your-company.com:audit:signer'
   };

   const sdk = OriginalsSDK.create({
     network: 'mainnet',
     auditConfig: {
       signer: turnkeyAuditSigner
     }
   });
   ```

---

## External Signer Examples

### Turnkey Integration with did:webvh

```typescript
import { TurnkeyClient } from '@turnkey/sdk-browser';

// Step 1: Create did:webvh with Turnkey as external signer
const turnkeyWebvhSigner = {
  async sign(input) {
    const canonical = prepareDataForSigning(input.document, input.proof);
    const signResult = await turnkeyClient.signRawPayload({
      organizationId: 'your-org-id',
      signWith: 'audit-webvh-key-id',
      payload: canonical
    });
    return { proofValue: signResult.signature };
  },
  getVerificationMethodId: () => 'did:webvh:your-company.com:audit#key-1'
};

const auditDidResult = await sdk.did.createDIDWebVH({
  domain: 'your-company.com',
  paths: ['audit'],
  externalSigner: turnkeyWebvhSigner,
  verificationMethods: [{
    type: 'Multikey',
    publicKeyMultibase: 'z6Mk...'  // From Turnkey public key
  }]
});
// Result: did:webvh:your-company.com:audit

// Step 2: Create audit signer using the did:webvh
const turnkeyAuditSigner = {
  async sign(record: Omit<MigrationAuditRecord, 'signature'>) {
    const canonical = JSON.stringify(sortKeys(record));
    const signResult = await turnkeyClient.signRawPayload({
      organizationId: 'your-org-id',
      signWith: 'audit-key-id',
      payload: canonical
    });
    return { signature: signResult.signature };
  },
  getSignerId: () => 'did:webvh:your-company.com:audit'  // Uses did:webvh, not did:key
};

// Step 3: Configure SDK with Turnkey audit signer
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  auditConfig: { signer: turnkeyAuditSigner }
});
```

### AWS KMS Integration with did:btco

```typescript
import { KMSClient, SignCommand } from '@aws-sdk/client-kms';

// Step 1: Create did:btco with KMS as external signer
// (KMS manages secp256k1 key for Bitcoin compatibility)
const kmsDidResult = await sdk.bitcoin.inscribeDID({
  satoshi: '123456789',
  externalSigner: kmsWebvhSigner,
  verificationMethods: [{
    type: 'Multikey',
    publicKeyMultibase: 'zQ3sh...'  // secp256k1 public key from KMS
  }]
});
// Result: did:btco:123456789

// Step 2: Create audit signer using did:btco
const kmsAuditSigner = {
  async sign(record: Omit<MigrationAuditRecord, 'signature'>) {
    const canonical = JSON.stringify(sortKeys(record));
    const kmsClient = new KMSClient({ region: 'us-east-1' });
    const signCommand = new SignCommand({
      KeyId: 'arn:aws:kms:us-east-1:123456789:key/audit-key-id',
      Message: Buffer.from(canonical),
      SigningAlgorithm: 'ECDSA_SHA_256'
    });
    const result = await kmsClient.send(signCommand);
    return { signature: encodeMultibase(result.Signature) };
  },
  getSignerId: () => 'did:btco:123456789'  // Uses did:btco, not did:key
};

// Step 3: Configure SDK with KMS audit signer
const sdk = OriginalsSDK.create({
  network: 'mainnet',
  auditConfig: { signer: kmsAuditSigner }
});
```

---

## Implementation Notes

1. **Follow WebVHManager Pattern Exactly**
   - OriginalsAuditSigner mirrors OriginalsWebVHSigner
   - Same interface structure
   - Same error handling patterns
   - Same multibase encoding

2. **Deterministic Serialization**
   - Sort object keys alphabetically
   - Handle all JSON types (null, array, object, primitive)
   - No whitespace in canonical form
   - Use JCS (JSON Canonicalization Scheme) if available

3. **Error Handling**
   - Throw clear errors for missing config
   - Warn when auto-generating keys
   - Gracefully handle verification failures
   - Log signature verification errors

4. **Storage Integration**
   - Use existing StorageAdapter interface
   - Append-only writes
   - Efficient querying by DID
   - Support batch retrieval

---

## Success Metrics

- [ ] 100% test coverage for new code
- [ ] All existing tests still pass
- [ ] Performance benchmarks met (<10ms overhead)
- [ ] Documentation complete with examples
- [ ] No breaking changes to public APIs
- [ ] External signer pattern validated with mock Turnkey integration

---

## Files to Create/Modify

### New Files:
1. `/home/user/sdk/packages/sdk/src/migration/audit/OriginalsAuditSigner.ts`
2. `/home/user/sdk/packages/sdk/tests/unit/migration/audit/AuditLogger.test.ts`
3. `/home/user/sdk/packages/sdk/tests/unit/migration/audit/OriginalsAuditSigner.test.ts`
4. `/home/user/sdk/packages/sdk/tests/integration/audit-e2e.test.ts`
5. `/home/user/sdk/docs/AUDIT_LOGGING.md`

### Modified Files:
1. `/home/user/sdk/packages/sdk/src/migration/audit/AuditLogger.ts` (replace signAuditRecord method)
2. `/home/user/sdk/packages/sdk/src/migration/types.ts` (add interfaces)
3. `/home/user/sdk/packages/sdk/src/types/common.ts` (add auditConfig to OriginalsConfig)
4. `/home/user/sdk/packages/sdk/src/migration/MigrationManager.ts` (uncomment auditLogger)
5. `/home/user/sdk/README.md` (add audit logging section)

---

## Timeline Estimate

- **Step 1-2:** Type definitions + OriginalsAuditSigner - **4 hours**
- **Step 3:** Update AuditLogger class - **3 hours**
- **Step 4:** MigrationManager integration - **2 hours**
- **Step 5:** Update OriginalsConfig - **1 hour**
- **Step 6-7:** Tests (unit + integration) - **6 hours**
- **Step 8:** Documentation - **2 hours**
- **Testing & refinement** - **4 hours**

**Total: 22 hours (2.75 days)**

---

## Questions to Resolve

1. Should we support multiple signature algorithms in v1.1, or just Ed25519?
2. Should we migrate existing unsigned records from v1.0, or leave them as-is?
3. Should audit key generation show a warning/prompt, or be silent?
4. Should we implement batch signature verification for performance?
5. Should we support Merkle tree proofs for efficient batch verification?

---

END OF IMPLEMENTATION PROMPT
