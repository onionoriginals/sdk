/**
 * UnifiedVerifier's `ordinalsProvider` constructor option (SPIKE).
 *
 * The option existed with no direct test: nothing asserted it was actually
 * threaded into `verifyEventLog`, so wiring it to the wrong key — or dropping
 * it — would have looked identical to a passing suite. btco anchoring is
 * GATING, so the difference is observable without spying on internals: the same
 * log verifies with a provider and fails closed without one.
 */
import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import {
  multikey,
  canonicalizeEvent,
  canonicalizeEntryForChain,
  computeDigestMultibase,
  createEventLog,
  appendEvent,
  deriveDidCel,
  type EventLog,
  type LogEntry,
  type OrdinalsLookup,
} from '@originals/cel';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { UnifiedVerifier } from '../../../src/verify/UnifiedVerifier';
import { DIDManager } from '../../../src/did/DIDManager';

const SAT = '1234567890';

/** A did:key signer whose key is embedded in the DID, so verification is offline. */
async function makeKey() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof',
    // The pre-042 label, still accepted on READ — its preimage is the event alone.
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-08-15T00:00:00Z',
    verificationMethod: vm,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(
      new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
    ),
  });
  return { signer, didKey, vm, pubMb };
}

const chainDigest = (event: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(event));

function btcoDoc(satoshi: string, headDigestMultibase: string, didCel: string) {
  const id = `did:btco:reg:${satoshi}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    alsoKnownAs: [didCel],
    service: [
      { id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase } },
    ],
  };
}

function attachWitness(log: EventLog, insc: { inscriptionId: string; txid: string }): EventLog {
  const last = log.events[log.events.length - 1];
  const witnessedAt = '2026-08-15T00:00:01Z';
  return {
    events: [
      ...log.events.slice(0, -1),
      {
        ...last,
        proof: [
          ...last.proof,
          {
            type: 'DataIntegrityProof',
            cryptosuite: 'bitcoin-ordinals-2024',
            created: witnessedAt,
            verificationMethod: 'did:btco:witness',
            proofPurpose: 'assertionMethod',
            proofValue: `z${insc.inscriptionId}`,
            witnessedAt,
            txid: insc.txid,
            satoshi: SAT,
            inscriptionId: insc.inscriptionId,
          },
        ],
      },
    ],
  };
}

/** create → migrate(btco), witnessed by the anchor document inscribed on SAT. */
async function makeAnchoredLog(provider: OrdMockProvider): Promise<EventLog> {
  const a = await makeKey();
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-08-15T00:00:00Z', nonce: 'uv-1' },
    { signer: a.signer, verificationMethod: a.vm }
  );
  log = await appendEvent(
    log,
    'migrate',
    {
      sourceDid: 'did:cel:uPlaceholder',
      layer: 'btco',
      network: 'regtest',
      to: `did:btco:reg:${SAT}`,
      migratedAt: '2026-08-15T00:00:00Z',
    },
    { signer: a.signer, verificationMethod: a.vm }
  );
  const migrateDigest = chainDigest(log.events[log.events.length - 1]);
  const res = await provider.createInscription({
    data: Buffer.from(JSON.stringify(btcoDoc(SAT, migrateDigest, deriveDidCel(log)))),
    contentType: 'application/did+json',
    targetSatoshi: SAT,
  });
  return attachWitness(log, { inscriptionId: res.inscriptionId, txid: res.txid });
}

/** Counts the lookups the verifier makes, to prove the provider is consulted. */
function countingProvider(inner: OrdMockProvider) {
  const calls: string[] = [];
  return {
    calls,
    provider: new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as unknown as OrdinalsLookup,
  };
}

describe('UnifiedVerifier — ordinalsProvider option (spike)', () => {
  const didManager = new DIDManager({} as never);

  test('a btco-anchored log verifies when the provider is supplied to the constructor', async () => {
    const mock = new OrdMockProvider();
    const log = await makeAnchoredLog(mock);
    const { provider, calls } = countingProvider(mock);

    const res = await new UnifiedVerifier(didManager, { ordinalsProvider: provider }).verify(log);

    expect(res.kind).toBe('eventLog');
    expect(res.verified).toBe(true);
    expect(res.errors).toEqual([]);
    // The option is genuinely threaded through, not merely accepted and dropped.
    expect(calls.length).toBeGreaterThan(0);
  });

  test('the same log FAILS CLOSED when no provider is supplied', async () => {
    const mock = new OrdMockProvider();
    const log = await makeAnchoredLog(mock);

    const res = await new UnifiedVerifier(didManager).verify(log);

    expect(res.kind).toBe('eventLog');
    expect(res.verified).toBe(false);
    // Pin the REASON, so this cannot pass because of some unrelated failure.
    expect(res.errors.join(' ')).toMatch(/without an ordinalsProvider/i);
  });

  test('an unrelated provider cannot satisfy the anchoring (the log is bound to its own inscription)', async () => {
    const mock = new OrdMockProvider();
    const log = await makeAnchoredLog(mock);

    // A provider that knows nothing about this log's inscription.
    const res = await new UnifiedVerifier(didManager, {
      ordinalsProvider: new OrdMockProvider() as unknown as OrdinalsLookup,
    }).verify(log);

    expect(res.verified).toBe(false);
    expect(res.errors.join(' ')).toMatch(/inscription .* not found on chain/i);
  });
});
