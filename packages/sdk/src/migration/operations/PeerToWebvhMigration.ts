/**
 * PeerToWebvhMigration - Handles migration from did:peer to did:webvh
 */

import {
  MigrationOptions,
  CostEstimate,
  MigrationStateEnum
} from '../types.js';
import { DIDDocument } from '../../types/index.js';
import { BaseMigration } from './BaseMigration.js';

export class PeerToWebvhMigration extends BaseMigration {
  /**
   * Execute peer → webvh migration
   */
  async executeMigration(
    options: MigrationOptions,
    migrationId: string
  ): Promise<{ targetDid: string; didDocument: DIDDocument }> {
    // Resolve source DID
    const sourceDid = await this.resolveSourceDid(options.sourceDid);

    // Validate domain is provided
    if (!options.domain) {
      throw new Error('Domain is required for webvh migrations');
    }

    await this.updateStateWithRetry(migrationId, {
      state: MigrationStateEnum.IN_PROGRESS,
      currentOperation: 'Creating webvh DID document',
      progress: 30
    });

    // Migrate DID document to webvh. The full result carries the signed DID
    // log and update key pair; the migration result surfaces the document,
    // and callers needing to host the log should use
    // didManager.migrateToDIDWebVH directly with an outputDir.
    const migration = await this.didManager.migrateToDIDWebVH(sourceDid, options.domain);
    const migratedDoc = migration.didDocument;

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
   * Estimate cost for peer → webvh migration
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async estimateCost(_options: MigrationOptions): Promise<CostEstimate> {
    // Web hosting is typically negligible cost
    return {
      storageCost: 0,
      networkFees: 0,
      totalCost: 0,
      currency: 'sats'
    };
  }
}
