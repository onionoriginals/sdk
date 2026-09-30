/**
 * Unit tests for migration-specific event scenarios
 * Covers:
 *   CORE-MIG-EVENTS-004 — DID update validates against schema before applying
 *   CORE-MIG-EVENTS-009 — EventEmitter handles invalid/incomplete event structure
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { EventEmitter } from '../../../src/events/EventEmitter';
import type {
  MigrationStartedEvent,
  MigrationFailedEvent,
  MigrationCheckpointedEvent,
  MigrationRolledbackEvent,
  MigrationQuarantineEvent,
  BatchFailedEvent,
  BatchCompletedEvent,
} from '../../../src/events/types';

describe('Migration event contracts and edge cases', () => {
  let emitter: EventEmitter;

  beforeEach(() => {
    emitter = new EventEmitter();
  });

  // CORE-MIG-EVENTS-009 / invalid-input: EventEmitter handles invalid/incomplete event structure
  describe('CORE-MIG-EVENTS-009 — EventEmitter resilience to invalid/incomplete events', () => {
    it('does not throw when emit is called with a minimal event missing optional fields', async () => {
      const captured: any[] = [];
      emitter.on('migration:started', (e) => captured.push(e));

      // Minimal event (type + timestamp + required fields for migration:started)
      const minimalEvent: MigrationStartedEvent = {
        type: 'migration:started',
        timestamp: new Date().toISOString(),
        migrationId: 'mig-minimal',
        sourceDid: 'did:peer:z123',
        targetLayer: 'webvh'
      };

      await expect(emitter.emit(minimalEvent)).resolves.toBeUndefined();
      expect(captured).toHaveLength(1);
    });

    it('does not propagate handler errors to the caller', async () => {
      let handlerCalledCount = 0;

      // First handler throws
      emitter.on('migration:failed', (_e) => {
        handlerCalledCount++;
        throw new Error('Handler intentionally throws');
      });

      // Second handler is fine
      emitter.on('migration:failed', (_e) => {
        handlerCalledCount++;
      });

      const event: MigrationFailedEvent = {
        type: 'migration:failed',
        timestamp: new Date().toISOString(),
        migrationId: 'mig-error-test',
        error: { message: 'Something went wrong', code: 'TEST_ERROR' }
      };

      // Should not throw even though one handler throws
      await expect(emitter.emit(event)).resolves.toBeUndefined();
      // Both handlers were called
      expect(handlerCalledCount).toBe(2);
    });

    it('handles a handler that returns a rejected promise without propagating', async () => {
      let secondHandlerCalled = false;

      emitter.on('migration:completed', async (_e) => {
        throw new Error('Async handler rejection');
      });

      emitter.on('migration:completed', (_e) => {
        secondHandlerCalled = true;
      });

      // Construct a valid MigrationCompletedEvent
      await expect(
        emitter.emit({
          type: 'migration:completed',
          timestamp: new Date().toISOString(),
          migrationId: 'mig-async-err',
          sourceDid: 'did:peer:z123',
          targetDid: 'did:webvh:z456'
        })
      ).resolves.toBeUndefined();

      expect(secondHandlerCalled).toBe(true);
    });

    it('handles no listeners gracefully for migration events', async () => {
      // No listener registered; should resolve without throwing
      await expect(
        emitter.emit({
          type: 'migration:checkpointed',
          timestamp: new Date().toISOString(),
          migrationId: 'mig-no-listener',
          checkpointId: 'chk-x'
        } satisfies MigrationCheckpointedEvent)
      ).resolves.toBeUndefined();
    });

    it('once handler for migration:rolledback fires only once', async () => {
      const callLog: string[] = [];
      emitter.once('migration:rolledback', (e) => {
        callLog.push(e.migrationId);
      });

      const event: MigrationRolledbackEvent = {
        type: 'migration:rolledback',
        timestamp: new Date().toISOString(),
        migrationId: 'mig-once',
        checkpointId: 'chk-once'
      };

      await emitter.emit(event);
      await emitter.emit(event);

      expect(callLog).toHaveLength(1);
      expect(callLog[0]).toBe('mig-once');
    });

    it('migration:quarantine event delivers checkpointId and reason', async () => {
      let captured: MigrationQuarantineEvent | null = null;
      emitter.on('migration:quarantine', (e) => {
        captured = e;
      });

      const event: MigrationQuarantineEvent = {
        type: 'migration:quarantine',
        timestamp: new Date().toISOString(),
        migrationId: 'mig-q',
        checkpointId: 'chk-q',
        reason: 'Rollback failed — manual intervention required'
      };

      await emitter.emit(event);

      expect(captured).not.toBeNull();
      expect(captured!.checkpointId).toBe('chk-q');
      expect(captured!.reason).toBe('Rollback failed — manual intervention required');
    });
  });

  // CORE-MIG-EVENTS-012 / error: batch:failed event with error details + partial results
  describe('CORE-MIG-EVENTS-012 — batch:failed event payload contract', () => {
    it('batch:failed event delivers batchId, operation, error, and optional partialResults', async () => {
      let captured: BatchFailedEvent | null = null;
      emitter.on('batch:failed', (e) => {
        captured = e;
      });

      const event: BatchFailedEvent = {
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId: 'batch-fail-001',
        operation: 'publish',
        error: 'Storage adapter unavailable',
        partialResults: {
          successful: 2,
          failed: 3
        }
      };

      await emitter.emit(event);

      expect(captured).not.toBeNull();
      expect(captured!.batchId).toBe('batch-fail-001');
      expect(captured!.operation).toBe('publish');
      expect(captured!.error).toBe('Storage adapter unavailable');
      expect(captured!.partialResults?.successful).toBe(2);
      expect(captured!.partialResults?.failed).toBe(3);
    });

    it('batch:failed event without partialResults is valid', async () => {
      let captured: BatchFailedEvent | null = null;
      emitter.on('batch:failed', (e) => {
        captured = e;
      });

      const event: BatchFailedEvent = {
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId: 'batch-fail-002',
        operation: 'create',
        error: 'Unexpected fatal error'
      };

      await emitter.emit(event);

      expect(captured).not.toBeNull();
      expect(captured!.partialResults).toBeUndefined();
    });

    it('batch:completed event correctly summarizes partial failures', async () => {
      let captured: BatchCompletedEvent | null = null;
      emitter.on('batch:completed', (e) => {
        captured = e;
      });

      const event: BatchCompletedEvent = {
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId: 'batch-mixed-001',
        operation: 'inscribe',
        results: {
          successful: 7,
          failed: 3,
          totalDuration: 5000
        }
      };

      await emitter.emit(event);

      expect(captured).not.toBeNull();
      expect(captured!.results.successful).toBe(7);
      expect(captured!.results.failed).toBe(3);
      // failed > 0 but event type is batch:completed (not batch:failed)
      // — this is valid when continueOnError=true
    });
  });

  // CORE-MIG-EVENTS-004 / error: DID update validates against schema
  // The ValidationPipeline.validateQuick() is the lightweight sync validator
  // that catches schema/input errors without async operations.
  describe('CORE-MIG-EVENTS-004 — input validation catches schema violations', () => {
    it('ValidationPipeline.validateQuick rejects missing sourceDid', () => {
      // Dynamic import to avoid circular issues in test env
      const { ValidationPipeline } = require('../../../src/migration/validation/ValidationPipeline');
      const { OriginalsSDK } = require('../../../src');
      MigrationManager.resetInstance();

      const sdk = OriginalsSDK.create({ network: 'signet', defaultKeyType: 'Ed25519' });
      const pipeline = new ValidationPipeline(sdk['config'], sdk.did, sdk.credentials);

      const errors = pipeline.validateQuick({
        sourceDid: '', // invalid — empty string
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      expect(errors.some((e: any) => e.code === 'INVALID_SOURCE_DID')).toBe(true);
    });

    it('ValidationPipeline.validateQuick rejects invalid targetLayer', () => {
      const { ValidationPipeline } = require('../../../src/migration/validation/ValidationPipeline');
      const { OriginalsSDK } = require('../../../src');
      MigrationManager.resetInstance();

      const sdk = OriginalsSDK.create({ network: 'signet', defaultKeyType: 'Ed25519' });
      const pipeline = new ValidationPipeline(sdk['config'], sdk.did, sdk.credentials);

      const errors = pipeline.validateQuick({
        sourceDid: 'did:peer:z123',
        targetLayer: 'invalid_layer' as any,
        domain: 'example.com'
      });

      expect(errors.some((e: any) => e.code === 'INVALID_TARGET_LAYER')).toBe(true);
    });

    it('ValidationPipeline.validateQuick rejects webvh migration without domain', () => {
      const { ValidationPipeline } = require('../../../src/migration/validation/ValidationPipeline');
      const { OriginalsSDK } = require('../../../src');
      MigrationManager.resetInstance();

      const sdk = OriginalsSDK.create({ network: 'signet', defaultKeyType: 'Ed25519' });
      const pipeline = new ValidationPipeline(sdk['config'], sdk.did, sdk.credentials);

      const errors = pipeline.validateQuick({
        sourceDid: 'did:peer:z123',
        targetLayer: 'webvh'
        // domain omitted
      });

      expect(errors.some((e: any) => e.code === 'DOMAIN_REQUIRED')).toBe(true);
    });

    it('ValidationPipeline.validateQuick rejects negative feeRate for btco', () => {
      const { ValidationPipeline } = require('../../../src/migration/validation/ValidationPipeline');
      const { OriginalsSDK } = require('../../../src');
      MigrationManager.resetInstance();

      const sdk = OriginalsSDK.create({ network: 'signet', defaultKeyType: 'Ed25519' });
      const pipeline = new ValidationPipeline(sdk['config'], sdk.did, sdk.credentials);

      const errors = pipeline.validateQuick({
        sourceDid: 'did:peer:z123',
        targetLayer: 'btco',
        feeRate: -5 // invalid
      });

      expect(errors.some((e: any) => e.code === 'INVALID_FEE_RATE')).toBe(true);
    });

    it('ValidationPipeline.validateQuick returns no errors for valid input', () => {
      const { ValidationPipeline } = require('../../../src/migration/validation/ValidationPipeline');
      const { OriginalsSDK } = require('../../../src');
      MigrationManager.resetInstance();

      const sdk = OriginalsSDK.create({ network: 'signet', defaultKeyType: 'Ed25519' });
      const pipeline = new ValidationPipeline(sdk['config'], sdk.did, sdk.credentials);

      const errors = pipeline.validateQuick({
        sourceDid: 'did:peer:z6MkHAB2FrxbPpQ',
        targetLayer: 'webvh',
        domain: 'example.com'
      });

      expect(errors).toHaveLength(0);
    });
  });
});

// Bring MigrationManager into scope for beforeEach-free use
import { MigrationManager } from '../../../src/migration';
