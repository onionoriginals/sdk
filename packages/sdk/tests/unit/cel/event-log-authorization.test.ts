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

  it('rejects a co-signer proof appended to the create event', async () => {
    // The create event's signature and the hash chain cover only
    // {type,data,previousEvent}, not the proof array — so an attacker can
    // append their own valid controller proof to event 0 (keeping the owner's)
    // and, without this guard, become an authorized signer for later events.
    const owner = makeSigner();
    const log = await new PeerCelManager(owner as any).create('Owner Asset', []);

    const attacker = makeSigner();
    const ev0 = log.events[0];
    const attackerProof = await (attacker as any)({ type: ev0.type, data: ev0.data });
    (ev0.proof as any[]).push(attackerProof);

    // Attacker appends a forged update signed with their now-"authorized" key.
    const forged = await updateEventLog(log, { name: 'Hijacked' }, {
      signer: attacker as any,
      verificationMethod: 'ignored',
    });

    const result = await verifyEventLog(forged);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /exactly one controller proof/.test(e))).toBe(true);
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

  // Authorization is by resolved public KEY, not the VM URI string. These two
  // cases pin both axes for non-did:key (resolver-backed) controllers.
  describe('key-based authorization (resolver-backed VMs)', () => {
    // A signer that signs with `priv` but stamps an arbitrary verificationMethod.
    function vmSigner(priv: Uint8Array, verificationMethod: string) {
      return async (data: unknown) => {
        const sig = await ed25519.signAsync(canonicalizeEvent(data), priv);
        return {
          type: 'DataIntegrityProof',
          cryptosuite: 'eddsa-jcs-2022',
          created: '2020-01-01T00:00:00Z',
          verificationMethod,
          proofPurpose: 'assertionMethod',
          proofValue: multikey.encodeMultibase(new Uint8Array(sig)),
        };
      };
    }

    it('accepts the same key under a different equivalent VM id', async () => {
      const priv = crypto.getRandomValues(new Uint8Array(32));
      const pub = await ed25519.getPublicKeyAsync(priv);
      // resolveKey maps BOTH VM ids to the same public key.
      const resolveKey = async (_vm: string) => pub;

      const create = new PeerCelManager(vmSigner(priv, 'did:webvh:example.com:alice#key-0') as any);
      let log = await create.create('Asset', []);
      log = await new PeerCelManager(vmSigner(priv, 'did:webvh:example.com:alice#key-alias') as any)
        .update(log, { name: 'v2' });

      const result = await verifyEventLog(log, { resolveKey });
      expect(result.verified).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects a different key even under the same DID document', async () => {
      const privA = crypto.getRandomValues(new Uint8Array(32));
      const privB = crypto.getRandomValues(new Uint8Array(32));
      const pubA = await ed25519.getPublicKeyAsync(privA);
      const pubB = await ed25519.getPublicKeyAsync(privB);
      // #key-0 → A, #key-1 → B (distinct keys in the same DID document).
      const resolveKey = async (vm: string) => (vm.endsWith('#key-1') ? pubB : pubA);

      const create = new PeerCelManager(vmSigner(privA, 'did:webvh:example.com:alice#key-0') as any);
      let log = await create.create('Asset', []);
      log = await new PeerCelManager(vmSigner(privB, 'did:webvh:example.com:alice#key-1') as any)
        .update(log, { name: 'hijacked' });

      const result = await verifyEventLog(log, { resolveKey });
      expect(result.verified).toBe(false);
      expect(result.errors.some(e => /not authorized by the log's create event/.test(e))).toBe(true);
    });
  });
});
