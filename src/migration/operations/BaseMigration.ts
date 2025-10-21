/**
 * BaseMigration - Base class for all migration operations
 */

import {
  MigrationOptions,
  MigrationResult,
  MigrationError,
  MigrationErrorType,
  MigrationStateEnum,
  CostEstimate
} from '../types';
import { OriginalsConfig, DIDDocument } from '../../types';
import { DIDManager } from '../../did/DIDManager';
import { CredentialManager } from '../../vc/CredentialManager';
import { StateTracker } from '../state/StateTracker';
import { EventEmitter } from '../../events/EventEmitter';

export abstract class BaseMigration {
  protected eventEmitter: EventEmitter;

  constructor(
    protected config: OriginalsConfig,
    protected didManager: DIDManager,
    protected credentialManager: CredentialManager,
    protected stateTracker: StateTracker
  ) {
    this.eventEmitter = new EventEmitter();
  }

  /**
   * Execute the migration (to be implemented by subclasses)
   */
  abstract executeMigration(
    options: MigrationOptions,
    migrationId: string
  ): Promise<{ targetDid: string; didDocument: DIDDocument }>;

  /**
   * Get estimated cost (to be implemented by subclasses)
   */
  abstract estimateCost(options: MigrationOptions): Promise<CostEstimate>;

  /**
   * Emit migration event
   */
  protected async emitEvent(type: string, data: any): Promise<void> {
    try {
      await this.eventEmitter.emit({
        type,
        timestamp: new Date().toISOString(),
        ...data
      });
    } catch (error) {
      console.error(`Error emitting event ${type}:`, error);
    }
  }

  /**
   * Create migration error
   */
  protected createError(
    type: MigrationErrorType,
    code: string,
    message: string,
    migrationId?: string,
    details?: any
  ): MigrationError {
    return {
      type,
      code,
      message,
      technicalDetails: details ? JSON.stringify(details) : undefined,
      migrationId,
      timestamp: Date.now()
    };
  }

  /**
   * Update migration state with error handling
   */
  protected async updateStateWithRetry(
    migrationId: string,
    updates: any,
    maxRetries: number = 3
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.stateTracker.updateState(migrationId, updates);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < maxRetries - 1) {
          // Exponential backoff: 100ms, 200ms, 400ms
          await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError || new Error('Failed to update state after retries');
  }

  /**
   * Resolve source DID document
   */
  protected async resolveSourceDid(sourceDid: string): Promise<DIDDocument> {
    const didDocument = await this.didManager.resolveDID(sourceDid);
    if (!didDocument) {
      throw new Error(`Could not resolve source DID: ${sourceDid}`);
    }
    return didDocument;
  }

  /**
   * Extract layer from DID
   */
  protected extractLayer(did: string): 'peer' | 'webvh' | 'btco' {
    if (did.startsWith('did:peer:')) return 'peer';
    if (did.startsWith('did:webvh:')) return 'webvh';
    if (did.startsWith('did:btco:')) return 'btco';
    throw new Error(`Unsupported DID method: ${did}`);
  }
}
