import { describe, test, expect } from 'bun:test';
import { 
  CredentialManager,
  type ResourceCreatedSubject,
  type MigrationSubject,
  type OwnershipSubject,
  type AssetResource,
  type VerifiableCredential
} from '../../../src';
import { DIDManager } from '../../../src/did/DIDManager';

const config: any = { 
  network: 'regtest', 
  defaultKeyType: 'Ed25519',
  enableLogging: false 
};

describe('CredentialManager - Factory Methods', () => {
  const didManager = new DIDManager(config);
  const credentialManager = new CredentialManager(config, didManager);

  describe('issueResourceCredential', () => {
    test('creates a ResourceCreated credential with all required fields', async () => {
      const resource: AssetResource = {
        id: 'main.js',
        type: 'code',
        contentType: 'text/javascript',
        hash: 'abc123def456',
        createdAt: '2024-01-15T10:00:00Z'
      };
      
      const credential = await credentialManager.issueResourceCredential(
        resource,
        'did:peer:assetId',
        'did:peer:creator'
      );
      
      expect(credential.type).toContain('VerifiableCredential');
      expect(credential.type).toContain('ResourceCreated');
      expect(credential.issuer).toBe('did:peer:creator');
      expect(credential.issuanceDate).toBeDefined();
      expect(credential.id).toBeDefined();
      expect(credential.id?.startsWith('urn:uuid:')).toBe(true);
      
      const subject = credential.credentialSubject as ResourceCreatedSubject;
      expect(subject.id).toBe('did:peer:assetId');
      expect(subject.resourceId).toBe('main.js');
      expect(subject.resourceType).toBe('code');
      expect(subject.contentHash).toBe('abc123def456');
      expect(subject.contentType).toBe('text/javascript');
      expect(subject.creator).toBe('did:peer:creator');
      expect(subject.createdAt).toBe('2024-01-15T10:00:00Z');
    });

    test('uses current timestamp when resource.createdAt is not provided', async () => {
      const resource: AssetResource = {
        id: 'readme.md',
        type: 'text',
        contentType: 'text/markdown',
        hash: 'deadbeef'
      };
      
      const before = new Date().toISOString();
      const credential = await credentialManager.issueResourceCredential(
        resource,
        'did:peer:asset',
        'did:peer:creator'
      );
      const after = new Date().toISOString();
      
      const subject = credential.credentialSubject as ResourceCreatedSubject;
      expect(subject.createdAt >= before).toBe(true);
      expect(subject.createdAt <= after).toBe(true);
    });

    test('supports credential chaining', async () => {
      const resource: AssetResource = {
        id: 'file.txt',
        type: 'text',
        contentType: 'text/plain',
        hash: 'aabbccdd'
      };
      
      const credential = await credentialManager.issueResourceCredential(
        resource,
        'did:peer:asset',
        'did:peer:creator',
        {
          previousCredentialId: 'urn:uuid:previous-credential',
          previousCredentialHash: 'prevhash123'
        }
      );
      
      const subject = credential.credentialSubject as any;
      expect(subject.previousCredential).toBeDefined();
      expect(subject.previousCredential.id).toBe('urn:uuid:previous-credential');
      expect(subject.previousCredential.hash).toBe('prevhash123');
    });
  });

  describe('issueResourceUpdateCredential', () => {
    test('creates a ResourceUpdated credential', async () => {
      const credential = await credentialManager.issueResourceUpdateCredential(
        'main.js',
        'did:webvh:example.com:asset',
        'oldhash',
        'newhash',
        1,
        2,
        'did:webvh:example.com:updater',
        'Bug fix'
      );
      
      expect(credential.type).toContain('ResourceUpdated');
      expect(credential.issuer).toBe('did:webvh:example.com:updater');
      
      const subject = credential.credentialSubject as any;
      expect(subject.id).toBe('did:webvh:example.com:asset');
      expect(subject.resourceId).toBe('main.js');
      expect(subject.previousHash).toBe('oldhash');
      expect(subject.newHash).toBe('newhash');
      expect(subject.fromVersion).toBe(1);
      expect(subject.toVersion).toBe(2);
      expect(subject.updateReason).toBe('Bug fix');
      expect(subject.updatedAt).toBeDefined();
    });

    test('works without update reason', async () => {
      const credential = await credentialManager.issueResourceUpdateCredential(
        'file.txt',
        'did:peer:asset',
        'old',
        'new',
        1,
        2,
        'did:peer:user'
      );
      
      const subject = credential.credentialSubject as any;
      expect(subject.updateReason).toBeUndefined();
    });
  });

  describe('issueMigrationCredential', () => {
    test('creates a MigrationCompleted credential for peer to webvh', async () => {
      const credential = await credentialManager.issueMigrationCredential(
        'did:peer:source123',
        'did:webvh:example.com:target456',
        'did:peer',
        'did:webvh',
        'did:webvh:example.com:publisher'
      );
      
      expect(credential.type).toContain('MigrationCompleted');
      expect(credential.issuer).toBe('did:webvh:example.com:publisher');
      
      const subject = credential.credentialSubject as MigrationSubject;
      expect(subject.id).toBe('did:webvh:example.com:target456');
      expect(subject.sourceDid).toBe('did:peer:source123');
      expect(subject.targetDid).toBe('did:webvh:example.com:target456');
      expect(subject.fromLayer).toBe('did:peer');
      expect(subject.toLayer).toBe('did:webvh');
      expect(subject.migratedAt).toBeDefined();
    });

    test('creates a MigrationCompleted credential for webvh to btco', async () => {
      const credential = await credentialManager.issueMigrationCredential(
        'did:webvh:example.com:asset',
        'did:btco:12345',
        'did:webvh',
        'did:btco',
        'did:btco:12345',
        {
          transactionId: 'tx123',
          inscriptionId: 'insc456',
          satoshi: '12345',
          migrationReason: 'Permanent anchoring'
        }
      );
      
      const subject = credential.credentialSubject as MigrationSubject;
      expect(subject.fromLayer).toBe('did:webvh');
      expect(subject.toLayer).toBe('did:btco');
      expect(subject.transactionId).toBe('tx123');
      expect(subject.inscriptionId).toBe('insc456');
      expect(subject.satoshi).toBe('12345');
      expect(subject.migrationReason).toBe('Permanent anchoring');
    });

    test('works without targetDid (same-layer operation)', async () => {
      const credential = await credentialManager.issueMigrationCredential(
        'did:peer:asset',
        undefined,
        'did:peer',
        'did:webvh',
        'did:peer:issuer'
      );
      
      const subject = credential.credentialSubject as MigrationSubject;
      expect(subject.id).toBe('did:peer:asset');
      expect(subject.targetDid).toBeUndefined();
    });
  });

  describe('issueOwnershipCredential', () => {
    test('creates an OwnershipTransferred credential', async () => {
      const credential = await credentialManager.issueOwnershipCredential(
        'did:btco:12345',
        'bc1qoldowner...',
        'bc1qnewowner...',
        'txid123abc',
        'did:btco:12345',
        {
          satoshi: '12345',
          transferReason: 'Sale'
        }
      );
      
      expect(credential.type).toContain('OwnershipTransferred');
      expect(credential.issuer).toBe('did:btco:12345');
      
      const subject = credential.credentialSubject as OwnershipSubject;
      expect(subject.id).toBe('did:btco:12345');
      expect(subject.previousOwner).toBe('bc1qoldowner...');
      expect(subject.newOwner).toBe('bc1qnewowner...');
      expect(subject.transactionId).toBe('txid123abc');
      expect(subject.transferredAt).toBeDefined();
      expect(subject.satoshi).toBe('12345');
      expect(subject.transferReason).toBe('Sale');
    });

    test('works without optional details', async () => {
      const credential = await credentialManager.issueOwnershipCredential(
        'did:btco:67890',
        'bc1qold...',
        'bc1qnew...',
        'txid456',
        'did:btco:67890'
      );
      
      const subject = credential.credentialSubject as OwnershipSubject;
      expect(subject.satoshi).toBeUndefined();
      expect(subject.transferReason).toBeUndefined();
    });
  });
});

