import { describe, test, expect, vi } from 'bun:test';
import { BtcoCelManager } from '../../../src/cel/layers/BtcoCelManager';
import { WebVHCelManager } from '../../../src/cel/layers/WebVHCelManager';
import { PeerCelManager } from '../../../src/cel/layers/PeerCelManager';
import { computeDigestMultibase } from '../../../src/cel/hash';
import type { DataIntegrityProof, EventLog } from '../../../src/cel/types';
import type { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';

const signer = async (): Promise<DataIntegrityProof> => ({
  type: 'DataIntegrityProof',
  cryptosuite: 'eddsa-jcs-2022',
  created: '2026-01-01T00:00:00.000Z',
  verificationMethod: 'did:key:z6MkConformance#key-0',
  proofPurpose: 'assertionMethod',
  proofValue: 'zconformance',
});

const createWebvhLog = async (): Promise<EventLog> => {
  const peer = new PeerCelManager(signer);
  const peerLog = await peer.create('Conformance Asset', [
    { digestMultibase: 'uConformanceHash', mediaType: 'image/png' },
  ]);
  const webvh = new WebVHCelManager(signer, 'example.com');
  return webvh.migrate(peerLog);
};

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = sortKeys(obj[key]);
  return sorted;
}

describe('Btco finalization conformance', () => {
  test('materializes deterministic final artifact digest and emits final attestation', async () => {
    const inscribeData = vi
      .fn()
      .mockResolvedValueOnce({ txid: 'tx-witness', inscriptionId: 'tx-witnessi0', satoshi: '42', blockHeight: 10 })
      .mockResolvedValueOnce({ txid: 'tx-attest', inscriptionId: 'tx-attesti0', satoshi: '43', blockHeight: 11 });

    const bitcoinManager = { inscribeData } as unknown as BitcoinManager;
    const manager = new BtcoCelManager(signer, bitcoinManager, { feeRate: 8 });
    const webvhLog = await createWebvhLog();

    const btcoLog = await manager.migrate(webvhLog);
    const migrationData = btcoLog.events[btcoLog.events.length - 1].data as Record<string, any>;

    expect(inscribeData).toHaveBeenCalledTimes(2);
    expect(migrationData.finalAttestation?.finalityStatus).toBe('final');
    expect(migrationData.finalAttestation?.inscriptionId).toBe('tx-attesti0');
    expect(migrationData.finalArtifact?.digestMultibase).toMatch(/^u/);

    const state = manager.getCurrentState(btcoLog) as Record<string, any>;
    if (state.metadata) {
      delete state.metadata.finalArtifact;
      delete state.metadata.finalAttestation;
    }
    const payload = {
      type: 'OriginalsFinalArtifact',
      version: '1.1',
      sourceDid: migrationData.sourceDid,
      targetDid: migrationData.targetDid,
      celHeadDigest: migrationData.finalAttestation.celHeadDigest,
      state,
    };
    const expectedDigest = computeDigestMultibase(new TextEncoder().encode(JSON.stringify(sortKeys(payload))));
    expect(migrationData.finalArtifact.digestMultibase).toBe(expectedDigest);
  });
});
