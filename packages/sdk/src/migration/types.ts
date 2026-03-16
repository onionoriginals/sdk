/**
 * Migration system types and interfaces
 * Defines all types used across the migration infrastructure
 */

import { DIDDocument, VerifiableCredential, LayerType } from '../types';

/**
 * DID layer types (short form used in migration system)
 *
 * `DIDLayer` uses short names ('peer', 'webvh', 'btco') while
 * `LayerType` uses DID method prefixes ('did:peer', 'did:webvh', 'did:btco').
 * Both represent the same three-layer concept. Use the conversion helpers
 * `layerToLayerType()` and `layerTypeToLayer()` to bridge between them.
 */
export type DIDLayer = 'peer' | 'webvh' | 'btco';

const LAYER_TO_LAYER_TYPE: Record<DIDLayer, LayerType> = {
  peer: 'did:peer',
  webvh: 'did:webvh',
  btco: 'did:btco',
};

const LAYER_TYPE_TO_LAYER: Record<LayerType, DIDLayer> = {
  'did:peer': 'peer',
  'did:webvh': 'webvh',
  'did:btco': 'btco',
};

/**
 * Convert a short DIDLayer value to the full LayerType form.
 * Throws if the input is not a valid DIDLayer.
 */
export function layerToLayerType(layer: DIDLayer): LayerType {
  const result = LAYER_TO_LAYER_TYPE[layer];
  if (!result) {
    throw new Error(`Invalid DIDLayer: '${layer}'. Must be one of: peer, webvh, btco`);
  }
  return result;
}

/**
 * Convert a full LayerType value to the short DIDLayer form.
 * Throws if the input is not a valid LayerType.
 */
export function layerTypeToLayer(layerType: LayerType): DIDLayer {
  const result = LAYER_TYPE_TO_LAYER[layerType];
  if (!result) {
    throw new Error(`Invalid LayerType: '${layerType}'. Must be one of: did:peer, did:webvh, did:btco`);
  }
  return result;
}

/**
 * Check if a string is a valid DIDLayer value.
 */
export function isDIDLayer(value: string): value is DIDLayer {
  return value === 'peer' || value === 'webvh' || value === 'btco';
}

/**
 * Migration state enum
 */
export enum MigrationStateEnum {
  PENDING = 'pending',           // Migration queued
  VALIDATING = 'validating',     // Running validation pipeline
  CHECKPOINTED = 'checkpointed', // Checkpoint created
  IN_PROGRESS = 'in_progress',   // Active migration
  ANCHORING = 'anchoring',       // Bitcoin anchoring (btco only)
  COMPLETED = 'completed',       // Successfully completed
  FAILED = 'failed',             // Failed, rollback initiated
  ROLLED_BACK = 'rolled_back',   // Rolled back successfully
  QUARANTINED = 'quarantined'    // Rollback failed, needs manual intervention
}

/**
 * Migration error types
 */
export enum MigrationErrorType {
  VALIDATION_ERROR = 'validation_error',     // Pre-migration validation failed
  STORAGE_ERROR = 'storage_error',           // Storage adapter failure
  BITCOIN_ERROR = 'bitcoin_error',           // Bitcoin anchoring failed
  CREDENTIAL_ERROR = 'credential_error',     // Credential re-issuance failed
  NETWORK_ERROR = 'network_error',           // Network/connectivity failure
  ROLLBACK_ERROR = 'rollback_error',         // Rollback failed (critical)
  TIMEOUT_ERROR = 'timeout_error',           // Operation timeout
  UNKNOWN_ERROR = 'unknown_error'            // Unexpected error
}

/**
 * Migration options for initiating a migration
 */
export interface MigrationOptions {
  sourceDid: string;                    // Source DID to migrate from
  targetLayer: DIDLayer;                // Target layer
  credentialIssuance?: boolean;         // Require VC issuance (default: true)
  batchMode?: boolean;                  // Batch operation flag
  partialMode?: {                       // For large files
    chunkSize: number;                  // Bytes per chunk
    resumable: boolean;                 // Support resume
  };
  estimateCostOnly?: boolean;           // Return cost estimate without migrating
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;       // Additional migration metadata
  domain?: string;                      // For webvh migrations
  satoshi?: string;                     // For btco migrations
  feeRate?: number;                     // For btco migrations
}

/**
 * Batch migration options
 */
export interface BatchMigrationOptions extends MigrationOptions {
  maxConcurrent?: number;               // Max concurrent migrations
  continueOnError?: boolean;            // Continue batch if individual migration fails
}

/**
 * Cost estimate for a migration
 */
export interface CostEstimate {
  storageCost: number;                  // Storage cost in currency units
  networkFees: number;                  // Bitcoin network fees (btco only)
  totalCost: number;                    // Total cost
  currency: string;                     // Currency unit (e.g., 'sats', 'USD')
}

/**
 * Validation error
 */
export interface ValidationError {
  code: string;
  message: string;
  field?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details?: any;
}

/**
 * Validation warning
 */
export interface ValidationWarning {
  code: string;
  message: string;
  field?: string;
}

/**
 * Migration validation result
 */
export interface MigrationValidationResult {
  valid: boolean;
  errors: ValidationError[];            // Blocking errors
  warnings: ValidationWarning[];        // Non-blocking issues
  estimatedCost: CostEstimate;
  estimatedDuration: number;            // milliseconds
}

/**
 * Migration checkpoint data
 */
