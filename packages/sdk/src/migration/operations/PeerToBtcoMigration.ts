/**
 * PeerToBtcoMigration - Handles direct migration from did:peer to did:btco
 */

import {
  MigrationOptions,
  CostEstimate,
  MigrationStateEnum
} from '../types';
import { DIDDocument, OriginalsConfig } from '../../types';
import { BaseMigration } from './BaseMigration';
import { BitcoinManager } from '../../bitcoin/BitcoinManager';
import { DIDManager } from '../../did/DIDManager';
import { CredentialManager } from '../../vc/CredentialManager';
import { StateTracker } from '../state/StateTracker';

export class PeerToBtcoMigration extends BaseMigration {
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
   * Execute peer → btco migration (direct, skipping webvh layer)
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

    // Use satoshi identifier or inscription ID
    const satoshiId = inscription.satoshi || inscription.inscriptionId.split('i')[0];

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
   * Estimate cost for peer → btco migration
   */
  async estimateCost(options: MigrationOptions): Promise<CostEstimate> {
    const feeRate = options.feeRate || 10; // default 10 sat/vB
    const estimatedSize = 1024; // ~1KB for typical DID document
    const networkFees = estimatedSize * feeRate;

    return {
      storageCost: 0,
      networkFees,
      totalCost: networkFees,
      estimatedDuration: 600000, // ~10 minutes
      currency: 'sats'
    };
  }
}
