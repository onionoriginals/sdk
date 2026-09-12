import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { createLocalSigner, encodeDocument, type SatSnapshot } from '@originals/sdk/cel';
import { OriginalsSDK } from '@originals/sdk';
import type { OrdinalsProvider } from '@originals/sdk';
import { verifyMainnetExample, type MainnetReceipt } from './verify-mainnet-example';

const signer = createLocalSigner('Ed25519', new Uint8Array(32).fill(7));
const key = new Uint8Array(32).fill(3);
const payment = btc.p2wpkh(secp256k1.getPublicKey(key), btc.NETWORK);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
const blockHash = 'b'.repeat(64);

/**
 * Builds a real accepted mainnet boundary publication (genuine CEL signatures
 * and a genuine BitcoinPublications.prepare() output — no real broadcast) and
 * a fixture provider whose getSatSnapshot serves it, mirroring the SDK's own
 * packages/sdk/tests/unit/v3/bitcoin.test.ts fixture pattern.
 */
async function buildFixture(): Promise<{ receipt: MainnetReceipt; provider: OrdinalsProvider }> {
  const fundingUtxos = [
    {
      txid: '12'.repeat(32),
      vout: 0,
      value: 100_000,
      scriptPubKey: Buffer.from(payment.script).toString('hex'),
    },
  ];
  const sat = '500000000000000';
  const stored = new Map<string, { content: Uint8Array; contentType?: string }>();
  const snapshot: SatSnapshot = {
    network: 'mainnet',
    sat,
    tipBefore: { height: 900_000, hash: blockHash },
    tipAfter: { height: 900_000, hash: blockHash },
    indexTip: { height: 900_000, hash: blockHash },
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [],
    ownership: { owner: payment.address!, satpoint: fundingUtxos[0].txid + ':0:0' },
    publications: [],
  };
  const provider: OrdinalsProvider = {
    getFirstSatOfOutput: async () => sat,
    getSatSnapshot: async () => snapshot,
    getInscriptionById: async () => null,
    getInscriptionsBySatoshi: async () => [],
    broadcastTransaction: async () => {
      throw new Error('not used by this fixture');
    },
    getTransactionStatus: async () => {
      throw new Error('not used by this fixture');
    },
  };
  const sdk = OriginalsSDK.create({
    network: 'mainnet',
    signer,
    ordinalsProvider: provider,
    storageAdapter: {
      putObject: async (domain, path, content, options) => {
        stored.set(domain + '/' + path, { content: content.slice(), contentType: options?.contentType });
        return 'https://' + domain + '/' + path;
      },
      getObject: async (domain, path) => stored.get(domain + '/' + path) ?? null,
      exists: async (domain, path) => stored.has(domain + '/' + path),
    },
  });
  const local = await sdk.lifecycle.createAsset([
    { id: 'tla-logo.png', mediaType: 'image/png', content: png },
  ]);
  const { asset } = await sdk.lifecycle.publishToWeb(local, { domain: 'example.com' });
  const prepared = await sdk.lifecycle.prepareBitcoinPublication(asset, {
    fundingUtxos,
    satSigner: {
      signAndFinalizeCommitPsbt: async (psbt: string) => {
        const transaction = btc.Transaction.fromPSBT(Buffer.from(psbt, 'base64'), {
          allowUnknownOutputs: true,
        });
        transaction.sign(key);
        transaction.finalize();
        return transaction.hex;
      },
    },
    changeAddress: payment.address!,
    feeRate: 2,
  });
  const revealTxId = prepared.transactions.revealTxId;
  const inscriptionId = `${revealTxId}i0`;
  snapshot.blocks.push({ height: 900_000, hash: blockHash, txids: [revealTxId] });
  snapshot.publications.push({
    id: inscriptionId,
    revealTxid: revealTxId,
    network: 'mainnet',
    sat,
    confirmed: true,
    creation: { height: 900_000, blockHash, transactionIndex: 0, inscriptionIndex: 0 },
    body: {
      status: 'complete',
      mediaType: 'image/png',
      bytes: png,
      metadata: encodeDocument(prepared.document, 'cbor'),
    },
  });
  snapshot.ownership.satpoint = `${revealTxId}:0:0`;
  const receipt: MainnetReceipt = {
    assetDid: asset.id,
    didBtco: `did:btco:${sat}`,
    sat,
    inscriptionId,
    revealTxId,
    resource: {
      id: 'tla-logo.png',
      mediaType: 'image/png',
      byteLength: png.length,
      sha256: hex.encode(sha256(png)),
    },
    observedAt: new Date(0).toISOString(),
    sourceHref: 'https://example.com/evidence.json',
  };
  return { receipt, provider };
}

