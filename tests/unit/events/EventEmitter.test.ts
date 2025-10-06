import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { EventEmitter } from '../../../src/events/EventEmitter';
import type { AssetCreatedEvent, AssetMigratedEvent } from '../../../src/events/types';

describe('EventEmitter', () => {
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  describe('on() - event subscription', () => {
    test('should subscribe to events', () => {
      const handler = mock(() => {});
      emitter.on('asset:created', handler);
      
      expect(emitter.listenerCount('asset:created')).toBe(1);
    });

    test('should call handler when event is emitted', async () => {
      const handler = mock(() => {});
      emitter.on('asset:created', handler);
      
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
      
      await emitter.emit(event);
      
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(event);
    });

    test('should support multiple handlers for same event', async () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});
      
      emitter.on('asset:created', handler1);
      emitter.on('asset:created', handler2);
      
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
      
      await emitter.emit(event);
      
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    test('should return unsubscribe function', () => {
      const handler = mock(() => {});
      const unsubscribe = emitter.on('asset:created', handler);
      
      expect(emitter.listenerCount('asset:created')).toBe(1);
      
      unsubscribe();
      
      expect(emitter.listenerCount('asset:created')).toBe(0);
    });

    test('should support async handlers', async () => {
      let resolved = false;
      const handler = mock(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        resolved = true;
      });
      
      emitter.on('asset:created', handler);
      
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
      
      await emitter.emit(event);
      
      expect(handler).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(true);
    });
  });

  describe('once() - one-time subscription', () => {
    test('should call handler only once', async () => {
      const handler = mock(() => {});
      emitter.once('asset:created', handler);
      
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
      
      await emitter.emit(event);
      await emitter.emit(event);
      
      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('should return unsubscribe function', () => {
      const handler = mock(() => {});
      const unsubscribe = emitter.once('asset:created', handler);
      
      expect(emitter.listenerCount('asset:created')).toBe(1);
      
      unsubscribe();
      
      expect(emitter.listenerCount('asset:created')).toBe(0);
    });

    test('should remove handler after emission', async () => {
      const handler = mock(() => {});
      emitter.once('asset:created', handler);
      
      expect(emitter.listenerCount('asset:created')).toBe(1);
      
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
      
      await emitter.emit(event);
      
      expect(emitter.listenerCount('asset:created')).toBe(0);
    });
  });

  describe('off() - unsubscribe', () => {
    test('should unsubscribe handler', () => {
      const handler = mock(() => {});
      emitter.on('asset:created', handler);
      
      expect(emitter.listenerCount('asset:created')).toBe(1);
      
      emitter.off('asset:created', handler);
      
      expect(emitter.listenerCount('asset:created')).toBe(0);
    });

    test('should only unsubscribe specific handler', async () => {
      const handler1 = mock(() => {});
      const handler2 = mock(() => {});
      
      emitter.on('asset:created', handler1);
      emitter.on('asset:created', handler2);
      
      emitter.off('asset:created', handler1);
      
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
      
      await emitter.emit(event);
      
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('emit() - event emission', () => {
    test('should emit events with correct data', async () => {
      let capturedEvent: AssetCreatedEvent | null = null;
      
      emitter.on('asset:created', (event) => {
        capturedEvent = event;
      });
      
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
      
      await emitter.emit(event);
      
      expect(capturedEvent).toEqual(event);
    });

    test('should handle events with no listeners gracefully', async () => {
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
      
      // Should not throw
      await expect(emitter.emit(event)).resolves.toBeUndefined();
    });

    test('should call handlers in order', async () => {
      const callOrder: number[] = [];
      
      emitter.on('asset:created', () => {
        callOrder.push(1);
      });
      
      emitter.on('asset:created', () => {
        callOrder.push(2);
      });
      
      emitter.on('asset:created', () => {
        callOrder.push(3);
      });
      
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
      
      await emitter.emit(event);
      
      expect(callOrder).toEqual([1, 2, 3]);
    });
  });

  describe('error isolation', () => {
    test('should isolate errors - one failing handler does not affect others', async () => {
      const handler1 = mock(() => {
        throw new Error('Handler 1 error');
      });
      
      const handler2 = mock(() => {});
      
      emitter.on('asset:created', handler1);
      emitter.on('asset:created', handler2);
      
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
      
      // Should not throw
      await expect(emitter.emit(event)).resolves.toBeUndefined();
      
      // Both handlers should have been called
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    test('should isolate async handler errors', async () => {
      const handler1 = mock(async () => {
        throw new Error('Async handler error');
      });
      
      const handler2 = mock(() => {});
      
      emitter.on('asset:created', handler1);
      emitter.on('asset:created', handler2);
      
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
      
      await expect(emitter.emit(event)).resolves.toBeUndefined();
      
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAllListeners()', () => {
    test('should remove all listeners for specific event', () => {
      emitter.on('asset:created', () => {});
      emitter.on('asset:created', () => {});
      emitter.on('asset:migrated', () => {});
      
      expect(emitter.listenerCount('asset:created')).toBe(2);
      expect(emitter.listenerCount('asset:migrated')).toBe(1);
      
      emitter.removeAllListeners('asset:created');
      
      expect(emitter.listenerCount('asset:created')).toBe(0);
      expect(emitter.listenerCount('asset:migrated')).toBe(1);
    });

    test('should remove all listeners for all events when no type specified', () => {
      emitter.on('asset:created', () => {});
      emitter.on('asset:migrated', () => {});
      
      expect(emitter.listenerCount('asset:created')).toBe(1);
      expect(emitter.listenerCount('asset:migrated')).toBe(1);
      
      emitter.removeAllListeners();
      
      expect(emitter.listenerCount('asset:created')).toBe(0);
      expect(emitter.listenerCount('asset:migrated')).toBe(0);
    });
  });

  describe('listenerCount() and hasListeners()', () => {
    test('should return correct listener count', () => {
      expect(emitter.listenerCount('asset:created')).toBe(0);
      
      emitter.on('asset:created', () => {});
      expect(emitter.listenerCount('asset:created')).toBe(1);
      
      emitter.on('asset:created', () => {});
      expect(emitter.listenerCount('asset:created')).toBe(2);
      
      emitter.once('asset:created', () => {});
      expect(emitter.listenerCount('asset:created')).toBe(3);
    });

    test('should return correct hasListeners result', () => {
      expect(emitter.hasListeners('asset:created')).toBe(false);
      
      emitter.on('asset:created', () => {});
      expect(emitter.hasListeners('asset:created')).toBe(true);
      
      emitter.removeAllListeners('asset:created');
      expect(emitter.hasListeners('asset:created')).toBe(false);
    });
  });

  describe('performance', () => {
    test('should have minimal overhead (<5ms per event)', async () => {
      const handler = mock(() => {});
      emitter.on('asset:created', handler);
      
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
      
      const start = performance.now();
      await emitter.emit(event);
      const duration = performance.now() - start;
      
      // Should complete in less than 5ms (smoke check for reasonable performance)
      // Note: Relaxed from <1ms to avoid CI timing variance
      expect(duration).toBeLessThan(5);
    });
  });
});
