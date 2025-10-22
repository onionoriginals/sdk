/**
 * Migration module exports
 * Provides DID layer migration capabilities with validation, checkpoints, and rollbacks
 */

export { MigrationManager } from './MigrationManager';
export * from './types';

// Validators
export { ValidationPipeline } from './validation/ValidationPipeline';
export { DIDCompatibilityValidator } from './validation/DIDCompatibilityValidator';
export { CredentialValidator } from './validation/CredentialValidator';
export { StorageValidator } from './validation/StorageValidator';
export { LifecycleValidator } from './validation/LifecycleValidator';
export { BitcoinValidator } from './validation/BitcoinValidator';

// Checkpoint and Rollback
export { CheckpointManager } from './checkpoint/CheckpointManager';
export { CheckpointStorage } from './checkpoint/CheckpointStorage';
export { RollbackManager } from './rollback/RollbackManager';

// State Management
export { StateTracker } from './state/StateTracker';
export { StateMachine } from './state/StateMachine';

// Audit
export { AuditLogger } from './audit/AuditLogger';

// Operations
export { BaseMigration } from './operations/BaseMigration';
export { PeerToWebvhMigration } from './operations/PeerToWebvhMigration';
export { WebvhToBtcoMigration } from './operations/WebvhToBtcoMigration';
export { PeerToBtcoMigration } from './operations/PeerToBtcoMigration';
