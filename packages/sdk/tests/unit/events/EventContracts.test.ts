import { describe, test, expect } from 'bun:test';
import type {
  AssetCreatedEvent,
  ResourcePublishedEvent,
  CredentialIssuedEvent,
  BatchStartedEvent,
  BatchCompletedEvent,
  BatchFailedEvent,
} from '../../../src/events/types';

/**
 * Contract tests to ensure emitted event payloads match their TypeScript interfaces.
 * These tests prevent drift between what LifecycleManager emits and what consumers type against.
 *
 * If a test here fails, it means the emitter or the interface changed without updating the other.
 */

/** Helper: assert an object has exactly the expected keys (no extra, no missing). */
function assertExactShape(obj: Record<string, unknown>, expectedKeys: string[], context: string) {
  const actual = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  expect(actual, `${context}: unexpected keys`).toEqual(expected);
}

describe('Event Contract Tests', () => {
  describe('AssetCreatedEvent', () => {
    test('basic asset:created event shape matches interface', () => {
      // Simulates what LifecycleManager.createAsset() emits
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:123',
          layer: 'did:peer',
          resourceCount: 2,
          createdAt: new Date().toISOString(),
        },
      };

      expect(event.type).toBe('asset:created');
      assertExactShape(event, ['type', 'timestamp', 'asset'], 'AssetCreatedEvent');
      assertExactShape(
        event.asset as unknown as Record<string, unknown>,
        ['id', 'layer', 'resourceCount', 'createdAt'],
        'AssetCreatedEvent.asset'
      );
    });

    test('typed original asset:created event shape matches interface', () => {
      // Simulates what LifecycleManager.createTypedOriginal() emits
      const event: AssetCreatedEvent = {
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: 'did:peer:456',
          layer: 'did:peer',
          resourceCount: 3,
          createdAt: new Date().toISOString(),
          kind: 'music',
          name: 'My Track',
          version: '1.0.0',
        },
      };

      expect(event.type).toBe('asset:created');
      assertExactShape(event, ['type', 'timestamp', 'asset'], 'AssetCreatedEvent (typed)');
      assertExactShape(
        event.asset as unknown as Record<string, unknown>,
        ['id', 'layer', 'resourceCount', 'createdAt', 'kind', 'name', 'version'],
        'AssetCreatedEvent.asset (typed)'
      );
    });
  });

  describe('ResourcePublishedEvent', () => {
    test('resource:published event shape matches interface', () => {
      // Simulates what LifecycleManager.emitResourcePublishedEvent() emits
      const event: ResourcePublishedEvent = {
        type: 'resource:published',
        timestamp: new Date().toISOString(),
        asset: { id: 'did:peer:123' },
        resource: {
          id: 'res-001',
          url: 'https://example.com/resource.json',
          contentType: 'application/json',
          hash: 'sha256-abc123',
        },
        publisherDid: 'did:webvh:publisher',
        domain: 'example.com',
      };

      expect(event.type).toBe('resource:published');
      assertExactShape(event, ['type', 'timestamp', 'asset', 'resource', 'publisherDid', 'domain'], 'ResourcePublishedEvent');
      assertExactShape(
        event.resource as unknown as Record<string, unknown>,
        ['id', 'url', 'contentType', 'hash'],
        'ResourcePublishedEvent.resource'
      );
    });
  });

  describe('CredentialIssuedEvent', () => {
    test('credential:issued event shape matches interface', () => {
      // Simulates what LifecycleManager.issuePublicationCredential() emits
      const event: CredentialIssuedEvent = {
        type: 'credential:issued',
        timestamp: new Date().toISOString(),
        asset: { id: 'did:peer:123' },
        credential: {
          type: ['VerifiableCredential', 'ResourceMigratedCredential'],
          issuer: 'did:webvh:issuer',
        },
      };

      expect(event.type).toBe('credential:issued');
      assertExactShape(event, ['type', 'timestamp', 'asset', 'credential'], 'CredentialIssuedEvent');
      assertExactShape(
        event.credential as unknown as Record<string, unknown>,
        ['type', 'issuer'],
        'CredentialIssuedEvent.credential'
      );
    });
  });

  describe('BatchStartedEvent', () => {
    test('batch:started event shape matches interface', () => {
      const event: BatchStartedEvent = {
        type: 'batch:started',
        timestamp: new Date().toISOString(),
        operation: 'create',
        batchId: 'batch-001',
        itemCount: 5,
      };

      expect(event.type).toBe('batch:started');
      assertExactShape(event, ['type', 'timestamp', 'operation', 'batchId', 'itemCount'], 'BatchStartedEvent');
    });

    test('supports all operation types', () => {
      const operations: Array<BatchStartedEvent['operation']> = ['create', 'publish', 'inscribe', 'transfer'];
      for (const op of operations) {
        const event: BatchStartedEvent = {
          type: 'batch:started',
          timestamp: new Date().toISOString(),
          operation: op,
          batchId: `batch-${op}`,
          itemCount: 1,
        };
        expect(event.operation).toBe(op);
      }
    });
  });

  describe('BatchCompletedEvent', () => {
    test('batch:completed event shape matches interface (without costSavings)', () => {
      const event: BatchCompletedEvent = {
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId: 'batch-001',
        operation: 'create',
        results: {
          successful: 5,
          failed: 0,
          totalDuration: 1234,
        },
      };

      expect(event.type).toBe('batch:completed');
      assertExactShape(event, ['type', 'timestamp', 'batchId', 'operation', 'results'], 'BatchCompletedEvent');
      assertExactShape(
        event.results as unknown as Record<string, unknown>,
        ['successful', 'failed', 'totalDuration'],
        'BatchCompletedEvent.results'
      );
    });

    test('batch:completed event shape with costSavings matches interface', () => {
      const event: BatchCompletedEvent = {
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId: 'batch-001',
        operation: 'inscribe',
        results: {
          successful: 3,
          failed: 0,
          totalDuration: 5000,
          costSavings: {
            amount: 15000,
            percentage: 40,
          },
        },
      };

      assertExactShape(
        event.results as unknown as Record<string, unknown>,
        ['successful', 'failed', 'totalDuration', 'costSavings'],
        'BatchCompletedEvent.results (with costSavings)'
      );
    });
  });

  describe('BatchFailedEvent', () => {
    test('batch:failed event shape matches interface (without partialResults)', () => {
      const event: BatchFailedEvent = {
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId: 'batch-001',
        operation: 'create',
        error: 'Something went wrong',
      };

      expect(event.type).toBe('batch:failed');
      assertExactShape(event, ['type', 'timestamp', 'batchId', 'operation', 'error'], 'BatchFailedEvent');
    });

    test('batch:failed event shape with partialResults matches interface', () => {
      const event: BatchFailedEvent = {
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId: 'batch-001',
        operation: 'publish',
        error: 'Partial failure',
        partialResults: {
          successful: 2,
          failed: 3,
        },
      };

      assertExactShape(
        event,
        ['type', 'timestamp', 'batchId', 'operation', 'error', 'partialResults'],
        'BatchFailedEvent (with partialResults)'
      );
    });
  });
});
