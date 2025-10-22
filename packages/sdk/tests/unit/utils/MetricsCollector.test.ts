import { describe, test, expect, beforeEach } from 'bun:test';
import { MetricsCollector } from '../../../src/utils/MetricsCollector';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;
  
  beforeEach(() => {
    metrics = new MetricsCollector();
  });
  
  describe('operation recording', () => {
    test('should record operation with duration and success', () => {
      metrics.recordOperation('testOp', 100, true);
      
      const opMetrics = metrics.getOperationMetrics('testOp');
      
      expect(opMetrics).not.toBeNull();
      expect(opMetrics!.count).toBe(1);
      expect(opMetrics!.totalTime).toBe(100);
      expect(opMetrics!.avgTime).toBe(100);
      expect(opMetrics!.minTime).toBe(100);
      expect(opMetrics!.maxTime).toBe(100);
      expect(opMetrics!.errorCount).toBe(0);
    });
    
    test('should record multiple operations and calculate statistics', () => {
      metrics.recordOperation('testOp', 50, true);
      metrics.recordOperation('testOp', 100, true);
      metrics.recordOperation('testOp', 150, true);
      
      const opMetrics = metrics.getOperationMetrics('testOp');
      
      expect(opMetrics!.count).toBe(3);
      expect(opMetrics!.totalTime).toBe(300);
      expect(opMetrics!.avgTime).toBe(100);
      expect(opMetrics!.minTime).toBe(50);
      expect(opMetrics!.maxTime).toBe(150);
    });
    
    test('should track errors in operations', () => {
      metrics.recordOperation('testOp', 50, true);
      metrics.recordOperation('testOp', 100, false);
      metrics.recordOperation('testOp', 75, false);
      
      const opMetrics = metrics.getOperationMetrics('testOp');
      
      expect(opMetrics!.count).toBe(3);
      expect(opMetrics!.errorCount).toBe(2);
    });
    
    test('should return null for non-existent operation', () => {
      const opMetrics = metrics.getOperationMetrics('nonExistent');
      
      expect(opMetrics).toBeNull();
    });
  });
  
  describe('startOperation helper', () => {
    test('should track operation duration automatically', () => {
      const complete = metrics.startOperation('autoOp');
      
      // Simulate work
      const start = Date.now();
      while (Date.now() - start < 10) {
        // Wait 10ms
      }
      
      complete(true);
      
      const opMetrics = metrics.getOperationMetrics('autoOp');
      
      expect(opMetrics!.count).toBe(1);
      expect(opMetrics!.totalTime).toBeGreaterThanOrEqual(9);
    });
    
    test('should record success or failure', () => {
      const complete1 = metrics.startOperation('op1');
      complete1(true);
      
      const complete2 = metrics.startOperation('op1');
      complete2(false);
      
      const opMetrics = metrics.getOperationMetrics('op1');
      
      expect(opMetrics!.count).toBe(2);
      expect(opMetrics!.errorCount).toBe(1);
    });
  });
  
  describe('asset lifecycle metrics', () => {
    test('should record asset creations', () => {
      metrics.recordAssetCreated();
      metrics.recordAssetCreated();
      metrics.recordAssetCreated();
      
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.assetsCreated).toBe(3);
    });
    
    test('should record migrations by layer transition', () => {
      metrics.recordMigration('did:peer', 'did:webvh');
      metrics.recordMigration('did:peer', 'did:webvh');
      metrics.recordMigration('did:webvh', 'did:btco');
      
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.assetsMigrated['peer→webvh']).toBe(2);
      expect(allMetrics.assetsMigrated['webvh→btco']).toBe(1);
    });
    
    test('should record asset transfers', () => {
      metrics.recordTransfer();
      metrics.recordTransfer();
      
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.assetsTransferred).toBe(2);
    });
  });
  
  describe('error tracking', () => {
    test('should track errors by code', () => {
      metrics.recordError('ERR_001');
      metrics.recordError('ERR_001');
      metrics.recordError('ERR_002');
      
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.errors['ERR_001']).toBe(2);
      expect(allMetrics.errors['ERR_002']).toBe(1);
    });
    
    test('should increment operation error count when operation is provided', () => {
      // First create some operations
      metrics.recordOperation('testOp', 100, true);
      
      // Then record errors for that operation
      metrics.recordError('ERR_001', 'testOp');
      metrics.recordError('ERR_002', 'testOp');
      
      const opMetrics = metrics.getOperationMetrics('testOp');
      
      expect(opMetrics!.errorCount).toBe(2);
    });
  });
  
  describe('cache statistics', () => {
    test('should track cache hits and misses', () => {
      metrics.recordCacheHit();
      metrics.recordCacheHit();
      metrics.recordCacheMiss();
      
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.cacheStats).toBeDefined();
      expect(allMetrics.cacheStats!.hits).toBe(2);
      expect(allMetrics.cacheStats!.misses).toBe(1);
      expect(allMetrics.cacheStats!.hitRate).toBeCloseTo(2 / 3);
    });
    
    test('should return undefined cache stats when no cache operations', () => {
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.cacheStats).toBeUndefined();
    });
    
    test('should calculate hit rate correctly', () => {
      // 80% hit rate
      for (let i = 0; i < 8; i++) {
        metrics.recordCacheHit();
      }
      for (let i = 0; i < 2; i++) {
        metrics.recordCacheMiss();
      }
      
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.cacheStats!.hitRate).toBe(0.8);
    });
  });
  
  describe('system metrics', () => {
    test('should track start time', () => {
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.startTime).toBeDefined();
      expect(new Date(allMetrics.startTime).getTime()).toBeLessThanOrEqual(Date.now());
    });
    
    test('should track uptime', async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.uptime).toBeGreaterThanOrEqual(9);
    });
  });
  
  describe('reset functionality', () => {
    test('should reset all metrics', () => {
      // Record various metrics
      metrics.recordAssetCreated();
      metrics.recordMigration('did:peer', 'did:webvh');
      metrics.recordTransfer();
      metrics.recordOperation('testOp', 100, true);
      metrics.recordError('ERR_001');
      metrics.recordCacheHit();
      metrics.recordCacheMiss();
      
      // Reset
      metrics.reset();
      
      const allMetrics = metrics.getMetrics();
      
      expect(allMetrics.assetsCreated).toBe(0);
      expect(Object.keys(allMetrics.assetsMigrated).length).toBe(0);
      expect(allMetrics.assetsTransferred).toBe(0);
      expect(Object.keys(allMetrics.operationTimes).length).toBe(0);
      expect(Object.keys(allMetrics.errors).length).toBe(0);
      expect(allMetrics.cacheStats).toBeUndefined();
    });
  });
  
  describe('export formats', () => {
    beforeEach(() => {
      // Set up some test metrics
      metrics.recordAssetCreated();
      metrics.recordAssetCreated();
      metrics.recordMigration('did:peer', 'did:webvh');
      metrics.recordTransfer();
      metrics.recordOperation('createAsset', 150, true);
      metrics.recordOperation('createAsset', 200, true);
      metrics.recordOperation('createAsset', 250, false);
      metrics.recordError('ERR_001');
      metrics.recordCacheHit();
      metrics.recordCacheMiss();
    });
    
    test('should export as JSON', () => {
      const json = metrics.export('json');
      
      expect(() => JSON.parse(json)).not.toThrow();
      
      const parsed = JSON.parse(json);
      expect(parsed.assetsCreated).toBe(2);
      expect(parsed.assetsMigrated['peer→webvh']).toBe(1);
      expect(parsed.assetsTransferred).toBe(1);
    });
    
    test('should export as Prometheus format', () => {
      const prometheus = metrics.export('prometheus');
      
      // Check for expected Prometheus metrics
      expect(prometheus).toContain('originals_assets_created_total');
      expect(prometheus).toContain('originals_assets_transferred_total');
      expect(prometheus).toContain('originals_assets_migrated_total');
      expect(prometheus).toContain('originals_operation_createAsset_total');
      expect(prometheus).toContain('originals_operation_createAsset_duration_milliseconds');
      expect(prometheus).toContain('originals_errors_total');
      expect(prometheus).toContain('originals_cache_hits_total');
      expect(prometheus).toContain('originals_uptime_milliseconds');
    });
    
    test('should format Prometheus metrics correctly', () => {
      const prometheus = metrics.export('prometheus');
      
      // Check specific values
      expect(prometheus).toContain('originals_assets_created_total 2');
      expect(prometheus).toContain('originals_assets_transferred_total 1');
      expect(prometheus).toContain('originals_assets_migrated_total{from="peer",to="webvh"} 1');
    });
    
    test('should include operation statistics in Prometheus format', () => {
      const prometheus = metrics.export('prometheus');
      
      // Check for operation metrics
      expect(prometheus).toContain('originals_operation_createAsset_total 3');
      expect(prometheus).toContain('originals_operation_createAsset_errors_total 1');
      
      // Check for duration quantiles
      expect(prometheus).toContain('originals_operation_createAsset_duration_milliseconds{quantile="0.0"}');
      expect(prometheus).toContain('originals_operation_createAsset_duration_milliseconds{quantile="0.5"}');
      expect(prometheus).toContain('originals_operation_createAsset_duration_milliseconds{quantile="1.0"}');
    });
    
    test('should throw error for unsupported format', () => {
      expect(() => metrics.export('xml' as any)).toThrow('Unsupported export format');
    });
  });
  
  describe('comprehensive metrics snapshot', () => {
    test('should provide complete metrics snapshot', () => {
      // Set up comprehensive metrics
      metrics.recordAssetCreated();
      metrics.recordMigration('did:peer', 'did:webvh');
      metrics.recordMigration('did:webvh', 'did:btco');
      metrics.recordTransfer();
      metrics.recordOperation('op1', 100, true);
      metrics.recordOperation('op2', 200, false);
      metrics.recordError('ERR_001');
      metrics.recordCacheHit();
      
      const allMetrics = metrics.getMetrics();
      
      // Verify structure
      expect(allMetrics).toHaveProperty('assetsCreated');
      expect(allMetrics).toHaveProperty('assetsMigrated');
      expect(allMetrics).toHaveProperty('assetsTransferred');
      expect(allMetrics).toHaveProperty('operationTimes');
      expect(allMetrics).toHaveProperty('errors');
      expect(allMetrics).toHaveProperty('cacheStats');
      expect(allMetrics).toHaveProperty('startTime');
      expect(allMetrics).toHaveProperty('uptime');
      
      // Verify values
      expect(allMetrics.assetsCreated).toBe(1);
      expect(allMetrics.assetsMigrated['peer→webvh']).toBe(1);
      expect(allMetrics.assetsMigrated['webvh→btco']).toBe(1);
      expect(allMetrics.assetsTransferred).toBe(1);
      expect(allMetrics.operationTimes['op1']).toBeDefined();
      expect(allMetrics.operationTimes['op2']).toBeDefined();
      expect(allMetrics.errors['ERR_001']).toBe(1);
    });
  });
  
  describe('memory efficiency', () => {
    test('should not leak memory with many operations', () => {
      // Record a large number of operations
      for (let i = 0; i < 10000; i++) {
        metrics.recordOperation(`op${i % 10}`, Math.random() * 100, Math.random() > 0.1);
      }
      
      // Should only have 10 unique operations
      const allMetrics = metrics.getMetrics();
      expect(Object.keys(allMetrics.operationTimes).length).toBe(10);
      
      // Each operation should have correct count
      expect(allMetrics.operationTimes['op0'].count).toBe(1000);
    });
    
    test('should handle many error codes efficiently', () => {
      // Record many different error codes
      for (let i = 0; i < 1000; i++) {
        metrics.recordError(`ERR_${i % 50}`);
      }
      
      const allMetrics = metrics.getMetrics();
      
      // Should have 50 unique error codes
      expect(Object.keys(allMetrics.errors).length).toBe(50);
      
      // Each error code should appear 20 times
      expect(allMetrics.errors['ERR_0']).toBe(20);
    });
  });
});

