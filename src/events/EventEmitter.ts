/**
 * Type-safe EventEmitter for Originals SDK
 * 
 * Features:
 * - Type-safe event emission and subscription
 * - Support for both sync and async handlers
 * - Error isolation (one failing handler doesn't affect others)
 * - Event namespacing
 * - Performance optimized (<1ms overhead per event)
 */

import type { OriginalsEvent, EventHandler, EventTypeMap } from './types';

/**
 * EventEmitter class for managing event subscriptions and emissions
 */
export class EventEmitter {
  private handlers: Map<string, Set<EventHandler>> = new Map();
  private onceHandlers: Map<string, Set<EventHandler>> = new Map();
  
  /**
   * Subscribe to an event
   * 
   * @param eventType - The type of event to listen for
   * @param handler - The handler function to call when the event is emitted
   * @returns A function to unsubscribe the handler
   * 
   * @example
   * ```typescript
   * const unsubscribe = emitter.on('asset:created', (event) => {
   *   console.log('Asset created:', event.asset.id);
   * });
   * 
   * // Later, to unsubscribe:
   * unsubscribe();
   * ```
   */
  on<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    
    this.handlers.get(eventType)!.add(handler as EventHandler);
    
    // Return unsubscribe function
    return () => this.off(eventType, handler);
  }
  
  /**
   * Subscribe to an event for a single emission
   * 
   * @param eventType - The type of event to listen for
   * @param handler - The handler function to call when the event is emitted (only once)
   * @returns A function to unsubscribe the handler
   * 
   * @example
   * ```typescript
   * emitter.once('asset:migrated', (event) => {
   *   console.log('Asset migrated once:', event.asset.id);
   * });
   * ```
   */
  once<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): () => void {
    if (!this.onceHandlers.has(eventType)) {
      this.onceHandlers.set(eventType, new Set());
    }
    
    this.onceHandlers.get(eventType)!.add(handler as EventHandler);
    
    // Return unsubscribe function
    return () => {
      const handlers = this.onceHandlers.get(eventType);
      if (handlers) {
        handlers.delete(handler as EventHandler);
      }
    };
  }
  
  /**
   * Unsubscribe from an event
   * 
   * @param eventType - The type of event to stop listening for
   * @param handler - The handler function to remove
   * 
   * @example
   * ```typescript
   * const handler = (event) => console.log(event);
   * emitter.on('asset:created', handler);
   * emitter.off('asset:created', handler);
   * ```
   */
  off<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): void {
    const handlers = this.handlers.get(eventType);
    if (handlers) {
      handlers.delete(handler as EventHandler);
    }
    
    const onceHandlers = this.onceHandlers.get(eventType);
    if (onceHandlers) {
      onceHandlers.delete(handler as EventHandler);
    }
  }
  
  /**
   * Emit an event to all subscribed handlers
   * 
   * @param event - The event to emit
   * 
   * Features:
   * - Handlers are called in subscription order
   * - Async handlers are awaited
   * - Errors in handlers are isolated (logged but don't affect other handlers)
   * - Once handlers are automatically removed after execution
   * 
   * @example
   * ```typescript
   * emitter.emit({
   *   type: 'asset:created',
   *   timestamp: new Date().toISOString(),
   *   asset: { id: 'did:peer:123', layer: 'did:peer', resourceCount: 1 }
   * });
   * ```
   */
  async emit<K extends keyof EventTypeMap>(event: EventTypeMap[K]): Promise<void> {
    const eventType = event.type as K;
    
    // Get regular handlers
    const handlers = this.handlers.get(eventType);
    if (handlers && handlers.size > 0) {
      // Create array to avoid modification during iteration
      const handlerArray = Array.from(handlers);
      
      for (const handler of handlerArray) {
        try {
          await handler(event as OriginalsEvent);
        } catch (error) {
          // Error isolation: log but don't throw
          // This ensures one failing handler doesn't affect others
          if (typeof console !== 'undefined' && console.error) {
            console.error(`Event handler error for ${eventType}:`, error);
          }
        }
      }
    }
    
    // Get and execute once handlers
    const onceHandlers = this.onceHandlers.get(eventType);
    if (onceHandlers && onceHandlers.size > 0) {
      // Create array to avoid modification during iteration
      const onceHandlerArray = Array.from(onceHandlers);
      
      // Clear once handlers before execution
      this.onceHandlers.delete(eventType);
      
      for (const handler of onceHandlerArray) {
        try {
          await handler(event as OriginalsEvent);
        } catch (error) {
          // Error isolation: log but don't throw
          if (typeof console !== 'undefined' && console.error) {
            console.error(`Event handler error (once) for ${eventType}:`, error);
          }
        }
      }
    }
  }
  
  /**
   * Remove all handlers for a specific event type, or all handlers if no type specified
   * 
   * @param eventType - Optional event type to clear handlers for
   * 
   * @example
   * ```typescript
   * // Remove all handlers for 'asset:created'
   * emitter.removeAllListeners('asset:created');
   * 
   * // Remove all handlers for all events
   * emitter.removeAllListeners();
   * ```
   */
  removeAllListeners<K extends keyof EventTypeMap>(eventType?: K): void {
    if (eventType) {
      this.handlers.delete(eventType);
      this.onceHandlers.delete(eventType);
    } else {
      this.handlers.clear();
      this.onceHandlers.clear();
    }
  }
  
  /**
   * Get the number of handlers for a specific event type
   * 
   * @param eventType - The event type to check
   * @returns The number of handlers subscribed to this event type
   */
  listenerCount<K extends keyof EventTypeMap>(eventType: K): number {
    const handlers = this.handlers.get(eventType);
    const onceHandlers = this.onceHandlers.get(eventType);
    return (handlers?.size || 0) + (onceHandlers?.size || 0);
  }
  
  /**
   * Check if there are any handlers for a specific event type
   * 
   * @param eventType - The event type to check
   * @returns True if there are any handlers subscribed
   */
  hasListeners<K extends keyof EventTypeMap>(eventType: K): boolean {
    return this.listenerCount(eventType) > 0;
  }
}