export interface MigrationCheckpoint {
  checkpointId?: string;
  migrationId: string;
  timestamp: number;
  sourceDid: string;
  sourceLayer: DIDLayer;
  didDocument: DIDDocument;
  credentials: VerifiableCredential[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  storageReferences: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lifecycleState: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ownershipProofs: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>;
}

/**
 * Rollback result
 */
export interface RollbackResult {
  success: boolean;
  migrationId: string;
  checkpointId?: string;
  restoredState: MigrationStateEnum;
  duration: number;                     // milliseconds
  errors?: MigrationError[];
}

/**
 * Migration state tracking
 */
export interface MigrationState {
  migrationId: string;
  state: MigrationStateEnum;
  sourceDid: string;
  sourceLayer: DIDLayer;
  targetDid?: string;
  targetLayer: DIDLayer;
  progress: number;                     // 0-100
  currentOperation: string;
  startTime: number;
  endTime?: number;
  error?: MigrationError;
  checkpointId?: string;
}

/**
 * Migration error details
 */
export interface MigrationError {
  type: MigrationErrorType;
  code: string;
  message: string;
  technicalDetails?: string;
  suggestedRecovery?: string;
  migrationId?: string;
  sourceDid?: string;
  targetDid?: string;
  timestamp: number;
  stack?: string;
}

/**
 * Migration audit record
 */
export interface MigrationAuditRecord {
  migrationId: string;
  timestamp: number;
  initiator: string;                    // User/system identifier
  sourceDid: string;
  sourceLayer: DIDLayer;
  targetDid: string | null;             // null if failed before creation
  targetLayer: DIDLayer;
  finalState: MigrationStateEnum;
  validationResults: MigrationValidationResult;
  costActual: CostEstimate;             // Actual costs incurred
  duration: number;                     // milliseconds
  checkpointId?: string;                 // For rollback reference
  errors: MigrationError[];             // Any errors encountered
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: Record<string, any>;        // Custom metadata
  signature?: string;                   // Cryptographic signature
}

/**
 * Migration result
 */
export interface MigrationResult {
  migrationId: string;
  success: boolean;
  sourceDid: string;
  targetDid?: string;
  sourceLayer: DIDLayer;
  targetLayer: DIDLayer;
  state: MigrationStateEnum;
  duration: number;
  cost: CostEstimate;
  auditRecord?: MigrationAuditRecord;  // Optional - undefined when AuditLogger disabled (v1.0)
  error?: MigrationError;
}

/**
 * Batch migration result
 */
export interface BatchMigrationResult {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  results: Map<string, MigrationResult>;  // sourceDid → result
  overallProgress: number;                // 0-100
  startTime: number;
  endTime?: number;
  errors: MigrationError[];
}

/**
 * Partial migration progress
 */
export interface PartialMigrationProgress {
  totalChunks: number;
  completedChunks: number;
  currentChunk: number;
  bytesTransferred: number;
  totalBytes: number;
  percentComplete: number;
  estimatedTimeRemaining: number;       // milliseconds
}

/**
 * Migration event types
 */
export type MigrationEventType =
  | 'migration:started'
  | 'migration:validated'
  | 'migration:checkpointed'
  | 'migration:in_progress'
  | 'migration:anchoring'
  | 'migration:completed'
  | 'migration:failed'
  | 'migration:rolledback'
  | 'migration:quarantine'
  | 'batch:progress';

/**
 * Migration event payload
 */
export interface MigrationEvent {
  type: MigrationEventType;
  migrationId: string;
  timestamp: number;
  state: MigrationStateEnum;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

/**
 * Storage migration context
 */
export interface StorageMigrationContext {
  sourceDid: string;
  targetDid: string;
  sourceLayer: DIDLayer;
  targetLayer: DIDLayer;
  resources: Array<{
    id: string;
    hash: string;
    contentType: string;
    size: number;
    url?: string;
  }>;
}

/**
 * Bitcoin anchoring context
 */
export interface BitcoinAnchoringContext {
  didDocument: DIDDocument;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  migrationMetadata: Record<string, any>;
  network: 'mainnet' | 'testnet' | 'signet';
  feeRate?: number;
  satoshi?: string;
}

/**
 * Lifecycle migration context
 */
export interface LifecycleMigrationContext {
  sourceDid: string;
  targetDid: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentState: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eventHistory: any[];
  migrationId: string;
}

/**
 * Validator interface
 */
export interface IValidator {
  validate(options: MigrationOptions): Promise<MigrationValidationResult>;
}

/**
 * Checkpoint manager interface
 */
export interface ICheckpointManager {
  createCheckpoint(migrationId: string, options: MigrationOptions): Promise<MigrationCheckpoint>;
  getCheckpoint(checkpointId: string): Promise<MigrationCheckpoint | null>;
  deleteCheckpoint(checkpointId: string): Promise<void>;
}

/**
 * Rollback manager interface
 */
export interface IRollbackManager {
  rollback(migrationId: string, checkpointId: string): Promise<RollbackResult>;
}

/**
 * State tracker interface
 */
export interface IStateTracker {
  createMigration(options: MigrationOptions): Promise<MigrationState>;
  updateState(migrationId: string, updates: Partial<MigrationState>): Promise<void>;
  getState(migrationId: string): Promise<MigrationState | null>;
  queryStates(filters: Partial<MigrationState>): Promise<MigrationState[]>;
}

/**
 * Audit logger interface
 */
export interface IAuditLogger {
  logMigration(record: MigrationAuditRecord): Promise<void>;
  getMigrationHistory(did: string): Promise<MigrationAuditRecord[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSystemMigrationLogs(filters: any): Promise<MigrationAuditRecord[]>;
}
