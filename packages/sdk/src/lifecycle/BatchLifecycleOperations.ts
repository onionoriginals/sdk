import {
  OriginalsConfig,
  AssetResource,
  BitcoinTransaction,
} from '../types/index.js';
import { BitcoinManager } from '../bitcoin/BitcoinManager.js';
import { OriginalsAsset } from './OriginalsAsset.js';
import { validateBitcoinAddress } from '../utils/bitcoin-address.js';
import { EventEmitter } from '../events/EventEmitter.js';
import { StructuredError } from '../utils/telemetry.js';
import { validateAndNormalizeDomain } from './domainUtils.js';
import {
  BatchOperationExecutor,
  BatchValidator,
  BatchError,
  type BatchResult,
  type BatchOperationOptions,
  type BatchInscriptionOptions,
  type BatchProgressSnapshot,
} from './BatchOperations.js';

/**
 * The single-asset lifecycle operations that batch operations orchestrate over.
 * Implemented by LifecycleManager and passed in so the batch logic can reuse the
 * exact same per-asset behavior.
 */
export interface LifecycleCoreOperations {
  createAsset(resources: AssetResource[]): Promise<OriginalsAsset>;
  publishToWeb(asset: OriginalsAsset, publisherDidOrSigner: any): Promise<OriginalsAsset>;
  inscribeOnBitcoin(asset: OriginalsAsset, feeRate?: number): Promise<OriginalsAsset>;
  transferOwnership(asset: OriginalsAsset, to: string): Promise<BitcoinTransaction>;
}

/**
 * Batch lifecycle operations extracted from LifecycleManager. Holds no state
 * beyond its collaborators; each public method mirrors the previous
 * LifecycleManager method exactly (same validation, events, and return shape).
 */
export class BatchLifecycleOperations {
  private batchExecutor: BatchOperationExecutor;
  private batchValidator: BatchValidator;

  constructor(
    private config: OriginalsConfig,
    private eventEmitter: EventEmitter,
    private core: LifecycleCoreOperations,
    private deps?: { bitcoinManager?: BitcoinManager }
  ) {
    this.batchExecutor = new BatchOperationExecutor();
    this.batchValidator = new BatchValidator();
  }

  /**
   * Per-settled-item 'batch:progress' emitter. Declared in the public
   * EventTypeMap and subscribed by EventLogger but previously never emitted
   * anywhere (issue #352).
   */
  private emitBatchProgress(batchId: string, operation: string) {
    return async ({ completed, failed, total }: BatchProgressSnapshot): Promise<void> => {
      await this.eventEmitter.emit({
        type: 'batch:progress',
        timestamp: new Date().toISOString(),
        batchId,
        operation,
        progress: total > 0 ? Math.round(((completed + failed) / total) * 100) : 100,
        completed,
        failed,
        total
      });
    };
  }

