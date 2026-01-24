/**
 * Batch Operations for Originals SDK
 * 
 * Enables efficient processing of multiple assets with:
 * - Configurable concurrency
 * - Retry logic with exponential backoff
 * - Fail-fast vs continue-on-error modes
 * - Pre-validation of all items
 * - Detailed timing and error tracking
 */

import { randomBytes, bytesToHex } from '@noble/hashes/utils.js';
import type { AssetResource } from '../types';
import type { OriginalsAsset } from './OriginalsAsset';

/**
 * Result of a batch operation containing successful and failed items
 */
export interface BatchResult<T> {
  successful: Array<{ 
    index: number; 
    result: T; 
    duration: number; // milliseconds for this operation
  }>;
  failed: Array<{ 
    index: number; 
    error: Error; 
    duration: number;
    retryAttempts?: number;
  }>;
  totalProcessed: number;
  totalDuration: number; // total batch duration
  batchId: string; // unique identifier for this batch
  startedAt: string; // ISO timestamp
  completedAt: string; // ISO timestamp
}

/**
 * Options for configuring batch operation execution
 */
export interface BatchOperationOptions {
  continueOnError?: boolean; // Default: false (fail fast)
  maxConcurrent?: number; // Default: 1 (sequential)
  retryCount?: number; // Default: 0 (no retries)
  retryDelay?: number; // Default: 1000ms (exponential backoff base)
  timeoutMs?: number; // Default: 30000ms per operation
  validateFirst?: boolean; // Default: true (validate all before processing)
}

/**
 * Options for batch inscription operations with Bitcoin-specific settings
 */
export interface BatchInscriptionOptions extends BatchOperationOptions {
  singleTransaction?: boolean; // KEY FEATURE: combine into one Bitcoin tx
  feeRate?: number; // sat/vB for inscription
}

/**
 * Error thrown when a batch operation fails
 */
export class BatchError extends Error {
  constructor(
    public batchId: string,
    public operation: string,
    public partialResults: { successful: number; failed: number },
    message: string
  ) {
    super(message);
    this.name = 'BatchError';
  }
}

/**
 * Result of a single-transaction batch inscription with cost analysis
 */
export interface BatchInscriptionResult<T> {
  batchTransactionId: string;
  individualInscriptionIds: string[];
  assets: T[];
  totalFee: number;
  feePerAsset: number[];
  feeSavings: {
    batchFee: number;
    individualFees: number;
    savings: number;
    savingsPercentage: number;
  };
  batchId: string;
  processingTime: number;
}

/**
 * Executor for batch operations with configurable options
 */
export class BatchOperationExecutor {
  constructor(private defaultOptions: BatchOperationOptions = {}) {}
  
  /**
   * Execute a batch operation on multiple items
   * 
   * @param items - Array of items to process
   * @param operation - Function to execute on each item
   * @param options - Batch operation options
   * @param predeterminedBatchId - Optional pre-generated batch ID for event correlation
   * @returns BatchResult with successful and failed operations
   */
  async execute<T, R>(
    items: T[],
    operation: (item: T, index: number) => Promise<R>,
    options?: BatchOperationOptions,
    predeterminedBatchId?: string
  ): Promise<BatchResult<R>> {
    const opts = { ...this.defaultOptions, ...options };
    const {
      continueOnError = false,
      maxConcurrent = 1,
      retryCount = 0,
      retryDelay = 1000,
      timeoutMs = 30000
    } = opts;
    
    const batchId = predeterminedBatchId || this.generateBatchId();
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    
    const successful: BatchResult<R>['successful'] = [];
    const failed: BatchResult<R>['failed'] = [];
    
    // Process items with concurrency control
    const processItem = async (item: T, index: number): Promise<void> => {
      const itemStartTime = Date.now();
      let lastError: Error | null = null;
      let attempts = 0;
      
      for (let attempt = 0; attempt <= retryCount; attempt++) {
        attempts = attempt + 1;
        try {
          // Execute with timeout
          const result = await this.executeWithTimeout(
            () => operation(item, index),
            timeoutMs
          );
          
          const duration = Date.now() - itemStartTime;
          successful.push({ index, result, duration });
          return;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          
          // If not last attempt, wait with exponential backoff
          if (attempt < retryCount) {
            const delay = this.calculateRetryDelay(attempt, retryDelay);
            await this.sleep(delay);
          }
        }
      }
      
      // All retries failed
      const duration = Date.now() - itemStartTime;
      failed.push({
        index,
        error: lastError!,
        duration,
        retryAttempts: attempts - 1
      });
      
      // If fail-fast mode, throw error
      if (!continueOnError) {
        throw lastError;
      }
    };
    
    // Process items in batches based on maxConcurrent
    try {
      if (maxConcurrent === 1) {
        // Sequential processing
        for (let i = 0; i < items.length; i++) {
          await processItem(items[i], i);
        }
      } else {
        // Concurrent processing with limit
        const chunks = this.chunkArray(items, maxConcurrent);
        for (const chunk of chunks) {
          await Promise.all(
            chunk.map((item, chunkIndex) => {
              const globalIndex = chunks.slice(0, chunks.indexOf(chunk))
                .reduce((acc, c) => acc + c.length, 0) + chunkIndex;
              return processItem(item, globalIndex);
            })
          );
        }
      }
    } catch (error) {
      // In fail-fast mode, re-throw the error so callers can handle it
      if (!continueOnError) {
        throw error instanceof Error ? error : new Error(String(error));
      }
      // In continue-on-error mode, the error was already logged in processItem
      // and we'll return the partial results below
    }
    
    const totalDuration = Date.now() - startTime;
    const completedAt = new Date().toISOString();
    
    return {
      successful,
      failed,
      totalProcessed: successful.length + failed.length,
      totalDuration,
      batchId,
      startedAt,
      completedAt
    };
  }
  
