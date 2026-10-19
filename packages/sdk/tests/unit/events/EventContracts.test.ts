import { describe, test, expect } from 'bun:test';
import type {
  AssetCreatedEvent,
  AssetMigratedEvent,
  AssetTransferredEvent,
  ResourcePublishedEvent,
  CredentialIssuedEvent,
  ResourceVersionCreatedEvent,
  VerificationCompletedEvent,
  BatchStartedEvent,
  BatchCompletedEvent,
  BatchFailedEvent,
  BatchProgressEvent,
  OriginalsEvent,
} from '../../../src/events/types';

/**
 * Golden contract tests for event payload shapes.
 *
 * These tests lock down the exact set of keys each event interface
 * declares so that implementation drift (extra or missing fields)
 * is caught at test time rather than at runtime.
 *
 * If an emitter adds a field, the corresponding interface MUST be
 * updated first, which will cause these tests to need updating too —
 * that's the point.
 */

// Helper: build a canonical event and return its sorted keys.
// Using `satisfies` ensures compile-time alignment with the interface.
function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

describe('Event contract tests — exact payload shapes', () => {
  const timestamp = '2026-01-01T00:00:00.000Z';

  test('AssetCreatedEvent has exactly the declared fields', () => {
    const event = {
      type: 'asset:created' as const,
      timestamp,
      asset: {
        id: 'did:peer:z123',
        layer: 'did:peer' as const,
        resourceCount: 1,
        createdAt: timestamp,
      },
    } satisfies AssetCreatedEvent;

    expect(sortedKeys(event)).toEqual(['asset', 'timestamp', 'type']);
    expect(sortedKeys(event.asset)).toEqual(['createdAt', 'id', 'layer', 'resourceCount']);
  });

  test('AssetMigratedEvent has exactly the declared fields', () => {
    const event = {
      type: 'asset:migrated' as const,
      timestamp,
      asset: {
        id: 'did:peer:z123',
        fromLayer: 'did:peer' as const,
        toLayer: 'did:webvh' as const,
      },
      details: {
        transactionId: 'tx123',
        inscriptionId: 'ins123',
        satoshi: '1000',
        commitTxId: 'commit123',
        revealTxId: 'reveal123',
        feeRate: 5,
      },
    } satisfies AssetMigratedEvent;

    expect(sortedKeys(event)).toEqual(['asset', 'details', 'timestamp', 'type']);
    expect(sortedKeys(event.asset)).toEqual(['fromLayer', 'id', 'toLayer']);
    expect(sortedKeys(event.details!)).toEqual([
      'commitTxId', 'feeRate', 'inscriptionId', 'revealTxId', 'satoshi', 'transactionId',
    ]);
  });

  test('AssetMigratedEvent works without optional details', () => {
    const event = {
      type: 'asset:migrated' as const,
      timestamp,
      asset: {
        id: 'did:peer:z123',
        fromLayer: 'did:peer' as const,
        toLayer: 'did:webvh' as const,
      },
    } satisfies AssetMigratedEvent;

    expect(sortedKeys(event)).toEqual(['asset', 'timestamp', 'type']);
  });

  test('AssetTransferredEvent has exactly the declared fields', () => {
    const event = {
      type: 'asset:transferred' as const,
      timestamp,
      asset: {
        id: 'did:btco:123',
        layer: 'did:btco' as const,
      },
      from: 'did:btco:owner1',
      to: 'did:btco:owner2',
      transactionId: 'tx456',
    } satisfies AssetTransferredEvent;

    expect(sortedKeys(event)).toEqual(['asset', 'from', 'timestamp', 'to', 'transactionId', 'type']);
    expect(sortedKeys(event.asset)).toEqual(['id', 'layer']);
  });

  test('ResourcePublishedEvent has exactly the declared fields (including domain)', () => {
    const event = {
      type: 'resource:published' as const,
      timestamp,
      asset: { id: 'did:webvh:z123' },
      resource: {
        id: 'res-1',
        url: 'https://example.com/resource',
        contentType: 'image/png',
        hash: 'sha256:abc123',
      },
      publisherDid: 'did:webvh:publisher',
      domain: 'example.com',
    } satisfies ResourcePublishedEvent;

    expect(sortedKeys(event)).toEqual([
      'asset', 'domain', 'publisherDid', 'resource', 'timestamp', 'type',
    ]);
    expect(sortedKeys(event.resource)).toEqual(['contentType', 'hash', 'id', 'url']);
  });

  test('CredentialIssuedEvent has exactly the declared fields', () => {
    const event = {
      type: 'credential:issued' as const,
      timestamp,
      asset: { id: 'did:peer:z123' },
      credential: {
        type: ['VerifiableCredential', 'ResourceCreatedCredential'],
        issuer: 'did:webvh:issuer',
      },
    } satisfies CredentialIssuedEvent;

    expect(sortedKeys(event)).toEqual(['asset', 'credential', 'timestamp', 'type']);
    expect(sortedKeys(event.credential)).toEqual(['issuer', 'type']);
  });

  test('ResourceVersionCreatedEvent has exactly the declared fields', () => {
    const event = {
      type: 'resource:version:created' as const,
      timestamp,
      asset: { id: 'did:peer:z123' },
      resource: {
        id: 'res-1',
        fromVersion: 1,
        toVersion: 2,
        fromHash: 'sha256:old',
        toHash: 'sha256:new',
      },
      changes: 'Updated content',
    } satisfies ResourceVersionCreatedEvent;

    expect(sortedKeys(event)).toEqual(['asset', 'changes', 'resource', 'timestamp', 'type']);
    expect(sortedKeys(event.resource)).toEqual(['fromHash', 'fromVersion', 'id', 'toHash', 'toVersion']);
  });

  test('ResourceVersionCreatedEvent works without optional changes', () => {
    const event = {
      type: 'resource:version:created' as const,
      timestamp,
      asset: { id: 'did:peer:z123' },
      resource: {
        id: 'res-1',
        fromVersion: 1,
        toVersion: 2,
        fromHash: 'sha256:old',
        toHash: 'sha256:new',
      },
    } satisfies ResourceVersionCreatedEvent;

    expect(sortedKeys(event)).toEqual(['asset', 'resource', 'timestamp', 'type']);
  });

  test('VerificationCompletedEvent has exactly the declared fields', () => {
    const event = {
      type: 'verification:completed' as const,
      timestamp,
      asset: { id: 'did:peer:z123' },
      result: true,
      checks: {
        didDocument: true,
        resources: true,
        credentials: true,
      },
    } satisfies VerificationCompletedEvent;

    expect(sortedKeys(event)).toEqual(['asset', 'checks', 'result', 'timestamp', 'type']);
    expect(sortedKeys(event.checks!)).toEqual(['credentials', 'didDocument', 'resources']);
  });

  test('BatchStartedEvent has exactly the declared fields', () => {
    const event = {
      type: 'batch:started' as const,
      timestamp,
      operation: 'create' as const,
      batchId: 'batch-1',
      itemCount: 10,
    } satisfies BatchStartedEvent;

    expect(sortedKeys(event)).toEqual(['batchId', 'itemCount', 'operation', 'timestamp', 'type']);
  });

  test('BatchCompletedEvent has exactly the declared fields', () => {
    const event = {
      type: 'batch:completed' as const,
      timestamp,
      batchId: 'batch-1',
      operation: 'create',
      results: {
        successful: 8,
        failed: 2,
        totalDuration: 1500,
        costSavings: {
          amount: 500,
          percentage: 15,
        },
      },
    } satisfies BatchCompletedEvent;

    expect(sortedKeys(event)).toEqual(['batchId', 'operation', 'results', 'timestamp', 'type']);
    expect(sortedKeys(event.results)).toEqual(['costSavings', 'failed', 'successful', 'totalDuration']);
  });

  test('BatchFailedEvent has exactly the declared fields', () => {
    const event = {
      type: 'batch:failed' as const,
      timestamp,
      batchId: 'batch-1',
      operation: 'publish',
      error: 'Storage unavailable',
      partialResults: {
        successful: 3,
        failed: 7,
      },
    } satisfies BatchFailedEvent;

    expect(sortedKeys(event)).toEqual([
      'batchId', 'error', 'operation', 'partialResults', 'timestamp', 'type',
    ]);
  });

  test('BatchProgressEvent has exactly the declared fields', () => {
    const event = {
      type: 'batch:progress' as const,
      timestamp,
      batchId: 'batch-1',
      operation: 'inscribe',
      progress: 0.5,
      completed: 5,
      failed: 0,
      total: 10,
    } satisfies BatchProgressEvent;

    expect(sortedKeys(event)).toEqual([
      'batchId', 'completed', 'failed', 'operation', 'progress', 'timestamp', 'total', 'type',
    ]);
  });
});

describe('OriginalsEvent union — discriminated by type field', () => {
  test('every event type literal is unique in the union', () => {
    // This test verifies at the type level that the union discriminant works.
    // At runtime we simply check that known type strings are distinct.
    const allTypes: OriginalsEvent['type'][] = [
      'asset:created',
      'asset:migrated',
      'asset:transferred',
      'resource:published',
      'credential:issued',
      'verification:completed',
      'batch:started',
      'batch:completed',
      'batch:failed',
      'batch:progress',
      'resource:version:created',
    ];

    const unique = new Set(allTypes);
    expect(unique.size).toBe(allTypes.length);
    expect(allTypes.length).toBe(11);
  });
});
