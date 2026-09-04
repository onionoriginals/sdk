/**
 * Dry-run a real inscription: build and sign the commit + reveal pair with the
 * code that ships, then refuse to broadcast (#526).
 *
 *   # Live reads (mainnet), a funded deposit address you hold the key for:
 *   BTC_NETWORK=mainnet QUICKNODE_ENDPOINT=... DRY_RUN_WIF=<compressed WIF> \
 *     bun run apps/landing/scripts/dry-run-inscription.ts
 *
 *   # No endpoint: the same path against the repo's mock provider and a fixture.
 *   BTC_NETWORK=mainnet bun run apps/landing/scripts/dry-run-inscription.ts
 *
 * What runs is the shipped path, not an analogue of it: the server's deposit,
 * fee, sat, prevtx and inscribe routes (`createBitcoinRoutes`), the browser's
 * `HttpOrdinalsProvider` + `TurnkeySatSigner` + `selectFundingUtxos`, and the
 * SDK's `inscribeOnBitcoin` → `inscribeOnSat` → commit/reveal builders. The
 * only substitution is the signature: a local key stands in for the Turnkey
 * API call (`DRY_RUN_WIF`), or, without one, the commit is left UNSIGNED and
 * the record says so.
 *
 * NEVER BROADCASTS, BY CONSTRUCTION. The provider the routes are built over
 * throws on every broadcast-shaped method, and `/api/btc/broadcast` is not
 * wired into the harness at all. The inscribe route therefore runs every
 * invariant, persists the pair, and fails at the broadcast step with the
 * sentinel below. Anything else (a 200, a txid) is reported as a FAILURE.
 *
 * Optional env: DRY_RUN_ADDRESS (deposit address; derived from the WIF when
 * given), DRY_RUN_PAYLOAD (a text file to inscribe; default: generated SVG),
 * DRY_RUN_CONTENT_TYPE, DRY_RUN_JSON (write the machine-readable report here).
 * Indexer env is the server's: BTC_INDEXER_API / BTC_INDEXER_TOKEN.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { base58check, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { OriginalsSDK, MemoryStorageAdapter, QuickNodeProvider } from '@originals/sdk';
import type { BitcoinSigner, OrdinalsProvider } from '@originals/sdk';
import { OrdMockProvider } from '@originals/sdk/testing';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../server/cookies';
import {
  createBitcoinRoutes,
  cachedOrdinalLookup,
  estimateInscriptionCostSats,
  indexerAuthHeaders,
  p2wpkhScriptHex,
  quickNodeOrdinalLookup,
  resolveIndexer,
  serverBtcNetwork,
  P2TR_OUTPUT_VB,
  P2WPKH_OUTPUT_VB,
  POSTAGE_SATS,
  type BtcNet,
  type IndexerConfig,
  type OrdinalLookup,
} from '../server/bitcoin';
import { createInscriptionsStore } from '../server/inscriptions-store';
import { createMoneyLogger } from '../server/money-log';
import { HttpOrdinalsProvider } from '../src/sdk/http-ordinals-provider';
import { TurnkeySatSigner } from '../src/sdk/turnkey-sat-signer';
import { addNonWitnessUtxos } from '../src/sdk/psbt-prevtx';
import { selectFundingUtxos, inscriptionContentBytes, type DepositInfo } from '../src/components/Demo';
import type { DemoAssetState } from '../src/sdk/engine';
import type { TurnkeyBitcoinClient } from '../src/auth/turnkey-session';
import { generateArtwork } from '../src/sdk/artwork';

export const BROADCAST_REFUSED_SENTINEL = 'DRY RUN: broadcast refused by construction; nothing was sent to the network';

/** Thrown by the wrapped provider for every method that would put bytes on the network. */
export class DryRunBroadcastRefused extends Error {
  readonly code = 'DRY_RUN_BROADCAST_REFUSED';
  constructor(readonly method: string) {
    super(`${BROADCAST_REFUSED_SENTINEL} (${method})`);
    this.name = 'DryRunBroadcastRefused';
  }
}

const REFUSED_METHODS = new Set(['broadcastTransaction', 'submitInscription', 'createInscription', 'transferInscription']);

/**
 * A provider that answers every READ from `inner` and throws on every method
 * that could spend. The routes are built over this, so "never broadcasts" is
 * a property of the object graph rather than of anyone's discipline.
 */
