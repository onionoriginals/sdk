import { describe, test, expect, beforeEach } from 'bun:test';
import { Logger, type LogOutput, type LogEntry } from '../../src/utils/Logger';
import { MetricsCollector } from '../../src/utils/MetricsCollector';
import { EventLogger } from '../../src/utils/EventLogger';
import { EventEmitter } from '../../src/events/EventEmitter';
import type { OriginalsConfig, AssetCreatedEvent } from '../../src/types';

describe('Logging Performance Benchmarks', () => {
  let config: OriginalsConfig;
  let noOpOutput: LogOutput;
  
  beforeEach(() => {
    noOpOutput = {
      write: () => {} // No-op for performance testing
    };
    
    config = {
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      logging: {
        level: 'info',
        outputs: [noOpOutput]
      }
    };
  });
  
  describe('Logger performance', () => {
    test('should log with <1ms overhead per call', () => {
      const logger = new Logger('Test', config);
      
      const iterations = 1000;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        logger.info('Test message', { iteration: i });
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / iterations;
      
      console.log(`Logger average time per call: ${avgDuration.toFixed(3)}ms`);
      
      expect(avgDuration).toBeLessThan(1);
    });
    
    test('should handle child logger creation efficiently', () => {
      const logger = new Logger('Test', config);
      
      const iterations = 1000;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        const child = logger.child(`Child${i}`);
        child.info('Test message');
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / iterations;
      
      console.log(`Child logger + log average time: ${avgDuration.toFixed(3)}ms`);
      
      expect(avgDuration).toBeLessThan(2);
    });
    
    test('should handle timer operations efficiently', () => {
      const logger = new Logger('Test', config);
      config.logging!.level = 'debug'; // Enable debug to see timer logs
      
      const iterations = 1000;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        const stopTimer = logger.startTimer(`operation${i}`);
        stopTimer();
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / iterations;
      
      console.log(`Timer operation average time: ${avgDuration.toFixed(3)}ms`);
      
      expect(avgDuration).toBeLessThan(1);
    });
    
    test('should filter log levels efficiently', () => {
      const logger = new Logger('Test', config);
      config.logging!.level = 'error'; // High threshold
      
      const iterations = 10000;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        logger.debug('Debug message'); // Should be filtered
        logger.info('Info message');   // Should be filtered
        logger.warn('Warn message');   // Should be filtered
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / (iterations * 3);
      
      console.log(`Filtered log average time: ${avgDuration.toFixed(3)}ms`);
      
      // Filtered logs should be even faster
      expect(avgDuration).toBeLessThan(0.1);
    });
  });
  
  describe('MetricsCollector performance', () => {
    test('should record operations efficiently', () => {
      const metrics = new MetricsCollector();
      
      const iterations = 10000;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        metrics.recordOperation('testOp', Math.random() * 100, true);
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / iterations;
      
      console.log(`MetricsCollector record average time: ${avgDuration.toFixed(3)}ms`);
      
      expect(avgDuration).toBeLessThan(0.1);
    });
    
    test('should handle concurrent metric types efficiently', () => {
      const metrics = new MetricsCollector();
      
      const iterations = 1000;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        metrics.recordAssetCreated();
        metrics.recordMigration('did:peer', 'did:webvh');
        metrics.recordTransfer();
        metrics.recordError('ERR_001');
        metrics.recordCacheHit();
        metrics.recordCacheMiss();
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / (iterations * 6);
      
      console.log(`Multiple metric types average time: ${avgDuration.toFixed(3)}ms`);
      
      expect(avgDuration).toBeLessThan(0.1);
    });
    
    test('should export large metric sets efficiently', () => {
      const metrics = new MetricsCollector();
      
      // Generate large metric set
      for (let i = 0; i < 1000; i++) {
        metrics.recordOperation(`op${i % 10}`, Math.random() * 100, true);
        metrics.recordAssetCreated();
        metrics.recordMigration('did:peer', 'did:webvh');
      }
      
      // Test JSON export
      const jsonStart = performance.now();
      const json = metrics.export('json');
      const jsonDuration = performance.now() - jsonStart;
      
      console.log(`JSON export time: ${jsonDuration.toFixed(3)}ms`);
      
      expect(jsonDuration).toBeLessThan(50);
      
      // Test Prometheus export
      const promStart = performance.now();
      const prom = metrics.export('prometheus');
      const promDuration = performance.now() - promStart;
      
      console.log(`Prometheus export time: ${promDuration.toFixed(3)}ms`);
      
      expect(promDuration).toBeLessThan(100);
    });
  });
  
  describe('EventLogger performance', () => {
    test('should handle event logging with <0.5ms overhead', async () => {
      const logger = new Logger('Test', config);
      const metrics = new MetricsCollector();
      const eventLogger = new EventLogger(logger, metrics);
      const eventEmitter = new EventEmitter();
      
      eventLogger.subscribeToEvents(eventEmitter);
      
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:test123',
          layer: 'did:peer',
          resourceCount: 1,
          createdAt: new Date().toISOString()
        }
      };
      
      const iterations = 100;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        await eventEmitter.emit(event);
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / iterations;
      
      console.log(`EventLogger average time per event: ${avgDuration.toFixed(3)}ms`);
      
      expect(avgDuration).toBeLessThan(0.5);
    });
  });
  
  describe('Memory efficiency', () => {
    test('should not leak memory with many log calls', () => {
      const logger = new Logger('Test', config);
      
      // Create a buffer to store some references
      const beforeMemory = (process as any).memoryUsage?.() || { heapUsed: 0 };
      
      for (let i = 0; i < 10000; i++) {
        logger.info('Test message', { 
          iteration: i,
          data: { key: 'value', nested: { deep: 'data' } }
        });
      }
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }
      
      const afterMemory = (process as any).memoryUsage?.() || { heapUsed: 0 };
      
      // Memory increase should be minimal (less than 10MB)
      const memoryIncrease = (afterMemory.heapUsed - beforeMemory.heapUsed) / 1024 / 1024;
      
      console.log(`Memory increase after 10k logs: ${memoryIncrease.toFixed(2)}MB`);
      
      expect(memoryIncrease).toBeLessThan(10);
    });
    
    test('should not leak memory in metrics collection', () => {
      const metrics = new MetricsCollector();
      
      const beforeMemory = (process as any).memoryUsage?.() || { heapUsed: 0 };
      
      // Record many operations
      for (let i = 0; i < 50000; i++) {
        metrics.recordOperation(`op${i % 20}`, Math.random() * 100, true);
      }
      
      if (global.gc) {
        global.gc();
      }
      
      const afterMemory = (process as any).memoryUsage?.() || { heapUsed: 0 };
      
      const memoryIncrease = (afterMemory.heapUsed - beforeMemory.heapUsed) / 1024 / 1024;
      
      console.log(`Memory increase after 50k metrics: ${memoryIncrease.toFixed(2)}MB`);
      
      // Should only store aggregated data for 20 operations, not 50k entries
      expect(memoryIncrease).toBeLessThan(5);
    });
  });
  
  describe('Sanitization performance', () => {
    test('should sanitize data efficiently', () => {
      config.logging!.sanitizeLogs = true;
      const logger = new Logger('Test', config);
      
      const sensitiveData = {
        username: 'alice',
        privateKey: 'z6Mk...',
        publicKey: 'z6Mk...',
        data: {
          nested: {
            secret: 'top-secret',
            password: 'password123'
          }
        }
      };
      
      const iterations = 1000;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        logger.info('User data', sensitiveData);
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / iterations;
      
      console.log(`Sanitization average time: ${avgDuration.toFixed(3)}ms`);
      
      // Sanitization should add minimal overhead
      expect(avgDuration).toBeLessThan(2);
    });
  });
  
  describe('Overall telemetry impact', () => {
    test('should have minimal impact on SDK operations', async () => {
      const logger = new Logger('SDK', config);
      const metrics = new MetricsCollector();
      
      // Simulate SDK operation with full logging
      const iterations = 100;
      const start = performance.now();
      
      for (let i = 0; i < iterations; i++) {
        const childLogger = logger.child('Operation');
        const stopTimer = childLogger.startTimer('fullOperation');
        
        childLogger.info('Starting operation', { iteration: i });
        
        // Simulate work
        metrics.recordOperation('work', Math.random() * 10, true);
        
        childLogger.info('Operation completed', { iteration: i });
        stopTimer();
      }
      
      const duration = performance.now() - start;
      const avgDuration = duration / iterations;
      
      console.log(`Full telemetry stack average time: ${avgDuration.toFixed(3)}ms`);
      
      // Total overhead should be less than 2ms per operation
      expect(avgDuration).toBeLessThan(2);
    });
  });
});

