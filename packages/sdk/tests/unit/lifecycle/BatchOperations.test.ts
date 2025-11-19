/**
 * Unit tests for Batch Operations
 * 
 * Tests the core batch execution logic, validation, and error handling
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  BatchOperationExecutor,
  BatchValidator,
  BatchError,
  type BatchResult,
  type BatchOperationOptions,
  type ValidationResult
} from '../../../src/lifecycle/BatchOperations';

describe('BatchOperations', () => {
  describe('BatchOperationExecutor', () => {
    let executor: BatchOperationExecutor;

    beforeEach(() => {
      executor = new BatchOperationExecutor();
    });

    test('should execute all operations successfully in sequential mode', async () => {
      const items = [1, 2, 3, 4, 5];
      const operation = async (item: number) => item * 2;

      const result = await executor.execute(items, operation, {
        maxConcurrent: 1,
        continueOnError: false
      });

      expect(result.successful).toHaveLength(5);
      expect(result.failed).toHaveLength(0);
      expect(result.totalProcessed).toBe(5);
      expect(result.batchId).toMatch(/^batch_\d+_[0-9a-f]+$/);
      expect(result.successful.map(s => s.result)).toEqual([2, 4, 6, 8, 10]);
    });

    test('should execute operations concurrently when maxConcurrent > 1', async () => {
      const items = [1, 2, 3, 4, 5, 6];
      const executionOrder: number[] = [];
      
      const operation = async (item: number) => {
        executionOrder.push(item);
        await new Promise(resolve => setTimeout(resolve, 10));
        return item * 2;
      };

      const result = await executor.execute(items, operation, {
        maxConcurrent: 3,
        continueOnError: false
      });

      expect(result.successful).toHaveLength(6);
      expect(result.failed).toHaveLength(0);
      // With maxConcurrent=3, items should be processed in chunks
      // Items 1,2,3 should start before 4,5,6
      expect(executionOrder.slice(0, 3).sort()).toEqual([1, 2, 3]);
    });

    test('should handle partial failures with continueOnError: true', async () => {
      const items = [1, 2, 3, 4, 5];
      const operation = async (item: number) => {
        if (item === 3 || item === 5) {
          throw new Error(`Failed on item ${item}`);
        }
        return item * 2;
      };

      const result = await executor.execute(items, operation, {
        continueOnError: true,
        maxConcurrent: 1
      });

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(2);
      expect(result.totalProcessed).toBe(5);
      expect(result.successful.map(s => s.result)).toEqual([2, 4, 8]);
      expect(result.failed.map(f => f.index)).toEqual([2, 4]); // indices 2 and 4 (items 3 and 5)
      expect(result.failed[0].error.message).toBe('Failed on item 3');
    });

    test('should fail fast when continueOnError: false', async () => {
      const items = [1, 2, 3, 4, 5];
      const operation = async (item: number) => {
        if (item === 3) {
          throw new Error('Failed on item 3');
        }
        return item * 2;
      };

      await expect(
        executor.execute(items, operation, {
          continueOnError: false,
          maxConcurrent: 1
        })
      ).rejects.toThrow('Failed on item 3');
    });

    test('should retry failed operations with exponential backoff', async () => {
      let attempts = 0;
      const items = [1];
      
      const operation = async (item: number) => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return item * 2;
      };

      const result = await executor.execute(items, operation, {
        retryCount: 2,
        retryDelay: 10,
        continueOnError: false
      });

      expect(attempts).toBe(3);
      expect(result.successful).toHaveLength(1);
      expect(result.successful[0].result).toBe(2);
    });

    test('should fail after exhausting retries', async () => {
      let attempts = 0;
      const items = [1];
      
      const operation = async (item: number) => {
        attempts++;
        throw new Error('Permanent failure');
      };

      const result = await executor.execute(items, operation, {
        retryCount: 2,
        retryDelay: 10,
        continueOnError: true
      });

      expect(attempts).toBe(3); // Initial attempt + 2 retries
      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].retryAttempts).toBe(2);
    });

    test('should respect timeout for operations', async () => {
      const items = [1];
      const operation = async (item: number) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return item * 2;
      };

      const result = await executor.execute(items, operation, {
        timeoutMs: 50,
        continueOnError: true
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].error.message).toContain('timeout');
    });

    test('should generate unique batch IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(executor.generateBatchId());
      }
      expect(ids.size).toBe(100);
    });

    test('should calculate timing accurately', async () => {
      const items = [1, 2, 3];
      const operation = async (item: number) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return item * 2;
      };

      const result = await executor.execute(items, operation, {
        maxConcurrent: 1
      });

      expect(result.totalDuration).toBeGreaterThanOrEqual(60); // At least 60ms (3 * 20ms)
      expect(result.startedAt).toBeDefined();
      expect(result.completedAt).toBeDefined();
      
      const startTime = new Date(result.startedAt).getTime();
      const endTime = new Date(result.completedAt).getTime();
      expect(endTime - startTime).toBeGreaterThanOrEqual(60);
    });

    test('should track individual operation durations', async () => {
      const items = [1, 2, 3];
      const operation = async (item: number) => {
        await new Promise(resolve => setTimeout(resolve, item * 10));
        return item * 2;
      };

      const result = await executor.execute(items, operation, {
        maxConcurrent: 1
      });

      // Allow for timing imprecision - setTimeout can fire slightly early
      // Use 80% of expected time as minimum to account for timer precision issues
      expect(result.successful[0].duration).toBeGreaterThanOrEqual(8);
      expect(result.successful[1].duration).toBeGreaterThanOrEqual(18);
      expect(result.successful[2].duration).toBeGreaterThanOrEqual(28);
      
      // Also verify durations are reasonable (not too high)
      expect(result.successful[0].duration).toBeLessThan(50);
      expect(result.successful[1].duration).toBeLessThan(60);
      expect(result.successful[2].duration).toBeLessThan(70);
    });

    test('should handle empty array', async () => {
      const items: number[] = [];
      const operation = async (item: number) => item * 2;

      const result = await executor.execute(items, operation);

      expect(result.successful).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.totalProcessed).toBe(0);
    });

    test('should preserve item indices in results', async () => {
      const items = [10, 20, 30, 40, 50];
      const operation = async (item: number, index: number) => {
        if (item === 30) throw new Error('Failed');
        return { item, index };
      };

      const result = await executor.execute(items, operation, {
        continueOnError: true
      });

      expect(result.successful[0].index).toBe(0);
      expect(result.successful[0].result.index).toBe(0);
      expect(result.successful[1].index).toBe(1);
      expect(result.failed[0].index).toBe(2); // Item 30 at index 2
    });
  });

  describe('BatchValidator', () => {
    let validator: BatchValidator;

    beforeEach(() => {
      validator = new BatchValidator();
    });

    describe('validateBatchCreate', () => {
      test('should validate correct resource lists', () => {
        const resourcesList = [
          [
            {
              id: 'res1',
              type: 'image',
              contentType: 'image/png',
              hash: 'abc123'
            }
          ],
          [
            {
              id: 'res2',
              type: 'text',
              contentType: 'text/plain',
              hash: 'def456'
            }
          ]
        ];

        const results = validator.validateBatchCreate(resourcesList);

        expect(results).toHaveLength(2);
        expect(results[0].isValid).toBe(true);
        expect(results[1].isValid).toBe(true);
        expect(results[0].errors).toHaveLength(0);
      });

      test('should detect empty resource arrays', () => {
        const resourcesList = [[]];

        const results = validator.validateBatchCreate(resourcesList);

        expect(results[0].isValid).toBe(false);
        expect(results[0].errors[0]).toContain('At least one resource is required');
      });

      test('should detect invalid resource objects', () => {
        const resourcesList = [
          [
            {
              id: 'res1'
              // missing type, contentType, hash
            }
          ]
        ];

        const results = validator.validateBatchCreate(resourcesList as any);

        expect(results[0].isValid).toBe(false);
        expect(results[0].errors.length).toBeGreaterThan(0);
      });

      test('should detect invalid hash format', () => {
        const resourcesList = [
          [
            {
              id: 'res1',
              type: 'image',
              contentType: 'image/png',
              hash: 'not-hex-!@#'
            }
          ]
        ];

        const results = validator.validateBatchCreate(resourcesList);

        expect(results[0].isValid).toBe(false);
        expect(results[0].errors[0]).toContain('invalid hash');
      });

      test('should handle non-array input', () => {
        const resourcesList = ['not-an-array'];

        const results = validator.validateBatchCreate(resourcesList as any);

        expect(results[0].isValid).toBe(false);
        expect(results[0].errors[0]).toContain('must be an array');
      });
    });

    describe('validateBatchInscription', () => {
      test('should validate correct assets', () => {
        const assets = [
          {
            id: 'did:peer:123',
            currentLayer: 'did:peer',
            resources: [{ id: 'res1' }]
          },
          {
            id: 'did:webvh:example.com:456',
            currentLayer: 'did:webvh',
            resources: [{ id: 'res2' }]
          }
        ];

        const results = validator.validateBatchInscription(assets);

        expect(results).toHaveLength(2);
        expect(results[0].isValid).toBe(true);
        expect(results[1].isValid).toBe(true);
      });

      test('should detect already inscribed assets', () => {
        const assets = [
          {
            id: 'did:btco:123',
            currentLayer: 'did:btco',
            resources: [{ id: 'res1' }]
          }
        ];

        const results = validator.validateBatchInscription(assets);

        expect(results[0].isValid).toBe(false);
        expect(results[0].errors[0]).toContain('already inscribed');
      });

      test('should detect missing resources', () => {
        const assets = [
          {
            id: 'did:peer:123',
            currentLayer: 'did:peer',
            resources: []
          }
        ];

        const results = validator.validateBatchInscription(assets);

        expect(results[0].isValid).toBe(false);
        expect(results[0].errors[0]).toContain('at least one resource');
      });

      test('should detect invalid asset objects', () => {
        const assets = [null, undefined, 'not-an-object'];

        const results = validator.validateBatchInscription(assets as any);

        expect(results).toHaveLength(3);
        expect(results.every(r => !r.isValid)).toBe(true);
      });
    });

    describe('validateBatchTransfer', () => {
      test('should validate correct transfers', () => {
        const transfers = [
          {
            asset: {
              id: 'did:btco:123',
              currentLayer: 'did:btco'
            },
            to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
          }
        ];

        const results = validator.validateBatchTransfer(transfers);

        expect(results[0].isValid).toBe(true);
      });

      test('should detect non-btco assets', () => {
        const transfers = [
          {
            asset: {
              id: 'did:peer:123',
              currentLayer: 'did:peer'
            },
            to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
          }
        ];

        const results = validator.validateBatchTransfer(transfers);

        expect(results[0].isValid).toBe(false);
        expect(results[0].errors[0]).toContain('must be inscribed on Bitcoin');
      });

      test('should detect missing destination address', () => {
        const transfers = [
          {
            asset: {
              id: 'did:btco:123',
              currentLayer: 'did:btco'
            },
            to: ''
          }
        ];

        const results = validator.validateBatchTransfer(transfers);

        expect(results[0].isValid).toBe(false);
        expect(results[0].errors[0]).toContain('Invalid destination address');
      });

      test('should detect invalid transfer objects', () => {
        const transfers = [null, { asset: null, to: 'address' }];

        const results = validator.validateBatchTransfer(transfers as any);

        expect(results).toHaveLength(2);
        expect(results.every(r => !r.isValid)).toBe(true);
      });
    });
  });

  describe('BatchError', () => {
    test('should create error with batch metadata', () => {
      const error = new BatchError(
        'batch_123',
        'create',
        { successful: 3, failed: 2 },
        'Operation failed'
      );

      expect(error.name).toBe('BatchError');
      expect(error.message).toBe('Operation failed');
      expect(error.batchId).toBe('batch_123');
      expect(error.operation).toBe('create');
      expect(error.partialResults.successful).toBe(3);
      expect(error.partialResults.failed).toBe(2);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('Integration scenarios', () => {
    test('should handle mixed success and failure with retries', async () => {
      const executor = new BatchOperationExecutor();
      const attemptCounts = new Map<number, number>();
      
      const items = [1, 2, 3, 4, 5];
      const operation = async (item: number) => {
        const count = attemptCounts.get(item) || 0;
        attemptCounts.set(item, count + 1);
        
        // Item 3 fails on first two attempts, succeeds on third
        if (item === 3 && count < 2) {
          throw new Error('Temporary failure');
        }
        
        // Item 5 always fails
        if (item === 5) {
          throw new Error('Permanent failure');
        }
        
        return item * 2;
      };

      const result = await executor.execute(items, operation, {
        retryCount: 2,
        retryDelay: 5,
        continueOnError: true,
        maxConcurrent: 1
      });

      expect(result.successful).toHaveLength(4); // Items 1, 2, 3, 4
      expect(result.failed).toHaveLength(1); // Item 5
      expect(attemptCounts.get(3)).toBe(3); // 2 failures + 1 success
      expect(attemptCounts.get(5)).toBe(3); // 3 failures
    });

    test('should handle large batches efficiently', async () => {
      const executor = new BatchOperationExecutor();
      const items = Array.from({ length: 100 }, (_, i) => i);
      
      const startTime = Date.now();
      const result = await executor.execute(items, async (item) => item * 2, {
        maxConcurrent: 10
      });
      const duration = Date.now() - startTime;

      expect(result.successful).toHaveLength(100);
      expect(result.failed).toHaveLength(0);
      // With concurrency=10, should be much faster than sequential
      // This is a rough check - actual timing depends on system load
      expect(duration).toBeLessThan(5000);
    });
  });
});