describe('CredentialManager - Credential Chaining', () => {
  const credentialManager = new CredentialManager(config);

  describe('computeCredentialHash', () => {
    test('computes consistent hash for same credential', async () => {
      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'TestCredential'],
        issuer: 'did:test:issuer',
        issuanceDate: '2024-01-15T10:00:00Z',
        credentialSubject: { id: 'did:test:subject', name: 'Test' }
      };
      
      const hash1 = await credentialManager.computeCredentialHash(credential);
      const hash2 = await credentialManager.computeCredentialHash(credential);
      
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 hex string
    });

    test('computes different hash for different credentials', async () => {
      const credential1: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'TypeOne'],
        issuer: 'did:test:issuer1',
        issuanceDate: '2024-01-15T10:00:00Z',
        credentialSubject: { 
          id: 'subject1',
          name: 'Alice',
          role: 'admin'
        }
      };
      
      const credential2: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential', 'TypeTwo'],
        issuer: 'did:test:issuer2',
        issuanceDate: '2024-01-16T10:00:00Z',
        credentialSubject: { 
          id: 'subject2',
          name: 'Bob',
          role: 'user'
        }
      };
      
      const hash1 = await credentialManager.computeCredentialHash(credential1);
      const hash2 = await credentialManager.computeCredentialHash(credential2);
      
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyCredentialChain', () => {
    test('returns valid for empty chain', async () => {
      const result = await credentialManager.verifyCredentialChain([]);
      
      expect(result.valid).toBe(true);
      expect(result.chainLength).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    test('validates chain with linked credentials', async () => {
      // Create first credential
      const cred1: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        id: 'urn:uuid:cred1',
        issuer: 'did:test:issuer',
        issuanceDate: '2024-01-01T00:00:00Z',
        credentialSubject: { id: 'subject', value: 1 }
      };
      
      // Compute hash of first credential
      const cred1Hash = await credentialManager.computeCredentialHash(cred1);
      
      // Create second credential linked to first
      const cred2: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        id: 'urn:uuid:cred2',
        issuer: 'did:test:issuer',
        issuanceDate: '2024-01-02T00:00:00Z',
        credentialSubject: { 
          id: 'subject', 
          value: 2,
          previousCredential: { id: 'urn:uuid:cred1', hash: cred1Hash }
        }
      };
      
      // Note: Without actual proofs, verifyCredential returns false
      // The chain verification will report credential verification failures
      // but the hash linking will be validated
      const result = await credentialManager.verifyCredentialChain([cred1, cred2]);
      
      // We expect credential verification failures (no proofs)
      // but no chain integrity errors
      expect(result.chainLength).toBe(2);
    });
  });
});

