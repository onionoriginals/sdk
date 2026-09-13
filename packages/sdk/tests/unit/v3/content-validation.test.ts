import { expect, test } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { digestBytes, type SatSnapshot } from '@originals/cel/v3';
import { prepareInscriptionOnSat } from '../../../src/bitcoin/inscribe-on-sat.js';
import type { PreparedInscriptionOnSat } from '../../../src/bitcoin/inscription-recovery.js';
import { getScureNetwork } from '../../../src/bitcoin/transactions/commit.js';
import { createBitcoinCoreContentValidator } from '../../../src/v3/content-validation.js';

const key = new Uint8Array(32).fill(1);
const payment = btc.p2wpkh(secp256k1.getPublicKey(key), getScureNetwork('regtest'));

// A real, fully-signed reveal transaction, built the same way the SDK's own
// writer creates one — the independent validator must derive content from
// this exact on-chain witness, never from what a provider separately claims.
async function preparedReveal(
  content: Uint8Array,
  contentType: string,
): Promise<PreparedInscriptionOnSat> {
  return prepareInscriptionOnSat({
    buildContent: async () => ({ content, contentType }),
    fundingUtxos: [
      {
        txid: '12'.repeat(32),
        vout: 0,
        value: 100_000,
        scriptPubKey: Buffer.from(payment.script!).toString('hex'),
      },
    ],
    satSigner: {
      signAndFinalizeCommitPsbt: async (psbt: string) => {
        const tx = btc.Transaction.fromPSBT(Buffer.from(psbt, 'base64'), {
          allowUnknownOutputs: true,
        });
        tx.sign(key);
        tx.finalize();
        return tx.hex;
      },
    },
    changeAddress: payment.address!,
    feeRate: 2,
    network: 'regtest',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider: { getFirstSatOfOutput: async () => '1250000000' } as any,
  });
}

function snapshotFor(
  prepared: PreparedInscriptionOnSat,
  providerBody: { mediaType: string; bytes: Uint8Array },
): SatSnapshot {
  const blockHash = 'b'.repeat(64);
  return {
    network: 'regtest',
    sat: prepared.satoshi,
    tipBefore: { height: 1, hash: blockHash },
    tipAfter: { height: 1, hash: blockHash },
    indexTip: { height: 1, hash: blockHash },
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [{ height: 1, hash: blockHash, txids: [prepared.revealTxId] }],
    ownership: { owner: null, satpoint: null },
    publications: [
      {
        id: prepared.inscriptionId,
        revealTxid: prepared.revealTxId,
        network: 'regtest',
        sat: prepared.satoshi,
        confirmed: true,
        creation: {
          height: 1,
          blockHash,
          transactionIndex: 0,
          inscriptionIndex: 0,
        },
        body: {
          status: 'complete',
          mediaType: providerBody.mediaType,
          bytes: providerBody.bytes,
          metadata: null,
        },
      },
    ],
  };
}

