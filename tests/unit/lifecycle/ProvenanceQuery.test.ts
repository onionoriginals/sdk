import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';
import { ProvenanceQuery, MigrationQuery, TransferQuery } from '../../../src/lifecycle/ProvenanceQuery';
import { AssetResource, DIDDocument, VerifiableCredential, LayerType } from '../../../src/types';

function buildDid(id: string): DIDDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id
  };
}

const emptyCreds: VerifiableCredential[] = [];
const resources: AssetResource[] = [
  {
    id: 'res1',
    type: 'text',
    content: 'hello',
    contentType: 'text/plain',
    hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  }
];

describe('ProvenanceQuery', () => {
  let asset: OriginalsAsset;
  
  beforeEach(() => {
    // Create asset with did:peer
    asset = new OriginalsAsset(resources, buildDid('did:peer:abc123'), emptyCreds);
    
    // Simulate publishing to web (peer → webvh)
    asset.migrate('did:webvh', { transactionId: 'tx-web-123' });
    
    // Simulate inscribing on Bitcoin (webvh → btco)
    asset.migrate('did:btco', { 
      transactionId: 'tx-btc-456',
      inscriptionId: 'insc-789',
      satoshi: '1000',
      commitTxId: 'commit-abc',
      revealTxId: 'reveal-xyz',
      feeRate: 5
    });
    
    // Simulate a transfer
    asset.recordTransfer('address1', 'address2', 'tx-transfer-111');
    
    // Add another transfer for testing
    asset.recordTransfer('address2', 'address3', 'tx-transfer-222');
  });

  describe('ProvenanceQuery basics', () => {
    test('should create a query from asset', () => {
      const query = asset.queryProvenance();
      expect(query).toBeInstanceOf(ProvenanceQuery);
    });

    test('should count all provenance entries', () => {
      const count = asset.queryProvenance().count();
      expect(count).toBe(4); // 2 migrations + 2 transfers
    });

    test('should get first entry', () => {
      const first = asset.queryProvenance().first();
      expect(first).toBeDefined();
      expect(first).toHaveProperty('from');
    });

    test('should get last entry', () => {
      const last = asset.queryProvenance().last();
      expect(last).toBeDefined();
      expect(last).toHaveProperty('transactionId');
    });

    test('should get all entries', () => {
      const all = asset.queryProvenance().all();
      expect(all).toHaveLength(4);
    });

    test('should return null for first when no results', () => {
      const emptyAsset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
      const first = emptyAsset.queryProvenance().first();
      expect(first).toBeNull();
    });

    test('should return null for last when no results', () => {
      const emptyAsset = new OriginalsAsset(resources, buildDid('did:peer:xyz'), emptyCreds);
      const last = emptyAsset.queryProvenance().last();
      expect(last).toBeNull();
    });
  });

  describe('migrations', () => {
    test('should query all migrations', () => {
      const migrations = asset.queryProvenance().migrations().all();
      expect(migrations).toHaveLength(2); // peer→webvh, webvh→btco
      expect(migrations[0].from).toBe('did:peer');
      expect(migrations[0].to).toBe('did:webvh');
      expect(migrations[1].from).toBe('did:webvh');
      expect(migrations[1].to).toBe('did:btco');
    });
    
    test('should return MigrationQuery instance', () => {
      const query = asset.queryProvenance().migrations();
      expect(query).toBeInstanceOf(MigrationQuery);
    });

    test('should filter by fromLayer', () => {
      const fromPeer = asset.queryProvenance()
        .migrations()
        .fromLayer('did:peer')
        .all();
      expect(fromPeer).toHaveLength(1);
      expect(fromPeer[0].from).toBe('did:peer');
      expect(fromPeer[0].to).toBe('did:webvh');
    });
    
    test('should filter by toLayer', () => {
      const toBtco = asset.queryProvenance()
        .migrations()
        .toLayer('did:btco')
        .all();
      expect(toBtco).toHaveLength(1);
      expect(toBtco[0].to).toBe('did:btco');
      expect(toBtco[0].from).toBe('did:webvh');
    });
    
    test('should filter by transaction ID', () => {
      const migration = asset.queryProvenance()
        .migrations()
        .withTransaction('tx-btc-456')
        .first();
      expect(migration).toBeDefined();
      expect(migration?.transactionId).toBe('tx-btc-456');
    });

    test('should filter by inscription ID', () => {
      const migration = asset.queryProvenance()
        .migrations()
        .withInscription('insc-789')
        .first();
      expect(migration).toBeDefined();
      expect(migration?.inscriptionId).toBe('insc-789');
    });
    
    test('should chain multiple filters', () => {
      const result = asset.queryProvenance()
        .migrations()
        .fromLayer('did:peer')
        .toLayer('did:webvh')
        .all();
      expect(result).toHaveLength(1);
      expect(result[0].from).toBe('did:peer');
      expect(result[0].to).toBe('did:webvh');
    });

    test('should return empty array when no matches', () => {
      const result = asset.queryProvenance()
        .migrations()
        .fromLayer('did:btco')
        .all();
      expect(result).toHaveLength(0);
    });

    test('should count migrations', () => {
      const count = asset.queryProvenance().migrations().count();
      expect(count).toBe(2);
    });

    test('should get first migration', () => {
      const first = asset.queryProvenance().migrations().first();
      expect(first).toBeDefined();
      expect(first?.from).toBe('did:peer');
    });

    test('should get last migration', () => {
      const last = asset.queryProvenance().migrations().last();
      expect(last).toBeDefined();
      expect(last?.to).toBe('did:btco');
    });
  });
  
  describe('transfers', () => {
    test('should query all transfers', () => {
      const transfers = asset.queryProvenance().transfers().all();
      expect(transfers).toHaveLength(2);
      expect(transfers[0].from).toBe('address1');
      expect(transfers[0].to).toBe('address2');
      expect(transfers[1].from).toBe('address2');
      expect(transfers[1].to).toBe('address3');
    });

    test('should return TransferQuery instance', () => {
      const query = asset.queryProvenance().transfers();
      expect(query).toBeInstanceOf(TransferQuery);
    });
    
    test('should filter by from address', () => {
      const transfers = asset.queryProvenance()
        .transfers()
        .from('address1')
        .all();
      expect(transfers).toHaveLength(1);
      expect(transfers[0].from).toBe('address1');
      expect(transfers[0].to).toBe('address2');
    });

    test('should filter by to address', () => {
      const transfers = asset.queryProvenance()
        .transfers()
        .to('address3')
        .all();
      expect(transfers).toHaveLength(1);
      expect(transfers[0].from).toBe('address2');
      expect(transfers[0].to).toBe('address3');
    });

    test('should filter by transaction ID', () => {
      const transfer = asset.queryProvenance()
        .transfers()
        .withTransaction('tx-transfer-111')
        .first();
      expect(transfer).toBeDefined();
      expect(transfer?.transactionId).toBe('tx-transfer-111');
    });

    test('should chain multiple filters', () => {
      const result = asset.queryProvenance()
        .transfers()
        .from('address1')
        .to('address2')
        .all();
      expect(result).toHaveLength(1);
      expect(result[0].transactionId).toBe('tx-transfer-111');
    });

    test('should return empty array when no matches', () => {
      const result = asset.queryProvenance()
        .transfers()
        .from('nonexistent')
        .all();
      expect(result).toHaveLength(0);
    });

    test('should count transfers', () => {
      const count = asset.queryProvenance().transfers().count();
      expect(count).toBe(2);
    });

    test('should get first transfer', () => {
      const first = asset.queryProvenance().transfers().first();
      expect(first).toBeDefined();
      expect(first?.from).toBe('address1');
    });

    test('should get last transfer', () => {
      const last = asset.queryProvenance().transfers().last();
      expect(last).toBeDefined();
      expect(last?.to).toBe('address3');
    });
  });
  
  describe('date filtering', () => {
    test('should filter by after date (string)', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const results = asset.queryProvenance()
        .after(yesterday)
        .migrations()
        .all();
      expect(results.length).toBe(2);
    });

    test('should filter by after date (Date object)', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const results = asset.queryProvenance()
        .after(yesterday)
        .migrations()
        .all();
      expect(results.length).toBe(2);
    });

    test('should filter by before date (string)', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const results = asset.queryProvenance()
        .before(tomorrow)
        .migrations()
        .all();
      expect(results.length).toBe(2);
    });

    test('should filter by before date (Date object)', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const results = asset.queryProvenance()
        .before(tomorrow)
        .migrations()
        .all();
      expect(results.length).toBe(2);
    });
    
    test('should filter by date range (strings)', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const results = asset.queryProvenance()
        .between(yesterday, tomorrow)
        .migrations()
        .all();
      expect(results.length).toBe(2);
    });

    test('should filter by date range (Date objects)', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const results = asset.queryProvenance()
        .between(yesterday, tomorrow)
        .migrations()
        .all();
      expect(results.length).toBe(2);
    });

    test('should filter out old entries with after', () => {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const results = asset.queryProvenance()
        .after(tomorrow)
        .migrations()
        .all();
      expect(results.length).toBe(0);
    });

    test('should filter out future entries with before', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const results = asset.queryProvenance()
        .before(yesterday)
        .migrations()
        .all();
      expect(results.length).toBe(0);
    });

    test('should apply date filters to transfers', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const results = asset.queryProvenance()
        .after(yesterday)
        .transfers()
        .all();
      expect(results.length).toBe(2);
    });

    test('should chain date filters with other filters', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const result = asset.queryProvenance()
        .after(yesterday)
        .migrations()
        .fromLayer('did:peer')
        .all();
      expect(result.length).toBe(1);
    });

    test('should preserve date filters when switching query types', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const migrations = asset.queryProvenance()
        .after(yesterday)
        .migrations()
        .all();
      expect(migrations.length).toBe(2);
    });
  });
  
  describe('convenience methods', () => {
    test('getMigrationsToLayer should return filtered migrations', () => {
      const toBtco = asset.getMigrationsToLayer('did:btco');
      expect(toBtco).toHaveLength(1);
      expect(toBtco[0].to).toBe('did:btco');
      expect(toBtco[0].from).toBe('did:webvh');
    });

    test('getMigrationsToLayer should return empty array when no matches', () => {
      const result = asset.getMigrationsToLayer('did:peer');
      expect(result).toHaveLength(0);
    });

    test('getTransfersFrom should return filtered transfers', () => {
      const transfers = asset.getTransfersFrom('address1');
      expect(transfers).toHaveLength(1);
      expect(transfers[0].from).toBe('address1');
      expect(transfers[0].to).toBe('address2');
    });

    test('getTransfersFrom should return empty array when no matches', () => {
      const result = asset.getTransfersFrom('nonexistent');
      expect(result).toHaveLength(0);
    });

    test('getTransfersTo should return filtered transfers', () => {
      const transfers = asset.getTransfersTo('address3');
      expect(transfers).toHaveLength(1);
      expect(transfers[0].from).toBe('address2');
      expect(transfers[0].to).toBe('address3');
    });

    test('getTransfersTo should return empty array when no matches', () => {
      const result = asset.getTransfersTo('nonexistent');
      expect(result).toHaveLength(0);
    });
    
    test('getProvenanceSummary should return summary', () => {
      const summary = asset.getProvenanceSummary();
      expect(summary.migrationCount).toBe(2);
      expect(summary.transferCount).toBe(2);
      expect(summary.currentLayer).toBe('did:btco');
      expect(summary.creator).toBe('did:peer:abc123');
      expect(summary.created).toBeDefined();
      expect(summary.lastActivity).toBeDefined();
    });

    test('getProvenanceSummary should use migration timestamp when no transfers', () => {
      const newAsset = new OriginalsAsset(resources, buildDid('did:peer:test'), emptyCreds);
      newAsset.migrate('did:webvh', { transactionId: 'tx1' });
      const summary = newAsset.getProvenanceSummary();
      expect(summary.lastActivity).toBe(newAsset.getProvenance().migrations[0].timestamp);
    });

    test('getProvenanceSummary should use createdAt when no migrations or transfers', () => {
      const newAsset = new OriginalsAsset(resources, buildDid('did:peer:test'), emptyCreds);
      const summary = newAsset.getProvenanceSummary();
      expect(summary.lastActivity).toBe(summary.created);
    });
    
    test('findByTransactionId should find migration', () => {
      const result = asset.findByTransactionId('tx-btc-456');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('from');
      expect(result).toHaveProperty('to');
    });

    test('findByTransactionId should find transfer', () => {
      const result = asset.findByTransactionId('tx-transfer-111');
      expect(result).toBeDefined();
      expect(result).toHaveProperty('from', 'address1');
      expect(result).toHaveProperty('to', 'address2');
    });

    test('findByTransactionId should return null when not found', () => {
      const result = asset.findByTransactionId('nonexistent');
      expect(result).toBeNull();
    });

    test('findByInscriptionId should find migration', () => {
      const result = asset.findByInscriptionId('insc-789');
      expect(result).toBeDefined();
      expect(result?.inscriptionId).toBe('insc-789');
    });

    test('findByInscriptionId should return null when not found', () => {
      const result = asset.findByInscriptionId('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('query chaining and switching', () => {
    test('should switch from migrations to transfers maintaining date filters', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const transfers = asset.queryProvenance()
        .after(yesterday)
        .migrations()
        .transfers()
        .all();
      expect(transfers.length).toBe(2);
    });

    test('should switch from transfers to migrations maintaining date filters', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const migrations = asset.queryProvenance()
        .after(yesterday)
        .transfers()
        .migrations()
        .all();
      expect(migrations.length).toBe(2);
    });

    test('should allow calling migrations() on MigrationQuery (fluent)', () => {
      const result = asset.queryProvenance()
        .migrations()
        .fromLayer('did:peer')
        .migrations()
        .all();
      expect(result.length).toBe(1);
    });

    test('should allow calling transfers() on TransferQuery (fluent)', () => {
      const result = asset.queryProvenance()
        .transfers()
        .from('address1')
        .transfers()
        .all();
      expect(result.length).toBe(1);
    });
  });

  describe('performance with large datasets', () => {
    test('should handle large provenance chains efficiently', () => {
      // Create an asset with many migrations and transfers
      const largeAsset = new OriginalsAsset(resources, buildDid('did:peer:large'), emptyCreds);
      
      // Add 500 transfers (can't add 500 migrations as we only have 2 valid transitions)
      for (let i = 0; i < 500; i++) {
        largeAsset.recordTransfer(`addr-${i}`, `addr-${i + 1}`, `tx-transfer-${i}`);
      }

      const startTime = Date.now();
      const result = largeAsset.queryProvenance()
        .transfers()
        .from('addr-0')
        .all();
      const endTime = Date.now();

      expect(result.length).toBe(1);
      // Query should complete in less than 100ms for 500 entries
      expect(endTime - startTime).toBeLessThan(100);
    });

    test('should handle complex queries on large datasets', () => {
      const largeAsset = new OriginalsAsset(resources, buildDid('did:peer:large2'), emptyCreds);
      
      // Add many transfers
      for (let i = 0; i < 1000; i++) {
        largeAsset.recordTransfer(`addr-${i}`, `addr-${i + 1}`, `tx-transfer-${i}`);
      }

      const startTime = Date.now();
      const result = largeAsset.queryProvenance()
        .transfers()
        .to('addr-500')
        .after(new Date(Date.now() - 24 * 60 * 60 * 1000))
        .all();
      const endTime = Date.now();

      expect(result.length).toBe(1);
      expect(endTime - startTime).toBeLessThan(50);
    });
  });

  describe('edge cases', () => {
    test('should handle empty provenance chain', () => {
      const emptyAsset = new OriginalsAsset(resources, buildDid('did:peer:empty'), emptyCreds);
      const migrations = emptyAsset.queryProvenance().migrations().all();
      const transfers = emptyAsset.queryProvenance().transfers().all();
      
      expect(migrations).toHaveLength(0);
      expect(transfers).toHaveLength(0);
    });

    test('should handle query with all filters returning empty', () => {
      const result = asset.queryProvenance()
        .migrations()
        .fromLayer('did:btco')
        .toLayer('did:peer')
        .all();
      
      expect(result).toHaveLength(0);
    });

    test('should handle undefined transaction IDs in filters', () => {
      const newAsset = new OriginalsAsset(resources, buildDid('did:peer:test2'), emptyCreds);
      newAsset.migrate('did:webvh'); // No transaction ID
      
      const result = newAsset.queryProvenance()
        .migrations()
        .withTransaction('tx-123')
        .all();
      
      expect(result).toHaveLength(0);
    });

    test('should handle undefined inscription IDs in filters', () => {
      const result = asset.queryProvenance()
        .migrations()
        .withInscription('nonexistent')
        .all();
      
      expect(result).toHaveLength(0);
    });
  });
});
