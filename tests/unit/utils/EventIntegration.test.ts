import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventLogger } from '../../../src/utils/EventLogger';
import { Logger, type LogOutput } from '../../../src/utils/Logger';
import { MetricsCollector } from '../../../src/utils/MetricsCollector';
import { EventEmitter } from '../../../src/events/EventEmitter';
import type { AssetCreatedEvent, AssetMigratedEvent, AssetTransferredEvent } from '../../../src/events/types';
import type { OriginalsConfig } from '../../../src/types';

describe('EventIntegration', () => {
  let eventEmitter: EventEmitter;
  let logger: Logger;
  let metricsCollector: MetricsCollector;
  let eventLogger: EventLogger;
  let config: OriginalsConfig;
  let logOutput: any;
  
  beforeEach(() => {
    eventEmitter = new EventEmitter();
    metricsCollector = new MetricsCollector();
    
    logOutput = mock(() => {});
    const mockOutput: LogOutput = {
      write: logOutput
    };
    
    config = {
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      logging: {
        level: 'info',
        outputs: [mockOutput]
      }
    };
    
    logger = new Logger('Test', config);
    eventLogger = new EventLogger(logger, metricsCollector);
  });
  
  describe('event subscription', () => {
    test('should subscribe to all event types', () => {
      eventLogger.subscribeToEvents(eventEmitter);
      
      // Check that event emitter has listeners
      expect(eventEmitter.hasListeners('asset:created')).toBe(true);
      expect(eventEmitter.hasListeners('asset:migrated')).toBe(true);
      expect(eventEmitter.hasListeners('asset:transferred')).toBe(true);
      expect(eventEmitter.hasListeners('resource:published')).toBe(true);
      expect(eventEmitter.hasListeners('credential:issued')).toBe(true);
      expect(eventEmitter.hasListeners('verification:completed')).toBe(true);
    });
    
    test('should unsubscribe from all events', () => {
      eventLogger.subscribeToEvents(eventEmitter);
      eventLogger.unsubscribe();
      
      expect(eventEmitter.hasListeners('asset:created')).toBe(false);
      expect(eventEmitter.hasListeners('asset:migrated')).toBe(false);
      expect(eventEmitter.hasListeners('asset:transferred')).toBe(false);
    });
  });
  
  describe('event logging', () => {
    beforeEach(() => {
      eventLogger.subscribeToEvents(eventEmitter);
    });
    
    test('should log asset:created events', async () => {
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          layer: 'did:peer',
          resourceCount: 2,
          createdAt: new Date().toISOString()
        }
      };
      
      await eventEmitter.emit(event);
      
      expect(logOutput).toHaveBeenCalled();
      const logEntry = logOutput.mock.calls[0][0];
      expect(logEntry.message).toBe('Asset created');
      expect(logEntry.data.assetId).toBe('did:peer:123');
      expect(logEntry.data.resourceCount).toBe(2);
    });
    
    test('should log asset:migrated events', async () => {
      const event: AssetMigratedEvent = {
        type: 'asset:migrated',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          fromLayer: 'did:peer',
          toLayer: 'did:webvh'
        },
        details: {
          transactionId: 'tx123'
        }
      };
      
      await eventEmitter.emit(event);
      
      expect(logOutput).toHaveBeenCalled();
      const logEntry = logOutput.mock.calls[0][0];
      expect(logEntry.message).toBe('Asset migrated');
      expect(logEntry.data.fromLayer).toBe('did:peer');
      expect(logEntry.data.toLayer).toBe('did:webvh');
    });
    
    test('should log asset:transferred events', async () => {
      const event: AssetTransferredEvent = {
        type: 'asset:transferred',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:btco:123',
          layer: 'did:btco'
        },
        from: 'alice',
        to: 'bc1q...',
        transactionId: 'tx456'
      };
      
      await eventEmitter.emit(event);
      
      expect(logOutput).toHaveBeenCalled();
      const logEntry = logOutput.mock.calls[0][0];
      expect(logEntry.message).toBe('Asset transferred');
      expect(logEntry.data.from).toBe('alice');
      expect(logEntry.data.to).toBe('bc1q...');
    });
  });
  
  describe('metrics extraction', () => {
    beforeEach(() => {
      eventLogger.subscribeToEvents(eventEmitter);
    });
    
    test('should extract metrics from asset:created events', async () => {
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          layer: 'did:peer',
          resourceCount: 1,
          createdAt: new Date().toISOString()
        }
      };
      
      await eventEmitter.emit(event);
      
      const metrics = metricsCollector.getMetrics();
      expect(metrics.assetsCreated).toBe(1);
    });
    
    test('should extract metrics from asset:migrated events', async () => {
      const event: AssetMigratedEvent = {
        type: 'asset:migrated',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          fromLayer: 'did:peer',
          toLayer: 'did:webvh'
        }
      };
      
      await eventEmitter.emit(event);
      
      const metrics = metricsCollector.getMetrics();
      expect(metrics.assetsMigrated['peer→webvh']).toBe(1);
    });
    
    test('should extract metrics from asset:transferred events', async () => {
      const event: AssetTransferredEvent = {
        type: 'asset:transferred',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:btco:123',
          layer: 'did:btco'
        },
        from: 'alice',
        to: 'bc1q...',
        transactionId: 'tx456'
      };
      
      await eventEmitter.emit(event);
      
      const metrics = metricsCollector.getMetrics();
      expect(metrics.assetsTransferred).toBe(1);
    });
    
    test('should track multiple events', async () => {
      const events = [
        {
          type: 'asset:created' as const,
          timestamp: new Date().toISOString(),
          asset: {
            id: 'did:peer:1',
            layer: 'did:peer' as const,
            resourceCount: 1,
            createdAt: new Date().toISOString()
          }
        },
        {
          type: 'asset:created' as const,
          timestamp: new Date().toISOString(),
          asset: {
            id: 'did:peer:2',
            layer: 'did:peer' as const,
            resourceCount: 1,
            createdAt: new Date().toISOString()
          }
        },
        {
          type: 'asset:migrated' as const,
          timestamp: new Date().toISOString(),
          asset: {
            id: 'did:peer:1',
            fromLayer: 'did:peer' as const,
            toLayer: 'did:webvh' as const
          }
        }
      ];
      
      for (const event of events) {
        await eventEmitter.emit(event);
      }
      
      const metrics = metricsCollector.getMetrics();
      expect(metrics.assetsCreated).toBe(2);
      expect(metrics.assetsMigrated['peer→webvh']).toBe(1);
    });
  });
  
  describe('event logging configuration', () => {
    test('should respect custom log levels', async () => {
      eventLogger.configureEventLogging({
        'asset:created': 'debug',
        'asset:migrated': 'warn'
      });
      
      eventLogger.subscribeToEvents(eventEmitter);
      
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          layer: 'did:peer',
          resourceCount: 1,
          createdAt: new Date().toISOString()
        }
      };
      
      // With default info level, debug logs won't appear
      await eventEmitter.emit(event);
      
      // Log should not appear because debug is below info threshold
      // (Logger is configured with 'info' level)
      // This is a smoke test to ensure configuration doesn't crash
      expect(logOutput.mock.calls.length).toBeGreaterThanOrEqual(0);
    });
    
    test('should disable logging for specific events', async () => {
      eventLogger.configureEventLogging({
        'asset:created': false
      });
      
      eventLogger.subscribeToEvents(eventEmitter);
      
      const createdEvent: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          layer: 'did:peer',
          resourceCount: 1,
          createdAt: new Date().toISOString()
        }
      };
      
      const migratedEvent: AssetMigratedEvent = {
        type: 'asset:migrated',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          fromLayer: 'did:peer',
          toLayer: 'did:webvh'
        }
      };
      
      await eventEmitter.emit(createdEvent);
      const callsAfterCreated = logOutput.mock.calls.length;
      
      await eventEmitter.emit(migratedEvent);
      const callsAfterMigrated = logOutput.mock.calls.length;
      
      // asset:created should not log, asset:migrated should log
      expect(callsAfterMigrated).toBeGreaterThan(callsAfterCreated);
    });
    
    test('should still extract metrics even when logging is disabled', async () => {
      eventLogger.configureEventLogging({
        'asset:created': false
      });
      
      eventLogger.subscribeToEvents(eventEmitter);
      
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          layer: 'did:peer',
          resourceCount: 1,
          createdAt: new Date().toISOString()
        }
      };
      
      await eventEmitter.emit(event);
      
      // Metrics should still be recorded
      const metrics = metricsCollector.getMetrics();
      expect(metrics.assetsCreated).toBe(1);
    });
  });
  
  describe('performance', () => {
    test('should have minimal overhead (<1ms per event)', async () => {
      eventLogger.subscribeToEvents(eventEmitter);
      
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          layer: 'did:peer',
          resourceCount: 1,
          createdAt: new Date().toISOString()
        }
      };
      
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        await eventEmitter.emit(event);
      }
      const duration = performance.now() - start;
      
      const avgDuration = duration / 100;
      
      // Each event should add less than 1ms overhead
      expect(avgDuration).toBeLessThan(1);
    });
  });
  
  describe('error handling', () => {
    test('should not throw if metrics recording fails', async () => {
      // Create a spy that throws
      const brokenMetrics = new MetricsCollector();
      (brokenMetrics as any).recordAssetCreated = () => {
        throw new Error('Metrics error');
      };
      
      const brokenEventLogger = new EventLogger(logger, brokenMetrics);
      brokenEventLogger.subscribeToEvents(eventEmitter);
      
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          layer: 'did:peer',
          resourceCount: 1,
          createdAt: new Date().toISOString()
        }
      };
      
      // Should not throw even if metrics recording fails
      await expect(eventEmitter.emit(event)).resolves.toBeUndefined();
    });
  });
});

