/**
 * Metrics Collector for Originals SDK
 * 
 * Features:
 * - Track operation counts and performance
 * - Asset lifecycle metrics (created, migrated, transferred)
 * - Error tracking by error code
 * - Cache statistics (optional)
 * - Export in JSON and Prometheus formats
 * - Memory-efficient storage
 */

import type { LayerType } from '../types';

/**
 * Operation-specific metrics
 */
export interface OperationMetrics {
  count: number;
  totalTime: number;
  avgTime: number;
  minTime: number;
  maxTime: number;
  errorCount: number;
}

/**
 * Complete metrics snapshot
 */
export interface Metrics {
  // Asset operations
  assetsCreated: number;
  assetsMigrated: Record<string, number>; // by layer transition (e.g., "peer→webvh": 5)
  assetsTransferred: number;
  
  // Operation performance
  operationTimes: Record<string, OperationMetrics>;
  
  // Error tracking
  errors: Record<string, number>; // by error code
  
  // Cache statistics (if caching is implemented)
  cacheStats?: {
    hits: number;
    misses: number;
    hitRate: number;
  };
  
  // System metrics
  startTime: string;
  uptime: number; // milliseconds
}

/**
 * MetricsCollector class
 */
export class MetricsCollector {
  private assetsCreatedCount = 0;
  private assetsMigratedMap: Map<string, number> = new Map();
  private assetsTransferredCount = 0;
  
  private operationMetrics: Map<string, {
    count: number;
    totalTime: number;
    minTime: number;
    maxTime: number;
    errorCount: number;
  }> = new Map();
  
  private errorCounts: Map<string, number> = new Map();
  
  private cacheHits = 0;
  private cacheMisses = 0;
  
  private readonly startTime: string;
  
  constructor() {
    this.startTime = new Date().toISOString();
  }
  
  /**
   * Record an operation with timing and success status
   */
  recordOperation(operation: string, duration: number, success: boolean): void {
    if (!this.operationMetrics.has(operation)) {
      this.operationMetrics.set(operation, {
        count: 0,
        totalTime: 0,
        minTime: Infinity,
        maxTime: -Infinity,
        errorCount: 0
      });
    }
    
    const metrics = this.operationMetrics.get(operation)!;
    metrics.count++;
    metrics.totalTime += duration;
    metrics.minTime = Math.min(metrics.minTime, duration);
    metrics.maxTime = Math.max(metrics.maxTime, duration);
    
    if (!success) {
      metrics.errorCount++;
    }
  }
  
  /**
   * Start tracking an operation, returns completion function
   */
  startOperation(operation: string): () => void {
    const startTime = performance.now();
    
    return (success: boolean = true) => {
      const duration = performance.now() - startTime;
      this.recordOperation(operation, duration, success);
    };
  }
  
  /**
   * Record an asset creation
   */
  recordAssetCreated(): void {
    this.assetsCreatedCount++;
  }
  
  /**
   * Record an asset migration between layers
   */
  recordMigration(from: LayerType, to: LayerType): void {
    // Create transition key
    const fromShort = from.split(':')[1]; // "peer", "webvh", "btco"
    const toShort = to.split(':')[1];
    const transitionKey = `${fromShort}→${toShort}`;
    
    const current = this.assetsMigratedMap.get(transitionKey) || 0;
    this.assetsMigratedMap.set(transitionKey, current + 1);
  }
  
  /**
   * Record an asset transfer
   */
  recordTransfer(): void {
    this.assetsTransferredCount++;
  }
  
  /**
   * Record an error by error code
   */
  recordError(code: string, operation?: string): void {
    // Track error by code
    const current = this.errorCounts.get(code) || 0;
    this.errorCounts.set(code, current + 1);
    
    // If operation is provided, increment its error count
    if (operation && this.operationMetrics.has(operation)) {
      this.operationMetrics.get(operation)!.errorCount++;
    }
  }
  
  /**
   * Record a cache hit
   */
  recordCacheHit(): void {
    this.cacheHits++;
  }
  
  /**
   * Record a cache miss
   */
  recordCacheMiss(): void {
    this.cacheMisses++;
  }
  
  /**
   * Get a snapshot of all metrics
   */
  getMetrics(): Metrics {
    const operationTimes: Record<string, OperationMetrics> = {};
    
    for (const [operation, metrics] of this.operationMetrics.entries()) {
      operationTimes[operation] = {
        count: metrics.count,
        totalTime: metrics.totalTime,
        avgTime: metrics.count > 0 ? metrics.totalTime / metrics.count : 0,
        minTime: metrics.minTime === Infinity ? 0 : metrics.minTime,
        maxTime: metrics.maxTime === -Infinity ? 0 : metrics.maxTime,
        errorCount: metrics.errorCount
      };
    }
    
    const assetsMigrated: Record<string, number> = {};
    for (const [key, count] of this.assetsMigratedMap.entries()) {
      assetsMigrated[key] = count;
    }
    
    const errors: Record<string, number> = {};
    for (const [code, count] of this.errorCounts.entries()) {
      errors[code] = count;
    }
    
    const totalCacheRequests = this.cacheHits + this.cacheMisses;
    const cacheStats = totalCacheRequests > 0 ? {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: this.cacheHits / totalCacheRequests
    } : undefined;
    
    return {
      assetsCreated: this.assetsCreatedCount,
      assetsMigrated,
      assetsTransferred: this.assetsTransferredCount,
      operationTimes,
      errors,
      cacheStats,
      startTime: this.startTime,
      uptime: Date.now() - new Date(this.startTime).getTime()
    };
  }
  