function core(rawHexByTxid: Record<string, string>) {
  const calls: unknown[][] = [];
  const fetchImpl = (async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    calls.push([method, ...params]);
    if (method === 'getrawtransaction')
      return Response.json({ result: rawHexByTxid[params[0] as string] ?? null });
    throw new Error('unexpected method');
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('derives independent content from the reveal transaction witness, disagreeing with a substituted provider body', async () => {
  const content = new TextEncoder().encode('the real on-chain content');
  const prepared = await preparedReveal(content, 'text/plain');
  const forgedBody = new TextEncoder().encode('a compromised indexer served this instead');
  const snapshot = snapshotFor(prepared, { mediaType: 'text/plain', bytes: forgedBody });
  const mock = core({ [prepared.revealTxId]: prepared.revealTxHex });
  const validator = createBitcoinCoreContentValidator({
    endpoint: 'http://localhost:18443',
    fetchImpl: mock.fetchImpl,
  });
  const evidence = await validator(snapshot);
  expect(evidence).toEqual([
    {
      inscriptionId: prepared.inscriptionId,
      mediaType: 'text/plain',
      contentDigest: digestBytes(content),
    },
  ]);
  expect(evidence[0].contentDigest).not.toBe(digestBytes(forgedBody));
  expect(mock.calls).toEqual([['getrawtransaction', prepared.revealTxId, 0, 'b'.repeat(64)]]);
});

test('agrees when the provider honestly reports the same on-chain content', async () => {
  const content = new TextEncoder().encode('honest content');
  const prepared = await preparedReveal(content, 'text/plain');
  const snapshot = snapshotFor(prepared, { mediaType: 'text/plain', bytes: content });
  const mock = core({ [prepared.revealTxId]: prepared.revealTxHex });
  const evidence = await createBitcoinCoreContentValidator({
    endpoint: 'http://localhost:18443',
    fetchImpl: mock.fetchImpl,
  })(snapshot);
  expect(evidence[0].contentDigest).toBe(digestBytes(content));
});

test('caches raw transaction fetches per distinct reveal txid', async () => {
  const prepared = await preparedReveal(new TextEncoder().encode('once'), 'text/plain');
  const snapshot = snapshotFor(prepared, { mediaType: 'text/plain', bytes: new TextEncoder().encode('once') });
  // Two publications happen to share one reveal transaction: fetching it twice would be wasteful.
  snapshot.publications.push({ ...snapshot.publications[0] });
  const mock = core({ [prepared.revealTxId]: prepared.revealTxHex });
  const evidence = await createBitcoinCoreContentValidator({
    endpoint: 'http://localhost:18443',
    fetchImpl: mock.fetchImpl,
  })(snapshot);
  expect(evidence).toHaveLength(2);
  expect(mock.calls.filter((c) => c[0] === 'getrawtransaction')).toHaveLength(1);
});

test('leaves an inscription uncovered, rather than guessing, when no envelope is found at its index', async () => {
  const prepared = await preparedReveal(new TextEncoder().encode('x'), 'text/plain');
  const snapshot = snapshotFor(prepared, { mediaType: 'text/plain', bytes: new TextEncoder().encode('x') });
  // This reveal only carries inscription index 0; ask about index 1 instead.
  snapshot.publications[0].id = prepared.revealTxId + 'i1';
  const mock = core({ [prepared.revealTxId]: prepared.revealTxHex });
  const evidence = await createBitcoinCoreContentValidator({
    endpoint: 'http://localhost:18443',
    fetchImpl: mock.fetchImpl,
  })(snapshot);
  expect(evidence).toEqual([]);
});

test('skips unconfirmed and incomplete publications without consulting the node', async () => {
  const prepared = await preparedReveal(new TextEncoder().encode('x'), 'text/plain');
  const snapshot = snapshotFor(prepared, { mediaType: 'text/plain', bytes: new TextEncoder().encode('x') });
  snapshot.publications[0].confirmed = false;
  const mock = core({ [prepared.revealTxId]: prepared.revealTxHex });
  const evidence = await createBitcoinCoreContentValidator({
    endpoint: 'http://localhost:18443',
    fetchImpl: mock.fetchImpl,
  })(snapshot);
  expect(evidence).toEqual([]);
  expect(mock.calls).toEqual([]);
});

test('fails when the independent node is unreachable, rather than silently reporting no evidence', async () => {
  const prepared = await preparedReveal(new TextEncoder().encode('x'), 'text/plain');
  const snapshot = snapshotFor(prepared, { mediaType: 'text/plain', bytes: new TextEncoder().encode('x') });
  const fetchImpl = (async () => { throw new Error('connection refused'); }) as typeof fetch;
  await expect(
    createBitcoinCoreContentValidator({ endpoint: 'http://localhost:18443', fetchImpl })(snapshot),
  ).rejects.toMatchObject({ code: 'CONTENT_VALIDATOR_UNAVAILABLE' });
});

test('rejects URL credentials and a fragment in the configured endpoint', () => {
  expect(() =>
    createBitcoinCoreContentValidator({ endpoint: 'http://user:secret@localhost:18443' }),
  ).toThrow();
  expect(() =>
    createBitcoinCoreContentValidator({ endpoint: 'http://localhost:18443#frag' }),
  ).toThrow();
});

test('bounds total RPC calls', async () => {
  const first = await preparedReveal(new TextEncoder().encode('x'), 'text/plain');
  const snapshot = snapshotFor(first, { mediaType: 'text/plain', bytes: new TextEncoder().encode('x') });
  const second = await preparedReveal(new TextEncoder().encode('y'), 'text/plain');
  const blockHash = 'b'.repeat(64);
  snapshot.blocks[0].txids.push(second.revealTxId);
  snapshot.publications.push({
    ...snapshot.publications[0],
    id: second.inscriptionId,
    revealTxid: second.revealTxId,
    creation: { height: 1, blockHash, transactionIndex: 1, inscriptionIndex: 0 },
  });
  const mock = core({ [first.revealTxId]: first.revealTxHex, [second.revealTxId]: second.revealTxHex });
  await expect(
    createBitcoinCoreContentValidator({
      endpoint: 'http://localhost:18443',
      fetchImpl: mock.fetchImpl,
      maxRequests: 1,
    })(snapshot),
  ).rejects.toMatchObject({ code: 'CONTENT_VALIDATOR_BUDGET_EXCEEDED' });
});
