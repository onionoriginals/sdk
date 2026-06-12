import {
  OriginalsConfig,
  AssetResource,
  BitcoinTransaction,
} from '../types';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { OriginalsAsset } from './OriginalsAsset';
import { validateBitcoinAddress } from '../utils/bitcoin-address';
import { EventEmitter } from '../events/EventEmitter';
import { StructuredError } from '../utils/telemetry';
import {
  BatchOperationExecutor,
  BatchValidator,
  BatchError,
  type BatchResult,
  type BatchOperationOptions,
  type BatchInscriptionOptions,
} from './BatchOperations';

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
        batchId // Pass the pre-generated batchId for event correlation
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
        error: error instanceof Error ? error.message : String(error)
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

    // Validate domain once
    if (!domain || typeof domain !== 'string') {
      throw new StructuredError('INVALID_DOMAIN', 'Invalid domain: must be a non-empty string');
    }

    const normalized = domain.trim().toLowerCase();

    // Split domain and port if present
    const [domainPart, portPart] = normalized.split(':');

    // Validate port if present
    if (portPart && (!/^\d+$/.test(portPart) || parseInt(portPart) < 1 || parseInt(portPart) > 65535)) {
      throw new StructuredError('INVALID_DOMAIN', `Invalid domain format: ${domain} - invalid port`);
    }

    // Allow localhost and IP addresses for development
    const isLocalhost = domainPart === 'localhost';
    const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(domainPart);

    if (!isLocalhost && !isIP) {
      // For non-localhost domains, require proper domain format
      const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
      const domainRegex = new RegExp(`^(?=.{1,253}$)(?:${label})(?:\\.(?:${label}))+?$`, 'i');
      if (!domainRegex.test(domainPart)) {
        throw new StructuredError('INVALID_DOMAIN', `Invalid domain format: ${domain}. Must be a valid hostname (e.g., example.com) or localhost.`);
      }
    }

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
        batchId // Pass the pre-generated batchId for event correlation
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
        error: error instanceof Error ? error.message : String(error)
      });

      throw error;
    }
  }

  /**
   * Inscribe multiple assets on Bitcoin with cost optimization
   * KEY FEATURE: singleTransaction option for 30%+ cost savings
   */
  async batchInscribeOnBitcoin(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    // Validate first if requested
    if (options?.validateFirst !== false) {
      const validationResults = this.batchValidator.validateBatchInscription(assets);
      const invalid = validationResults.filter(r => !r.isValid);
      if (invalid.length > 0) {
        const errors = invalid.flatMap(r => r.errors).join('; ');
        throw new StructuredError('BATCH_VALIDATION_FAILED', `Batch validation failed: ${errors}`);
      }
    }

    if (options?.singleTransaction) {
      return this.batchInscribeSingleTransaction(assets, options);
    } else {
      return this.batchInscribeIndividualTransactions(assets, options);
    }
  }

  /**
   * CORE INNOVATION: Single-transaction batch inscription
   * Combines multiple assets into one Bitcoin transaction for 30%+ cost savings
   */
  private async batchInscribeSingleTransaction(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    const batchId = this.batchExecutor.generateBatchId();
    const startTime = Date.now();
    const startedAt = new Date().toISOString();

    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: startedAt,
      operation: 'inscribe',
      batchId,
      itemCount: assets.length
    });

    try {
      // Calculate total data size for all assets
      const totalDataSize = this.calculateTotalDataSize(assets);

      // Estimate savings from batch inscription
      const estimatedSavings = this.estimateBatchSavings(assets, options?.feeRate);

      // Create manifests for all assets
      const manifests = assets.map(asset => ({
        assetId: asset.id,
        resources: asset.resources.map(res => ({
          id: res.id,
          hash: res.hash,
          contentType: res.contentType,
          url: res.url
        })),
        timestamp: new Date().toISOString()
      }));

      // Combine all manifests into a single batch payload
      const batchManifest = {
        batchId,
        assets: manifests,
        timestamp: new Date().toISOString()
      };

      const payload = Buffer.from(JSON.stringify(batchManifest));

      // Inscribe the batch manifest as a single transaction
      const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
      const inscription = await bitcoinManager.inscribeData(
        payload,
        'application/json',
        options?.feeRate
      ) as {
        revealTxId?: string;
        txid: string;
        commitTxId?: string;
        inscriptionId: string;
        satoshi?: string;
        feeRate?: number;
      };

      const revealTxId = inscription.revealTxId ?? inscription.txid;
      const commitTxId = inscription.commitTxId;
      const usedFeeRate = typeof inscription.feeRate === 'number' ? inscription.feeRate : options?.feeRate;

      // Calculate fee per asset (split proportionally by data size)
      // Include both metadata and resource content size for accurate fee distribution
      const assetSizes = assets.map(asset => {
        // Calculate metadata size
        const metadataSize = JSON.stringify({
          assetId: asset.id,
          resources: asset.resources.map(r => ({
            id: r.id,
            hash: r.hash,
            contentType: r.contentType,
            url: r.url
          }))
        }).length;

        // Add resource content sizes
        const contentSize = asset.resources.reduce((sum, r) => {
          const content = (r as { content?: string | Buffer }).content;
          if (content) {
            const length = typeof content === 'string' ? Buffer.byteLength(content) : content.length;
            return sum + (length || 0);
          }
          return sum;
        }, 0);

        return metadataSize + contentSize;
      });
      const totalSize = assetSizes.reduce((sum, size) => sum + size, 0);

      // Calculate total fee from batch transaction size and fee rate
      // Estimate transaction size: base overhead (200 bytes) + batch payload size
      const batchTxSize = 200 + totalDataSize;
      const effectiveFeeRate = usedFeeRate ?? 10;
      const totalFee = batchTxSize * effectiveFeeRate;

      // Split fees proportionally by asset data size
      const feePerAsset = assetSizes.map(size =>
        Math.floor(totalFee * (size / totalSize))
      );

      // Update all assets with batch inscription data
      const individualInscriptionIds: string[] = [];
      const successful: BatchResult<OriginalsAsset>['successful'] = [];

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        // For batch inscriptions, use the base inscription ID for all assets
        // The batch index is stored as metadata, not in the ID
        const individualInscriptionId = inscription.inscriptionId;
        individualInscriptionIds.push(individualInscriptionId);

        await asset.migrate('did:btco', {
          transactionId: revealTxId,
          inscriptionId: individualInscriptionId,
          satoshi: inscription.satoshi,
          commitTxId,
          revealTxId,
          feeRate: usedFeeRate
        });

        // Add batch metadata to provenance
        const provenance = asset.getProvenance();
        const latestMigration = provenance.migrations[provenance.migrations.length - 1];
        const migrationWithBatchData = latestMigration as typeof latestMigration & {
          batchId?: string;
          batchInscription?: boolean;
          batchIndex?: number;
          feePaid?: number;
        };
        migrationWithBatchData.batchId = batchId;
        migrationWithBatchData.batchInscription = true;
        migrationWithBatchData.batchIndex = i; // Store index as metadata
        migrationWithBatchData.feePaid = feePerAsset[i];

        const bindingValue = inscription.satoshi
          ? `did:btco:${inscription.satoshi}`
          : `did:btco:${individualInscriptionId}`;
        asset.bindings = Object.assign({}, asset.bindings || {}, { 'did:btco': bindingValue });

        successful.push({
          index: i,
          result: asset,
          duration: Date.now() - startTime
        });
      }

      const totalDuration = Date.now() - startTime;
      const completedAt = new Date().toISOString();

      // Emit batch:completed event with cost savings
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: completedAt,
        batchId,
        operation: 'inscribe',
        results: {
          successful: successful.length,
          failed: 0,
          totalDuration,
          costSavings: {
            amount: estimatedSavings.savings,
            percentage: estimatedSavings.savingsPercentage
          }
        }
      });

      return {
        successful,
        failed: [],
        totalProcessed: assets.length,
        totalDuration,
        batchId,
        startedAt,
        completedAt
      };
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'inscribe',
        error: error instanceof Error ? error.message : String(error)
      });

      throw new BatchError(
        batchId,
        'inscribe',
        { successful: 0, failed: assets.length },
        error instanceof Error ? error.message : String(error)
      );
    }
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
        batchId // Pass the pre-generated batchId for event correlation
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
        error: error instanceof Error ? error.message : String(error)
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
        batchId // Pass the pre-generated batchId for event correlation
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
        error: error instanceof Error ? error.message : String(error)
      });

      throw error;
    }
  }

  /**
   * Calculate total data size for all assets in a batch
   */
  private calculateTotalDataSize(assets: OriginalsAsset[]): number {
    return assets.reduce((total, asset) => {
      const manifest = {
        assetId: asset.id,
        resources: asset.resources.map(res => ({
          id: res.id,
          hash: res.hash,
          contentType: res.contentType,
          url: res.url
        })),
        timestamp: new Date().toISOString()
      };
      return total + JSON.stringify(manifest).length;
    }, 0);
  }

  /**
   * Estimate cost savings from batch inscription vs individual inscriptions
   */
  private estimateBatchSavings(
    assets: OriginalsAsset[],
    feeRate?: number
  ): {
    batchFee: number;
    individualFees: number;
    savings: number;
    savingsPercentage: number;
  } {
    // Calculate total size for batch
    const batchSize = this.calculateTotalDataSize(assets);

    // Estimate individual sizes
    const individualSizes = assets.map(asset =>
      JSON.stringify({
        assetId: asset.id,
        resources: asset.resources.map(r => ({
          id: r.id,
          hash: r.hash,
          contentType: r.contentType,
          url: r.url
        }))
      }).length
    );

    // Realistic fee estimation based on Bitcoin transaction structure
    // Base transaction overhead: ~200 bytes (inputs, outputs, etc.)
    // Per inscription witness overhead: ~120 bytes (script, envelope, etc.)
    // In batch mode: shared transaction overhead + minimal per-asset overhead
    const effectiveFeeRate = feeRate ?? 10; // default 10 sat/vB

    // Batch: one transaction overhead + batch data + minimal per-asset overhead
    // The batch manifest is more efficient as it shares structure
    const batchTxSize = 200 + batchSize + (assets.length * 5); // 5 bytes per asset for array/object overhead
    const batchFee = batchTxSize * effectiveFeeRate;

    // Individual: each inscription needs full transaction overhead + witness overhead + data
    const individualFees = individualSizes.reduce((total, size) => {
      // Each individual inscription has:
      // - Full transaction overhead: 200 bytes
      // - Witness/inscription overhead: 122 bytes
      // - Asset data: size bytes
      const txSize = 200 + 122 + size;
      return total + (txSize * effectiveFeeRate);
    }, 0);

    const savings = individualFees - batchFee;
    const savingsPercentage = (savings / individualFees) * 100;

    return {
      batchFee,
      individualFees,
      savings,
      savingsPercentage
    };
  }
}
