/**
 * A small simulated chain for the landing's anchoring tests (plan 011, PR 10b):
 * real signed transactions, a mempool, blocks, one sat that moves with its
 * spends, and the sat reads ord would give. Not evidence of anything on a real
 * node — the regtest journey (scripts/regtest/landing-anchor.ts) is.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ORIGINALS_INSCRIPTION_TYPE } from '@originals/vh/originals';
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias } from '@originals/sdk/originals';
import type { BitcoinSigner, OrdinalsProvider, SatSnapshot } from '@originals/sdk';
import { createLocalAuthor } from '../../src/sdk/local-author';
import type { OrdinalLookup } from '../bitcoin';

export const SAT = '5000000000';
export const NETWORK = 'regtest' as const;
export const INDEX = 'ord-test';
export const BCRT = { ...btc.TEST_NETWORK, bech32: 'bcrt' };
const WALLET_PRIV = hex.decode('5'.repeat(64));
const wallet = btc.p2wpkh(secp256k1.getPublicKey(WALLET_PRIV, true), BCRT);
export const WALLET_ADDRESS = wallet.address!;
export const WALLET_SCRIPT = hex.encode(wallet.script);

/** The sat holder's key: signs every commit input, as the Turnkey deposit key does in the browser. */
export const walletSigner: BitcoinSigner = {
  signAndFinalizeCommitPsbt(psbt) {
    const tx = btc.Transaction.fromPSBT(base64.decode(psbt), { allowUnknownOutputs: true });
    tx.sign(WALLET_PRIV);
    tx.finalize();
    return Promise.resolve(tx.hex);
  },
};

const T = Date.parse('2026-10-22T12:00:00Z') / 1000;
const hashAt = (h: number) => h.toString(16).padStart(64, '0');
/** The simulated chain's header at a height: what Core's getblockheader gives (P9.15). */
export const blockHeader = (h: number) => ({ time: T + h * 600, hash: hashAt(h), ...(h > 0 ? { prev: hashAt(h - 1) } : {}) });
export const headerClock = () => new InscriptionClock(async (h) => blockHeader(h));

const parse = (raw: string) => btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownInputs: true, allowUnknownOutputs: true });

/** The body of an inscription envelope in a reveal's first input, or null. */
export function inscribedBody(raw: string): { contentType: string; body: Uint8Array } | null {
  const witness = parse(raw).getInput(0).finalScriptWitness;
  if (!witness || witness.length < 3) return null;
  const ops = btc.Script.decode(witness[witness.length - 2]);
  const start = ops.findIndex((op, k) => op === 'IF' && ops[k + 1] instanceof Uint8Array && new TextDecoder().decode(ops[k + 1] as Uint8Array) === 'ord');
  if (start < 0) return null;
  let k = start + 2;
  let contentType = '';
  const isZero = (op: unknown) => op === 0 || (op instanceof Uint8Array && op.length === 0);
  while (k < ops.length && !isZero(ops[k])) {
    const tag = ops[k];
    const value = ops[k + 1];
    const tagNum = typeof tag === 'number' ? tag : tag instanceof Uint8Array && tag.length === 1 ? tag[0] : -1;
    if (tagNum === 1 && value instanceof Uint8Array) contentType = new TextDecoder().decode(value);
    k += 2;
  }
  const chunks: Uint8Array[] = [];
  for (k = k + 1; k < ops.length && ops[k] !== 'ENDIF'; k++) if (ops[k] instanceof Uint8Array) chunks.push(ops[k] as Uint8Array);
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { body.set(c, o); o += c.length; }
  return { contentType, body };
}