  /**
   * Generate unique batch ID
   */
  generateBatchId(): string {
    return `batch_${Date.now()}_${bytesToHex(randomBytes(8))}`;
  }
  
  /**
   * Calculate retry delay with exponential backoff
   */
  private calculateRetryDelay(attempt: number, baseDelay: number): number {
    // Exponential backoff: baseDelay * 2^attempt
    return baseDelay * Math.pow(2, attempt);
  }
  
  /**
   * Execute operation with timeout
   */
  private async executeWithTimeout<R>(
    operation: () => Promise<R>,
    timeoutMs: number
  ): Promise<R> {
    return Promise.race([
      operation(),
      new Promise<R>((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timeout after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  }
  
  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  /**
   * Chunk array into smaller arrays of specified size
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

/**
 * Validation result for batch operations
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * Validator for batch operations
 */
export class BatchValidator {
  /**
   * Validate batch of resources for asset creation
   */
  validateBatchCreate(resourcesList: AssetResource[][]): ValidationResult[] {
    return resourcesList.map((resources, index) => {
      const errors: string[] = [];
      
      if (!Array.isArray(resources)) {
        errors.push(`Item ${index}: Resources must be an array`);
        return { isValid: false, errors };
      }
      
      if (resources.length === 0) {
        errors.push(`Item ${index}: At least one resource is required`);
        return { isValid: false, errors };
      }
      
      // Validate each resource
      for (let i = 0; i < resources.length; i++) {
        const resource = resources[i];
        if (!resource || typeof resource !== 'object') {
          errors.push(`Item ${index}, resource ${i}: Invalid resource object`);
          continue;
        }
        // AssetResource is properly typed, so we can access properties directly
        if (!resource.id || typeof resource.id !== 'string') {
          errors.push(`Item ${index}, resource ${i}: Missing or invalid id`);
        }
        if (!resource.type || typeof resource.type !== 'string') {
          errors.push(`Item ${index}, resource ${i}: Missing or invalid type`);
        }
        if (!resource.contentType || typeof resource.contentType !== 'string') {
          errors.push(`Item ${index}, resource ${i}: Missing or invalid contentType`);
        }
        if (!resource.hash || typeof resource.hash !== 'string' || !/^[0-9a-fA-F]+$/.test(resource.hash)) {
          errors.push(`Item ${index}, resource ${i}: Missing or invalid hash`);
        }
      }
      
      return { isValid: errors.length === 0, errors };
    });
  }
  
  /**
   * Validate batch of assets for inscription
   */
  validateBatchInscription(assets: OriginalsAsset[]): ValidationResult[] {
    return assets.map((asset, index) => {
      const errors: string[] = [];

      if (!asset || typeof asset !== 'object') {
        errors.push(`Item ${index}: Invalid asset object`);
        return { isValid: false, errors };
      }

      if (!asset.id || typeof asset.id !== 'string') {
        errors.push(`Item ${index}: Missing or invalid asset id`);
      }

      const currentLayer = asset.currentLayer;
      if (!currentLayer) {
        errors.push(`Item ${index}: Missing currentLayer`);
      } else if (currentLayer === 'did:btco') {
        errors.push(`Item ${index}: Asset already inscribed on Bitcoin`);
      }

      const resources = asset.resources;
      if (!resources || !Array.isArray(resources) || resources.length === 0) {
        errors.push(`Item ${index}: Asset must have at least one resource`);
      }

      return { isValid: errors.length === 0, errors };
    });
  }
  
  /**
   * Validate batch of transfer operations
   */
  validateBatchTransfer(transfers: Array<{ asset: OriginalsAsset; to: string }>): ValidationResult[] {
    return transfers.map((transfer, index) => {
      const errors: string[] = [];

      if (!transfer || typeof transfer !== 'object') {
        errors.push(`Item ${index}: Invalid transfer object`);
        return { isValid: false, errors };
      }

      if (!transfer.asset || typeof transfer.asset !== 'object') {
        errors.push(`Item ${index}: Invalid asset`);
      } else {
        const currentLayer = transfer.asset.currentLayer;
        if (currentLayer !== 'did:btco') {
          errors.push(`Item ${index}: Asset must be inscribed on Bitcoin before transfer`);
        }
      }

      if (!transfer.to || typeof transfer.to !== 'string') {
        errors.push(`Item ${index}: Invalid destination address`);
      }

      return { isValid: errors.length === 0, errors };
    });
  }
}
