/**
 * Event types for the Originals SDK asset lifecycle operations
 * 
 * All events follow a consistent structure:
 * - type: Namespaced event name (e.g., 'asset:created')
 * - timestamp: ISO 8601 timestamp of when the event occurred
 * - Specific payload data relevant to the event
 */

import { LayerType } from '../types/index.js';

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
  /**
   * Best-effort pre-move sat holder; omitted when no owner index is available
   * (never fabricated). Ownership is the sat itself, read live from the chain;
   * Authority to sign changes is separate (P9.11, P9.12): a sat move does not grant
   * the recipient authority to append to the asset history.
   */
  from?: string;
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
 * Emitted when credential issuance was skipped or failed during a publish.
 * The publish itself still succeeds; this event lets callers detect that the
 * asset carries no publication credential and why.
 */
export interface CredentialSkippedEvent extends BaseEvent {
  type: 'credential:skipped';
  asset: {
    id: string;
  };
  reason: string;
  message: string;
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
 * Emitted when an operation mints a new key but no keyStore holds it: the
 * DID exists but the key is unusable later (e.g. a webvh migration's update key).
 */
export interface KeyUnpersistedEvent extends BaseEvent {
  type: 'key:unpersisted';
  asset: {
    id: string;
  };
  did: string;
  /**
   * The verification method whose private key is unpersisted, when the DID
   * alone does not identify it.
   */
  verificationMethod?: string;
}

/**
 * Emitted when a did:webvh log is signed but no storage adapter is
 * configured to host it: the DID exists but does not resolve.
 */
export interface DidLogUnhostedEvent extends BaseEvent {
  type: 'did:log-unhosted';
  did: string;
  /** Why the signed log was not hosted: no adapter configured, or the log had no entries to write. */
  reason: 'NO_STORAGE_ADAPTER' | 'EMPTY_LOG';
}

/**
 * Emitted when the controller rotates the did:btco keys by reinscribing an
 * updated document (same id, new verification method) on the same sat —
 * a cooperative rotation, signed by the outgoing controller.
 */
export interface KeyRotatedEvent extends BaseEvent {
  type: 'key:rotated';
  asset: {
    id: string;
  };
  did: string;
  inscriptionId: string;
}

/**
 * Emitted (#407 phase 3) after a did:btco authorship append is inscribed on the
 * anchoring sat, making the on-chain log current for that event.
 */
export interface ResourceInscribedEvent extends BaseEvent {
  type: 'resource:inscribed';
  asset: { id: string };
  did: string;
  inscriptionId: string;
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
  | CredentialSkippedEvent
  | VerificationCompletedEvent
  | BatchStartedEvent
  | BatchCompletedEvent
  | BatchFailedEvent
  | BatchProgressEvent
  | ResourceVersionCreatedEvent
  | KeyUnpersistedEvent
  | DidLogUnhostedEvent
  | ResourceInscribedEvent
  | KeyRotatedEvent;

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
  'credential:skipped': CredentialSkippedEvent;
  'verification:completed': VerificationCompletedEvent;
  'batch:started': BatchStartedEvent;
  'batch:completed': BatchCompletedEvent;
  'batch:failed': BatchFailedEvent;
  'batch:progress': BatchProgressEvent;
  'resource:version:created': ResourceVersionCreatedEvent;
  'key:unpersisted': KeyUnpersistedEvent;
  'did:log-unhosted': DidLogUnhostedEvent;
  'resource:inscribed': ResourceInscribedEvent;
  'key:rotated': KeyRotatedEvent;
}
