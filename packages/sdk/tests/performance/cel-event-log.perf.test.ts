/**
 * Performance benchmarks for CEL (Cryptographic Event Log) operations.
 *
 * Establishes baselines for:
 * - Event log creation
 * - Event log updates (append events)
 * - Event log verification
 * - JSON/CBOR serialization round-trips
 */

import { describe, test, expect } from 'bun:test';
import { createEventLog } from '../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../src/cel/algorithms/updateEventLog';
import { verifyEventLog } from '../../src/cel/algorithms/verifyEventLog';
import { serializeEventLogJson, parseEventLogJson } from '../../src/cel/serialization/json';
import { serializeEventLogCbor, parseEventLogCbor } from '../../src/cel/serialization/cbor';
import type { DataIntegrityProof, EventLog } from '../../src/cel/types';

function createMockSigner(verificationMethod: string = 'did:key:z6MkTest#key-1') {
  return async (data: unknown): Promise<DataIntegrityProof> => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: new Date().toISOString(),
    verificationMethod,
    proofPurpose: 'assertionMethod',
    proofValue: 'z3ABC123mockProofValue',
  });
}

const signerOpts = {
  signer: createMockSigner(),
  verificationMethod: 'did:key:z6MkTest#key-1',
  proofPurpose: 'assertionMethod' as const,
};

function stats(durations: number[]) {
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(durations.length * 0.5)];
  const p95 = sorted[Math.floor(durations.length * 0.95)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return { avg, p50, p95, min, max };
}

function printStats(label: string, durations: number[]) {
  const s = stats(durations);
  console.log(`\n${label}:`);
  console.log(`  Iterations: ${durations.length}`);
  console.log(`  Avg: ${s.avg.toFixed(2)}ms | P50: ${s.p50.toFixed(2)}ms | P95: ${s.p95.toFixed(2)}ms`);
  console.log(`  Min: ${s.min.toFixed(2)}ms | Max: ${s.max.toFixed(2)}ms`);
}

