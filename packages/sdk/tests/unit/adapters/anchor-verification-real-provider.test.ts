/**
 * CEL-CORE-026 — bitcoin anchoring verified through a REAL provider surface.
 *
 * Anchoring is gating, but every existing test drives it through
 * `OrdMockProvider`, an in-memory double that hands back exactly the object it
 * was given. That bypasses the entire decode path a production provider runs:
 * JSON-RPC transport, base64 content, `satpoint`/`sat` parsing, and the
 * server-field validation added by #350. A verifier that only works against the
 * mock is a verifier nobody has tested.
 *
 * This drives `verifyEventLog`'s anchoring branch through `QuickNodeProvider`
 * over mocked JSON-RPC — the real wire format — so the anchor document reaches
 * the verifier the way it would from an ord node.
 *
 * What still needs #328: a live node. The transport is mocked here; the
 * provider's own parsing, validation and error mapping are not.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import {
  multikey,
  canonicalizeEvent,
  canonicalizeEntryForChain,
  computeDigestMultibase,
  createEventLog,
  appendEvent,
  deriveDidCel,
  verifyEventLog,
  type EventLog,
  type LogEntry,
  type OrdinalsLookup,
} from '@originals/cel';
import { QuickNodeProvider } from '../../../src/adapters/providers/QuickNodeProvider';

const ENDPOINT = 'https://example-name.btc.quiknode.pro/test-token/';
const SAT = '1234567890';
const TXID = 'a860baeecae8c2d9fb95f09608d3b3e2bbaf207f25a6361e0d07a326906f8be6';
const INSCRIPTION_ID = `${TXID}i0`;

// ---------------------------------------------------------------- JSON-RPC mock

type RpcRequest = { method: string; params: unknown[]; id: number; jsonrpc: string };
let results: Record<string, unknown>;
let errors: Record<string, { code?: number; message: string }>;
let seen: string[];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  seen = [];
  errors = {};
  results = { getblockchaininfo: { chain: 'regtest' } };
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const req = JSON.parse(String(init?.body ?? '{}')) as RpcRequest;
    seen.push(req.method);
    const body = Object.prototype.hasOwnProperty.call(errors, req.method)
      ? { jsonrpc: '2.0', id: req.id, result: null, error: errors[req.method] }
      : Object.prototype.hasOwnProperty.call(results, req.method)
        ? { jsonrpc: '2.0', id: req.id, result: results[req.method] }
        : { jsonrpc: '2.0', id: req.id, result: null, error: { code: -32601, message: `Method not found: ${req.method}` } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The production provider exactly as it ships. */
function provider(): OrdinalsLookup {
  return new QuickNodeProvider({
    endpoint: ENDPOINT,
    expectedNetwork: 'regtest',
  }) as unknown as OrdinalsLookup;
}

/**
 * The production provider PLUS the one capability it does not implement (see
 * the `UNIQUENESS_UNVERIFIABLE` test below). Everything the anchoring branch
 * actually decodes still comes from `QuickNodeProvider` over mocked JSON-RPC;
 * only the enumeration is supplied, so the rest of the branch is reachable.
 */
function providerWithEnumeration(didCel: string): OrdinalsLookup {
  const inner = provider();
  return new Proxy(inner as object, {
    get(target, prop, receiver) {
      if (prop === 'getAnchoringsForDidCel') {
        return async (requested: string) =>
          requested === didCel ? [{ satoshi: SAT, inscriptionId: INSCRIPTION_ID, blockHeight: 100 }] : [];
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as OrdinalsLookup;
}

/** Serve `doc` as the inscription on SAT, in ord's real response shape. */
function serveAnchor(doc: unknown, overrides?: { sat?: string | number; satpoint?: string }): void {
  results.ord_getInscription = {
    id: INSCRIPTION_ID,
    satpoint: overrides?.satpoint ?? `${TXID}:0:0`,
    sat: overrides?.sat ?? SAT,
    content_type: 'application/did+json',
  };
  // ord returns content base64-encoded over JSON-RPC.
  results.ord_getContent = Buffer.from(JSON.stringify(doc)).toString('base64');
}

// ------------------------------------------------------------- log construction

async function makeKey() {
  const priv = crypto.getRandomValues(new Uint8Array(32));
  const pub = await ed25519.getPublicKeyAsync(priv);
  const pubMb = multikey.encodePublicKey(pub, 'Ed25519');
  const didKey = `did:key:${pubMb}`;
  const vm = `${didKey}#${pubMb}`;
  const signer = async (data: unknown) => ({
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    created: '2026-08-15T00:00:00Z',
    verificationMethod: vm,
    proofPurpose: 'assertionMethod',
    proofValue: multikey.encodeMultibase(
      new Uint8Array(await ed25519.signAsync(canonicalizeEvent(data), priv))
    ),
  });
  return { signer, didKey, vm };
}

const chainDigest = (event: LogEntry) => computeDigestMultibase(canonicalizeEntryForChain(event));

function anchorDoc(headDigestMultibase: string, didCel: string, satoshi = SAT) {
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

function attachWitness(log: EventLog, satoshi = SAT): EventLog {
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
            proofValue: `z${INSCRIPTION_ID}`,
            witnessedAt,
            txid: TXID,
            satoshi,
            inscriptionId: INSCRIPTION_ID,
          },
        ],
      },
    ],
  };
}

