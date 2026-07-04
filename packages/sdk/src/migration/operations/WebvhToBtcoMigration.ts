/**
 * WebvhToBtcoMigration - Handles migration from did:webvh to did:btco
 */

import {
  MigrationOptions,
  CostEstimate,
  MigrationStateEnum
} from '../types.js';
import { DIDDocument, OriginalsConfig } from '../../types/index.js';
import { BaseMigration } from './BaseMigration.js';
import { StructuredError } from '../../utils/telemetry.js';
import { BitcoinManager } from '../../bitcoin/BitcoinManager.js';
import { DIDManager } from '../../did/DIDManager.js';
import { CredentialManager } from '../../vc/CredentialManager.js';
import { StateTracker } from '../state/StateTracker.js';

export class WebvhToBtcoMigration extends BaseMigration {
  private bitcoinManager: BitcoinManager;

  constructor(
    config: OriginalsConfig,
    didManager: DIDManager,
    credentialManager: CredentialManager,
    stateTracker: StateTracker,
    bitcoinManager: BitcoinManager
  ) {
    super(config, didManager, credentialManager, stateTracker);
    this.bitcoinManager = bitcoinManager;
  }

  /**
   * Execute webvh → btco migration
   */
  async executeMigration(
    options: MigrationOptions,
    migrationId: string
  ): Promise<{ targetDid: string; didDocument: DIDDocument }> {
    // Resolve source DID
    const sourceDid = await this.resolveSourceDid(options.sourceDid);

    await this.updateStateWithRetry(migrationId, {
      state: MigrationStateEnum.IN_PROGRESS,
      currentOperation: 'Creating Bitcoin inscription',
      progress: 30
    });

    // Create Bitcoin inscription with DID document
    const manifest = {
      didDocument: sourceDid,
      migrationId,
      timestamp: new Date().toISOString()
    };
    const payload = Buffer.from(JSON.stringify(manifest));

    await this.updateStateWithRetry(migrationId, {
      state: MigrationStateEnum.ANCHORING,
      currentOperation: 'Anchoring to Bitcoin',
      progress: 50
    });

    const inscription = await this.bitcoinManager.inscribeData(
      payload,
      'application/json',
      options.feeRate
    );

    // The satoshi ordinal is the did:btco identifier — a txid derived from the
    // inscription id is NOT a valid substitute (it would fabricate a DID for a
    // sat the asset does not sit on). Fail clearly when the provider omits it.
    const satoshiId = inscription.satoshi;
    if (!satoshiId) {
      throw new StructuredError(
        'ORD_SATOSHI_UNKNOWN',
        'Ordinals provider did not return a satoshi ordinal for the inscription; ' +
        'a did:btco identifier cannot be derived without it.',
        { inscriptionId: inscription.inscriptionId, txid: inscription.txid }
      );
    }

    await this.updateStateWithRetry(migrationId, {
      currentOperation: 'Creating btco DID document',
      progress: 80
    });

    // Migrate DID document to btco
    const migratedDoc = await this.didManager.migrateToDIDBTCO(sourceDid, satoshiId);

    await this.updateStateWithRetry(migrationId, {
      currentOperation: 'Migration completed',
      progress: 100,
      targetDid: migratedDoc.id
    });

    return {
      targetDid: migratedDoc.id,
      didDocument: migratedDoc
    };
  }

  /**
   * Estimate cost for webvh → btco migration
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async estimateCost(options: MigrationOptions): Promise<CostEstimate> {
    const feeRate = options.feeRate || 10; // default 10 sat/vB
    const estimatedSize = 1024; // ~1KB for typical DID document
    const networkFees = estimatedSize * feeRate;

    return {
      storageCost: 0,
      networkFees,
      totalCost: networkFees,
      currency: 'sats'
    };
  }
}
