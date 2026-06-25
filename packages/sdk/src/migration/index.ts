/**
 * Migration module exports
 * Provides DID layer migration capabilities with validation, checkpoints, and rollbacks
 */

export { MigrationManager } from './MigrationManager.js';
export * from './types.js';

// Validators
export { ValidationPipeline } from './validation/ValidationPipeline.js';
export { DIDCompatibilityValidator } from './validation/DIDCompatibilityValidator.js';
export { CredentialValidator } from './validation/CredentialValidator.js';
export { StorageValidator } from './validation/StorageValidator.js';
export { LifecycleValidator } from './validation/LifecycleValidator.js';
export { BitcoinValidator } from './validation/BitcoinValidator.js';

// Checkpoint and Rollback
export { CheckpointManager } from './checkpoint/CheckpointManager.js';
export { CheckpointStorage } from './checkpoint/CheckpointStorage.js';
export { RollbackManager } from './rollback/RollbackManager.js';

// State Management
export { StateTracker } from './state/StateTracker.js';
export { StateMachine } from './state/StateMachine.js';

// Audit
export { AuditLogger } from './audit/AuditLogger.js';

// Operations
export { BaseMigration } from './operations/BaseMigration.js';
export { PeerToWebvhMigration } from './operations/PeerToWebvhMigration.js';
export { WebvhToBtcoMigration } from './operations/WebvhToBtcoMigration.js';
export { PeerToBtcoMigration } from './operations/PeerToBtcoMigration.js';
