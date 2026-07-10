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

// Mock BitcoinManager that records what it inscribes and exposes a matching
// ordinals lookup, so the (gating) bitcoin witness verification can confirm
// the inscription exists, sits on the claimed satoshi, and commits to the
// event digest.
const mockBitcoin = (): { manager: BitcoinManager; ordinalsProvider: any } => {
  let lastPayload: unknown;
  const manager = {
    network: 'mainnet',
    inscribeData: async (data: unknown) => {
      lastPayload = data;
      return {
        txid: 'abc123def456',
        inscriptionId: 'abc123def456i0',
        satoshi: '1234567890',
        blockHeight: 800000,
      };
    },
  } as unknown as BitcoinManager;
  const ordinalsProvider = {
    getInscriptionById: async (id: string) =>
      id === 'abc123def456i0'
        ? {
            inscriptionId: id,
            content: Buffer.from(JSON.stringify(lastPayload)),
            contentType: 'application/json',
            txid: 'abc123def456',
            satoshi: '1234567890',
          }
        : null,
  };
  return { manager, ordinalsProvider };
};

describe('CEL event-log authorization and btco verifiability', () => {
  it('a real webvh→btco migration produces a verifiable log', async () => {
    const signer = makeSigner();
    const peer = new PeerCelManager(signer as any);
    let { log } = await peer.create('Asset', [{ digestMultibase: 'uHash', mediaType: 'image/png' }]);
    log = await new WebVHCelManager(signer as any, 'example.com').migrate(log);
    const { manager, ordinalsProvider } = mockBitcoin();
    const btcoLog = await new BtcoCelManager(signer as any, manager).migrate(log);

    // btco anchoring is gating: without an ordinalsProvider the log must NOT verify.
    const unanchored = await verifyEventLog(btcoLog);
    expect(unanchored.verified).toBe(false);
    expect(unanchored.errors.some(e => /ordinalsProvider/.test(e))).toBe(true);

    const result = await verifyEventLog(btcoLog, { ordinalsProvider });
    expect(result.verified).toBe(true);
    expect(result.errors).toEqual([]);

    // Bitcoin details are carried in the witness proof, not the signed data.
    const last = btcoLog.events[btcoLog.events.length - 1];
    const bp = (last.proof as any[]).find(p => p.cryptosuite === 'bitcoin-ordinals-2024');
    expect(bp.txid).toBe('abc123def456');
    expect((last.data as any).txid).toBeUndefined();
    // targetDid is derived from the satoshi and is a resolvable numeric did:btco.
    expect((last.data as any).targetDid).toBeUndefined();
    const state = new BtcoCelManager(makeSigner() as any, mockBitcoin().manager).getCurrentState(btcoLog);
    expect(/^did:btco:[0-9]+$/.test(state.did)).toBe(true);
  });

  it('reports a clear "content is missing" diagnostic when the witness inscription has no content', async () => {
    const signer = makeSigner();
    const peer = new PeerCelManager(signer as any);
    let { log } = await peer.create('Asset', [{ digestMultibase: 'uHash', mediaType: 'image/png' }]);
    log = await new WebVHCelManager(signer as any, 'example.com').migrate(log);
    const { manager } = mockBitcoin();
    const btcoLog = await new BtcoCelManager(signer as any, manager).migrate(log);

    // Provider finds the inscription but it carries no `content` field: this must
    // NOT be misreported as "content is not valid JSON" (which implies tampering).
    const ordinalsProvider = {
      getInscriptionById: async (id: string) =>
        id === 'abc123def456i0'
          ? {
              inscriptionId: id,
              contentType: 'application/json',
              txid: 'abc123def456',
              satoshi: '1234567890',
            }
          : null,
    };

    const result = await verifyEventLog(btcoLog, { ordinalsProvider });
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /content is missing/.test(e))).toBe(true);
    expect(result.errors.some(e => /not valid JSON/.test(e))).toBe(false);
  });

  it('rejects a LEGACY create event re-signed by a different key than the one embedded in the did:peer', async () => {
    // Attack: copy a victim's create event `data` verbatim (including the
    // victim's self-certifying did:peer:4) and re-sign event 0 with the
    // attacker's own did:key. The log is internally consistent, but the
    // create key is not embedded in the DID — verification must fail.
    //
    // Legacy fixture: the write path no longer emits `data.did` (did:cel
    // genesis is de-self-referenced), but logs in this shape exist and the
    // verify READ path must keep rejecting this forgery on them.
    const victim = makeSigner();
    const victimVm = (await victim({ probe: true })).verificationMethod;
    const victimKeyMb = victimVm.slice('did:key:'.length).split('#')[0];
    const didPeerMod = await import('@aviarytech/did-peer');
    const victimDid: string = await didPeerMod.createNumAlgo4(
      [{ type: 'Multikey', publicKeyMultibase: victimKeyMb }],
      undefined,
      undefined
    );
    const legacyData = {
      name: 'Victim Asset',
      did: victimDid,
      layer: 'peer',
      resources: [],
      creator: victimDid,
      createdAt: '2020-01-01T00:00:00Z',
    };
    const victimProof = await victim({ type: 'create', data: legacyData });
    const log = { events: [{ type: 'create', data: legacyData, proof: [victimProof] }] };

    // Sanity: the victim's own legacy log passes the self-certifying binding.
    const legit = await verifyEventLog(log as any);
    expect(legit.verified).toBe(true);

    const attacker = makeSigner();
    const attackerProof = await attacker({ type: 'create', data: legacyData });
    const forged = { events: [{ type: 'create', data: legacyData, proof: [attackerProof] }] };

    const result = await verifyEventLog(forged as any);
    expect(result.verified).toBe(false);
    expect(result.errors.some(e => /not a key embedded in the self-certifying DID/.test(e))).toBe(true);
  });

  it('derives btco state without a BitcoinManager (network read from signed data)', async () => {
    const signer = makeSigner();
    let { log } = await new PeerCelManager(signer as any).create('Asset', []);
    log = await new WebVHCelManager(signer as any, 'example.com').migrate(log);
    const btcoLog = await new BtcoCelManager(signer as any, mockBitcoin().manager).migrate(log);

    // Replaying a persisted log in a fresh SDK without Bitcoin access is a
    // pure read and must work — the network lives in the signed migration data.
    const readOnly = new BtcoCelManager(makeSigner() as any, undefined);
    const state = readOnly.getCurrentState(btcoLog);
    expect(/^did:btco:[0-9]+$/.test(state.did)).toBe(true);
    expect(state.layer).toBe('btco');
  });

  it('does not misclassify a regular update carrying sourceDid/layer fields as a migration', async () => {
    // A migration event always carries migratedAt (and OriginalsCel.update
    // reserves it). A direct updateEventLog append with application-level
    // sourceDid/layer fields but no migratedAt must replay as a regular
    // update: the name change applies and the layer does not flip.
    const signer = makeSigner();
    let { log } = await new PeerCelManager(signer as any).create('Asset', []);
    const webvhManager = new WebVHCelManager(signer as any, 'example.com');
    log = await webvhManager.migrate(log);
    log = await updateEventLog(log, { sourceDid: 'did:example:app-field', layer: 'btco', name: 'renamed' }, {
      signer: signer as any,
      verificationMethod: 'ignored',
    });

    const state = webvhManager.getCurrentState(log);
    // Under the old sourceDid+layer predicate this event was replayed as a
    // migration and the name change was silently dropped. (The regular-update
    // branch still applies an explicit `layer` field — longstanding update
    // semantics — so only the name is the misclassification discriminator.)
    expect(state.name).toBe('renamed');
  });

  it('rejects an event appended by a key not authorized by the create event', async () => {
    const owner = makeSigner();
    const { log } = await new PeerCelManager(owner as any).create('Owner Asset', []);

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
    const { log } = await new PeerCelManager(owner as any).create('Owner Asset', []);

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
    let { log } = await peer.create('Owner Asset', []);
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
      let { log } = await create.create('Asset', []);
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
      let { log } = await create.create('Asset', []);
      log = await new PeerCelManager(vmSigner(privB, 'did:webvh:example.com:alice#key-1') as any)
        .update(log, { name: 'hijacked' });

      const result = await verifyEventLog(log, { resolveKey });
      expect(result.verified).toBe(false);
      expect(result.errors.some(e => /not authorized by the log's create event/.test(e))).toBe(true);
    });
  });
});