export function neverBroadcast<T extends OrdinalsProvider>(inner: T): { provider: T; attempts: string[] } {
  const attempts: string[] = [];
  const provider = new Proxy(inner, {
    get(target, prop, _receiver) {
      if (typeof prop === 'string' && REFUSED_METHODS.has(prop)) {
        return (..._args: unknown[]) => {
          attempts.push(prop);
          return Promise.reject(new DryRunBroadcastRefused(prop));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { provider, attempts };
}

export interface DryRunPayload {
  content: string;
  contentType: string;
  filename: string;
}

/** The world the routes read from: an endpoint and indexer, or the mock fixture. */
export interface DryRunWorld {
  /** The deposit address. Derived from `privateKey` when that is given. */
  address?: string;
  /** Signs the commit locally in place of the Turnkey API call. Absent: the commit is left unsigned. */
  privateKey?: Uint8Array;
  /** READ provider. It is wrapped by neverBroadcast before any route sees it. */
  readProvider: OrdinalsProvider;
  ordinals?: OrdinalLookup;
  indexer: IndexerConfig;
  /** The indexer's fetch (the routes' `fetchImpl`). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface DryRunOptions {
  network: BtcNet;
  /** 'mock' runs the repo's mock provider and fixture; 'live' reads the configured endpoint and indexer. */
  mode: 'mock' | 'live';
  payload: DryRunPayload;
  /**
   * The world, or a factory given the content-bytes hint the quote will be
   * sized from (the mock fixture sizes its deposit against it).
   */
  world: DryRunWorld | ((contentBytesHint: number) => DryRunWorld);
  /** The did:webvh domain the asset is published under before inscribing. */
  webvhDomain: string;
  dataDir?: string;
  /**
   * TEST-ONLY. Replaces the neverBroadcast guard so a test can prove the
   * harness fails loudly when a broadcast gets through. Never set otherwise.
   */
  unsafeGuardForTests?: typeof neverBroadcast;
}

export interface Check {
  id: string;
  label: string;
  result: 'pass' | 'fail' | 'skip';
  detail: string;
}

export interface TxSummary {
  hex: string;
  txid: string;
  vsize: number;
  weight: number;
  /** True when the transaction is unsigned and its size was estimated as if it were. */
  sizeEstimated: boolean;
  inputs: Array<{ outpoint: string; value: number | null; sequence: number; witnessItems: number }>;
  outputs: Array<{ vout: number; value: number; address: string; scriptType: string; scriptHex: string }>;
  feeSats: number | null;
  feeRateSatVb: number | null;
}

export interface DryRunReport {
  mode: 'mock' | 'live';
  network: BtcNet;
  address: string;
  signing: 'local-key' | 'unsigned';
  payload: { filename: string; contentType: string; bytes: number; sha256: string };
  asset: { didCel: string; didWebvh: string | null; contentBytesHint: number };
  fee: {
    rawEstimateSatVb: number | null;
    routeRateSatVb: number | null;
    bufferMultiplier: number;
    quotedCostSats: number | null;
    rederivedQuoteSats: number | null;
  };
  deposit: DepositInfo | null;
  depositError: string | null;
  candidates: Array<{
    outpoint: string;
    value: number;
    classification: 'clean' | 'inscribed' | 'unclassified';
    inscriptions: string[];
    selected: boolean;
    role: 'identity' | 'fee' | null;
  }>;
  selection: { selected: string[]; totalSats: number; shortfallSats: number } | null;
  satoshi: string | null;
  expectedDid: string | null;
  commit: TxSummary | null;
  reveal: TxSummary | null;
  envelope: {
    contentType: string | null;
    bodyBytes: number;
    bodySha256: string | null;
    metadataBytes: number;
    metadataNamesDid: boolean;
    controlBlockVersion: number | null;
    internalKey: string | null;
    rebuildsCommitOutput: boolean;
  } | null;
  freshness: { firstInternalKey: string | null; secondInternalKey: string | null; fundingKeyXOnly: string | null };
  server: {
    inscribeStatus: number | null;
    inscribeBody: Record<string, unknown> | null;
    recordStatus: string | null;
    broadcastAttempts: string[];
    broadcastRouteCalls: number;
    buildError: string | null;
    moneyLog: string[];
  };
  /** What the SDK printed while building (dust folded into fee, excluded UTXOs). */
  sdkNotes: string[];
  inscriptionId: string | null;
  checks: Check[];
  verdict: 'pass' | 'fail' | 'incomplete';
  recordDir: string;
}

const hexOf = (b: Uint8Array): string => hex.encode(b);
const sha256Hex = (bytes: Uint8Array): string => hexOf(sha256(bytes));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function scureNetwork(network: BtcNet): typeof btc.NETWORK {
  return network === 'mainnet' ? btc.NETWORK : btc.TEST_NETWORK;
}

function parseTx(txHex: string): btc.Transaction {
  return btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
}

function addressOf(script: Uint8Array, network: BtcNet): { address: string; type: string } {
  try {
    const decoded = btc.OutScript.decode(script);
    const codec = btc.Address(scureNetwork(network));
    return { address: codec.encode(decoded as Parameters<typeof codec.encode>[0]), type: decoded.type };
  } catch {
    return { address: '(undecodable)', type: 'unknown' };
  }
}

/** A raw transaction, summarized for the record. `inputValues` prices the fee when known. */
export function summarizeTx(txHex: string, network: BtcNet, inputValues: Array<number | null>): TxSummary {
  const tx = parseTx(txHex);
  const inputs: TxSummary['inputs'] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    inputs.push({
      outpoint: `${input.txid ? hexOf(input.txid) : '?'}:${input.index ?? '?'}`,
      value: inputValues[i] ?? null,
      sequence: input.sequence ?? 0xffffffff,
      witnessItems: input.finalScriptWitness?.length ?? 0,
    });
  }
  const outputs: TxSummary['outputs'] = [];
  let outSum = 0;
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const script = out.script ?? new Uint8Array();
    const value = Number(out.amount ?? 0n);
    outSum += value;
    const { address, type } = addressOf(script, network);
    outputs.push({ vout: i, value, address, scriptType: type, scriptHex: hexOf(script) });
  }
  const allKnown = inputValues.length === tx.inputsLength && inputValues.every((v) => typeof v === 'number');
  const inSum = allKnown ? (inputValues as number[]).reduce((n, v) => n + v, 0) : null;
  const feeSats = inSum === null ? null : inSum - outSum;
  // An UNSIGNED commit has no witness yet; size it as if each P2WPKH input
  // carried one (108 witness bytes, plus the marker and flag), so its fee rate
  // is judged against the size that would actually relay.
  let weight: number;
  if (tx.isFinal) {
    weight = tx.weight;
  } else {
    const unsigned = inputs.filter((i) => i.witnessItems === 0).length;
    weight = txHex.length / 2 * 4 + unsigned * 108 + 2;
  }
  const vsize = Math.ceil(weight / 4);
  return {
    hex: txHex,
    txid: tx.id,
    vsize,
    weight,
    sizeEstimated: !tx.isFinal,
    inputs,
    outputs,
    feeSats,
    feeRateSatVb: feeSats === null ? null : Math.round((feeSats / vsize) * 100) / 100,
  };
}

/**
 * The inscription envelope, read back out of the reveal's leaf script:
 * `<key> CHECKSIG OP_0 IF "ord" <1> <contentType> [<5> <metadata>…] OP_0 <body>… ENDIF`.
 * Read with a generic script decoder rather than the library that wrote it,
 * so the check compares bytes against the payload instead of trusting a
 * round-trip through the same code.
 */
export function decodeEnvelope(leafScript: Uint8Array): { contentType: string | null; body: Uint8Array; metadata: Uint8Array } {
  const ops = btc.Script.decode(leafScript) as Array<string | number | Uint8Array>;
  const isBytes = (o: unknown): o is Uint8Array => o instanceof Uint8Array;
  const start = ops.findIndex((o, i) => isBytes(o) && hexOf(o) === hexOf(utf8('ord')) && ops[i - 1] === 'IF');
  if (start < 0) throw new Error('no ord envelope in the reveal leaf script');
  let contentType: string | null = null;
  const metadata: Uint8Array[] = [];
  const body: Uint8Array[] = [];
  let inBody = false;
  for (let j = start + 1; j < ops.length && ops[j] !== 'ENDIF'; j++) {
    const op = ops[j];
    if (inBody) {
      if (isBytes(op)) body.push(op);
      continue;
    }
    if (op === 0) {
      inBody = true;
      continue;
    }
    // A tag key, then its value.
    const tag = isBytes(op) && op.length === 1 ? op[0] : typeof op === 'number' ? op : -1;
    const value = ops[j + 1];
    j++;
    if (!isBytes(value)) continue;
    if (tag === 1) contentType = new TextDecoder().decode(value);
    else if (tag === 5) metadata.push(value);
  }
  const concat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  };
  return { contentType, body: concat(body), metadata: concat(metadata) };
}

/** A compressed WIF for `network` → 32-byte private key. Mirrors rawKeyFaucetSigner's checks. */
export function privateKeyFromWif(wif: string, network: BtcNet): Uint8Array {
  const raw = base58check(sha256).decode(wif.trim());
  const expected = network === 'mainnet' ? 0x80 : 0xef;
  if (raw[0] !== expected) {
    throw new Error(`DRY_RUN_WIF is not a ${network} WIF (version 0x${raw[0].toString(16)}, expected 0x${expected.toString(16)}).`);
  }
  if (raw.length !== 34 || raw[33] !== 0x01) {
    throw new Error('DRY_RUN_WIF must be a COMPRESSED WIF (P2WPKH needs a compressed key).');
  }
  return raw.slice(1, 33);
}

export function p2wpkhAddressOf(privateKey: Uint8Array, network: BtcNet): string {
  const pub = secp256k1.getPublicKey(privateKey, true);
  return btc.p2wpkh(pub, scureNetwork(network)).address!;
}

/**
 * Stands in for the Turnkey API: signs the PSBT with a local key and returns
 * it still unfinalized, exactly the shape Turnkey returns. TurnkeySatSigner
 * then runs unchanged (prevtx attachment, finalization).
 */
function localKeyClient(privateKey: Uint8Array): TurnkeyBitcoinClient {
  const unused = (name: string) => () => Promise.reject(new Error(`dry run: ${name} is not part of signing a commit`));
  return {
    async signTransaction({ unsignedTransaction }: { unsignedTransaction: string }) {
      const tx = btc.Transaction.fromPSBT(hex.decode(unsignedTransaction), { allowUnknownInputs: true, allowUnknownOutputs: true });
      tx.sign(privateKey);
      return { signedTransaction: hex.encode(tx.toPSBT()) };
    },
    createWalletAccounts: unused('createWalletAccounts'),
    getWallets: unused('getWallets'),
    getWalletAccounts: unused('getWalletAccounts'),
  } as unknown as TurnkeyBitcoinClient;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * No key: attach the previous transactions the way the shipped signer would,
 * then hand back the UNSIGNED transaction as raw hex. The funding inputs are
 * segwit, so the txid is witness-independent and the reveal builds on it.
 */
function unsignedSigner(fetchRawTx: (txid: string) => Promise<string>): BitcoinSigner {
  return {
    async signAndFinalizeCommitPsbt(psbtBase64) {
      const { base64 } = await import('@scure/base');
      const withPrev = await addNonWitnessUtxos(psbtBase64, fetchRawTx);
      const tx = btc.Transaction.fromPSBT(base64.decode(withPrev), { allowUnknownInputs: true, allowUnknownOutputs: true });
      return hex.encode(tx.unsignedTx);
    },
  };
}

/** The payload, from DRY_RUN_PAYLOAD or the demo's generated artwork. */
export function resolvePayload(env: Record<string, string | undefined>): DryRunPayload {
  const path = env.DRY_RUN_PAYLOAD;
  if (!path) {
    const art = generateArtwork('Dry run', 'Artwork', 526);
    return { content: art.svg, contentType: 'image/svg+xml', filename: 'artwork.svg' };
  }
  const bytes = readFileSync(path);
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not UTF-8 text. The landing inscribes text-shaped bytes only (SVG, text, JSON); binary payloads are #540.`);
  }
  const byExt: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.md': 'text/plain',
    '.json': 'application/json',
    '.html': 'text/html',
  };
  const contentType = env.DRY_RUN_CONTENT_TYPE ?? byExt[extname(path).toLowerCase()];
  if (!contentType) throw new Error(`Set DRY_RUN_CONTENT_TYPE for ${path} (no default for ${extname(path) || 'no extension'}).`);
  return { content, contentType, filename: path.split('/').pop() ?? 'payload' };
}

/**
 * The mock world: a fixture key, a fake confirmed deposit paying that key
 * three times (two clean outputs sized so the quote needs BOTH, plus a
 * 546-sat output carrying an inscription that must never be selected), an
 * Esplora-shaped indexer serving it, an ordinal lookup that knows which
 * output is inscribed, and the repo's OrdMockProvider for sat + fee reads.
 */
export function mockFixture(opts: { network: BtcNet; privateKey?: Uint8Array; contentBytes: number; ordinals?: OrdinalLookup | null }): DryRunWorld & { address: string; depositTxid: string; values: number[]; inscribedOutpoint: string } {
  const privateKey = opts.privateKey ?? hex.decode('5'.repeat(64));
  const address = p2wpkhAddressOf(privateKey, opts.network);
  const provider = new OrdMockProvider();
  const feeRate = 5; // OrdMockProvider's default estimate
  const oneInput = estimateInscriptionCostSats({ feeRate, inputs: 1, contentBytes: opts.contentBytes, commitOutputsVB: [P2TR_OUTPUT_VB, P2WPKH_OUTPUT_VB] });
  const twoInputs = estimateInscriptionCostSats({ feeRate, inputs: 2, contentBytes: opts.contentBytes, commitOutputsVB: [P2TR_OUTPUT_VB, P2WPKH_OUTPUT_VB] });
  // Largest alone falls short of the one-input quote; together they clear the two-input quote.
  const largest = Math.ceil(oneInput * 0.8);
  const values = [largest, twoInputs - largest + 1_500, 546];
  const deposit = new btc.Transaction();
  deposit.addInput({ txid: '11'.repeat(32), index: 0 });
  for (const v of values) deposit.addOutputAddress(address, BigInt(v), scureNetwork(opts.network));
  const depositHex = hex.encode(deposit.unsignedTx);
  const depositTxid = parseTx(depositHex).id;
  const inscribedOutpoint = `${depositTxid}:2`;
  const utxos = values.map((value, vout) => ({ txid: depositTxid, vout, value, status: { confirmed: true } }));
  const indexer: IndexerConfig = { api: 'https://indexer.mock' };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === `/address/${address}/utxo`) return Response.json(utxos);
    if (url.pathname === `/tx/${depositTxid}/hex`) return new Response(depositHex);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  const ordinals: OrdinalLookup | undefined =
    opts.ordinals === null
      ? undefined
      : opts.ordinals ?? {
          async outpointInscriptions(o) {
            return `${o.txid}:${o.vout}` === inscribedOutpoint ? [`${'e'.repeat(64)}i0`] : [];
          },
        };
  return { privateKey, address, readProvider: provider, ordinals, indexer, fetchImpl, depositTxid, values, inscribedOutpoint };
}

