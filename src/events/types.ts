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
  domain: string;
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
  | ResourceVersionCreatedEvent;

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
  'resource:version:created': ResourceVersionCreatedEvent;
}