/** create → migrate(btco on SAT) → witnessed. Returns the log, anchor doc and did:cel. */
async function anchoredLog(): Promise<{ log: EventLog; doc: unknown; didCel: string }> {
  const a = await makeKey();
  let log = await createEventLog(
    { name: 'Asset', controller: a.didKey, resources: [], createdAt: '2026-08-15T00:00:00Z', nonce: 'qn-1' },
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
  const didCel = deriveDidCel(log);
  const doc = anchorDoc(chainDigest(log.events[log.events.length - 1]), didCel);
  return { log: attachWitness(log), doc, didCel };
}

// ------------------------------------------------------------------------ tests

describe('bitcoin anchoring verified through QuickNodeProvider (real wire format)', () => {
  /**
   * LIMITATION, pinned deliberately.
   *
   * `getAnchoringsForDidCel` (#402, first-anchor-wins uniqueness) is implemented
   * ONLY by `OrdMockProvider`. Neither production provider the SDK ships —
   * QuickNodeProvider or OrdHttpProvider — has it, and `verifyEventLog` fails
   * closed without it. So today NO btco-anchored did:cel asset can be verified
   * against a real endpoint, whatever the rest of the anchoring branch does.
   *
   * When a provider grows the capability, this test SHOULD fail. That is the
   * signal to delete it and drop the `providerWithEnumeration` shim below.
   */
  test('KNOWN GAP: the shipped provider cannot enumerate anchorings, so uniqueness fails closed', async () => {
    const { log, doc } = await anchoredLog();
    serveAnchor(doc);

    const result = await verifyEventLog(log, { ordinalsProvider: provider() });

    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toMatch(/UNIQUENESS_UNVERIFIABLE/);
    expect(typeof (provider() as { getAnchoringsForDidCel?: unknown }).getAnchoringsForDidCel)
      .not.toBe('function');
  });

  test('an honestly anchored log verifies when the anchor is served over JSON-RPC', async () => {
    const { log, doc, didCel } = await anchoredLog();
    serveAnchor(doc);

    const result = await verifyEventLog(log, { ordinalsProvider: providerWithEnumeration(didCel) });

    expect(result.errors).toEqual([]);
    expect(result.verified).toBe(true);
    // The provider was genuinely exercised: chain guard, inscription, content.
    expect(seen).toContain('getblockchaininfo');
    expect(seen).toContain('ord_getInscription');
    expect(seen).toContain('ord_getContent');
  });

  test('base64 content decoding is exercised, not bypassed', async () => {
    const { log, doc, didCel } = await anchoredLog();
    serveAnchor(doc);
    // Corrupt only the ENCODING, leaving the document itself intact: if the
    // verifier were reading anything other than the provider's decoded bytes,
    // this would still pass.
    results.ord_getContent = Buffer.from(JSON.stringify(doc)).toString('base64').slice(0, -8) + 'AAAAAAAA';

    const result = await verifyEventLog(log, { ordinalsProvider: providerWithEnumeration(didCel) });

    expect(result.verified).toBe(false);
  });

  test('an anchor on a DIFFERENT sat than the signed one is rejected', async () => {
    const { log, doc, didCel } = await anchoredLog();
    // The provider reports the inscription living on another sat.
    serveAnchor(doc, { sat: '9999999999' });

    const result = await verifyEventLog(log, { ordinalsProvider: providerWithEnumeration(didCel) });

    expect(result.verified).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('a missing inscription fails closed rather than skipping the anchor check', async () => {
    const { log, didCel } = await anchoredLog();
    errors.ord_getInscription = { code: -32000, message: 'inscription not found' };

    const result = await verifyEventLog(log, { ordinalsProvider: providerWithEnumeration(didCel) });

    expect(result.verified).toBe(false);
    expect(result.errors.join(' ')).toMatch(/not found on chain/i);
  });

  test('a malformed sat from the endpoint is a contract violation, not a pass', async () => {
    const { log, doc, didCel } = await anchoredLog();
    // #350: a compromised endpoint must not be able to inject arbitrary values
    // into provenance. The provider throws; the verifier must not treat that
    // as a verified anchor.
    serveAnchor(doc, { sat: 'not-a-sat' });

    const result = await verifyEventLog(log, { ordinalsProvider: providerWithEnumeration(didCel) });

    expect(result.verified).toBe(false);
  });

  test('a wrong-chain endpoint is refused before any anchor is trusted', async () => {
    const { log, doc, didCel } = await anchoredLog();
    serveAnchor(doc);
    results.getblockchaininfo = { chain: 'main' };

    const result = await verifyEventLog(log, { ordinalsProvider: providerWithEnumeration(didCel) });

    expect(result.verified).toBe(false);
  });
});