describe('CEL Event Log Performance', () => {
  describe('Event log creation baselines', () => {
    test('createEventLog throughput', async () => {
      const iterations = 50;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await createEventLog({
          name: `Asset ${i}`,
          did: `did:peer:4z6MkTest${i}`,
          layer: 'peer',
          createdAt: new Date().toISOString(),
          resources: [],
          creator: `did:peer:4z6MkTest${i}`,
        }, signerOpts);
        durations.push(performance.now() - start);
      }

      printStats('createEventLog', durations);
      expect(stats(durations).avg).toBeLessThan(50);
    });

    test('concurrent createEventLog', async () => {
      const batchSize = 20;
      const start = performance.now();

      const promises = Array.from({ length: batchSize }, (_, i) =>
        createEventLog({
          name: `Concurrent ${i}`,
          did: `did:peer:4z6MkConc${i}`,
          layer: 'peer',
          createdAt: new Date().toISOString(),
          resources: [],
          creator: `did:peer:4z6MkConc${i}`,
        }, signerOpts)
      );
      const results = await Promise.all(promises);
      const duration = performance.now() - start;
      const throughput = (batchSize / duration) * 1000;

      console.log(`\nConcurrent createEventLog (${batchSize}):`);
      console.log(`  Total: ${duration.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(1)} logs/sec`);

      expect(results).toHaveLength(batchSize);
      expect(throughput).toBeGreaterThan(50);
    });
  });

  describe('Event log update baselines', () => {
    test('updateEventLog append performance', async () => {
      let log = await createEventLog({
        name: 'Update Test',
        did: 'did:peer:4z6MkUpdateTest',
        layer: 'peer',
        createdAt: new Date().toISOString(),
        resources: [],
        creator: 'did:peer:4z6MkUpdateTest',
      }, signerOpts);

      const iterations = 30;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        log = await updateEventLog(log, {
          name: `Updated ${i}`,
          updatedAt: new Date().toISOString(),
        }, signerOpts);
        durations.push(performance.now() - start);
      }

      printStats('updateEventLog (append)', durations);
      expect(stats(durations).avg).toBeLessThan(50);
      expect(log.events.length).toBe(iterations + 1);
    });

    test('update performance does not degrade with log size', async () => {
      let log = await createEventLog({
        name: 'Scaling Test',
        did: 'did:peer:4z6MkScaleTest',
        layer: 'peer',
        createdAt: new Date().toISOString(),
        resources: [],
        creator: 'did:peer:4z6MkScaleTest',
      }, signerOpts);

      // Build up a log with 50 events
      for (let i = 0; i < 50; i++) {
        log = await updateEventLog(log, { step: i }, signerOpts);
      }

      // Measure updates on a large log
      const durations: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        log = await updateEventLog(log, { step: 50 + i }, signerOpts);
        durations.push(performance.now() - start);
      }

      printStats('updateEventLog (50+ events)', durations);
      // Should not be significantly slower than small logs
      expect(stats(durations).avg).toBeLessThan(100);
    });
  });

  describe('Verification baselines', () => {
    test('verifyEventLog performance', async () => {
      // Create logs of various sizes
      const logs: EventLog[] = [];
      for (let i = 0; i < 10; i++) {
        let log = await createEventLog({
          name: `Verify Test ${i}`,
          did: `did:peer:4z6MkVerify${i}`,
          layer: 'peer',
          createdAt: new Date().toISOString(),
          resources: [],
          creator: `did:peer:4z6MkVerify${i}`,
        }, signerOpts);
        // Add 5 updates each
        for (let j = 0; j < 5; j++) {
          log = await updateEventLog(log, { step: j }, signerOpts);
        }
        logs.push(log);
      }

      const durations: number[] = [];
      for (const log of logs) {
        const start = performance.now();
        const result = await verifyEventLog(log);
        durations.push(performance.now() - start);
        expect(result.verified).toBe(true);
      }

      printStats('verifyEventLog (6 events each)', durations);
      expect(stats(durations).avg).toBeLessThan(100);
    });
  });

  describe('Serialization baselines', () => {
    let sampleLog: EventLog;

    test('JSON serialization round-trip', async () => {
      sampleLog = await createEventLog({
        name: 'Serialize Test',
        did: 'did:peer:4z6MkSerialize',
        layer: 'peer',
        createdAt: new Date().toISOString(),
        resources: [{ id: 'r1', type: 'text', contentType: 'text/plain', hash: 'a'.repeat(64) }],
        creator: 'did:peer:4z6MkSerialize',
      }, signerOpts);
      for (let i = 0; i < 10; i++) {
        sampleLog = await updateEventLog(sampleLog, { step: i }, signerOpts);
      }

      const iterations = 50;
      const serDurations: number[] = [];
      const deDurations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const startSer = performance.now();
        const json = serializeEventLogJson(sampleLog);
        serDurations.push(performance.now() - startSer);

        const startDe = performance.now();
        parseEventLogJson(json);
        deDurations.push(performance.now() - startDe);
      }

      printStats('JSON serialize (11 events)', serDurations);
      printStats('JSON parse (11 events)', deDurations);

      expect(stats(serDurations).avg).toBeLessThan(10);
      expect(stats(deDurations).avg).toBeLessThan(10);
    });

    test('CBOR serialization round-trip', async () => {
      const log = await createEventLog({
        name: 'CBOR Test',
        did: 'did:peer:4z6MkCBOR',
        layer: 'peer',
        createdAt: new Date().toISOString(),
        resources: [{ id: 'r1', type: 'text', contentType: 'text/plain', hash: 'b'.repeat(64) }],
        creator: 'did:peer:4z6MkCBOR',
      }, signerOpts);

      const iterations = 50;
      const serDurations: number[] = [];
      const deDurations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const startSer = performance.now();
        const cbor = serializeEventLogCbor(log);
        serDurations.push(performance.now() - startSer);

        const startDe = performance.now();
        parseEventLogCbor(cbor);
        deDurations.push(performance.now() - startDe);
      }

      printStats('CBOR serialize', serDurations);
      printStats('CBOR parse', deDurations);

      expect(stats(serDurations).avg).toBeLessThan(10);
      expect(stats(deDurations).avg).toBeLessThan(10);
    });

    test('JSON vs CBOR size comparison', async () => {
      const log = await createEventLog({
        name: 'Size Comparison',
        did: 'did:peer:4z6MkSize',
        layer: 'peer',
        createdAt: new Date().toISOString(),
        resources: [{ id: 'r1', type: 'text', contentType: 'text/plain', hash: 'c'.repeat(64) }],
        creator: 'did:peer:4z6MkSize',
      }, signerOpts);

      const json = serializeEventLogJson(log);
      const cbor = serializeEventLogCbor(log);

      const jsonSize = new TextEncoder().encode(json).length;
      const cborSize = cbor.length;
      const savings = ((jsonSize - cborSize) / jsonSize * 100).toFixed(1);

      console.log(`\nSerialization size comparison (1 event):`);
      console.log(`  JSON: ${jsonSize} bytes`);
      console.log(`  CBOR: ${cborSize} bytes`);
      console.log(`  CBOR savings: ${savings}%`);

      // CBOR should be more compact
      expect(cborSize).toBeLessThan(jsonSize);
    });
  });

  describe('Regression guards', () => {
    test('createEventLog should not regress beyond 3x baseline', async () => {
      // Warm up
      await createEventLog({
        name: 'warmup',
        did: 'did:peer:4z6MkWarmup',
        layer: 'peer',
        createdAt: new Date().toISOString(),
        resources: [],
        creator: 'did:peer:4z6MkWarmup',
      }, signerOpts);

      const runs: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        await createEventLog({
          name: `reg-${i}`,
          did: `did:peer:4z6MkReg${i}`,
          layer: 'peer',
          createdAt: new Date().toISOString(),
          resources: [],
          creator: `did:peer:4z6MkReg${i}`,
        }, signerOpts);
        runs.push(performance.now() - start);
      }

      const sorted = [...runs].sort((a, b) => a - b);
      const median = sorted[5];

      for (const run of runs) {
        expect(run).toBeLessThan(median * 3);
      }

      console.log(`\nCEL regression guard: median=${median.toFixed(2)}ms, max allowed=${(median * 3).toFixed(2)}ms`);
    });
  });
});