  /**
   * Create multiple assets in batch
   */
  async batchCreateAssets(
    resourcesList: AssetResource[][],
    options?: BatchOperationOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    const batchId = this.batchExecutor.generateBatchId();

    // Validate first if requested
    if (options?.validateFirst !== false) {
      const validationResults = this.batchValidator.validateBatchCreate(resourcesList);
      const invalid = validationResults.filter(r => !r.isValid);
      if (invalid.length > 0) {
        const errors = invalid.flatMap(r => r.errors).join('; ');
        throw new StructuredError('BATCH_VALIDATION_FAILED', `Batch validation failed: ${errors}`);
      }
    }

    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: new Date().toISOString(),
      operation: 'create',
      batchId,
      itemCount: resourcesList.length
    });

    try {
      // Use batch executor to process all asset creations
      const result = await this.batchExecutor.execute(
        resourcesList,
        async (resources, _index) => {
          const asset = await this.core.createAsset(resources);
          return asset;
        },
        options,
        batchId, // Pass the pre-generated batchId for event correlation
        this.emitBatchProgress(batchId, 'create')
      );

      // Emit batch:completed event
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'create',
        results: {
          successful: result.successful.length,
          failed: result.failed.length,
          totalDuration: result.totalDuration
        }
      });

      return result;
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'create',
        error: error instanceof Error ? error.message : String(error),
        partialResults: error instanceof BatchError ? error.partialResults : undefined
      });

      throw error;
    }
  }

  /**
   * Publish multiple assets to web storage in batch
   */
  async batchPublishToWeb(
    assets: OriginalsAsset[],
    domain: string,
    options?: BatchOperationOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    const batchId = this.batchExecutor.generateBatchId();

    // Validate domain once (shared with the single-asset path in LifecycleManager).
    validateAndNormalizeDomain(domain);

    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: new Date().toISOString(),
      operation: 'publish',
      batchId,
      itemCount: assets.length
    });

    try {
      const result = await this.batchExecutor.execute(
        assets,
        async (asset, _index) => {
          return await this.core.publishToWeb(asset, domain);
        },
        options,
        batchId, // Pass the pre-generated batchId for event correlation
        this.emitBatchProgress(batchId, 'publish')
      );

      // Emit batch:completed event
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'publish',
        results: {
          successful: result.successful.length,
          failed: result.failed.length,
          totalDuration: result.totalDuration
        }
      });

      return result;
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'publish',
        error: error instanceof Error ? error.message : String(error),
        partialResults: error instanceof BatchError ? error.partialResults : undefined
      });

      throw error;
    }
  }

  /**
   * Inscribe multiple assets on Bitcoin.
   *
   * Each asset is inscribed in its own transaction so it receives its own
   * inscription and satoshi. A `did:btco` identity is satoshi-scoped, so an
   * asset MUST be tied to its own sat — the former `singleTransaction` mode
   * put every asset in the batch on ONE inscription/satoshi, giving N assets
   * the same on-chain identity (and transferring one would move the sat the
   * others claim). That mode is therefore rejected.
   */
  async batchInscribeOnBitcoin(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    if (options?.singleTransaction) {
      throw new StructuredError(
        'BATCH_SINGLE_TX_UNSUPPORTED',
        'singleTransaction batch inscription is not supported: all assets in the batch would share ' +
        'one inscription/satoshi and therefore one did:btco identity. Each asset must be tied to its ' +
        'own satoshi — omit singleTransaction to inscribe each asset in its own transaction.'
      );
    }

    // Validate first if requested
    if (options?.validateFirst !== false) {
      const validationResults = this.batchValidator.validateBatchInscription(assets);
      const invalid = validationResults.filter(r => !r.isValid);
      if (invalid.length > 0) {
        const errors = invalid.flatMap(r => r.errors).join('; ');
        throw new StructuredError('BATCH_VALIDATION_FAILED', `Batch validation failed: ${errors}`);
      }
    }

    return this.batchInscribeIndividualTransactions(assets, options);
  }

  /**
   * Individual transaction batch inscription (fallback mode)
   * Each asset is inscribed in its own transaction
   */
  private async batchInscribeIndividualTransactions(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    const batchId = this.batchExecutor.generateBatchId();

    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: new Date().toISOString(),
      operation: 'inscribe',
      batchId,
      itemCount: assets.length
    });

    try {
      const result = await this.batchExecutor.execute(
        assets,
        async (asset, _index) => {
          return await this.core.inscribeOnBitcoin(asset, options?.feeRate);
        },
        options,
        batchId, // Pass the pre-generated batchId for event correlation
        this.emitBatchProgress(batchId, 'inscribe')
      );

      // Emit batch:completed event
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'inscribe',
        results: {
          successful: result.successful.length,
          failed: result.failed.length,
          totalDuration: result.totalDuration
        }
      });

      return result;
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'inscribe',
        error: error instanceof Error ? error.message : String(error),
        partialResults: error instanceof BatchError ? error.partialResults : undefined
      });

      throw error;
    }
  }

  /**
   * Transfer ownership of multiple assets in batch
   */
  async batchTransferOwnership(
    transfers: Array<{ asset: OriginalsAsset; to: string }>,
    options?: BatchOperationOptions
  ): Promise<BatchResult<BitcoinTransaction>> {
    const batchId = this.batchExecutor.generateBatchId();

    // Validate first if requested
    if (options?.validateFirst !== false) {
      const validationResults = this.batchValidator.validateBatchTransfer(transfers);
      const invalid = validationResults.filter(r => !r.isValid);
      if (invalid.length > 0) {
        const errors = invalid.flatMap(r => r.errors).join('; ');
        throw new StructuredError('BATCH_VALIDATION_FAILED', `Batch validation failed: ${errors}`);
      }

      // Validate all Bitcoin addresses
      for (let i = 0; i < transfers.length; i++) {
        try {
          validateBitcoinAddress(transfers[i].to, this.config.network);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid Bitcoin address';
          throw new StructuredError('INVALID_ADDRESS', `Transfer ${i}: Invalid Bitcoin address: ${message}`);
        }
      }
    }

    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: new Date().toISOString(),
      operation: 'transfer',
      batchId,
      itemCount: transfers.length
    });

    try {
      const result = await this.batchExecutor.execute(
        transfers,
        async (transfer, _index) => {
          return await this.core.transferOwnership(transfer.asset, transfer.to);
        },
        options,
        batchId, // Pass the pre-generated batchId for event correlation
        this.emitBatchProgress(batchId, 'transfer')
      );

      // Emit batch:completed event
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'transfer',
        results: {
          successful: result.successful.length,
          failed: result.failed.length,
          totalDuration: result.totalDuration
        }
      });

      return result;
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'transfer',
        error: error instanceof Error ? error.message : String(error),
        partialResults: error instanceof BatchError ? error.partialResults : undefined
      });

      throw error;
    }
  }

}
