/**
 * Event Logger - Integration between Event System and Logger
 * 
 * Features:
 * - Auto-subscribe to EventEmitter events
 * - Configurable logging levels per event type
 * - Automatic metrics extraction from events
 * - Performance tracking
 */

import type { EventEmitter } from '../events/EventEmitter';
import type { OriginalsEvent, EventTypeMap } from '../events/types';
import type { Logger, LogLevel } from './Logger';
import type { MetricsCollector } from './MetricsCollector';

/**
 * Event logging configuration
 */
export interface EventLoggingConfig {
  'asset:created'?: LogLevel | false;
  'asset:migrated'?: LogLevel | false;
  'asset:transferred'?: LogLevel | false;
  'resource:published'?: LogLevel | false;
  'credential:issued'?: LogLevel | false;
  'resource:version:created'?: LogLevel | false;
  'verification:completed'?: LogLevel | false;
  'batch:started'?: LogLevel | false;
  'batch:completed'?: LogLevel | false;
  'batch:failed'?: LogLevel | false;
}

/**
 * Default event logging configuration
 */
const DEFAULT_EVENT_CONFIG: EventLoggingConfig = {
  'asset:created': 'info',
  'asset:migrated': 'info',
  'asset:transferred': 'info',
  'resource:published': 'info',
  'credential:issued': 'info',
  'resource:version:created': 'info',
  'verification:completed': 'info',
  'batch:started': 'info',
  'batch:completed': 'info',
  'batch:failed': 'warn'
};

/**
 * EventLogger class for integrating events with logging and metrics
 */
export class EventLogger {
  private config: EventLoggingConfig;
  private unsubscribeFns: Array<() => void> = [];
  
  constructor(
    private logger: Logger,
    private metricsCollector: MetricsCollector
  ) {
    this.config = { ...DEFAULT_EVENT_CONFIG };
  }
  
  /**
   * Subscribe to all events from an EventEmitter
   */
  subscribeToEvents(eventEmitter: EventEmitter): void {
    // Subscribe to each event type
    const eventTypes: Array<keyof EventTypeMap> = [
      'asset:created',
      'asset:migrated',
      'asset:transferred',
      'resource:published',
      'credential:issued',
      'resource:version:created',
      'verification:completed',
      'batch:started',
      'batch:completed',
      'batch:failed'
    ];
    
    for (const eventType of eventTypes) {
      const unsubscribe = eventEmitter.on(eventType, (event) => {
        this.handleEvent(event);
      });
      
      this.unsubscribeFns.push(unsubscribe);
    }
  }
  
  /**
   * Configure which events to log at which levels
   */
  configureEventLogging(config: EventLoggingConfig): void {
    this.config = { ...this.config, ...config };
  }
  
  /**
   * Unsubscribe from all events
   */
  unsubscribe(): void {
    for (const unsubscribe of this.unsubscribeFns) {
      unsubscribe();
    }
    this.unsubscribeFns = [];
  }
  
  /**
   * Handle an event - log and extract metrics
   */
  private handleEvent(event: OriginalsEvent): void {
    const eventType = event.type;
    const logLevel = this.config[eventType];
    
    // Always extract metrics from the event (even if logging is disabled)
    this.extractMetrics(event);
    
    // Skip logging if disabled for this event type
    if (logLevel === false) {
      return;
    }
    
    // Log the event
    if (logLevel) {
      this.logEvent(event, logLevel);
    }
  }
  
  /**
   * Log an event at the specified level
   */
  private logEvent(event: OriginalsEvent, level: LogLevel): void {
    let message: string;
    let data: Record<string, any>;
    
    switch (event.type) {
      case 'asset:created':
        message = 'Asset created';
        data = {
          assetId: event.asset.id,
          layer: event.asset.layer,
          resourceCount: event.asset.resourceCount
        };
        break;
        
      case 'asset:migrated':
        message = 'Asset migrated';
        data = {
          assetId: event.asset.id,
          fromLayer: event.asset.fromLayer,
          toLayer: event.asset.toLayer,
          details: event.details
        };
        break;
        
      case 'asset:transferred':
        message = 'Asset transferred';
        data = {
          assetId: event.asset.id,
          layer: event.asset.layer,
          from: event.from,
          to: event.to,
          transactionId: event.transactionId
        };
        break;
        
      case 'resource:published':
        message = 'Resource published';
        data = {
          assetId: event.asset.id,
          resourceId: event.resource.id,
          url: event.resource.url,
          domain: event.domain
        };
        break;
        
      case 'credential:issued':
        message = 'Credential issued';
        data = {
          assetId: event.asset.id,
          credentialType: event.credential.type,
          issuer: event.credential.issuer
        };
        break;
        
      case 'resource:version:created':
        message = 'Resource version created';
        data = {
          assetId: event.asset.id,
          resourceId: event.resource.id,
          fromVersion: event.resource.fromVersion,
          toVersion: event.resource.toVersion,
          changes: event.changes
        };
        break;
        
      case 'verification:completed':
        message = 'Verification completed';
        data = {
          assetId: event.asset.id,
          result: event.result,
          checks: event.checks
        };
        break;
        
      case 'batch:started':
        message = 'Batch operation started';
        data = {
          batchId: event.batchId,
          operation: event.operation,
          itemCount: event.itemCount
        };
        break;
        
      case 'batch:completed':
        message = 'Batch operation completed';
        data = {
          batchId: event.batchId,
          operation: event.operation,
          results: event.results
        };
        break;
        
      case 'batch:failed':
        message = 'Batch operation failed';
        data = {
          batchId: event.batchId,
          operation: event.operation,
          error: event.error,
          partialResults: event.partialResults
        };
        break;
        
      default:
        return; // Unknown event type
    }
    
    // Call the appropriate log method based on level
    switch (level) {
      case 'debug':
        this.logger.debug(message, data);
        break;
      case 'info':
        this.logger.info(message, data);
        break;
      case 'warn':
        this.logger.warn(message, data);
        break;
      case 'error':
        this.logger.error(message, undefined, data);
        break;
    }
  }
  
  /**
   * Extract metrics from an event
   */
  private extractMetrics(event: OriginalsEvent): void {
    switch (event.type) {
      case 'asset:created':
        this.metricsCollector.recordAssetCreated();
        break;
        
      case 'asset:migrated':
        this.metricsCollector.recordMigration(
          event.asset.fromLayer,
          event.asset.toLayer
        );
        break;
        
      case 'asset:transferred':
        this.metricsCollector.recordTransfer();
        break;
        
      // Other events don't need explicit metric recording
      // as they're tracked elsewhere
    }
  }
}