/** Auth cookie for a route call, as the browser session would carry it. */
function sessionCookie(sub: string, secret: string): string {
  return serializeCookie(getAuthCookieConfig(signToken(sub, 'dry-run@localhost', undefined, { secret })));
}

function sdkFor(network: BtcNet, provider: OrdinalsProvider, keys: Map<string, string>): ReturnType<typeof OriginalsSDK.create> {
  return OriginalsSDK.create({
    network,
    webvhNetwork: network === 'mainnet' ? 'pichu' : 'cleffa',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    storageAdapter: new MemoryStorageAdapter(),
    enableLogging: false,
    logging: { level: 'error' },
    keyStore: {
      async getPrivateKey(id: string) { return keys.get(id) ?? null; },
      async setPrivateKey(id: string, key: string) { keys.set(id, key); },
      getAllVerificationMethodIds() { return [...keys.keys()]; },
    },
  } as unknown as Parameters<typeof OriginalsSDK.create>[0]);
}

export async function runDryRun(opts: DryRunOptions): Promise<DryRunReport> {
  // The SDK's builders print operational notes (dust folded into the fee,
  // excluded UTXOs); keep them in the record instead of interleaved with it.
  const sdkNotes: string[] = [];
  const realConsole = { log: console.log, warn: console.warn, info: console.info, error: console.error };
  const capture = (...args: unknown[]) => { sdkNotes.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.info = capture;
  console.error = capture;
  try {
    return await runDryRunInner(opts, sdkNotes);
  } finally {
    console.log = realConsole.log;
    console.warn = realConsole.warn;
    console.info = realConsole.info;
    console.error = realConsole.error;
  }
}

async function runDryRunInner(opts: DryRunOptions, sdkNotes: string[]): Promise<DryRunReport> {
  const { network, mode, payload } = opts;
  const net = scureNetwork(network);

  // 1. The asset, exactly as the demo makes it: payload + metadata.json, then
  //    published. The provider's fetch is bound once the routes exist below.
  let routeFetchImpl: FetchLike = () => Promise.reject(new Error('dry run: routes not built yet'));
  const keys = new Map<string, string>();
  const sdkProvider = new HttpOrdinalsProvider({ baseUrl: 'http://dry-run.local', fetchImpl: ((i, init) => routeFetchImpl(i, init)) as typeof fetch });
  const sdk = sdkFor(network, sdkProvider, keys);
  const payloadBytes = utf8(payload.content);
  const payloadHash = sha256Hex(payloadBytes);
  const metadata = JSON.stringify(
    { title: 'Dry run', medium: 'Artwork', creator: 'dry-run-inscription', created: new Date().toISOString(), artwork: { file: payload.filename, sha256: payloadHash } },
    null,
    2
  );
  const asset = await sdk.lifecycle.createAsset([
    { id: payload.filename, type: payload.contentType.startsWith('image/') ? 'image' : 'text', content: payload.content, contentType: payload.contentType, hash: payloadHash, size: payloadBytes.length },
    { id: 'metadata.json', type: 'data', content: metadata, contentType: 'application/json', hash: sha256Hex(utf8(metadata)), size: utf8(metadata).length },
  ]);
  await sdk.lifecycle.publishToWeb(asset, opts.webvhDomain);
  const didWebvh = (asset.bindings as Record<string, string> | undefined)?.['did:webvh'] ?? null;
  const contentBytesHint = inscriptionContentBytes({
    resource: { content: payload.content },
    metadata: { content: metadata },
    celLog: asset.celLog?.events ?? [],
  } as unknown as DemoAssetState);

  const world = typeof opts.world === 'function' ? opts.world(contentBytesHint) : opts.world;
  const address = world.privateKey ? p2wpkhAddressOf(world.privateKey, network) : world.address;
  if (!address) throw new Error('A deposit address is required: set DRY_RUN_ADDRESS or DRY_RUN_WIF.');
  if (world.address && world.privateKey && world.address !== address) {
    throw new Error(`DRY_RUN_ADDRESS (${world.address}) is not the address of DRY_RUN_WIF (${address}).`);
  }
  const depositScript = p2wpkhScriptHex(address, network);
  const fundingKeyXOnly = world.privateKey ? hexOf(secp256k1.getPublicKey(world.privateKey, true).slice(1)) : null;

  // 2. The server, built over a provider that cannot spend.
  const { provider, attempts } = (opts.unsafeGuardForTests ?? neverBroadcast)(world.readProvider);
  const jwtSecret = hexOf(secp256k1.utils.randomSecretKey());
  const recordDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'dry-run-inscription-'));
  const store = createInscriptionsStore({ dataDir: recordDir });
  const moneyLog: string[] = [];
  const routes = createBitcoinRoutes({
    jwtSecret,
    provider,
    network,
    indexer: world.indexer,
    ordinals: world.ordinals,
    inscriptions: store,
    moneyLog: createMoneyLogger((line) => moneyLog.push(line)),
    fetchImpl: world.fetchImpl,
  });
  // Only these five are reachable. The broadcast route is deliberately not here.
  const { deposit, fee, sat, prevTx, inscribe } = routes;

  const captured = {
    inscribeStatus: null as number | null,
    inscribeBody: null as Record<string, unknown> | null,
    inscribeRequest: null as { signedCommitHex: string; revealTxHex: string; fundingUtxos: Array<{ txid: string; vout: number; value: number }>; changeAddress: string } | null,
    satoshi: null as string | null,
    broadcastRouteCalls: 0,
  };
  const routeFetch = (sub: string): typeof fetch => {
    const cookie = sessionCookie(sub, jwtSecret);
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers ?? {});
      headers.set('cookie', cookie);
      const req = new Request(url, { method: init?.method ?? 'GET', headers, body: init?.body ?? null });
      switch (url.pathname) {
        case '/api/btc/deposit':
          return deposit(req, url, 'dry-run');
        case '/api/btc/fee':
          return fee(req, url, 'dry-run');
        case '/api/btc/prevtx':
          return prevTx(req, url, 'dry-run');
        case '/api/btc/sat': {
          const res = await sat(req, url, 'dry-run');
          if (res.ok) captured.satoshi = ((await res.clone().json()) as { satoshi: string }).satoshi;
          return res;
        }
        case '/api/btc/inscribe': {
          const text = typeof init?.body === 'string' ? init.body : '';
          captured.inscribeRequest = JSON.parse(text) as typeof captured.inscribeRequest;
          const res = await inscribe(new Request(url, { method: 'POST', headers, body: text }), url, 'dry-run');
          captured.inscribeStatus = res.status;
          captured.inscribeBody = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
          return res;
        }
        case '/api/btc/broadcast':
          captured.broadcastRouteCalls++;
          throw new Error(`${BROADCAST_REFUSED_SENTINEL} (/api/btc/broadcast is not wired in the dry run)`);
        default:
          throw new Error(`dry run: unexpected route ${url.pathname}`);
      }
    }) as typeof fetch;
  };

  const checks: Check[] = [];
  const check = (id: string, label: string, ok: boolean, detail: string): void => {
    checks.push({ id, label, result: ok ? 'pass' : 'fail', detail });
  };
  const skip = (id: string, label: string, detail: string): void => {
    checks.push({ id, label, result: 'skip', detail });
  };
  routeFetchImpl = routeFetch('dry-run');
  const browserFetch = routeFetchImpl;

  // 3. The fee source, raw and as the route serves it.
  let rawEstimate: number | null = null;
  let rawEstimateError: string | null = null;
  try {
    rawEstimate = await provider.estimateFee(1);
  } catch (e) {
    rawEstimateError = (e as Error).message;
  }
  let routeRate: number | null = null;
  const feeRes = await browserFetch('http://dry-run.local/api/btc/fee', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blocks: 1 }) });
  if (feeRes.ok) routeRate = ((await feeRes.json()) as { feeRate: number }).feeRate;
  check('fee.source', 'Live fee estimate is readable and sane (1..10000 sat/vB)', routeRate !== null && routeRate >= 1 && routeRate <= 10_000, routeRate === null ? `fee route ${feeRes.status}: ${await feeRes.text()}${rawEstimateError ? `; raw estimate failed: ${rawEstimateError}` : ''}` : `raw estimate ${rawEstimate} sat/vB → route serves ceil = ${routeRate} sat/vB`);

  // 4. The deposit read: the ORDINAL-CHECKED spendable set and the buffered quote.
  const depRes = await browserFetch(`http://dry-run.local/api/btc/deposit?address=${encodeURIComponent(address)}&contentBytes=${contentBytesHint}`);
  const depositInfo = depRes.ok ? ((await depRes.json()) as DepositInfo) : null;
  const depositError = depRes.ok ? null : `${depRes.status} ${await depRes.text()}`;
  let picked: ReturnType<typeof selectFundingUtxos> | null = null;
  const candidates: DryRunReport['candidates'] = [];
  if (depositInfo) {
    picked = selectFundingUtxos(depositInfo.confirmedUtxos, depositInfo.estimatedCostSats);
    const selectedSet = new Map(picked.selected.map((u, i) => [`${u.txid}:${u.vout}`, i]));
    // Every confirmed output at the address, classified one by one for the record.
    type IndexerUtxo = { txid: string; vout: number; value: number; status?: { confirmed?: boolean } };
    const all = await (world.fetchImpl ?? fetch)(`${world.indexer.api}/address/${address}/utxo`, { headers: indexerAuthHeaders(world.indexer) })
      .then((r) => (r.ok ? (r.json() as Promise<IndexerUtxo[]>) : []))
      .catch(() => [] as IndexerUtxo[]);
    for (const u of all.filter((x) => x.status?.confirmed)) {
      let inscriptions: string[] = [];
      let classification: 'clean' | 'inscribed' | 'unclassified' = 'unclassified';
      if (world.ordinals) {
        try {
          inscriptions = await world.ordinals.outpointInscriptions(u);
          classification = inscriptions.length > 0 ? 'inscribed' : 'clean';
        } catch { /* stays unclassified */ }
      }
      const key = `${u.txid}:${u.vout}`;
      const idx = selectedSet.get(key);
      candidates.push({ outpoint: key, value: u.value, classification, inscriptions, selected: idx !== undefined, role: idx === undefined ? null : idx === 0 ? 'identity' : 'fee' });
    }
  }
  check('deposit.read', 'Deposit route serves an ordinal-checked spendable set', !!depositInfo && depositInfo.ordinalCheck === 'ok', depositInfo ? `ordinalCheck=${depositInfo.ordinalCheck}, ${depositInfo.confirmedUtxos.length} spendable of ${candidates.length} confirmed, quote ${depositInfo.estimatedCostSats} sats for ${contentBytesHint} content bytes` : `deposit route failed: ${depositError}`);
  check('selection.funded', 'Largest-first selection covers the buffered quote', !!picked && picked.shortfallSats === 0 && picked.selected.length > 0, picked ? `${picked.selected.length} input(s), ${picked.totalSats} sats against a ${depositInfo?.estimatedCostSats} sat quote${picked.shortfallSats ? `, short by ${picked.shortfallSats}` : ''}` : 'no deposit read');
  check('selection.clean', 'No selected input carries an inscription; the inscribed one is excluded', candidates.some((c) => c.selected) && candidates.filter((c) => c.selected).every((c) => c.classification === 'clean') && candidates.filter((c) => c.classification === 'inscribed').every((c) => !c.selected), candidates.map((c) => `${c.outpoint} ${c.value} sats ${c.classification}${c.selected ? ` SELECTED(${c.role})` : ''}`).join('; ') || 'no candidates');

  const report: DryRunReport = {
    mode,
    network,
    address,
    signing: world.privateKey ? 'local-key' : 'unsigned',
    payload: { filename: payload.filename, contentType: payload.contentType, bytes: payloadBytes.length, sha256: payloadHash },
    asset: { didCel: asset.id, didWebvh, contentBytesHint },
    fee: { rawEstimateSatVb: rawEstimate, routeRateSatVb: routeRate, bufferMultiplier: 1.5, quotedCostSats: depositInfo?.estimatedCostSats ?? null, rederivedQuoteSats: null },
    deposit: depositInfo,
    depositError,
    candidates,
    selection: picked ? { selected: picked.selected.map((u) => `${u.txid}:${u.vout}`), totalSats: picked.totalSats, shortfallSats: picked.shortfallSats } : null,
    satoshi: null,
    expectedDid: null,
    commit: null,
    reveal: null,
    envelope: null,
    freshness: { firstInternalKey: null, secondInternalKey: null, fundingKeyXOnly },
    server: { inscribeStatus: null, inscribeBody: null, recordStatus: null, broadcastAttempts: attempts, broadcastRouteCalls: 0, buildError: null, moneyLog },
    sdkNotes,
    inscriptionId: null,
    checks,
    verdict: 'fail',
    recordDir,
  };
  if (!picked || picked.shortfallSats > 0 || picked.selected.length === 0) {
    report.verdict = 'fail';
    return report;
  }
  const selection = picked;
  if (routeRate !== null && depositInfo) {
    report.fee.rederivedQuoteSats = estimateInscriptionCostSats({ feeRate: routeRate, inputs: selection.selected.length, contentBytes: contentBytesHint, commitOutputsVB: [P2TR_OUTPUT_VB, P2WPKH_OUTPUT_VB] });
  }

  // 4. Build and sign through the shipped browser path; the server refuses at broadcast.
  const fetchRawTx = async (txid: string): Promise<string> => {
    const res = await browserFetch(`http://dry-run.local/api/btc/prevtx?txid=${txid}`);
    if (!res.ok) throw new Error(`prevtx route ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { hex: string }).hex;
  };
  const satSigner: BitcoinSigner = world.privateKey
    ? new TurnkeySatSigner({ client: localKeyClient(world.privateKey), signWith: address, fetchRawTx })
    : unsignedSigner(fetchRawTx);
  const build = async (signer: BitcoinSigner): Promise<{ error: unknown | null }> => {
    try {
      await sdk.lifecycle.inscribeOnBitcoin(asset, { fundingUtxos: selection.selected, satSigner: signer, changeAddress: address });
      return { error: null };
    } catch (e) {
      return { error: e };
    }
  };
  const first = await build(satSigner);
  const err = first.error as { code?: string; message?: string; details?: Record<string, unknown> } | null;
  const submitted = captured.inscribeRequest;
  report.server.inscribeStatus = captured.inscribeStatus;
  report.server.inscribeBody = captured.inscribeBody;
  report.server.broadcastRouteCalls = captured.broadcastRouteCalls;
  report.satoshi = captured.satoshi;
  report.expectedDid = captured.satoshi ? `${network === 'mainnet' ? 'did:btco' : 'did:btco:test'}:${captured.satoshi}` : null;

  const loud = first.error === null;
  check('never.broadcast', 'The build was refused at the broadcast step and nowhere else', !loud && err?.code === 'INSCRIPTION_SUBMIT_FAILED' && attempts.length >= 1 && captured.broadcastRouteCalls === 0 && String(captured.inscribeBody?.message ?? '').includes(BROADCAST_REFUSED_SENTINEL), loud ? 'FAILURE: inscribeOnBitcoin RESOLVED, which means the pair reached the network. This must never happen in a dry run.' : `provider refusals: ${attempts.join(',') || 'none'}; /api/btc/broadcast calls: ${captured.broadcastRouteCalls}; SDK error: ${err?.code ?? 'none'}${err?.code !== 'INSCRIPTION_SUBMIT_FAILED' ? ` (${err?.message ?? ''})` : ''}`);
  if (!submitted) {
    report.server.buildError = err?.message ?? String(first.error);
    check('server.reached', 'The signed pair reached the inscribe route', false, `nothing was submitted: ${report.server.buildError}`);
    return report;
  }
  report.inscriptionId = typeof err?.details?.inscriptionId === 'string' ? (err.details.inscriptionId as string) : `${parseTx(submitted.revealTxHex).id}i0`;

  // 5. The server's verdict: every invariant passed iff it got as far as broadcasting.
  const body = captured.inscribeBody ?? {};
  const record = (() => { try { return store.get('dry-run', String(body.commitTxId ?? '')); } catch { return null; } })();
  report.server.recordStatus = record?.status ?? null;
  check('server.invariants', 'Inscribe route accepted the pair (inputs, outputs, change, ordinal check, binding)', captured.inscribeStatus === 502 && body.error === 'commit_broadcast_failed', `route answered ${captured.inscribeStatus} ${JSON.stringify({ error: body.error, message: body.message })}`);
  check('server.persisted', 'Pair persisted as status=signed before any broadcast was attempted', record?.status === 'signed' && record.signedCommitHex === submitted.signedCommitHex && record.revealTxHex === submitted.revealTxHex, record ? `record ${record.commitTxId} status=${record.status} at ${recordDir}` : 'no record');

  // 6. The transactions themselves.
  const selectedValues = selection.selected.map((u) => u.value);
  const commit = summarizeTx(submitted.signedCommitHex, network, selectedValues);
  report.commit = commit;
  const reveal = summarizeTx(submitted.revealTxHex, network, [commit.outputs[0]?.value ?? null]);
  report.reveal = reveal;
  const feeRate = routeRate ?? 0;

  check('commit.inputs', 'Commit spends exactly the selected set, identity input first', commit.inputs.length === selection.selected.length && commit.inputs.every((i, n) => i.outpoint === `${selection.selected[n].txid}:${selection.selected[n].vout}`), commit.inputs.map((i, n) => `#${n} ${i.outpoint} (${i.value} sats)`).join('; '));
  check('commit.rbf', 'Every commit input signals RBF (sequence 0xfffffffd)', commit.inputs.every((i) => i.sequence === 0xfffffffd), commit.inputs.map((i) => `0x${i.sequence.toString(16)}`).join(', '));
  const out0 = commit.outputs[0];
  check('commit.output0', 'Commit output 0 is P2TR and funds reveal fee + postage', !!out0 && out0.scriptType === 'tr' && out0.value >= POSTAGE_SATS + (reveal.feeSats ?? 0), out0 ? `vout 0 → ${out0.address} (${out0.scriptType}) ${out0.value} sats` : 'no output 0');
  const change = commit.outputs[1];
  check('commit.change', 'Change (if any) returns to the deposit address; no third output', commit.outputs.length <= 2 && (!change || change.scriptHex === depositScript), change ? `vout 1 → ${change.address} ${change.value} sats` : 'no change output (leftover folded into the fee)');
  check('commit.feerate', 'Commit pays at least the live rate', commit.feeSats !== null && commit.feeRateSatVb !== null && commit.feeRateSatVb >= feeRate, `${commit.feeSats} sats over ${commit.vsize} vB = ${commit.feeRateSatVb} sat/vB (rate ${feeRate})`);
  const commitTx = parseTx(submitted.signedCommitHex);
  if (world.privateKey) {
    const signedOk = commit.inputs.every((_, n) => {
      const w = commitTx.getInput(n).finalScriptWitness;
      if (!w || w.length !== 2) return false;
      return btc.p2wpkh(w[1], net).address === address;
    });
    check('commit.signed', 'Commit is signed and finalized; witness keys match the deposit address', signedOk, commit.inputs.map((i) => `${i.witnessItems} witness items`).join(', '));
  } else {
    skip('commit.signed', 'Commit is signed and finalized', 'UNSIGNED: no DRY_RUN_WIF, so the commit carries no witness. Structure only; the txid is unaffected.');
  }

  check('reveal.spends', 'Reveal spends commit:0 as its only input', reveal.inputs.length === 1 && reveal.inputs[0].outpoint === `${commit.txid}:0`, reveal.inputs.map((i) => i.outpoint).join(', '));
  check('reveal.rbf', 'Reveal input signals RBF', reveal.inputs.every((i) => i.sequence === 0xfffffffd), reveal.inputs.map((i) => `0x${i.sequence.toString(16)}`).join(', '));
  const rout = reveal.outputs[0];
  check('reveal.postage', 'Inscribed sat lands at the deposit address with at least dust postage', reveal.outputs.length === 1 && !!rout && rout.scriptHex === depositScript && rout.value >= POSTAGE_SATS, rout ? `vout 0 → ${rout.address} ${rout.value} sats` : 'no output');
  check('reveal.feerate', 'Reveal pays at least the live rate', reveal.feeSats !== null && reveal.feeRateSatVb !== null && reveal.feeRateSatVb >= feeRate, `${reveal.feeSats} sats over ${reveal.vsize} vB = ${reveal.feeRateSatVb} sat/vB (rate ${feeRate})`);
  const spent = (commit.feeSats ?? 0) + (reveal.feeSats ?? 0) + (rout?.value ?? 0);
  check('fee.quote', 'What the pair actually costs sits inside the 1.5x-buffered quote', depositInfo !== null && spent <= depositInfo.estimatedCostSats && report.fee.rederivedQuoteSats === depositInfo.estimatedCostSats, `commit fee ${commit.feeSats} + reveal fee ${reveal.feeSats} + postage ${rout?.value} = ${spent} sats; quote ${depositInfo?.estimatedCostSats} (re-derived ${report.fee.rederivedQuoteSats}) = ceil(${feeRate} sat/vB × est. vB × 1.5) + ${POSTAGE_SATS}`);

  // 7. The envelope and the taproot commitment, read back from the reveal witness.
  const revealTx = parseTx(submitted.revealTxHex);
  const witness = revealTx.getInput(0).finalScriptWitness ?? [];
  let envelope: DryRunReport['envelope'] = null;
  if (witness.length === 3) {
    const [, leaf, controlBlock] = witness;
    const decoded = decodeEnvelope(leaf);
    const internalKey = controlBlock.slice(1, 33);
    let rebuilt = false;
    try {
      const p = btc.p2tr(internalKey, { type: 'tr', script: leaf } as never, net, true);
      rebuilt = hexOf(p.script) === out0?.scriptHex;
    } catch { /* rebuilt stays false */ }
    const metaText = new TextDecoder().decode(decoded.metadata);
    envelope = {
      contentType: decoded.contentType,
      bodyBytes: decoded.body.length,
      bodySha256: sha256Hex(decoded.body),
      metadataBytes: decoded.metadata.length,
      metadataNamesDid: report.expectedDid !== null && metaText.includes(report.expectedDid),
      controlBlockVersion: controlBlock[0],
      internalKey: hexOf(internalKey),
      rebuildsCommitOutput: rebuilt,
    };
  }
  report.envelope = envelope;
  report.freshness.firstInternalKey = envelope?.internalKey ?? null;
  // The control block's low bit is the output key's parity, so 0xc0 or 0xc1 is tapscript v0.
  const tapscriptV0 = envelope !== null && envelope.controlBlockVersion !== null && (envelope.controlBlockVersion & 0xfe) === 0xc0;
  check('reveal.scriptpath', 'Reveal is a 3-item script-path spend whose leaf + internal key rebuild commit output 0', !!envelope && envelope.rebuildsCommitOutput && tapscriptV0, envelope ? `witness [sig, leaf, control block]; leaf version 0x${((envelope.controlBlockVersion ?? 0) & 0xfe).toString(16)}; internal key ${envelope.internalKey}; rebuild matches: ${envelope.rebuildsCommitOutput}` : `witness has ${witness.length} items`);
  check('reveal.envelope', 'Envelope carries the payload bytes and content type unchanged', !!envelope && envelope.contentType === payload.contentType && envelope.bodySha256 === payloadHash, envelope ? `contentType ${envelope.contentType}; body ${envelope.bodyBytes} bytes sha256 ${envelope.bodySha256}; metadata ${envelope.metadataBytes} bytes` : 'no envelope');
  check('sat.identity', 'Metadata names did:btco:<first sat of identity input>; inscription id is reveal:i0', !!envelope && envelope.metadataNamesDid && report.inscriptionId === `${reveal.txid}i0`, `sat ${report.satoshi} (first sat of ${commit.inputs[0]?.outpoint}) → ${report.expectedDid}; ordinal FIFO: commit vout 0 offset 0 → reveal vout 0 offset 0 → ${report.inscriptionId}`);

  // 8. Freshness: build again from the same inputs; the reveal key must differ.
  store.bindDepositAddress('dry-run-2', network, address);
  const secondFetch = routeFetch('dry-run-2');
  const sdk2 = sdkFor(network, new HttpOrdinalsProvider({ baseUrl: 'http://dry-run.local', fetchImpl: secondFetch }), keys);
  const fetchRawTx2 = async (txid: string): Promise<string> => {
    const res = await secondFetch(`http://dry-run.local/api/btc/prevtx?txid=${txid}`);
    if (!res.ok) throw new Error(`prevtx route ${res.status}`);
    return ((await res.json()) as { hex: string }).hex;
  };
  const signer2 = world.privateKey ? new TurnkeySatSigner({ client: localKeyClient(world.privateKey), signWith: address, fetchRawTx: fetchRawTx2 }) : unsignedSigner(fetchRawTx2);
  Object.assign(captured, { inscribeRequest: null });
  try {
    await sdk2.lifecycle.inscribeOnBitcoin(asset, { fundingUtxos: selection.selected, satSigner: signer2, changeAddress: address });
    report.server.buildError = 'second build RESOLVED: a broadcast happened';
  } catch { /* refused at broadcast, as the first was */ }
  const secondRequest = (captured as { inscribeRequest: { revealTxHex: string } | null }).inscribeRequest;
  const secondWitness = secondRequest ? parseTx(secondRequest.revealTxHex).getInput(0).finalScriptWitness : undefined;
  report.freshness.secondInternalKey = secondWitness && secondWitness.length === 3 ? hexOf(secondWitness[2].slice(1, 33)) : null;
  const fresh = !!report.freshness.firstInternalKey && !!report.freshness.secondInternalKey && report.freshness.firstInternalKey !== report.freshness.secondInternalKey && report.freshness.firstInternalKey !== fundingKeyXOnly;
  check('reveal.freshkey', 'Reveal address derives from a fresh random keypair, not the funding key', fresh, `build 1 internal key ${report.freshness.firstInternalKey}; build 2 ${report.freshness.secondInternalKey}; funding key (x-only) ${fundingKeyXOnly ?? 'n/a (unsigned)'}`);
  check('never.broadcast.second', 'Second build was also refused; no broadcast route call ever happened', report.server.buildError === null && attempts.length >= 2 && captured.broadcastRouteCalls === 0, `provider refusals so far: ${attempts.length}; broadcast route calls: ${captured.broadcastRouteCalls}`);
  report.server.broadcastRouteCalls = captured.broadcastRouteCalls;

  const failed = checks.some((c) => c.result === 'fail');
  const skipped = checks.some((c) => c.result === 'skip');
  report.verdict = failed ? 'fail' : skipped ? 'incomplete' : 'pass';
  return report;
}

/** The human-readable record. */
export function renderReport(r: DryRunReport): string {
  const L: string[] = [];
  const h = (s: string) => { L.push('', `== ${s} ==`); };
  L.push(`DRY-RUN INSCRIPTION RECORD (${r.mode.toUpperCase()} ${r.mode === 'mock' ? 'PROVIDER AND FIXTURE, NOT THE CHAIN' : 'READS, NEVER BROADCAST'})`);
  L.push(`network: ${r.network}   deposit address: ${r.address}   signing: ${r.signing}`);
  L.push(`payload: ${r.payload.filename} (${r.payload.contentType}, ${r.payload.bytes} bytes, sha256 ${r.payload.sha256})`);
  L.push(`asset: ${r.asset.didCel}${r.asset.didWebvh ? ` → ${r.asset.didWebvh}` : ''}; content-bytes hint sent to the quote: ${r.asset.contentBytesHint}`);
  h('Fee');
  L.push(`live estimate (provider.estimateFee(1)): ${r.fee.rawEstimateSatVb} sat/vB → route rate (ceil): ${r.fee.routeRateSatVb} sat/vB`);
  L.push(`buffered quote (deposit route, x${r.fee.bufferMultiplier} + ${POSTAGE_SATS} postage): ${r.fee.quotedCostSats} sats; re-derived for the selected input count: ${r.fee.rederivedQuoteSats}`);
  if (r.commit && r.reveal) {
    L.push(`commit fee: ${r.commit.feeSats} sats / ${r.commit.vsize} vB = ${r.commit.feeRateSatVb} sat/vB`);
    L.push(`reveal fee: ${r.reveal.feeSats} sats / ${r.reveal.vsize} vB = ${r.reveal.feeRateSatVb} sat/vB`);
  }
  h('Inputs (every confirmed output at the address)');
  if (r.depositError) L.push(`deposit route failed: ${r.depositError}`);
  for (const c of r.candidates) {
    L.push(`${c.selected ? '*' : ' '} ${c.outpoint}  ${String(c.value).padStart(9)} sats  ${c.classification}${c.inscriptions.length ? ` [${c.inscriptions.join(', ')}]` : ''}${c.selected ? `  SELECTED as ${c.role} input` : c.classification === 'inscribed' ? '  excluded: carries an inscription' : c.classification === 'unclassified' ? '  excluded: unclassified' : '  not needed'}`);
  }
  if (r.selection) L.push(`selection: largest first until the ${r.fee.quotedCostSats} sat quote is covered → ${r.selection.selected.length} input(s), ${r.selection.totalSats} sats${r.selection.shortfallSats ? `, SHORT by ${r.selection.shortfallSats}` : ''}`);
  if (r.deposit) L.push(`ordinal check: ${r.deposit.ordinalCheck}; confirmed at address: ${r.deposit.confirmedSats} sats; unconfirmed: ${r.deposit.unconfirmedSats} sats`);
  const tx = (name: string, t: TxSummary) => {
    h(`${name} transaction`);
    L.push(`txid: ${t.txid}   vsize: ${t.vsize}   weight: ${t.weight}${t.sizeEstimated ? '   (unsigned: size estimated as if signed)' : ''}`);
    for (const [n, i] of t.inputs.entries()) L.push(`  in  #${n}: ${i.outpoint}  ${i.value ?? '?'} sats  seq 0x${i.sequence.toString(16)}  witness items: ${i.witnessItems}`);
    for (const o of t.outputs) L.push(`  out #${o.vout}: ${o.value} sats → ${o.address} (${o.scriptType})`);
    L.push(`raw hex (${t.hex.length / 2} bytes):`);
    L.push(t.hex);
  };
  if (r.commit) tx('Commit', r.commit);
  if (r.reveal) tx('Reveal', r.reveal);
  h('Reveal address and key');
  if (r.commit) L.push(`reveal (commit output 0) address: ${r.commit.outputs[0]?.address}`);
  L.push(`internal key from the control block: ${r.freshness.firstInternalKey ?? 'n/a'}`);
  L.push(`same inputs built again: ${r.freshness.secondInternalKey ?? 'n/a'}${r.freshness.firstInternalKey && r.freshness.secondInternalKey ? (r.freshness.firstInternalKey === r.freshness.secondInternalKey ? '  SAME (not fresh)' : '  different, so the key is generated per build') : ''}`);
  L.push(`funding key (x-only): ${r.freshness.fundingKeyXOnly ?? 'n/a (unsigned run)'}`);
  if (r.envelope) {
    L.push(`envelope: ${r.envelope.contentType}, body ${r.envelope.bodyBytes} bytes (sha256 ${r.envelope.bodySha256}), metadata ${r.envelope.metadataBytes} bytes, control block v0x${r.envelope.controlBlockVersion?.toString(16)}`);
    L.push(`leaf + internal key rebuild commit output 0: ${r.envelope.rebuildsCommitOutput}`);
  }
  h('Where the sat lands');
  L.push(`identity input: ${r.commit?.inputs[0]?.outpoint ?? 'n/a'}; its first sat per the sat index: ${r.satoshi ?? 'n/a'}`);
  L.push(`did: ${r.expectedDid ?? 'n/a'}   inscription id: ${r.inscriptionId ?? 'n/a'}`);
  if (r.reveal) L.push(`the sat leaves via commit vout 0 (offset 0) into reveal vout 0 (offset 0): ${r.reveal.outputs[0]?.value} sats → ${r.reveal.outputs[0]?.address}`);
  if (r.commit) L.push(`change: ${r.commit.outputs[1] ? `${r.commit.outputs[1].value} sats → ${r.commit.outputs[1].address}` : 'none'}`);
  h('Server');
  L.push(`inscribe route: ${r.server.inscribeStatus} ${JSON.stringify(r.server.inscribeBody)}`);
  L.push(`persisted record status: ${r.server.recordStatus} (dir ${r.recordDir})`);
  L.push(`provider broadcast refusals: ${r.server.broadcastAttempts.length} [${r.server.broadcastAttempts.join(', ')}]; /api/btc/broadcast calls: ${r.server.broadcastRouteCalls}`);
  if (r.server.buildError) L.push(`build error: ${r.server.buildError}`);
  for (const line of r.server.moneyLog) L.push(`  money: ${line}`);
  for (const line of r.sdkNotes) L.push(`  sdk: ${line.split('\n')[0].slice(0, 240)}${line.length > 240 ? ' ...' : ''}`);
  h('Checklist');
  for (const c of r.checks) L.push(`[${c.result === 'pass' ? 'PASS' : c.result === 'fail' ? 'FAIL' : 'SKIP'}] ${c.id}: ${c.label}`, `       ${c.detail}`);
  h('Judgement');
  if (r.verdict === 'pass') L.push(`PASS: every property holds. As far as this harness can judge, broadcasting this pair would have been correct.${r.mode === 'mock' ? ' (Mock provider and fixture: this proves the code path, not the chain.)' : ''}`);
  else if (r.verdict === 'incomplete') L.push('INCOMPLETE: no property failed, but the skipped rows above were not exercised (set DRY_RUN_WIF to sign). Do not treat this as a signed dry run.');
  else L.push(`FAIL: ${r.checks.filter((c) => c.result === 'fail').map((c) => c.id).join(', ')}. Broadcasting this pair would NOT have been correct.`);
  return L.join('\n');
}

async function main(): Promise<void> {
  const env = process.env;
  const chain = serverBtcNetwork(env);
  const network: BtcNet = chain === 'mainnet' ? 'mainnet' : 'testnet';
  const payload = resolvePayload(env);
  const privateKey = env.DRY_RUN_WIF ? privateKeyFromWif(env.DRY_RUN_WIF, network) : undefined;
  const webvhDomain = env.VITE_WEBVH_HOST || (network === 'mainnet' ? 'originals.build' : 'localhost');
  let report: DryRunReport;
  if (env.QUICKNODE_ENDPOINT) {
    const indexer = resolveIndexer(env, network);
    console.log(`Live ${chain} dry run. QuickNode: ${new URL(env.QUICKNODE_ENDPOINT).host}; indexer: ${indexer.api}; nothing will be broadcast.`);
    report = await runDryRun({
      network,
      mode: 'live',
      payload,
      world: {
        address: env.DRY_RUN_ADDRESS,
        privateKey,
        readProvider: new QuickNodeProvider({ endpoint: env.QUICKNODE_ENDPOINT, expectedNetwork: network }),
        ordinals: cachedOrdinalLookup(quickNodeOrdinalLookup({ endpoint: env.QUICKNODE_ENDPOINT })),
        indexer,
      },
      webvhDomain,
    });
  } else {
    console.log(`Mock ${chain} dry run: QUICKNODE_ENDPOINT is unset, so this runs the same path over OrdMockProvider and a fixture deposit.`);
    report = await runDryRun({
      network,
      mode: 'mock',
      payload,
      world: (contentBytes) => mockFixture({ network, privateKey, contentBytes }),
      webvhDomain,
    });
  }
  console.log(renderReport(report));
  if (env.DRY_RUN_JSON) {
    writeFileSync(env.DRY_RUN_JSON, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nJSON report written to ${env.DRY_RUN_JSON}`);
  }
  process.exit(report.verdict === 'pass' ? 0 : report.verdict === 'incomplete' ? 2 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`dry run aborted: ${(e as Error).stack ?? String(e)}`);
    process.exit(1);
  });
}
