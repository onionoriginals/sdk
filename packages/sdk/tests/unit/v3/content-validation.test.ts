import { expect, test } from 'bun:test';
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';
import { CBOR } from 'micro-ordinals/lib/cbor.js';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
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
  metadata?: Record<string, unknown>,
): Promise<PreparedInscriptionOnSat> {
  return prepareInscriptionOnSat({
    buildContent: async () => ({ content, contentType, metadata }),
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
  providerBody: { mediaType: string; bytes: Uint8Array; metadata?: Uint8Array | null },
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
          metadata: providerBody.metadata ?? null,
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
      metadataDigest: null,
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

test('derives the metadata tag digest from the actual on-chain envelope, independent of what the provider reports', async () => {
  const content = new TextEncoder().encode('resource bytes');
  const onChainMetadata = { profile: 'originals/cel/3', head: 'real-head' };
  const prepared = await preparedReveal(content, 'image/png', onChainMetadata);
  // A compromised indexer reports different metadata than what is actually
  // encoded in the reveal transaction, while the main content still matches.
  const forgedMetadata = { profile: 'originals/cel/3', head: 'forged-head' };
  const snapshot = snapshotFor(prepared, {
    mediaType: 'image/png',
    bytes: content,
    metadata: CBOR.encode(forgedMetadata),
  });
  const mock = core({ [prepared.revealTxId]: prepared.revealTxHex });
  const evidence = await createBitcoinCoreContentValidator({
    endpoint: 'http://localhost:18443',
    fetchImpl: mock.fetchImpl,
  })(snapshot);
  expect(evidence[0].metadataDigest).toBe(digestBytes(CBOR.encode(onChainMetadata)));
  expect(evidence[0].metadataDigest).not.toBe(digestBytes(CBOR.encode(forgedMetadata)));
});

test('metadataDigest is null when the envelope carries no metadata tag', async () => {
  const content = new TextEncoder().encode('log-only body');
  const prepared = await preparedReveal(content, 'application/cel');
  const snapshot = snapshotFor(prepared, { mediaType: 'application/cel', bytes: content });
  const mock = core({ [prepared.revealTxId]: prepared.revealTxHex });
  const evidence = await createBitcoinCoreContentValidator({
    endpoint: 'http://localhost:18443',
    fetchImpl: mock.fetchImpl,
  })(snapshot);
  expect(evidence[0].metadataDigest).toBeNull();
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

test('collects inscriptions across multiple script-path inputs of one batch reveal', async () => {
  // A batch reveal spends its inscriptions across separate inputs; the
  // inscription index is global across the whole transaction, not scoped
  // to one input, so every script-path input must contribute its envelopes.
  const pubkey1 = schnorr.getPublicKey(new Uint8Array(32).fill(2));
  const pubkey2 = schnorr.getPublicKey(new Uint8Array(32).fill(3));
  const revealWitness = (pubkey: Uint8Array, inscription: { tags: { contentType: string }; body: Uint8Array }) => {
    const script = ordinals.p2tr_ord_reveal(pubkey, [inscription]).script;
    const fakeControl = new Uint8Array(33);
    fakeControl[0] = 0xc0;
    fakeControl.set(pubkey, 1);
    return [new Uint8Array(64).fill(1), script, fakeControl];
  };
  const first = { tags: { contentType: 'text/plain' }, body: new TextEncoder().encode('first') };
  const second = { tags: { contentType: 'text/plain' }, body: new TextEncoder().encode('second') };
  const tx = new btc.Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    allowLegacyWitnessUtxo: true,
    disableScriptCheck: true,
  });
  tx.addOutput({ script: new Uint8Array(34), amount: 1000n });
  tx.addInput({ txid: '11'.repeat(32), index: 0, finalScriptWitness: revealWitness(pubkey1, first) }, true);
  tx.addInput({ txid: '22'.repeat(32), index: 0, finalScriptWitness: revealWitness(pubkey2, second) }, true);
  const revealTxHex = Buffer.from(tx.toBytes(true, true)).toString('hex');
  const revealTxId = btc.Transaction.fromRaw(Buffer.from(revealTxHex, 'hex'), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  }).id;

  const blockHash = 'b'.repeat(64);
  const snapshot: SatSnapshot = {
    network: 'regtest',
    sat: '1250000000',
    tipBefore: { height: 1, hash: blockHash },
    tipAfter: { height: 1, hash: blockHash },
    indexTip: { height: 1, hash: blockHash },
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [{ height: 1, hash: blockHash, txids: [revealTxId] }],
    ownership: { owner: null, satpoint: null },
    publications: [0, 1].map((index) => ({
      id: `${revealTxId}i${index}`,
      revealTxid: revealTxId,
      network: 'regtest',
      sat: '1250000000',
      confirmed: true,
      creation: { height: 1, blockHash, transactionIndex: 0, inscriptionIndex: index },
      body: {
        status: 'complete',
        mediaType: 'text/plain',
        bytes: new TextEncoder().encode(index === 0 ? 'first' : 'second'),
        metadata: null,
      },
    })),
  };
  const mock = core({ [revealTxId]: revealTxHex });
  const evidence = await createBitcoinCoreContentValidator({
    endpoint: 'http://localhost:18443',
    fetchImpl: mock.fetchImpl,
  })(snapshot);
  expect(evidence).toEqual([
    { inscriptionId: `${revealTxId}i0`, mediaType: 'text/plain', contentDigest: digestBytes(first.body), metadataDigest: null },
    { inscriptionId: `${revealTxId}i1`, mediaType: 'text/plain', contentDigest: digestBytes(second.body), metadataDigest: null },
  ]);
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
