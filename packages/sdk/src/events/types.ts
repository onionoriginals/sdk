/**
 * Event types for the Originals SDK asset lifecycle operations
 * 
 * All events follow a consistent structure:
 * - type: Namespaced event name (e.g., 'asset:created')
 * - timestamp: ISO 8601 timestamp of when the event occurred
 * - Specific payload data relevant to the event
 */

import { LayerType } from '../types';

/**
 * Base event interface that all events extend
 */
export interface BaseEvent {
  type: string;
  timestamp: string;
}

/**
 * Emitted when a new asset is created
 */
export interface AssetCreatedEvent extends BaseEvent {
  type: 'asset:created';
  asset: {
    id: string;
    layer: LayerType;
    resourceCount: number;
    createdAt: string;
  };
}

/**
 * Emitted when an asset migrates between layers
 * 
 * Note: The `details` field is populated differently based on the target layer:
 * - For did:webvh migrations: `details` is undefined (web publishing has no transaction details)
 * - For did:btco migrations: `details` includes Bitcoin transaction information
 *   (transactionId, inscriptionId, satoshi, commitTxId, revealTxId, feeRate)
 */
export interface AssetMigratedEvent extends BaseEvent {
  type: 'asset:migrated';
  asset: {
    id: string;
    fromLayer: LayerType;
    toLayer: LayerType;
  };
  details?: {
    transactionId?: string;
    inscriptionId?: string;
    satoshi?: string;
    commitTxId?: string;
    revealTxId?: string;
    feeRate?: number;
  };
}

/**
 * Emitted when an asset's ownership is transferred
 */
export interface AssetTransferredEvent extends BaseEvent {
  type: 'asset:transferred';
  asset: {
    id: string;
    layer: LayerType;
  };
  from: string;
  to: string;
  transactionId: string;
}

/**
 * Emitted when a resource is published to web storage
 */
export interface ResourcePublishedEvent extends BaseEvent {
  type: 'resource:published';
  asset: {
    id: string;
  };
  resource: {
    id: string;
    url: string;
    contentType: string;
    hash: string;
  };
  publisherDid: string;
}

/**
 * Emitted when a verifiable credential is issued for an asset
 */
export interface CredentialIssuedEvent extends BaseEvent {
  type: 'credential:issued';
  asset: {
    id: string;
  };
  credential: {
    type: string[];
    issuer: string;
  };
}

/**
 * Emitted when a new resource version is created
 */
export interface ResourceVersionCreatedEvent extends BaseEvent {
  type: 'resource:version:created';
  asset: {
    id: string;
  };
  resource: {
    id: string;
    fromVersion: number;
    toVersion: number;
    fromHash: string;
    toHash: string;
  };
  changes?: string;
}

/**
 * Emitted when asset verification is completed
 */
export interface VerificationCompletedEvent extends BaseEvent {
  type: 'verification:completed';
  asset: {
    id: string;
  };
  result: boolean;
  checks?: {
    didDocument: boolean;
    resources: boolean;
    credentials: boolean;
  };
}

/**
 * Emitted when a batch operation starts
 */
export interface BatchStartedEvent extends BaseEvent {
  type: 'batch:started';
  operation: 'create' | 'publish' | 'inscribe' | 'transfer';
  batchId: string;
  itemCount: number;
}

/**
 * Emitted when a batch operation completes successfully
 */
export interface BatchCompletedEvent extends BaseEvent {
  type: 'batch:completed';
  batchId: string;
  operation: string;
  results: {
    successful: number;
    failed: number;
    totalDuration: number;
    costSavings?: {
      amount: number;
      percentage: number;
    };
  };
}

/**
 * Emitted when a batch operation fails
 */
export interface BatchFailedEvent extends BaseEvent {
  type: 'batch:failed';
  batchId: string;
  operation: string;
  error: string;
  partialResults?: {
    successful: number;
    failed: number;
  };
}

/**
 * Emitted when a migration starts
 */
export interface MigrationStartedEvent extends BaseEvent {
  type: 'migration:started';
  migrationId: string;
  sourceDid: string;
  targetLayer: string;
}