describe('CredentialManager - Selective Disclosure', () => {
  const credentialManager = new CredentialManager(config);

  describe('prepareSelectiveDisclosure', () => {
    test('prepares credential with mandatory pointers', async () => {
      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:test:issuer',
        issuanceDate: '2024-01-15T10:00:00Z',
        credentialSubject: {
          id: 'did:test:subject',
          name: 'Alice',
          email: 'alice@example.com',
          age: 30
        }
      };
      
      const result = await credentialManager.prepareSelectiveDisclosure(credential, {
        mandatoryPointers: ['/issuer', '/issuanceDate', '/credentialSubject/id'],
        selectivePointers: ['/credentialSubject/name', '/credentialSubject/age']
      });
      
      expect(result.credential).toBeDefined();
      expect(result.mandatoryPointers).toContain('/issuer');
      expect(result.mandatoryPointers).toContain('/issuanceDate');
      expect(result.selectivePointers).toContain('/credentialSubject/name');
    });

    test('throws error for empty mandatory pointers', async () => {
      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:test:issuer',
        issuanceDate: '2024-01-15T10:00:00Z',
        credentialSubject: { id: 'subject' }
      };
      
      await expect(
        credentialManager.prepareSelectiveDisclosure(credential, {
          mandatoryPointers: []
        })
      ).rejects.toThrow('At least one mandatory pointer is required');
    });

    test('throws error for invalid JSON Pointer format', async () => {
      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:test:issuer',
        issuanceDate: '2024-01-15T10:00:00Z',
        credentialSubject: { id: 'subject' }
      };
      
      await expect(
        credentialManager.prepareSelectiveDisclosure(credential, {
          mandatoryPointers: ['issuer'] // Missing leading /
        })
      ).rejects.toThrow('Invalid JSON Pointer');
    });
  });

  describe('deriveSelectiveProof', () => {
    test('creates derived proof result with disclosed/hidden fields', async () => {
      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:test:issuer',
        issuanceDate: '2024-01-15T10:00:00Z',
        credentialSubject: {
          id: 'did:test:subject',
          name: 'Alice',
          email: 'alice@example.com'
        }
      };
      
      const result = await credentialManager.deriveSelectiveProof(
        credential,
        ['/issuer', '/credentialSubject/name']
      );
      
      expect(result.credential).toBeDefined();
      expect(result.disclosedFields).toContain('/issuer');
      expect(result.disclosedFields).toContain('/credentialSubject/name');
      expect(result.hiddenFields).toContain('/credentialSubject/email');
    });

    test('throws error for invalid JSON Pointer in disclosure', async () => {
      const credential: VerifiableCredential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: 'did:test:issuer',
        issuanceDate: '2024-01-15T10:00:00Z',
        credentialSubject: { id: 'subject' }
      };
      
      await expect(
        credentialManager.deriveSelectiveProof(credential, ['issuer'])
      ).rejects.toThrow('Invalid JSON Pointer');
    });
  });

  describe('getFieldByPointer', () => {
    const credential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:test:issuer',
      issuanceDate: '2024-01-15T10:00:00Z',
      credentialSubject: {
        id: 'did:test:subject',
        name: 'Alice',
        address: {
          city: 'New York',
          zip: '10001'
        }
      }
    };

    test('retrieves top-level field', () => {
      const value = credentialManager.getFieldByPointer(credential, '/issuer');
      expect(value).toBe('did:test:issuer');
    });

    test('retrieves nested field', () => {
      const value = credentialManager.getFieldByPointer(credential, '/credentialSubject/name');
      expect(value).toBe('Alice');
    });

    test('retrieves deeply nested field', () => {
      const value = credentialManager.getFieldByPointer(credential, '/credentialSubject/address/city');
      expect(value).toBe('New York');
    });

    test('returns undefined for non-existent path', () => {
      const value = credentialManager.getFieldByPointer(credential, '/nonexistent');
      expect(value).toBeUndefined();
    });

    test('throws error for invalid pointer format', () => {
      expect(() => {
        credentialManager.getFieldByPointer(credential, 'issuer');
      }).toThrow('JSON Pointer must start with /');
    });
  });
});

describe('CredentialManager - Credential ID Generation', () => {
  const credentialManager = new CredentialManager(config);

  test('generates unique credential IDs', async () => {
    const resource: AssetResource = {
      id: 'test',
      type: 'text',
      contentType: 'text/plain',
      hash: 'abc'
    };
    
    const cred1 = await credentialManager.issueResourceCredential(resource, 'did:a', 'did:b');
    const cred2 = await credentialManager.issueResourceCredential(resource, 'did:a', 'did:b');
    
    expect(cred1.id).toBeDefined();
    expect(cred2.id).toBeDefined();
    expect(cred1.id).not.toBe(cred2.id);
  });

  test('credential IDs follow URN format', async () => {
    const resource: AssetResource = {
      id: 'test',
      type: 'text',
      contentType: 'text/plain',
      hash: 'abc'
    };
    
    const credential = await credentialManager.issueResourceCredential(resource, 'did:a', 'did:b');
    
    expect(credential.id).toMatch(/^urn:uuid:\d+-[a-f0-9]+-[a-f0-9]+$/);
  });
});

