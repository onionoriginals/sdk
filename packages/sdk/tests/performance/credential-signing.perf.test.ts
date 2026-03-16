/**
 * Performance benchmarks for credential signing and verification.
 *
 * Establishes baselines for:
 * - Credential creation (factory methods)
 * - EdDSA signing (Ed25519)
 * - ES256K signing (secp256k1)
 * - Credential verification
 * - Sign + verify round-trip
 */

import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { VerifiableCredential, CredentialSubject } from '../../src/types';
import * as secp256k1 from '@noble/secp256k1';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../src/crypto/Multikey';

function makeSubject(id: string): CredentialSubject {
  return {
    id: `did:peer:subject-${id}`,
    resourceId: `res-${id}`,
    resourceType: 'text',
    createdAt: new Date().toISOString(),
    creator: 'did:peer:issuer',
  } as any;
}

function makeBaseVC(id: string): VerifiableCredential {
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiableCredential', 'ResourceCreated'],
    issuer: 'did:peer:issuer',
    issuanceDate: new Date().toISOString(),
    credentialSubject: makeSubject(id),
  };
}

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

describe('Credential Signing Performance', () => {
  describe('Credential creation baselines', () => {
    test('createResourceCredential throughput', async () => {
      const sdk = OriginalsSDK.create();
      const iterations = 50;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await sdk.credentials.createResourceCredential(
          'ResourceCreated',
          makeSubject(`create-${i}`),
          'did:peer:issuer'
        );
        durations.push(performance.now() - start);
      }

      printStats('createResourceCredential', durations);
      expect(stats(durations).avg).toBeLessThan(50);
    });
  });

  describe('EdDSA (Ed25519) signing baselines', () => {
    test('Ed25519 sign credential', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKeyAsync(sk);
      const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
      const pkMb = multikey.encodePublicKey(pk, 'Ed25519');

      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const vc = makeBaseVC(`ed-sign-${i}`);
        const start = performance.now();
        const signed = await sdk.credentials.signCredential(vc, skMb, pkMb);
        durations.push(performance.now() - start);

        expect(signed.proof).toBeDefined();
      }

      printStats('Ed25519 signCredential', durations);
      expect(stats(durations).avg).toBeLessThan(200);
    });

    test('Ed25519 verify credential', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKeyAsync(sk);
      const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
      const pkMb = multikey.encodePublicKey(pk, 'Ed25519');

      // Pre-sign credentials
      const signedVCs: VerifiableCredential[] = [];
      for (let i = 0; i < 20; i++) {
        signedVCs.push(await sdk.credentials.signCredential(makeBaseVC(`ed-ver-${i}`), skMb, pkMb));
      }

      const durations: number[] = [];
      for (const signed of signedVCs) {
        const start = performance.now();
        const valid = await sdk.credentials.verifyCredential(signed);
        durations.push(performance.now() - start);

        expect(valid).toBe(true);
      }

      printStats('Ed25519 verifyCredential', durations);
      expect(stats(durations).avg).toBeLessThan(200);
    });

    test('Ed25519 sign+verify round-trip', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKeyAsync(sk);
      const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
      const pkMb = multikey.encodePublicKey(pk, 'Ed25519');

      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const vc = makeBaseVC(`ed-rt-${i}`);
        const start = performance.now();
        const signed = await sdk.credentials.signCredential(vc, skMb, pkMb);
        const valid = await sdk.credentials.verifyCredential(signed);
        durations.push(performance.now() - start);

        expect(valid).toBe(true);
      }

      printStats('Ed25519 sign+verify round-trip', durations);
      expect(stats(durations).avg).toBeLessThan(400);
    });
  });

  describe('ES256K (secp256k1) signing baselines', () => {
    test('ES256K sign credential', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'ES256K' });
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk, true);
      const skMb = multikey.encodePrivateKey(sk, 'Secp256k1');
      const pkMb = multikey.encodePublicKey(pk, 'Secp256k1');

      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const vc = makeBaseVC(`secp-sign-${i}`);
        const start = performance.now();
        const signed = await sdk.credentials.signCredential(vc, skMb, pkMb);
        durations.push(performance.now() - start);

        expect(signed.proof).toBeDefined();
      }

      printStats('ES256K signCredential', durations);
      expect(stats(durations).avg).toBeLessThan(200);
    });

    test('ES256K verify credential', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'ES256K' });
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk, true);
      const skMb = multikey.encodePrivateKey(sk, 'Secp256k1');
      const pkMb = multikey.encodePublicKey(pk, 'Secp256k1');

      const signedVCs: VerifiableCredential[] = [];
      for (let i = 0; i < 20; i++) {
        signedVCs.push(await sdk.credentials.signCredential(makeBaseVC(`secp-ver-${i}`), skMb, pkMb));
      }

      const durations: number[] = [];
      for (const signed of signedVCs) {
        const start = performance.now();
        const valid = await sdk.credentials.verifyCredential(signed);
        durations.push(performance.now() - start);

        expect(valid).toBe(true);
      }

      printStats('ES256K verifyCredential', durations);
      expect(stats(durations).avg).toBeLessThan(200);
    });

    test('ES256K sign+verify round-trip', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'ES256K' });
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk, true);
      const skMb = multikey.encodePrivateKey(sk, 'Secp256k1');
      const pkMb = multikey.encodePublicKey(pk, 'Secp256k1');

      const iterations = 20;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const vc = makeBaseVC(`secp-rt-${i}`);
        const start = performance.now();
        const signed = await sdk.credentials.signCredential(vc, skMb, pkMb);
        const valid = await sdk.credentials.verifyCredential(signed);
        durations.push(performance.now() - start);

        expect(valid).toBe(true);
      }

      printStats('ES256K sign+verify round-trip', durations);
      expect(stats(durations).avg).toBeLessThan(400);
    });
  });

  describe('Throughput under load', () => {
    test('concurrent credential signing', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKeyAsync(sk);
      const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
      const pkMb = multikey.encodePublicKey(pk, 'Ed25519');

      const batchSize = 20;
      const start = performance.now();

      const promises = Array.from({ length: batchSize }, (_, i) =>
        sdk.credentials.signCredential(makeBaseVC(`conc-${i}`), skMb, pkMb)
      );
      const results = await Promise.all(promises);
      const duration = performance.now() - start;
      const throughput = (batchSize / duration) * 1000;

      console.log(`\nConcurrent signing (${batchSize} credentials):`);
      console.log(`  Total: ${duration.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(1)} credentials/sec`);

      expect(results).toHaveLength(batchSize);
      for (const signed of results) {
        expect(signed.proof).toBeDefined();
      }
    });
  });

  describe('Regression guards', () => {
    test('Ed25519 signing should not regress beyond 3x baseline', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });
      const sk = ed25519.utils.randomPrivateKey();
      const pk = await ed25519.getPublicKeyAsync(sk);
      const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
      const pkMb = multikey.encodePublicKey(pk, 'Ed25519');

      // Warm up
      await sdk.credentials.signCredential(makeBaseVC('warmup'), skMb, pkMb);

      const runs: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        await sdk.credentials.signCredential(makeBaseVC(`reg-${i}`), skMb, pkMb);
        runs.push(performance.now() - start);
      }

      const sorted = [...runs].sort((a, b) => a - b);
      const median = sorted[5];

      for (const run of runs) {
        expect(run).toBeLessThan(median * 3);
      }

      console.log(`\nEd25519 regression guard: median=${median.toFixed(2)}ms, max allowed=${(median * 3).toFixed(2)}ms`);
    });

    test('ES256K signing should not regress beyond 3x baseline', async () => {
      const sdk = OriginalsSDK.create({ defaultKeyType: 'ES256K' });
      const sk = secp256k1.utils.randomPrivateKey();
      const pk = secp256k1.getPublicKey(sk, true);
      const skMb = multikey.encodePrivateKey(sk, 'Secp256k1');
      const pkMb = multikey.encodePublicKey(pk, 'Secp256k1');

      // Warm up
      await sdk.credentials.signCredential(makeBaseVC('warmup'), skMb, pkMb);

      const runs: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        await sdk.credentials.signCredential(makeBaseVC(`reg-${i}`), skMb, pkMb);
        runs.push(performance.now() - start);
      }

      const sorted = [...runs].sort((a, b) => a - b);
      const median = sorted[5];

      for (const run of runs) {
        expect(run).toBeLessThan(median * 3);
      }

      console.log(`\nES256K regression guard: median=${median.toFixed(2)}ms, max allowed=${(median * 3).toFixed(2)}ms`);
    });
  });
});
