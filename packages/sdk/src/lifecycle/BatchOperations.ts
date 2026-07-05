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
import type { AssetResource } from '../types/index.js';
import type { OriginalsAsset } from './OriginalsAsset.js';

/**
 * Raised when a batch item exceeds its timeout. Distinct from operation
 * failures because the underlying operation cannot be cancelled and may
 * still complete — callers must treat the outcome as unknown.
 */
export class BatchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchTimeoutError';
  }
}

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
    message: string,
    /**
     * The full partial BatchResult accumulated before fail-fast aborted, so
     * callers can recover what already ran (including txids of already-broadcast
     * inscriptions) instead of losing it to a bare re-throw.
     */
    public result?: BatchResult<unknown>,
    /**
     * The original error that aborted the batch, preserved so callers can
     * still match on `instanceof StructuredError` / error codes instead of
     * only the flattened message.
     */
    cause?: unknown
  ) {
    super(message);
    this.name = 'BatchError';
    if (cause !== undefined) {
      this.cause = cause;
    }
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

    // Fail-fast abort flag: set as soon as any item exhausts its attempts in
    // fail-fast mode. Sibling operations already in flight cannot be
    // cancelled, but this prevents (a) sibling RETRIES from re-executing a
    // paid/non-idempotent operation after the batch has already failed and
    // (b) any not-yet-started item from starting.
    let aborted = false;

    // Process items with concurrency control
    const processItem = async (item: T, index: number): Promise<void> => {
      // Another item already failed the batch in fail-fast mode: do not start.
      if (aborted && !continueOnError) {
        return;
      }
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

          // A timeout does NOT mean the operation failed — Promise.race
          // cannot cancel it, so it may still complete (e.g. broadcast a
          // Bitcoin transaction, migrate the asset). Retrying would execute
          // a possibly-succeeded, non-idempotent operation a second time
          // (double inscription fees, duplicate transfers). Fail the item
          // with an outcome-unknown error instead.
          if (error instanceof BatchTimeoutError) {
            lastError = new Error(
              `Operation timeout after ${timeoutMs}ms; outcome unknown — ` +
              'not retried because the operation may still complete'
            );
            break;
          }

          // The batch has been aborted by a sibling failure while this
          // attempt was in flight: stop retrying (each retry could
          // re-broadcast a paid operation for a batch that already failed).
          if (aborted && !continueOnError) {
            break;
          }

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

      // If fail-fast mode, abort the batch and throw error
      if (!continueOnError) {
        aborted = true;
        throw lastError!;
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
        // Concurrent processing with limit. Wait for the WHOLE chunk to
        // settle (allSettled, not all) before surfacing a fail-fast error:
        // with Promise.all the throw propagated while sibling operations
        // were still running, so the BatchError's partial result kept
        // mutating after being handed to the caller and sibling outcomes
        // were unaccounted for.
        for (const [chunkStart, chunk] of this.chunkArray(items, maxConcurrent).map(
          (c, ci) => [ci * maxConcurrent, c] as const
        )) {
          const settled = await Promise.allSettled(
            chunk.map((item, chunkIndex) => processItem(item, chunkStart + chunkIndex))
          );
          if (!continueOnError) {
            const firstRejection = settled.find(
              (s): s is PromiseRejectedResult => s.status === 'rejected'
            );
            if (firstRejection) {
              throw firstRejection.reason;
            }
          }
        }
      }
    } catch (error) {
      // In fail-fast mode, surface the accumulated partial result rather than a
      // bare re-throw that discards the successful/failed arrays (which may
      // carry txids of already-broadcast inscriptions). Wrap in a BatchError so
      // callers — and the batch:failed event — can see what already ran.
      if (!continueOnError) {
        const message = error instanceof Error ? error.message : String(error);
        // Snapshot the arrays: every scheduled sibling has settled by now
        // (allSettled above), and copying guarantees the reported result can
        // never mutate under the caller.
        const partial: BatchResult<R> = {
          successful: [...successful],
          failed: [...failed],
          totalProcessed: successful.length + failed.length,
          totalDuration: Date.now() - startTime,
          batchId,
          startedAt,
          completedAt: new Date().toISOString()
        };
        throw new BatchError(
          batchId,
          'batch',
          { successful: successful.length, failed: failed.length },
          message,
          partial,
          error
        );
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<R>((_, reject) => {
          timer = setTimeout(() => reject(new BatchTimeoutError(`Operation timeout after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
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
    // Detect duplicates across the whole batch: each per-item check runs
    // against pre-batch state, so the same asset listed twice would pass both
    // checks independently and then be inscribed twice — paying twice and
    // failing the second migration after the money is spent (issue #243).
    const seenIds = new Map<string, number>();
    return assets.map((asset, index) => {
      const errors: string[] = [];

      if (!asset || typeof asset !== 'object') {
        errors.push(`Item ${index}: Invalid asset object`);
        return { isValid: false, errors };
      }

      if (!asset.id || typeof asset.id !== 'string') {
        errors.push(`Item ${index}: Missing or invalid asset id`);
      } else if (seenIds.has(asset.id)) {
        errors.push(`Item ${index}: Duplicate asset in batch (same id as item ${seenIds.get(asset.id)}): ${asset.id}`);
      } else {
        seenIds.set(asset.id, index);
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
    // Detect duplicates across the whole batch (same rationale as
    // validateBatchInscription, issue #243): each per-item check runs against
    // pre-batch state, so the same asset listed twice would pass both checks
    // independently and then be transferred twice — broadcasting two paid
    // transactions where the second races the first's UTXO state.
    const seenIds = new Map<string, number>();
    return transfers.map((transfer, index) => {
      const errors: string[] = [];

      if (!transfer || typeof transfer !== 'object') {
        errors.push(`Item ${index}: Invalid transfer object`);
        return { isValid: false, errors };
      }

      if (!transfer.asset || typeof transfer.asset !== 'object') {
        errors.push(`Item ${index}: Invalid asset`);
      } else {
        const assetId = transfer.asset.id;
        if (assetId && typeof assetId === 'string') {
          if (seenIds.has(assetId)) {
            errors.push(`Item ${index}: Duplicate asset in batch (same id as item ${seenIds.get(assetId)}): ${assetId}`);
          } else {
            seenIds.set(assetId, index);
          }
        }
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
