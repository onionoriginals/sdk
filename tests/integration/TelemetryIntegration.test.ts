import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import type { OriginalsConfig } from '../../src/types';
import type { LogOutput, LogEntry } from '../../src/utils/Logger';

describe('Telemetry Integration', () => {
  let logEntries: LogEntry[];
  let mockOutput: LogOutput;
  let config: OriginalsConfig;
  
  beforeEach(() => {
    logEntries = [];
    mockOutput = {
      write: (entry: LogEntry) => {
        logEntries.push(entry);
      }
    };
    
    config = {
      network: 'testnet',
      defaultKeyType: 'ES256K',
      logging: {
        level: 'debug',
        outputs: [mockOutput]
      },
      metrics: {
        enabled: true
      }
    };
  });
  
  describe('SDK initialization', () => {
    test('should log SDK initialization', () => {
      const sdk = new OriginalsSDK(config);
      
      // Should have logged initialization
      const initLogs = logEntries.filter(e => e.message.includes('Initializing'));
      expect(initLogs.length).toBeGreaterThan(0);
      
      const successLogs = logEntries.filter(e => e.message.includes('initialized successfully'));
      expect(successLogs.length).toBeGreaterThan(0);
    });
    
    test('should have logger and metrics accessible', () => {
      const sdk = new OriginalsSDK(config);
      
      expect(sdk.logger).toBeDefined();
      expect(sdk.metrics).toBeDefined();
    });
  });
  
  describe('lifecycle operations with logging', () => {
    test('should log asset creation', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        logging: {
          level: 'info',
          outputs: [mockOutput]
        }
      });
      
      const resources = [
        {
          id: 'test-resource',
          type: 'text',
          contentType: 'text/plain',
          hash: 'abc123',
          content: 'Hello World'
        }
      ];
      
      logEntries = []; // Reset log entries
      
      const asset = await sdk.lifecycle.createAsset(resources);
      
      // Should have logged asset creation
      const creationLogs = logEntries.filter(e => e.message.includes('Creating asset'));
      expect(creationLogs.length).toBeGreaterThan(0);
      
      const successLogs = logEntries.filter(e => e.message.includes('Asset created successfully'));
      expect(successLogs.length).toBeGreaterThan(0);
      
      // Check that metrics were recorded
      const lifecycleMetrics = (sdk.lifecycle as any).metrics.getMetrics();
      expect(lifecycleMetrics.assetsCreated).toBeGreaterThan(0);
    });
    
    test('should log with performance timing', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        logging: {
          level: 'debug',
          outputs: [mockOutput]
        }
      });
      
      const resources = [
        {
          id: 'test-resource',
          type: 'text',
          contentType: 'text/plain',
          hash: 'abc123',
          content: 'Hello World'
        }
      ];
      
      logEntries = [];
      
      await sdk.lifecycle.createAsset(resources);
      
      // Should have logged with duration
      const timedLogs = logEntries.filter(e => 
        e.message.includes('completed') && e.duration !== undefined
      );
      expect(timedLogs.length).toBeGreaterThan(0);
      
      // Duration should be reasonable
      const duration = timedLogs[0].duration!;
      expect(duration).toBeGreaterThan(0);
      expect(duration).toBeLessThan(10000); // Less than 10 seconds
    });
  });
  
  describe('event logging integration', () => {
    test('should automatically log events', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        logging: {
          level: 'info',
          outputs: [mockOutput],
          eventLogging: {
            'asset:created': 'info'
          }
        }
      });
      
      const resources = [
        {
          id: 'test-resource',
          type: 'text',
          contentType: 'text/plain',
          hash: 'abc123',
          content: 'Hello World'
        }
      ];
      
      logEntries = [];
      
      const asset = await sdk.lifecycle.createAsset(resources);
      
      // Wait for microtask (event is deferred)
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Should have logged the asset:created event
      const eventLogs = logEntries.filter(e => e.context.includes('Events'));
      expect(eventLogs.length).toBeGreaterThan(0);
    });
  });
  
  describe('metrics collection', () => {
    test('should collect metrics from lifecycle operations', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        metrics: {
          enabled: true
        }
      });
      
      const resources = [
        {
          id: 'test-resource',
          type: 'text',
          contentType: 'text/plain',
          hash: 'abc123',
          content: 'Hello World'
        }
      ];
      
      await sdk.lifecycle.createAsset(resources);
      await sdk.lifecycle.createAsset(resources);
      
      // Get metrics from LifecycleManager
      const lifecycleMetrics = (sdk.lifecycle as any).metrics.getMetrics();
      
      expect(lifecycleMetrics.assetsCreated).toBe(2);
    });
    
    test('should export metrics in JSON format', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K'
      });
      
      const resources = [
        {
          id: 'test-resource',
          type: 'text',
          contentType: 'text/plain',
          hash: 'abc123',
          content: 'Hello World'
        }
      ];
      
      await sdk.lifecycle.createAsset(resources);
      
      const lifecycleMetrics = (sdk.lifecycle as any).metrics;
      const json = lifecycleMetrics.export('json');
      
      expect(() => JSON.parse(json)).not.toThrow();
      
      const parsed = JSON.parse(json);
      expect(parsed.assetsCreated).toBeGreaterThan(0);
    });
    
    test('should export metrics in Prometheus format', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K'
      });
      
      const resources = [
        {
          id: 'test-resource',
          type: 'text',
          contentType: 'text/plain',
          hash: 'abc123',
          content: 'Hello World'
        }
      ];
      
      await sdk.lifecycle.createAsset(resources);
      
      const lifecycleMetrics = (sdk.lifecycle as any).metrics;
      const prometheus = lifecycleMetrics.export('prometheus');
      
      expect(prometheus).toContain('originals_assets_created_total');
    });
  });
  
  describe('error logging', () => {
    test('should log errors during operations', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        logging: {
          level: 'error',
          outputs: [mockOutput]
        }
      });
      
      logEntries = [];
      
      // Try to create asset with invalid resources
      try {
        await sdk.lifecycle.createAsset([]);
      } catch (error) {
        // Expected to fail
      }
      
      // Should have logged the error
      const errorLogs = logEntries.filter(e => e.level === 'error');
      expect(errorLogs.length).toBeGreaterThan(0);
    });
    
    test('should record error metrics', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K'
      });
      
      // Try to create asset with invalid resources
      try {
        await sdk.lifecycle.createAsset([]);
      } catch (error) {
        // Expected to fail
      }
      
      const lifecycleMetrics = (sdk.lifecycle as any).metrics.getMetrics();
      
      // Should have recorded an error
      expect(Object.keys(lifecycleMetrics.errors).length).toBeGreaterThan(0);
    });
  });
  
  describe('child loggers', () => {
    test('should use hierarchical context in logs', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        logging: {
          level: 'info',
          outputs: [mockOutput]
        }
      });
      
      const childLogger = sdk.logger.child('TestModule');
      
      logEntries = [];
      childLogger.info('Test message');
      
      expect(logEntries.length).toBe(1);
      expect(logEntries[0].context).toBe('SDK:TestModule');
    });
  });
  
  describe('configuration options', () => {
    test('should respect log level configuration', () => {
      const sdk = new OriginalsSDK({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        logging: {
          level: 'warn',
          outputs: [mockOutput]
        }
      });
      
      logEntries = [];
      
      sdk.logger.debug('Debug message');
      sdk.logger.info('Info message');
      sdk.logger.warn('Warn message');
      
      // Only warn and above should be logged
      expect(logEntries.length).toBe(1);
      expect(logEntries[0].level).toBe('warn');
    });
    
    test('should support custom event logging configuration', async () => {
      const sdk = OriginalsSDK.create({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        logging: {
          level: 'info',
          outputs: [mockOutput],
          eventLogging: {
            'asset:created': 'info',
            'asset:migrated': false // Disable migration logging
          }
        }
      });
      
      const resources = [
        {
          id: 'test-resource',
          type: 'text',
          contentType: 'text/plain',
          hash: 'abc123',
          content: 'Hello World'
        }
      ];
      
      logEntries = [];
      
      await sdk.lifecycle.createAsset(resources);
      
      // Wait for events
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Should have logs (configuration doesn't crash)
      expect(logEntries.length).toBeGreaterThan(0);
    });
  });
  
  describe('data sanitization', () => {
    test('should sanitize sensitive data in logs', () => {
      const sdk = new OriginalsSDK({
        network: 'testnet',
        defaultKeyType: 'ES256K',
        logging: {
          level: 'info',
          outputs: [mockOutput],
          sanitizeLogs: true
        }
      });
      
      logEntries = [];
      
      sdk.logger.info('User operation', {
        username: 'alice',
        privateKey: 'z6Mk...',
        operation: 'create'
      });
      
      expect(logEntries.length).toBe(1);
      expect(logEntries[0].data.username).toBe('alice');
      expect(logEntries[0].data.privateKey).toBe('[REDACTED]');
      expect(logEntries[0].data.operation).toBe('create');
    });
  });
});

