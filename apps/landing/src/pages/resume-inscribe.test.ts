/**
 * The refusal surface of the module that spends money.
 *
 * `resumeInscribe` rebuilds a published Original from its hosted artifacts and
 * hands it to the demo's own `engine.inscribe`. Everything before that hand-off
 * is a gate, and each gate exists because passing it wrongly costs real BTC:
 * a rebuild from bytes that will not verify, a commit that cannot pay for
 * itself, a spend against a deposit we could not read. These pin that NONE of
 * them reaches the engine — the engine is dynamically imported at the point of
 * no return, so "never got there" is observable as "never imported".
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { resumeInscribe, fetchHostedCel, fetchHostedResources, resolveAuthorshipDid } from './resume-inscribe';
import type { CelLog } from './original-detail-data';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

const HOST = 'demo.test';
const DID = `did:webvh:scid:${HOST}:u:sub-1:abc`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve a fixed map of path → body; anything else 404s. */
function serve(routes: Record<string, string>) {
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), `https://${HOST}`);
    seen.push(url.pathname);
    const body = routes[url.pathname];
    return body === undefined
      ? new Response('nope', { status: 404 })
      : new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return seen;
}

const signingClient = {} as TurnkeyBitcoinClient;


const deposit = (over: Partial<{ confirmedUtxos: unknown[]; estimatedCostSats: number }> = {}) =>
  ({
    address: 'bc1qexample',
    confirmedSats: 50_000,
    unconfirmedSats: 0,
    estimatedCostSats: 20_000,
    confirmedUtxos: [{ txid: 'a'.repeat(64), vout: 0, value: 50_000, scriptPubKey: '00' }],
    ...over,
  }) as never;

/** A genesis-only CEL. Unsigned on purpose: these never reach verification. */
const CEL: CelLog = {
  events: [
    {
      type: 'create',
      data: {
        controller: 'did:key:z6Mkj2fLd1Cft3Y1d4keoArcN9fxSUKUXo49sdyPDHA796qk',
        resources: [{ id: 'artwork.svg', digestMultibase: 'uEiCK9_ajaSgQrxYbHi9nHkZCMAv9Ef52nzfvpMj9AEE4_w', mediaType: 'image/svg+xml' }],
      },
    },
  ],
};

/** The path genesis's sealed resource is served under, derived from its digest. */
const RESOURCE_PATH = '/u/sub-1/abc/resources/uEiCK9_ajaSgQrxYbHi9nHkZCMAv9Ef52nzfvpMj9AEE4_w';
/** Everything the rebuild needs, so the gates under test are the LATER ones. */
const HOSTED = { '/u/sub-1/abc/cel.json': JSON.stringify(CEL), [RESOURCE_PATH]: '<svg/>' };

function run(opts: Partial<Parameters<typeof resumeInscribe>[0]> = {}) {
  return resumeInscribe({
    did: DID,
    host: HOST,
    subOrgId: 'sub-1',
    fundingAddress: 'bc1qexample',
    signingClient,
    loadDeposit: async () => deposit(),
    ...opts,
  });
}

describe('fetchHostedCel', () => {
  test('reads the hosted log', async () => {
    serve({ '/u/sub-1/abc/cel.json': JSON.stringify(CEL) });
    expect(await fetchHostedCel(DID, HOST)).toEqual(CEL);
  });

  test('null rather than throwing when it 404s', async () => {
    serve({});
    expect(await fetchHostedCel(DID, HOST)).toBeNull();
  });

  test('null for a DID that is not a did:webvh', async () => {
    serve({});
    expect(await fetchHostedCel('did:btco:123', HOST)).toBeNull();
  });
});

describe('fetchHostedResources', () => {
  /**
   * Every version, not just genesis. A revised Original rebuilt from its v1
   * bytes alone would anchor SUPERSEDED artwork to Bitcoin permanently.
   */
  test('fetches every version a signed update introduced', async () => {
    const revised: CelLog = {
      events: [
        ...CEL.events,
        {
          type: 'update',
          data: {
            resourceId: 'artwork.svg',
            toHash: '8b27d04ba1dddb2be18542ad170c52b957d35cc3b5fefdb6ef567ae04f97dfb9',
            toVersion: 2,
            contentType: 'image/svg+xml',
          },
        },
      ],
    };
    const seen = serve({});
    await fetchHostedResources(DID, revised, HOST);
    const fetched = seen.filter((p) => p.includes('/resources/'));
    expect(fetched.length).toBe(2);
  });

  test('a version that will not load is simply absent', async () => {
    serve({});
    expect(await fetchHostedResources(DID, CEL, HOST)).toEqual({});
  });
});

describe('resolveAuthorshipDid', () => {
  test('null with no client, and with no sub-org', async () => {
    expect(await resolveAuthorshipDid(null, 'sub-1')).toBeNull();
    expect(await resolveAuthorshipDid({} as TurnkeyBitcoinClient, undefined)).toBeNull();
  });

  test('null when the client cannot sign raw payloads at all', async () => {
    // Disabling the action up front is the point: it must not fail at signing
    // time, after the user has been told inscribing is about to happen.
    expect(await resolveAuthorshipDid({} as TurnkeyBitcoinClient, 'sub-1')).toBeNull();
  });
});

describe('refusing before anything is built or spent', () => {
  test('an Original that hosts no log', async () => {
    serve({});
    const out = await run();
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toMatch(/no event log/i);
  });

  test('a log whose bytes cannot be fetched back', async () => {
    // The digest is sealed in genesis; without the bytes there is nothing to
    // check it against, and inscribing unverified content is the one outcome
    // this whole path exists to prevent.
    serve({ '/u/sub-1/abc/cel.json': JSON.stringify(CEL) });
    const out = await run({ cel: CEL });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toMatch(/could not be fetched back/i);
  });

  test('a deposit that cannot be read', async () => {
    serve(HOSTED);
    const out = await run({ cel: CEL, loadDeposit: async () => null });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toMatch(/nothing was built or spent/i);
  });

  test('a deposit that does not cover the quote', async () => {
    serve(HOSTED);
    const out = await run({
      cel: CEL,
      loadDeposit: async () => deposit({ confirmedUtxos: [{ txid: 'a'.repeat(64), vout: 0, value: 100, scriptPubKey: '00' }] }),
    });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toMatch(/top it up/i);
  });

  test('a deposit with nothing spendable in it', async () => {
    // Confirmed balance can be non-zero while every UTXO is withheld — one
    // carrying an ordinal, or the ordinal lookup being down.
    serve(HOSTED);
    const out = await run({ cel: CEL, loadDeposit: async () => deposit({ confirmedUtxos: [] }) });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toMatch(/top it up/i);
  });

  test('every refusal names a reason and none of them throws', async () => {
    serve(HOSTED);
    for (const opts of [
      {},
      { cel: CEL },
      { cel: CEL, loadDeposit: async () => null },
      { cel: CEL, loadDeposit: async () => deposit({ confirmedUtxos: [] }) },
    ]) {
      const out = await run(opts as Parameters<typeof run>[0]);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.message.length).toBeGreaterThan(0);
    }
  });

  test('the hosted CEL is refused before the deposit is even read', async () => {
    // Ordering matters: reading the deposit is a server round-trip, and a
    // rebuild that cannot happen must not issue one.
    serve({});
    let asked = false;
    const out = await run({
      loadDeposit: async () => {
        asked = true;
        return deposit();
      },
    });
    expect(out.ok).toBe(false);
    expect(asked).toBe(false);
  });
});
