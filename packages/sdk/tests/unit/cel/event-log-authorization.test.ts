/**
 * Regression tests for two CEL protocol criticals:
 *
 *  1. did:btco migrations must produce cryptographically verifiable logs
 *     (event data was previously mutated after signing/witnessing).
 *  2. verifyEventLog must bind every event to the log's controller key
 *     (any key could previously append/rename/migrate/deactivate a log
 *     and it verified as valid).
 *
 * These use REAL Ed25519 signing (the other BtcoCelManager tests use a mock
 * signer and never exercise cryptographic verification).
 */
import { describe, it, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { multikey } from '../../../src/crypto/Multikey';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import { PeerCelManager } from '../../../src/cel/layers/PeerCelManager';
import { WebVHCelManager } from '../../../src/cel/layers/WebVHCelManager';
import { BtcoCelManager } from '../../../src/cel/layers/BtcoCelManager';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import type { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';

function makeSigner() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  let pubMb: string | undefined;
  return async (data: unknown) => {
    if (!pubMb) {
      const pub = await ed25519.getPublicKeyAsync(priv);
      pubMb = multikey.encodePublicKey(pub, 'Ed25519');
    }
    const sig = await ed25519.signAsync(canonicalizeEvent(data), priv);
    return {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: '2020-01-01T00:00:00Z',
      verificationMethod: `did:key:${pubMb}#${pubMb}`,
      proofPurpose: 'assertionMethod',
      proofValue: multikey.encodeMultibase(new Uint8Array(sig)),
    };
  };
}

const mockBitcoin = (): BitcoinManager => ({
  inscribeData: async () => ({
    txid: 'abc123def456',
    inscriptionId: 'abc123def456i0',
    satoshi: '1234567890',
    blockHeight: 800000,
  }),
} as unknown as BitcoinManager);

describe('CEL event-log authorization and btco verifiability', () => {
  it('a real webvh→btco migration produces a verifiable log', async () => {
    const signer = makeSigner();
    const peer = new PeerCelManager(signer as any);
    let log = await peer.create('Asset', [{ digestMultibase: 'uHash', mediaType: 'image/png' }]);
    log = await new WebVHCelManager(signer as any, 'example.com').migrate(log);
    const btcoLog = await new BtcoCelManager(signer as any, mockBitcoin()).migrate(log);

    const result = await verifyEventLog(btcoLog);
    expect(result.verified).toBe(true);
    expect(result.errors).toEqual([]);

    // Bitcoin details are carried in the witness proof, not the signed data.
    const last = btcoLog.events[btcoLog.events.length - 1];
    const bp = (last.proof as any[]).find(p => p.cryptosuite === 'bitcoin-ordinals-2024');
    expect(bp.txid).toBe('abc123def456');
    expect((last.data as any).txid).toBeUndefined();
    // targetDid is derived from the satoshi and is a resolvable numeric did:btco.
    expect((last.data as any).targetDid).toBeUndefined();
    const state = new BtcoCelManager(makeSigner() as any, mockBitcoin()).getCurrentState(btcoLog);
    expect(/^did:btco:[0-9]+$/.test(state.did)).toBe(true);
  });

  it('rejects an event appended by a key not authorized by the create event', async () => {
    const owner = makeSigner();
    const log = await new PeerCelManager(owner as any).create('Owner Asset', []);

    // Attacker signs an update with their own unrelated key.
    const attacker = makeSigner();
    const forged = await updateEventLog(log, { name: 'Stolen' }, {
      signer: attacker as any,
      verificationMethod: 'ignored',
    });

    const result = await verifyEventLog(forged);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /not authorized by the log's create event/.test(e))).toBe(true);
  });

  it('accepts an update signed by the same controller key', async () => {
    const owner = makeSigner();
    const peer = new PeerCelManager(owner as any);
    let log = await peer.create('Owner Asset', []);
    log = await peer.update(log, { name: 'v2' });

    const result = await verifyEventLog(log);
    expect(result.verified).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