  /**
   * Get metrics for a specific operation
   */
  getOperationMetrics(operation: string): OperationMetrics | null {
    const metrics = this.operationMetrics.get(operation);
    
    if (!metrics) {
      return null;
    }
    
    return {
      count: metrics.count,
      totalTime: metrics.totalTime,
      avgTime: metrics.count > 0 ? metrics.totalTime / metrics.count : 0,
      minTime: metrics.minTime === Infinity ? 0 : metrics.minTime,
      maxTime: metrics.maxTime === -Infinity ? 0 : metrics.maxTime,
      errorCount: metrics.errorCount
    };
  }
  
  /**
   * Reset all metrics
   */
  reset(): void {
    this.assetsCreatedCount = 0;
    this.assetsMigratedMap.clear();
    this.assetsTransferredCount = 0;
    this.operationMetrics.clear();
    this.errorCounts.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }
  
  /**
   * Export metrics in the specified format
   */
  export(format: 'json' | 'prometheus'): string {
    if (format === 'json') {
      return this.exportJSON();
    } else if (format === 'prometheus') {
      return this.exportPrometheus();
    }
    
    throw new Error(`Unsupported export format: ${format}`);
  }
  
  /**
   * Export metrics as JSON
   */
  private exportJSON(): string {
    return JSON.stringify(this.getMetrics(), null, 2);
  }
  
  /**
   * Export metrics in Prometheus format
   */
  private exportPrometheus(): string {
    const lines: string[] = [];
    const metrics = this.getMetrics();
    
    // Asset metrics
    lines.push('# HELP originals_assets_created_total Total number of assets created');
    lines.push('# TYPE originals_assets_created_total counter');
    lines.push(`originals_assets_created_total ${metrics.assetsCreated}`);
    lines.push('');
    
    lines.push('# HELP originals_assets_transferred_total Total number of assets transferred');
    lines.push('# TYPE originals_assets_transferred_total counter');
    lines.push(`originals_assets_transferred_total ${metrics.assetsTransferred}`);
    lines.push('');
    
    // Migration metrics
    lines.push('# HELP originals_assets_migrated_total Total number of assets migrated by layer transition');
    lines.push('# TYPE originals_assets_migrated_total counter');
    for (const [transition, count] of Object.entries(metrics.assetsMigrated)) {
      const [from, to] = transition.split('→');
      lines.push(`originals_assets_migrated_total{from="${from}",to="${to}"} ${count}`);
    }
    lines.push('');
    
    // Operation metrics
    for (const [operation, opMetrics] of Object.entries(metrics.operationTimes)) {
      const safeOpName = operation.replace(/[^a-zA-Z0-9_]/g, '_');
      
      lines.push(`# HELP originals_operation_${safeOpName}_total Total number of ${operation} operations`);
      lines.push(`# TYPE originals_operation_${safeOpName}_total counter`);
      lines.push(`originals_operation_${safeOpName}_total ${opMetrics.count}`);
      lines.push('');
      
      lines.push(`# HELP originals_operation_${safeOpName}_duration_milliseconds Duration of ${operation} operations`);
      lines.push(`# TYPE originals_operation_${safeOpName}_duration_milliseconds summary`);
      lines.push(`originals_operation_${safeOpName}_duration_milliseconds{quantile="0.0"} ${opMetrics.minTime}`);
      lines.push(`originals_operation_${safeOpName}_duration_milliseconds{quantile="0.5"} ${opMetrics.avgTime}`);
      lines.push(`originals_operation_${safeOpName}_duration_milliseconds{quantile="1.0"} ${opMetrics.maxTime}`);
      lines.push(`originals_operation_${safeOpName}_duration_milliseconds_sum ${opMetrics.totalTime}`);
      lines.push(`originals_operation_${safeOpName}_duration_milliseconds_count ${opMetrics.count}`);
      lines.push('');
      
      lines.push(`# HELP originals_operation_${safeOpName}_errors_total Total number of errors in ${operation} operations`);
      lines.push(`# TYPE originals_operation_${safeOpName}_errors_total counter`);
      lines.push(`originals_operation_${safeOpName}_errors_total ${opMetrics.errorCount}`);
      lines.push('');
    }
    
    // Error metrics
    lines.push('# HELP originals_errors_total Total number of errors by code');
    lines.push('# TYPE originals_errors_total counter');
    for (const [code, count] of Object.entries(metrics.errors)) {
      lines.push(`originals_errors_total{code="${code}"} ${count}`);
    }
    lines.push('');
    
    // Cache metrics
    if (metrics.cacheStats) {
      lines.push('# HELP originals_cache_hits_total Total number of cache hits');
      lines.push('# TYPE originals_cache_hits_total counter');
      lines.push(`originals_cache_hits_total ${metrics.cacheStats.hits}`);
      lines.push('');
      
      lines.push('# HELP originals_cache_misses_total Total number of cache misses');
      lines.push('# TYPE originals_cache_misses_total counter');
      lines.push(`originals_cache_misses_total ${metrics.cacheStats.misses}`);
      lines.push('');
      
      lines.push('# HELP originals_cache_hit_rate Cache hit rate');
      lines.push('# TYPE originals_cache_hit_rate gauge');
      lines.push(`originals_cache_hit_rate ${metrics.cacheStats.hitRate}`);
      lines.push('');
    }
    
    // System metrics
    lines.push('# HELP originals_uptime_milliseconds SDK uptime in milliseconds');
    lines.push('# TYPE originals_uptime_milliseconds gauge');
    lines.push(`originals_uptime_milliseconds ${metrics.uptime}`);
    lines.push('');
    
    return lines.join('\n');
  }
}

