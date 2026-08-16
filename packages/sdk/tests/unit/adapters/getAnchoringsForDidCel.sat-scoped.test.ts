/**
 * #473 — the SAT-SCOPED `getAnchoringsForDidCel` tier on the production
 * providers (QuickNodeProvider, OrdHttpProvider).
 *
 * Contract under test (see OrdinalsProvider docs): given the log's own
 * anchored sat as `opts.satoshi`, enumerate that sat's inscriptions and return
 * the ones whose inscribed did:btco document back-links the did:cel via
 * `alsoKnownAs` — with `blockHeight` and the inscribed `didDocument`. Without
 * a sat scope the provider must fail LOUDLY (never fabricate an empty
 * enumeration, which would read as "no anchorings exist").
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StructuredError } from '@originals/cel';
import { encode as encodeCbor } from '@originals/cel/cbor';
import { QuickNodeProvider } from '../../../src/adapters/providers/QuickNodeProvider';
import { OrdHttpProvider } from '../../../src/adapters/providers/OrdHttpProvider';

const SAT = '1234567890';
const TXID = 'a860baeecae8c2d9fb95f09608d3b3e2bbaf207f25a6361e0d07a326906f8be6';
const INSCRIPTION_ID = `${TXID}i0`;
const DID_CEL = 'did:cel:uEXAMPLEEXAMPLEEXAMPLE';

function backLinkedDoc(didCel: string = DID_CEL) {
  const id = `did:btco:reg:${SAT}`;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id,
    alsoKnownAs: [didCel],
    service: [{ id: `${id}#cel`, type: 'OriginalsCelAnchor', serviceEndpoint: { headDigestMultibase: 'uFAKE' } }],
  };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ------------------------------------------------------------- QuickNodeProvider

describe('QuickNodeProvider.getAnchoringsForDidCel (sat-scoped, JSON-RPC wire)', () => {
  type RpcRequest = { method: string; params: unknown[]; id: number; jsonrpc: string };
  let results: Record<string, unknown>;
  let errors: Record<string, { code?: number; message: string }>;

  beforeEach(() => {
    errors = {};
    results = { getblockchaininfo: { chain: 'regtest' } };
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const req = JSON.parse(String(init?.body ?? '{}')) as RpcRequest;
      const body = Object.prototype.hasOwnProperty.call(errors, req.method)
        ? { jsonrpc: '2.0', id: req.id, result: null, error: errors[req.method] }
        : Object.prototype.hasOwnProperty.call(results, req.method)
          ? { jsonrpc: '2.0', id: req.id, result: results[req.method] }
          : { jsonrpc: '2.0', id: req.id, result: null, error: { code: -32601, message: `Method not found: ${req.method}` } };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;
  });

  function provider(): QuickNodeProvider {
    return new QuickNodeProvider({
      endpoint: 'https://example-name.btc.quiknode.pro/test-token/',
      expectedNetwork: 'regtest',
    });
  }

  function serve(doc: unknown, opts?: { height?: number; contentType?: string }) {
    results.ord_getSat = { inscriptions: [INSCRIPTION_ID] };
    results.ord_getInscription = {
      id: INSCRIPTION_ID,
      satpoint: `${TXID}:0:0`,
      sat: SAT,
      height: opts?.height ?? 100,
      content_type: opts?.contentType ?? 'application/did+json',
    };
    results.ord_getContent = Buffer.from(JSON.stringify(doc)).toString('base64');
  }

  test('returns the back-linked anchoring on the scoped sat, with height and the inscribed doc', async () => {
    serve(backLinkedDoc());

    const anchorings = await provider().getAnchoringsForDidCel(DID_CEL, { satoshi: SAT });

    expect(anchorings).toHaveLength(1);
    expect(anchorings[0].satoshi).toBe(SAT);
    expect(anchorings[0].inscriptionId).toBe(INSCRIPTION_ID);
    expect(anchorings[0].blockHeight).toBe(100);
    expect((anchorings[0].didDocument as { alsoKnownAs?: string[] }).alsoKnownAs).toContain(DID_CEL);
  });

  test('#407 phase 2: the DID document is read from inscription METADATA when content is media', async () => {
    // Content is binary media (not JSON); provenance rides in CBOR metadata.
    results.ord_getSat = { inscriptions: [INSCRIPTION_ID] };
    results.ord_getInscription = {
      id: INSCRIPTION_ID,
      satpoint: `${TXID}:0:0`,
      sat: SAT,
      height: 42,
      content_type: 'image/png',
      metadata: Buffer.from(encodeCbor({ didDocument: backLinkedDoc() })).toString('hex'),
    };
    results.ord_getContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]).toString('base64');

    const anchorings = await provider().getAnchoringsForDidCel(DID_CEL, { satoshi: SAT });

    expect(anchorings).toHaveLength(1);
    expect(anchorings[0].blockHeight).toBe(42);
    expect((anchorings[0].didDocument as { id?: string }).id).toBe(`did:btco:reg:${SAT}`);
  });

  test('an inscription that does not back-link this did:cel is not an anchoring', async () => {
    serve(backLinkedDoc('did:cel:uSOMEONE-ELSE'));

    const anchorings = await provider().getAnchoringsForDidCel(DID_CEL, { satoshi: SAT });

    expect(anchorings).toEqual([]);
  });

  test('a sat with no inscriptions enumerates empty (fails closed at the uniqueness gate)', async () => {
    errors.ord_getSat = { code: -5, message: 'sat not found' };

    const anchorings = await provider().getAnchoringsForDidCel(DID_CEL, { satoshi: SAT });

    expect(anchorings).toEqual([]);
  });

  test('an UNSCOPED call fails loudly instead of fabricating an empty enumeration', async () => {
    await expect(provider().getAnchoringsForDidCel(DID_CEL)).rejects.toMatchObject({
      code: 'ANCHORING_ENUMERATION_UNSCOPED',
    });
  });

  test('an invalid sat scope is rejected before any RPC', async () => {
    let err: unknown;
    await provider().getAnchoringsForDidCel(DID_CEL, { satoshi: 'not-a-sat' }).catch((e) => { err = e; });
    expect(err).toBeInstanceOf(StructuredError);
    expect((err as StructuredError).code).toBe('ANCHORING_ENUMERATION_INVALID_SATOSHI');
  });
});

// --------------------------------------------------------------- OrdHttpProvider

describe('OrdHttpProvider.getAnchoringsForDidCel (sat-scoped, HTTP wire)', () => {
  const BASE = 'https://ord.test.local/api';
  let routes: Record<string, () => Response>;

  beforeEach(() => {
    routes = {};
    globalThis.fetch = (async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      const handler = routes[path];
      return handler ? handler() : new Response('not found', { status: 404 });
    }) as typeof globalThis.fetch;
  });

  function serve(doc: unknown) {
    routes[`/api/sat/${SAT}`] = () =>
      new Response(JSON.stringify({ inscription_ids: [INSCRIPTION_ID] }), { status: 200 });
    routes[`/api/inscription/${INSCRIPTION_ID}`] = () =>
      new Response(JSON.stringify({
        inscription_id: INSCRIPTION_ID,
        sat: SAT,
        block_height: 100,
        content_type: 'application/did+json',
      }), { status: 200 });
    routes[`/api/content/${INSCRIPTION_ID}`] = () =>
      new Response(JSON.stringify(doc), { status: 200 });
    // No CBOR metadata on this inscription (phase-1 content-as-DID-doc shape).
  }

  test('returns the back-linked anchoring on the scoped sat, with height and the inscribed doc', async () => {
    serve(backLinkedDoc());
    const provider = new OrdHttpProvider({ baseUrl: BASE });

    const anchorings = await provider.getAnchoringsForDidCel(DID_CEL, { satoshi: SAT });

    expect(anchorings).toHaveLength(1);
    expect(anchorings[0]).toMatchObject({ satoshi: SAT, inscriptionId: INSCRIPTION_ID, blockHeight: 100 });
    expect((anchorings[0].didDocument as { alsoKnownAs?: string[] }).alsoKnownAs).toContain(DID_CEL);
  });

  test('an inscription that does not back-link this did:cel is not an anchoring', async () => {
    serve(backLinkedDoc('did:cel:uSOMEONE-ELSE'));
    const provider = new OrdHttpProvider({ baseUrl: BASE });

    const anchorings = await provider.getAnchoringsForDidCel(DID_CEL, { satoshi: SAT });

    expect(anchorings).toEqual([]);
  });

  test('an UNSCOPED call fails loudly instead of fabricating an empty enumeration', async () => {
    const provider = new OrdHttpProvider({ baseUrl: BASE });

    await expect(provider.getAnchoringsForDidCel(DID_CEL)).rejects.toMatchObject({
      code: 'ANCHORING_ENUMERATION_UNSCOPED',
    });
  });
});