export function fakeChain() {
  const txs = new Map<string, string>();
  const confirmedAt = new Map<string, number>();
  const mempool: string[] = [];
  const publications: SatSnapshot['publications'] = [];
  /** Outpoints carrying inscriptions on other sats (a foreign ordinal at the address). */
  const foreign = new Map<string, string[]>();
  let height = 100;
  let seq = 0;
  let holder = '';
  const sent: string[] = [];
  /** Throw on broadcasting the transaction with this id once (a crash or a refusal between commit and reveal). */
  const refuseOnce = new Set<string>();

  function fund(value: number): { txid: string; vout: number; value: number; scriptPubKey: string } {
    seq++;
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: seq.toString(16).padStart(64, '0'), index: 0, sequence: 0xfffffffd, witnessUtxo: { script: wallet.script, amount: BigInt(value) + 10_000n } });
    tx.addOutput({ script: wallet.script, amount: BigInt(value) });
    tx.sign(WALLET_PRIV);
    tx.finalize();
    const raw = hex.encode(tx.extract());
    txs.set(tx.id, raw);
    confirmedAt.set(tx.id, height);
    return { txid: tx.id, vout: 0, value, scriptPubKey: WALLET_SCRIPT };
  }

  /** The output first holding the sat: an uninscribed UTXO at the holder's address. */
  const satUtxo = fund(10_000);
  holder = `${satUtxo.txid}:0`;

  const spends = (raw: string) => {
    const tx = parse(raw);
    return Array.from({ length: tx.inputsLength }, (_, i) => {
      const input = tx.getInput(i);
      return `${hex.encode(input.txid!)}:${input.index}`;
    });
  };

  function snapshot(): SatSnapshot {
    const tip = { height, hash: hashAt(height) };
    return {
      network: NETWORK, sat: SAT, tipBefore: tip, tipAfter: tip, indexTip: tip, indexHealthy: true, enumerationComplete: true, blocks: [],
      publications: publications.map((p) => ({ ...p })),
      // ord names no satpoint for a sat that carries no inscription.
      ownership: publications.length > 0 ? { owner: WALLET_ADDRESS, satpoint: `${holder}:0` } : { owner: null, satpoint: null },
    };
  }

  const provider = {
    getSatSnapshot: () => Promise.resolve(snapshot()),
    getFirstSatOfOutput: ({ txid, vout }: { txid: string; vout: number }) =>
      `${txid}:${vout}` === holder ? Promise.resolve(SAT) : Promise.reject(new Error(`output ${txid}:${vout} is spent or unknown`)),
    getTransactionStatus: (txid: string) => {
      const h = confirmedAt.get(txid);
      return Promise.resolve(h !== undefined ? { confirmed: true, confirmations: height - h + 1, blockHeight: h, blockHash: hashAt(h) } : { confirmed: false, confirmations: 0, inMempool: mempool.includes(txid) });
    },
    broadcastTransaction: (raw: unknown) => {
      const id = parse(raw as string).id;
      if (refuseOnce.delete(id)) return Promise.reject(new Error('connection reset before the node answered'));
      sent.push(raw as string);
      txs.set(id, raw as string);
      if (!mempool.includes(id) && !confirmedAt.has(id)) mempool.push(id);
      return Promise.resolve(id);
    },
    estimateFee: () => Promise.resolve(2),
    estimateFeeRate: () => Promise.resolve(2),
  } as unknown as OrdinalsProvider;

  /** Confirm everything in the mempool, in order, in one block; the sat follows its spends. */
  function mine(blocks = 1) {
    for (let b = 0; b < blocks; b++) {
      height++;
      for (const id of mempool.splice(0)) {
        confirmedAt.set(id, height);
        const raw = txs.get(id)!;
        if (spends(raw)[0] === holder) {
          holder = `${id}:0`;
          const found = inscribedBody(raw);
          if (found && found.contentType === ORIGINALS_INSCRIPTION_TYPE) {
            publications.push({
              id: `${id}i0`, revealTxid: id, network: NETWORK, sat: SAT, confirmed: true,
              creation: { height, blockHash: hashAt(height), transactionIndex: 1, inscriptionIndex: 0 },
              body: { status: 'complete', mediaType: ORIGINALS_INSCRIPTION_TYPE, bytes: found.body, metadata: null },
            } as SatSnapshot['publications'][number]);
          }
        }
      }
    }
  }

  /** The holder's address's confirmed unspent outputs, Esplora-shaped. */
  function addressUtxos() {
    const spent = new Set<string>();
    for (const id of [...confirmedAt.keys(), ...mempool]) for (const o of spends(txs.get(id)!)) spent.add(o);
    const out: Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean; block_height: number } }> = [];
    for (const [id, h] of confirmedAt) {
      const tx = parse(txs.get(id)!);
      for (let v = 0; v < tx.outputsLength; v++) {
        const o = tx.getOutput(v);
        if (hex.encode(o.script!) === WALLET_SCRIPT && !spent.has(`${id}:${v}`)) out.push({ txid: id, vout: v, value: Number(o.amount), status: { confirmed: true, block_height: h } });
      }
    }
    return out;
  }

  /** The deposit indexer seam (Esplora REST) over this chain. */
  const indexerFetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const tx = url.pathname.match(/\/tx\/([0-9a-f]{64})\/hex$/)?.[1];
    if (tx) return txs.has(tx) ? new Response(txs.get(tx)!) : new Response('not found', { status: 404 });
    if (/\/address\/[^/]+\/utxo$/.test(url.pathname)) return Response.json(addressUtxos());
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const ordinals: OrdinalLookup = {
    async outpointInscriptions({ txid, vout }) {
      const key = `${txid}:${vout}`;
      return [...(key === holder ? publications.map((p) => p.id) : []), ...(foreign.get(key) ?? [])];
    },
  };

  /** The output now holding the sat, as a funding UTXO for the next inscription. */
  function holderUtxo() {
    const [txid, vout] = holder.split(':');
    const out = parse(txs.get(txid)!).getOutput(Number(vout));
    return { txid, vout: Number(vout), value: Number(out.amount), scriptPubKey: WALLET_SCRIPT };
  }

  return { provider, ordinals, indexerFetch, fund, mine, satUtxo, holderUtxo, sent, refuseOnce, foreign, publications, mempool, height: () => height };
}

/** An author's browser: a local did:vh author and an Original anchored to SAT (the anchoring entry, P9.10). */
export async function authorWithOriginal() {
  const author = await createLocalAuthor(new Date('2026-10-22T11:00:00Z'));
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => author.evidence });
  const created = await sdk.create({ name: 'Harbor', resources: [{ id: 'photo.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('one') }], author: author.ref, signer: author.signer });
  if (created.kind !== 'original') throw new Error('expected an Original');
  const did = created.original.did;
  const anchored = await sdk.anchor(did, { parent: created.original.checkpoint, author: author.ref, signer: author.signer, sat: btcoAlias(NETWORK, SAT) });
  const edit = async (name: string) => {
    const head = (await sdk.get(did)).checkpoint;
    return (await sdk.edit(did, { parent: head, name, author: author.ref, signer: author.signer })).original.checkpoint;
  };
  return { author, sdk, did, anchoring: anchored.original.checkpoint, edit };
}