/**
 * Emitted when migration validation completes
 */
export interface MigrationValidatedEvent extends BaseEvent {
  type: 'migration:validated';
  migrationId: string;
  valid: boolean;
}

/**
 * Emitted when migration checkpoint is created
 */
export interface MigrationCheckpointedEvent extends BaseEvent {
  type: 'migration:checkpointed';
  migrationId: string;
  checkpointId: string;
}

/**
 * Emitted when migration enters in-progress state
 */
export interface MigrationInProgressEvent extends BaseEvent {
  type: 'migration:in_progress';
  migrationId: string;
  currentOperation: string;
  progress: number;
}

/**
 * Emitted when migration enters anchoring state (Bitcoin)
 */
export interface MigrationAnchoringEvent extends BaseEvent {
  type: 'migration:anchoring';
  migrationId: string;
  transactionId?: string;
}

/**
 * Emitted when migration completes successfully
 */
export interface MigrationCompletedEvent extends BaseEvent {
  type: 'migration:completed';
  migrationId: string;
  sourceDid: string;
  targetDid: string;
}

/**
 * Emitted when migration fails
 */
export interface MigrationFailedEvent extends BaseEvent {
  type: 'migration:failed';
  migrationId: string;
  error: any;
}

/**
 * Emitted when migration is rolled back
 */
export interface MigrationRolledbackEvent extends BaseEvent {
  type: 'migration:rolledback';
  migrationId: string;
  checkpointId: string;
}

/**
 * Emitted when migration enters quarantine state
 */
export interface MigrationQuarantineEvent extends BaseEvent {
  type: 'migration:quarantine';
  migrationId: string;
  checkpointId: string;
  reason: string;
}

/**
 * Emitted during batch operations to report progress
 */
export interface BatchProgressEvent extends BaseEvent {
  type: 'batch:progress';
  batchId: string;
  operation: string;
  progress: number;
  completed: number;
  failed: number;
  total: number;
}

/**
 * Union type of all possible events
 */
export type OriginalsEvent =
  | AssetCreatedEvent
  | AssetMigratedEvent
  | AssetTransferredEvent
  | ResourcePublishedEvent
  | CredentialIssuedEvent
  | VerificationCompletedEvent
  | BatchStartedEvent
  | BatchCompletedEvent
  | BatchFailedEvent
  | BatchProgressEvent
  | ResourceVersionCreatedEvent
  | MigrationStartedEvent
  | MigrationValidatedEvent
  | MigrationCheckpointedEvent
  | MigrationInProgressEvent
  | MigrationAnchoringEvent
  | MigrationCompletedEvent
  | MigrationFailedEvent
  | MigrationRolledbackEvent
  | MigrationQuarantineEvent;

/**
 * Event handler function type
 */
export type EventHandler<T extends OriginalsEvent = OriginalsEvent> = (event: T) => void | Promise<void>;

/**
 * Map of event types to their specific event interfaces
 */
export interface EventTypeMap {
  'asset:created': AssetCreatedEvent;
  'asset:migrated': AssetMigratedEvent;
  'asset:transferred': AssetTransferredEvent;
  'resource:published': ResourcePublishedEvent;
  'credential:issued': CredentialIssuedEvent;
  'verification:completed': VerificationCompletedEvent;
  'batch:started': BatchStartedEvent;
  'batch:completed': BatchCompletedEvent;
  'batch:failed': BatchFailedEvent;
  'batch:progress': BatchProgressEvent;
  'resource:version:created': ResourceVersionCreatedEvent;
  'migration:started': MigrationStartedEvent;
  'migration:validated': MigrationValidatedEvent;
  'migration:checkpointed': MigrationCheckpointedEvent;
  'migration:in_progress': MigrationInProgressEvent;
  'migration:anchoring': MigrationAnchoringEvent;
  'migration:completed': MigrationCompletedEvent;
  'migration:failed': MigrationFailedEvent;
  'migration:rolledback': MigrationRolledbackEvent;
  'migration:quarantine': MigrationQuarantineEvent;
}