const arbitraryReceipt: MainnetReceipt = {
  assetDid: 'did:cel:uEiArbitraryArbitraryArbitraryArbitraryArbitraryArbi',
  didBtco: 'did:btco:123456789012345',
  sat: '123456789012345',
  inscriptionId: `${'a'.repeat(64)}i0`,
  revealTxId: 'a'.repeat(64),
  resource: { id: 'artwork.png', mediaType: 'image/png', byteLength: 10, sha256: 'a'.repeat(64) },
  observedAt: '2026-09-07T01:08:29.599Z',
  sourceHref: 'https://example.com/evidence.json',
};

describe('verifyMainnetExample', () => {
  test('a real accepted boundary publication is checked live and matches the receipt', async () => {
    const { receipt, provider } = await buildFixture();
    const result = await verifyMainnetExample({ receipt, provider });
    expect(result.live).toBe(true);
    expect(result.network).toBe('mainnet');
    expect(result.didBtco).toBe(receipt.didBtco);
    expect(result.inscriptionId).toBe(receipt.inscriptionId);
    expect(result.sat).toBe(receipt.sat);
    expect(result.resourceOnChain).toBe(true);
  });

  test('falls back to the retained receipt when the provider has no sat-snapshot capability (e.g. a signed-out visitor)', async () => {
    const provider: OrdinalsProvider = {
      getInscriptionById: async () => null,
      getInscriptionsBySatoshi: async () => [],
      broadcastTransaction: async () => {
        throw new Error('not used by this fixture');
      },
    };
    const result = await verifyMainnetExample({ receipt: arbitraryReceipt, provider });
    expect(result.live).toBe(false);
    expect(result.didBtco).toBe(arbitraryReceipt.didBtco);
    expect(result.inscriptionId).toBe(arbitraryReceipt.inscriptionId);
    expect(result.observedAt).toBe(arbitraryReceipt.observedAt);
  });

  test('falls back to the retained receipt when the live provider throws (e.g. an unauthenticated 401)', async () => {
    const provider: OrdinalsProvider = {
      getSatSnapshot: async () => {
        throw new Error('401 unauthorized');
      },
      getInscriptionById: async () => null,
      getInscriptionsBySatoshi: async () => [],
      broadcastTransaction: async () => {
        throw new Error('not used by this fixture');
      },
    };
    const result = await verifyMainnetExample({ receipt: arbitraryReceipt, provider });
    expect(result.live).toBe(false);
  });

  test('falls back to the retained receipt when the accepted chain state does not match the expected asset identity', async () => {
    const { receipt, provider } = await buildFixture();
    const mismatched: MainnetReceipt = { ...receipt, assetDid: 'did:cel:uEiWrongWrongWrongWrongWrongWrongWrongWrongWrong' };
    const result = await verifyMainnetExample({ receipt: mismatched, provider });
    expect(result.live).toBe(false);
    expect(result.didBtco).toBe(mismatched.didBtco);
  });

  test('never throws even when the provider itself is unreachable', async () => {
    const provider: OrdinalsProvider = {
      getSatSnapshot: async () => {
        throw new TypeError('Failed to fetch');
      },
      getInscriptionById: async () => {
        throw new Error('unreachable');
      },
      getInscriptionsBySatoshi: async () => {
        throw new Error('unreachable');
      },
      broadcastTransaction: async () => {
        throw new Error('unreachable');
      },
    };
    await expect(verifyMainnetExample({ receipt: arbitraryReceipt, provider })).resolves.toEqual(
      expect.objectContaining({ live: false }),
    );
  });
});
