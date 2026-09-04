/**
 * Dry-run the inscription the landing page would broadcast, and never
 * broadcast it (#526).
 *
 *   bun scripts/dry-run-inscription.ts
 *     Mock record: OrdMockProvider, fixture deposits, regtest shapes. Proves
 *     the harness; proves nothing about mainnet.
 *
 *   BTC_NETWORK=mainnet QUICKNODE_ENDPOINT=https://… DRY_RUN_ADDRESS=bc1q… \
 *     [DRY_RUN_WIF=K…] [DRY_RUN_PAYLOAD=./file.svg] [DRY_RUN_OUT=./record.json] \
 *     bun scripts/dry-run-inscription.ts
 *     Mainnet record: live fee estimate and sat index from QuickNode, live
 *     UTXOs from the deposit indexer seam, live ordinal classification. With
 *     DRY_RUN_WIF (the funding key of DRY_RUN_ADDRESS) the commit is signed for
 *     real; without it the commit is left unsigned and every other property is
 *     still judged. The reveal is always fully signed by its ephemeral key.
 *
 * What runs is the code that ships: `lifecycle.inscribeOnBitcoin` with the
 * sat-selected funding set, which is exactly what the browser engine calls
 * (src/sdk/engine.ts), built on top of the server's fee normalisation, ordinal
 * classification, deposit quote and the browser's funding selection. The only
 * substitutions are the signer (a local key or none, instead of Turnkey) and
 * the provider, which REFUSES to broadcast: `broadcastTransaction` and
 * `submitInscription` both throw, so nothing here can reach the network by
 * construction rather than by discipline. The broadcast/inscribe routes are
 * never constructed.
 *
 * The record ends in a checklist with one PASS/FAIL per property the ticket
 * names, so the written judgement is mechanical. Exit code 1 on any FAIL.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import {
  MemoryStorageAdapter,
  OriginalsSDK,
  QuickNodeProvider,
  type BitcoinSigner,
  type OrdinalsProvider,
  type Utxo,
} from '@originals/sdk';
import { btcoDidFromSatoshi } from '@originals/sdk/cel';
import { OrdMockProvider } from '@originals/sdk/testing';
import {
  P2TR_OUTPUT_VB,
  P2WPKH_OUTPUT_VB,
  POSTAGE_SATS,
  cachedOrdinalLookup,
  classifySpendableUtxos,
  estimateInscriptionCostSats,
  fetchAddressUtxos,
  normalizeFeeRate,
  quickNodeOrdinalLookup,
  resolveIndexer,
  serverBtcNetwork,
  type OrdinalLookup,
} from '../server/bitcoin';
import { generateArtwork } from '../src/sdk/artwork';
import { inscriptionContentBytes, selectFundingUtxos, type FundingUtxo } from '../src/sdk/funding';

export type DryRunNetwork = 'mainnet' | 'testnet' | 'regtest';

// Same shape the SDK uses for regtest (bech32 `bcrt`), which @scure lacks.
const REGTEST_NETWORK: typeof btc.NETWORK = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export function scureNetwork(network: DryRunNetwork): typeof btc.NETWORK {
  return network === 'mainnet' ? btc.NETWORK : network === 'testnet' ? btc.TEST_NETWORK : REGTEST_NETWORK;
}

/** BIP-125 opt-in, as the SDK's commit/reveal builders set it. */
const RBF_SEQUENCE = 0xfffffffd;
const MIN_DUST = 546;
const SIGHASH_ALL = 0x01;
/** The deposit quote's buffer against a fee move between quote and broadcast. */
const QUOTE_BUFFER = 1.5;

// ---------------------------------------------------------------------------
// The provider that cannot broadcast.
// ---------------------------------------------------------------------------

/** Thrown by the dry-run provider on any attempt to put bytes on the network. */
export class DryRunBroadcastRefused extends Error {
  constructor(readonly seam: 'broadcastTransaction' | 'submitInscription') {
    super(`DRY RUN: ${seam} refused: nothing is ever broadcast from this harness.`);
    this.name = 'DryRunBroadcastRefused';
  }
}

/** The signed pair, exactly as the SDK handed it to the submit seam. */
export interface CapturedPair {
  signedCommitHex: string;
  revealTxHex: string;
  fundingUtxos: Array<{ txid: string; vout: number; value: number; scriptPubKey?: string }>;
  changeAddress: string;
}

/** The read-only surface a dry run needs from a real provider. */
export type ReadProvider = Pick<OrdinalsProvider, 'estimateFee' | 'getFirstSatOfOutput' | 'getTransactionStatus'> &
  Partial<Pick<OrdinalsProvider, 'getInscriptionById' | 'getInscriptionsBySatoshi' | 'getAnchoringsForDidCel' | 'getSatOwnership'>>;

export interface NeverBroadcastProvider extends OrdinalsProvider {
  /** What the SDK handed to submitInscription before it was refused. */
  readonly captured: CapturedPair | null;
  /** Every raw hex the SDK tried to put on the network via broadcastTransaction. Must stay empty. */
  readonly broadcastAttempts: string[];
  /** How many times the submit seam refused a pair. */
  readonly submitRefusals: number;
  /** Every fee estimate served: the provider's raw number and the normalised rate the SDK saw. */
  readonly feeEstimates: Array<{ blocks: number; raw: number; normalized: number }>;
  reset(): void;
}

/**
 * Wrap a real provider's READS in one whose every write path throws. The
 * inner provider's broadcastTransaction/submitInscription are never even
 * referenced, so a provider that could broadcast is not reachable through
 * this object. Fee estimates pass through the same normalisation the
 * /api/btc/fee route applies (server/bitcoin.ts normalizeFeeRate), so the SDK
 * builds at the rate the browser would have been served.
 */
export function neverBroadcastProvider(
  reads: ReadProvider,
  opts: {
    /** Omit the submit seam so the SDK falls back to broadcastTransaction, which must still refuse. Test-only. */
    withoutSubmitSeam?: boolean;
  } = {}
): NeverBroadcastProvider {
  let captured: CapturedPair | null = null;
  const broadcastAttempts: string[] = [];
  let submitRefusals = 0;
  const feeEstimates: NeverBroadcastProvider['feeEstimates'] = [];
  const unsupported = (name: string) => () =>
    Promise.reject(new Error(`DRY RUN: ${name} is not part of the inscribe path and is not forwarded.`));
  const submitInscription: OrdinalsProvider['submitInscription'] = async (params) => {
    captured = {
      signedCommitHex: params.signedCommitHex,
      revealTxHex: params.revealTxHex,
      fundingUtxos: params.fundingUtxos.map((u) => ({ ...u })),
      changeAddress: params.changeAddress,
    };
    submitRefusals++;
    throw new DryRunBroadcastRefused('submitInscription');
  };
  return {
    get captured() { return captured; },
    get broadcastAttempts() { return broadcastAttempts; },
    get submitRefusals() { return submitRefusals; },
    get feeEstimates() { return feeEstimates; },
    reset() { captured = null; broadcastAttempts.length = 0; submitRefusals = 0; feeEstimates.length = 0; },
    async estimateFee(blocks = 1) {
      const raw = await reads.estimateFee(blocks);
      const normalized = normalizeFeeRate(raw);
      feeEstimates.push({ blocks, raw, normalized });
      return normalized;
    },
    getFirstSatOfOutput(outpoint) {
      if (typeof reads.getFirstSatOfOutput !== 'function') {
        return Promise.reject(new Error('The read provider has no sat index (getFirstSatOfOutput).'));
      }
      return reads.getFirstSatOfOutput(outpoint);
    },
    getTransactionStatus: (txid) => reads.getTransactionStatus(txid),
    getInscriptionById: (id) => (reads.getInscriptionById ? reads.getInscriptionById(id) : unsupported('getInscriptionById')()),
    getInscriptionsBySatoshi: (sat) =>
      reads.getInscriptionsBySatoshi ? reads.getInscriptionsBySatoshi(sat) : unsupported('getInscriptionsBySatoshi')(),
    getAnchoringsForDidCel: (did, opts) =>
      reads.getAnchoringsForDidCel ? reads.getAnchoringsForDidCel(did, opts) : Promise.resolve([]),
    getSatOwnership: (sat) => (reads.getSatOwnership ? reads.getSatOwnership(sat) : Promise.resolve(null)),
    async broadcastTransaction(txHexOrObj: unknown) {
      broadcastAttempts.push(typeof txHexOrObj === 'string' ? txHexOrObj : JSON.stringify(txHexOrObj));
      throw new DryRunBroadcastRefused('broadcastTransaction');
    },
    ...(opts.withoutSubmitSeam ? {} : { submitInscription }),
    createInscription: unsupported('createInscription') as OrdinalsProvider['createInscription'],
    transferInscription: unsupported('transferInscription') as OrdinalsProvider['transferInscription'],
  };
}

// ---------------------------------------------------------------------------
// Signers: a local key standing in for Turnkey, or no key at all.
// ---------------------------------------------------------------------------

export type SignerKind = 'local-key' | 'unsigned';

export interface DryRunSigner extends BitcoinSigner {
  readonly kind: SignerKind;
  /** Compressed secp256k1 public key (hex) when a key is held. */
  readonly publicKeyHex?: string;
}

/** Sign and finalize the commit locally, the way the faucet signer does; the key never leaves this process. */
export function localKeySigner(privateKey: Uint8Array): DryRunSigner {
  const publicKeyHex = hex.encode(secp256k1.getPublicKey(privateKey, true));
  return {
    kind: 'local-key',
    publicKeyHex,
    async signAndFinalizeCommitPsbt(psbtBase64) {
      const tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64), { allowUnknownInputs: true, allowUnknownOutputs: true });
      tx.sign(privateKey);
      tx.finalize();
      return hex.encode(tx.extract());
    },
  };
}

/**
 * Hand the SDK the commit WITHOUT a signature. A segwit txid does not depend
 * on the witness, so the reveal the SDK builds on top is the real reveal; only
 * the "signed by the deposit key" property goes unjudged.
 */
export function unsignedCommitSigner(): DryRunSigner {
  return {
    kind: 'unsigned',
    async signAndFinalizeCommitPsbt(psbtBase64) {
      const tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64), { allowUnknownInputs: true, allowUnknownOutputs: true });
      return hex.encode(tx.unsignedTx);
    },
  };
}

/** The P2WPKH address and script a private key funds on the given network. */
export function depositAddressOf(privateKey: Uint8Array, network: DryRunNetwork): { address: string; scriptPubKey: string } {
  const pay = btc.p2wpkh(secp256k1.getPublicKey(privateKey, true), scureNetwork(network));
  return { address: pay.address!, scriptPubKey: hex.encode(pay.script) };
}

// ---------------------------------------------------------------------------
// Payload.
// ---------------------------------------------------------------------------

export interface DryRunPayload {
  title: string;
  style: string;
  filename: string;
  contentType: string;
  /** The exact bytes, as text: what the engine hashes, hosts and inscribes. */
  content: string;
}

/** The generated artwork the demo mints by default. */
export function defaultPayload(): DryRunPayload {
  const title = 'Dry run';
  const style = 'Artwork';
  return { title, style, filename: 'artwork.svg', contentType: 'image/svg+xml', content: generateArtwork(title, style, 20260904).svg };
}

const TEXT_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
};

/**
 * A text payload from disk. Text only, deliberately: the engine carries
 * resource content as a string, so a PNG cannot round-trip through this path
 * today (issue #540) and the dry run refuses rather than inscribe bytes the
 * landing page could not.
 */
export function payloadFromFile(path: string): DryRunPayload {
  const ext = extname(path).toLowerCase();
  const contentType = TEXT_TYPES[ext];
  if (!contentType) {
    throw new Error(`DRY_RUN_PAYLOAD must be a text file (${Object.keys(TEXT_TYPES).join(', ')}); got "${ext || path}".`);
  }
  const content = readFileSync(path, 'utf8');
  const filename = path.split(/[\\/]/).pop() ?? `payload${ext}`;
  return { title: filename, style: 'Upload', filename, contentType, content };
}

// ---------------------------------------------------------------------------
// The dry run.
// ---------------------------------------------------------------------------

export interface DryRunInput {
  network: DryRunNetwork;
  /** Where the money is: the creator's P2WPKH deposit address. Change and the inscribed sat return here. */
  depositAddress: string;
  /** Every CONFIRMED output at the deposit address, as the indexer seam reports them. */
  candidates: FundingUtxo[];
  /** The per-outpoint ordinal classifier; undefined means "nothing can be established". */
  ordinalLookup: OrdinalLookup | undefined;
  reads: ReadProvider;
  signer: DryRunSigner;
  payload: DryRunPayload;
  /** The did:webvh domain the Original is published under before inscription. */
  webvhDomain: string;
  /** What the record is labelled as; the mock label is load-bearing. */
  source: 'mock' | 'live';
  now?: () => Date;
  /** The refusing provider to hand the SDK; built from `reads` when omitted. Test-only. */
  provider?: NeverBroadcastProvider;
}

export interface CandidateClassification {
  outpoint: string;
  value: number;
  scriptPubKey: string;
  status: 'spendable' | 'inscribed' | 'unclassified';
  inscriptions: string[];
  reason?: string;
}

export interface SelectedInput extends CandidateClassification {
  /** 0-based position in the commit: 0 is the identity input. */
  index: number;
  /** Why this one: its rank in the largest-first walk and the running total after it. */
  rank: number;
  runningTotal: number;
}

export interface Check {
  id: string;
  ok: boolean | 'skipped';
  detail: string;
}

export interface TxFacts {
  txid: string;
  hex: string;
  /** True when every input carries its final witness. */
  final: boolean;
  vsize: number;
  /** 'actual' from the serialised bytes; 'estimated' when the commit is unsigned. */
  vsizeBasis: 'actual' | 'estimated';
  feeSats: number;
  feeRateSatVb: number;
  inputs: Array<{ outpoint: string; value: number; sequence: number; rbf: boolean; witnessItems: number }>;
  outputs: Array<{ n: number; address: string; scriptType: string; value: number }>;
}

export interface DryRunRecord {
  source: 'mock' | 'live';
  network: DryRunNetwork;
  createdAt: string;
  payload: { filename: string; contentType: string; bytes: number; sha256: string };
  asset: { didCel: string; didWebvh: string | null; celEvents: number; layerAfterDryRun: string };
  fee: {
    rawEstimate: number;
    feeRateSatVb: number;
    /** What the SDK's own estimateFee(1) read resolved to inside the build, if it read one. */
    sdkResolvedRate: number | null;
    contentBytes: number;
    quotedInputs: number;
    /** The deposit target the page shows: fees x1.5 plus postage. */
    quoteSats: number;
    /** The same quote without the buffer, to make the buffer visible. */
    unbufferedQuoteSats: number;
    /** What this pair actually spends on fees plus postage. */
    actualSats: number | null;
    /** The fee rate at which the actual pair would have exhausted the quote. */
    quoteAbsorbsUpToSatVb: number | null;
  };
  deposit: {
    address: string;
    candidates: CandidateClassification[];
    classification: { ok: boolean; unchecked: number; reason?: string };
    spendableSats: number;
    shortfallSats: number;
  };
  selection: SelectedInput[];
  signer: { kind: SignerKind; publicKeyHex?: string };
  commit: TxFacts | null;
  reveal: TxFacts | null;
  revealKey: {
    internalKeyHex: string;
    controlBlockHex: string;
    leafVersion: number;
    leafScriptBytes: number;
    commitAddress: string;
    rebuiltCommitAddress: string;
    secondBuildInternalKeyHex: string | null;
  } | null;
  envelope: { contentType: string; bodyBytes: number; bodySha256: string; metadataBytes: number } | null;
  sat: { satoshi: string; identityOutpoint: string; did: string; inscriptionId: string; landsAt: string } | null;
  broadcast: { attempts: number; submitRefusals: number; lifecycleRejected: boolean };
  /** A build that did not reach the submit seam; the checklist says why. */
  buildError: string | null;
  checks: Check[];
}

function outpointOf(u: { txid: string; vout: number }): string {
  return `${u.txid.toLowerCase()}:${u.vout}`;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** The metadata.json the engine mints beside the artwork (src/sdk/engine.ts buildMetadata). */
function metadataFor(payload: DryRunPayload, created: string, artworkHash: string): string {
  return JSON.stringify(
    { title: payload.title, style: payload.style, creator: 'you', created, artwork: { file: payload.filename, sha256: artworkHash } },
    null,
    2
  );
}

/** Label every candidate individually, then run the exact gate the deposit and inscribe routes run. */
export async function classifyCandidates(
  candidates: FundingUtxo[],
  lookup: OrdinalLookup | undefined
): Promise<{
  labelled: CandidateClassification[];
  gate: { ok: boolean; spendable: FundingUtxo[]; ordinalBearing: number; unchecked: number; reason?: string };
}> {
  const labelled: CandidateClassification[] = [];
  for (const u of candidates) {
    const base = { outpoint: outpointOf(u), value: u.value, scriptPubKey: u.scriptPubKey };
    if (!lookup) {
      labelled.push({ ...base, status: 'unclassified', inscriptions: [], reason: 'no ordinal lookup configured' });
      continue;
    }
    try {
      const inscriptions = await lookup.outpointInscriptions(u);
      labelled.push({ ...base, status: inscriptions.length > 0 ? 'inscribed' : 'spendable', inscriptions });
    } catch (e) {
      labelled.push({ ...base, status: 'unclassified', inscriptions: [], reason: (e as Error).message });
    }
  }
  const gate = await classifySpendableUtxos(candidates, lookup);
  return { labelled, gate };
}

/** The deposit route's input-count walk, so the quote prices the inputs the selection will spend. */
export function quoteFor(spendable: FundingUtxo[], feeRate: number, contentBytes: number): { inputs: number; quoteSats: number; unbufferedQuoteSats: number } {
  const costFor = (inputs: number, bufferMultiplier?: number) =>
    estimateInscriptionCostSats({ feeRate, inputs, contentBytes, commitOutputsVB: [P2TR_OUTPUT_VB, P2WPKH_OUTPUT_VB], bufferMultiplier });
  let inputCount = 1;
  if (spendable.length > 0) {
    const largestFirst = [...spendable].sort((a, b) => b.value - a.value);
    let sum = 0;
    let used = 0;
    for (const u of largestFirst) {
      sum += u.value;
      used++;
      if (sum >= costFor(used)) break;
    }
    inputCount = sum >= costFor(used) ? used : used + 1;
  }
  return { inputs: inputCount, quoteSats: costFor(inputCount), unbufferedQuoteSats: costFor(inputCount, 1) };
}

function addressOf(script: Uint8Array | undefined, network: DryRunNetwork): { address: string; scriptType: string } {
  if (!script) return { address: '(none)', scriptType: 'unknown' };
  try {
    const decoded = btc.OutScript.decode(script);
    // Cast: same widening as p2wpkhScriptHex in server/bitcoin.ts.
    const encode = btc.Address(scureNetwork(network)).encode;
    return { address: encode(decoded as Parameters<typeof encode>[0]), scriptType: decoded.type };
  } catch {
    return { address: hex.encode(script), scriptType: 'unknown' };
  }
}

function parseTx(txHex: string): btc.Transaction {
  return btc.Transaction.fromRaw(hex.decode(txHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
}

/** vsize of a not-yet-signed commit: its bytes plus a P2WPKH witness per input. */
function estimatedCommitVsize(unsignedBytes: number, inputs: number): number {
  const WITNESS_BYTES_P2WPKH = 108;
  return Math.ceil(unsignedBytes + (2 + WITNESS_BYTES_P2WPKH * inputs) / 4);
}

function txFacts(
  tx: btc.Transaction,
  txHex: string,
  inputValues: number[],
  network: DryRunNetwork
): TxFacts {
  const inputs: TxFacts['inputs'] = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    inputs.push({
      outpoint: `${inp.txid ? hex.encode(inp.txid) : '?'}:${inp.index ?? 0}`,
      value: inputValues[i] ?? 0,
      sequence: inp.sequence ?? 0xffffffff,
      rbf: (inp.sequence ?? 0xffffffff) < 0xfffffffe,
      witnessItems: inp.finalScriptWitness?.length ?? 0,
    });
  }
  const outputs: TxFacts['outputs'] = [];
  for (let n = 0; n < tx.outputsLength; n++) {
    const out = tx.getOutput(n);
    outputs.push({ n, ...addressOf(out.script, network), value: Number(out.amount ?? 0n) });
  }
  const feeSats = inputValues.reduce((s, v) => s + v, 0) - outputs.reduce((s, o) => s + o.value, 0);
  const final = tx.isFinal;
  const vsize = final ? tx.vsize : estimatedCommitVsize(txHex.length / 2, tx.inputsLength);
  return {
    txid: tx.id,
    hex: txHex,
    final,
    vsize,
    vsizeBasis: final ? 'actual' : 'estimated',
    feeSats,
    feeRateSatVb: Math.round((feeSats / vsize) * 100) / 100,
    inputs,
    outputs,
  };
}

/** Verify each P2WPKH input's witness: pubkey matches the spent script, SIGHASH_ALL, DER signature over the BIP-143 digest. */
function verifyCommitSignatures(tx: btc.Transaction, spent: Array<{ scriptPubKey: string; value: number }>): { ok: boolean; detail: string } {
  for (let i = 0; i < tx.inputsLength; i++) {
    const witness = tx.getInput(i).finalScriptWitness;
    if (!witness || witness.length !== 2) return { ok: false, detail: `input ${i}: expected a 2-item P2WPKH witness, got ${witness?.length ?? 0}` };
    const [sigWithType, pubkey] = witness;
    const spentScript = btc.OutScript.decode(hex.decode(spent[i].scriptPubKey));
    if (spentScript.type !== 'wpkh') return { ok: false, detail: `input ${i}: spent script is ${spentScript.type}, not wpkh` };
    if (hex.encode(btc.p2wpkh(pubkey).script) !== spent[i].scriptPubKey.toLowerCase()) {
      return { ok: false, detail: `input ${i}: witness pubkey does not hash to the spent scriptPubKey` };
    }
    const hashType = sigWithType[sigWithType.length - 1];
    if (hashType !== SIGHASH_ALL) return { ok: false, detail: `input ${i}: sighash type 0x${hashType.toString(16)}, not SIGHASH_ALL` };
    // BIP-143 scriptCode for P2WPKH is the P2PKH script of the same hash.
    const scriptCode = btc.OutScript.encode({ type: 'pkh', hash: spentScript.hash });
    const digest = tx.preimageWitnessV0(i, scriptCode, hashType, BigInt(spent[i].value));
    const valid = secp256k1.verify(sigWithType.slice(0, -1), digest, pubkey, { prehash: false, format: 'der' });
    if (!valid) return { ok: false, detail: `input ${i}: signature does not verify` };
  }
  return { ok: true, detail: `${tx.inputsLength} P2WPKH input(s): pubkey matches the spent script, SIGHASH_ALL, DER signature verifies over the BIP-143 digest` };
}

/** Walk the ord envelope in the reveal's leaf script: tag 1 content type, tag 5 metadata chunks, OP_0 then body chunks. */
export function parseEnvelope(leafScript: Uint8Array): { pubkey: Uint8Array; contentType: string; metadata: Uint8Array; body: Uint8Array } {
  const ops = btc.Script.decode(leafScript);
  const isBytes = (o: unknown): o is Uint8Array => o instanceof Uint8Array;
  if (!isBytes(ops[0]) || ops[0].length !== 32 || ops[1] !== 'CHECKSIG' || ops[2] !== 0 || ops[3] !== 'IF') {
    throw new Error('leaf script does not start with <pubkey> CHECKSIG OP_0 IF');
  }
  if (!isBytes(ops[4]) || new TextDecoder().decode(ops[4]) !== 'ord') throw new Error('leaf script has no "ord" marker');
  let contentType = '';
  const metadata: Uint8Array[] = [];
  const body: Uint8Array[] = [];
  let i = 5;
  for (; i < ops.length; i++) {
    const op = ops[i];
    if (op === 0) { i++; break; }
    const tag = isBytes(op) && op.length === 1 ? op[0] : typeof op === 'number' ? op : -1;
    const value = ops[i + 1];
    if (tag < 0 || !isBytes(value)) throw new Error(`unexpected envelope field at op ${i}`);
    if (tag === 1) contentType = new TextDecoder().decode(value);
    else if (tag === 5) metadata.push(value);
    i++;
  }
  for (; i < ops.length; i++) {
    const op = ops[i];
    if (op === 'ENDIF') break;
    if (!isBytes(op)) throw new Error(`non-push op ${String(op)} inside the body`);
    body.push(op);
  }
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  return { pubkey: ops[0], contentType, metadata: concat(metadata), body: concat(body) };
}

interface BuildOutcome {
  pair: CapturedPair;
  satoshi: string;
  inscriptionId: string;
  commitTxId: string;
  revealTxId: string;
  lifecycleRejected: boolean;
}

/**
 * One full pass through `lifecycle.inscribeOnBitcoin`. The SDK must end by
 * REJECTING with INSCRIPTION_SUBMIT_FAILED (the provider refused the pair);
 * anything else means the build never reached the seam, or worse, something
 * did not refuse.
 */
async function buildPair(
  sdk: ReturnType<typeof OriginalsSDK.create>,
  asset: Awaited<ReturnType<typeof sdk.lifecycle.createAsset>>,
  provider: NeverBroadcastProvider,
  fundingUtxos: Utxo[],
  signer: DryRunSigner,
  changeAddress: string
): Promise<BuildOutcome> {
  const before = { captured: provider.captured, refusals: provider.submitRefusals };
  let details: Record<string, unknown> = {};
  let rejected = false;
  try {
    await sdk.lifecycle.inscribeOnBitcoin(asset, { fundingUtxos, satSigner: signer, changeAddress });
  } catch (e) {
    rejected = true;
    const err = e as { code?: string; message?: string; details?: Record<string, unknown> };
    if (err.code !== 'INSCRIPTION_SUBMIT_FAILED') {
      throw new Error(`build did not reach the submit seam: ${err.code ?? ''} ${err.message ?? String(e)}`.trim());
    }
    details = err.details ?? {};
  }
  if (!rejected) {
    throw new Error('the lifecycle call RESOLVED: the pair was accepted somewhere, which a dry run must never allow');
  }
  const pair = provider.captured;
  if (!pair || pair === before.captured || provider.submitRefusals !== before.refusals + 1) {
    throw new Error('the submit seam did not see exactly one pair');
  }
  return {
    pair,
    satoshi: String(details.satoshi ?? ''),
    inscriptionId: String(details.inscriptionId ?? ''),
    commitTxId: String(details.commitTxId ?? ''),
    revealTxId: String(details.revealTxId ?? ''),
    lifecycleRejected: true,
  };
}

export async function dryRunInscription(input: DryRunInput): Promise<DryRunRecord> {
  const now = input.now ?? (() => new Date());
  const checks: Check[] = [];
  const check = (id: string, ok: boolean | 'skipped', detail: string) => { checks.push({ id, ok, detail }); return ok === true; };
  const network = input.network;
  const payloadBytes = utf8(input.payload.content);
  const payloadSha = hex.encode(sha256(payloadBytes));

  const provider = input.provider ?? neverBroadcastProvider(input.reads);

  // 1) The live fee, through the route's normalisation.
  const feeRate = await provider.estimateFee(1);
  const rawEstimate = provider.feeEstimates[0].raw;

  // 2) Classify every confirmed output; the gate is the route's own.
  const { labelled, gate } = await classifyCandidates(input.candidates, input.ordinalLookup);
  const spendable = gate.spendable;
  const spendableSats = spendable.reduce((n, u) => n + u.value, 0);

  // 3) The Original, minted the way the engine mints it, published before inscription.
  const keys = new Map<string, string>();
  const sdk = OriginalsSDK.create({
    network,
    webvhNetwork: network === 'mainnet' ? 'pichu' : network === 'testnet' ? 'cleffa' : 'magby',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    storageAdapter: new MemoryStorageAdapter(),
    enableLogging: false,
    logging: { outputs: [{ write() { /* the record is the output */ } }] },
    keyStore: {
      async getPrivateKey(id: string) { return keys.get(id) ?? null; },
      async setPrivateKey(id: string, key: string) { keys.set(id, key); },
      getAllVerificationMethodIds() { return [...keys.keys()]; },
    },
  } as unknown as Parameters<typeof OriginalsSDK.create>[0]);
  const created = now().toISOString();
  const metadata = metadataFor(input.payload, created, payloadSha);
  const metaBytes = utf8(metadata);
  const asset = await sdk.lifecycle.createAsset([
    {
      id: input.payload.filename,
      type: input.payload.contentType.startsWith('image/') ? 'image' : 'text',
      content: input.payload.content,
      contentType: input.payload.contentType,
      hash: payloadSha,
      size: payloadBytes.length,
    },
    { id: 'metadata.json', type: 'data', content: metadata, contentType: 'application/json', hash: hex.encode(sha256(metaBytes)), size: metaBytes.length },
  ]);
  await sdk.lifecycle.publishToWeb(asset, input.webvhDomain);
  const didWebvh = ((asset.bindings ?? {}) as Record<string, string>)['did:webvh'] ?? null;

  // 4) The quote the page shows, sized like the deposit route, and the page's own selection.
  const contentBytes = inscriptionContentBytes({
    resource: { content: input.payload.content },
    metadata: { content: metadata },
    celLog: asset.celLog?.events ?? [],
  });
  const quote = quoteFor(spendable, feeRate, contentBytes);
  const selection = selectFundingUtxos(spendable, quote.quoteSats);
  const largestFirst = [...spendable].sort((a, b) => b.value - a.value);
  let running = 0;
  const selected: SelectedInput[] = selection.selected.map((u, index) => {
    running += u.value;
    const label = labelled.find((c) => c.outpoint === outpointOf(u))!;
    return { ...label, index, rank: largestFirst.findIndex((l) => outpointOf(l) === outpointOf(u)) + 1, runningTotal: running };
  });

  check(
    'deposit.classification_established',
    gate.ok,
    gate.ok
      ? `${labelled.length} confirmed output(s) classified; ${gate.ordinalBearing} inscription-bearing excluded; ${gate.unchecked} past the lookup budget (unclassified, not offered)`
      : `classification failed (${gate.reason}); the routes offer nothing spendable in this state`
  );
  check(
    'deposit.no_inscribed_output_offered',
    !spendable.some((u) => labelled.find((c) => c.outpoint === outpointOf(u))?.status !== 'spendable'),
    'every output offered as spendable was individually classified clean'
  );
  check(
    'deposit.covers_quote',
    selection.shortfallSats === 0 && selection.selected.length > 0,
    selection.shortfallSats === 0 && selection.selected.length > 0
      ? `spendable ${spendableSats} sats >= quote ${quote.quoteSats} sats`
      : `spendable ${spendableSats} sats is short of the ${quote.quoteSats} sat quote by ${selection.shortfallSats}; the page would not build`
  );

  const record: DryRunRecord = {
    source: input.source,
    network,
    createdAt: created,
    payload: { filename: input.payload.filename, contentType: input.payload.contentType, bytes: payloadBytes.length, sha256: payloadSha },
    asset: { didCel: asset.id, didWebvh, celEvents: asset.celLog?.events.length ?? 0, layerAfterDryRun: asset.currentLayer },
    fee: {
      rawEstimate,
      feeRateSatVb: feeRate,
      sdkResolvedRate: null,
      contentBytes,
      quotedInputs: quote.inputs,
      quoteSats: quote.quoteSats,
      unbufferedQuoteSats: quote.unbufferedQuoteSats,
      actualSats: null,
      quoteAbsorbsUpToSatVb: null,
    },
    deposit: {
      address: input.depositAddress,
      candidates: labelled,
      classification: { ok: gate.ok, unchecked: gate.unchecked, ...(gate.reason ? { reason: gate.reason } : {}) },
      spendableSats,
      shortfallSats: selection.shortfallSats,
    },
    selection: selected,
    signer: { kind: input.signer.kind, ...(input.signer.publicKeyHex ? { publicKeyHex: input.signer.publicKeyHex } : {}) },
    commit: null,
    reveal: null,
    revealKey: null,
    envelope: null,
    sat: null,
    broadcast: { attempts: 0, submitRefusals: 0, lifecycleRejected: false },
    buildError: null,
    checks,
  };

  if (selection.selected.length === 0 || !gate.ok) {
    check('broadcast.nothing_left_the_process', provider.broadcastAttempts.length === 0, 'no build was attempted, and the provider saw no broadcast');
    return record;
  }

  // 5) Build and sign, twice: the first pair is the record, the second only proves the reveal key is fresh.
  const fundingUtxos: Utxo[] = selection.selected.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, scriptPubKey: u.scriptPubKey }));
  let built: BuildOutcome;
  try {
    built = await buildPair(sdk, asset, provider, fundingUtxos, input.signer, input.depositAddress);
  } catch (e) {
    record.buildError = (e as Error).message;
    record.broadcast = { attempts: provider.broadcastAttempts.length, submitRefusals: provider.submitRefusals, lifecycleRejected: true };
    check('build.reached_submit_seam', false, record.buildError);
    check('broadcast.nothing_left_the_process', provider.broadcastAttempts.length === 0, `${provider.broadcastAttempts.length} broadcastTransaction attempt(s), all refused`);
    return record;
  }
  const sdkFeeReads = provider.feeEstimates.slice(1);
  record.fee.sdkResolvedRate = sdkFeeReads.length > 0 ? sdkFeeReads[sdkFeeReads.length - 1].normalized : null;
  let secondInternalKey: string | null = null;
  try {
    const second = await buildPair(sdk, asset, provider, fundingUtxos, input.signer, input.depositAddress);
    const w = parseTx(second.pair.revealTxHex).getInput(0).finalScriptWitness;
    if (w && w.length === 3) secondInternalKey = hex.encode(btc.TaprootControlBlock.decode(w[2]).internalKey);
  } catch {
    // Freshness is judged 'skipped' below rather than failing the record.
  }
  record.broadcast = { attempts: provider.broadcastAttempts.length, submitRefusals: provider.submitRefusals, lifecycleRejected: built.lifecycleRejected };
  record.asset.layerAfterDryRun = asset.currentLayer;
  check('build.reached_submit_seam', true, `the SDK handed a signed pair to submitInscription and was refused (INSCRIPTION_SUBMIT_FAILED)`);

  // 6) Inspect the pair from its bytes alone.
  const commitTx = parseTx(built.pair.signedCommitHex);
  const revealTx = parseTx(built.pair.revealTxHex);
  const spent = selection.selected.map((u) => ({ scriptPubKey: u.scriptPubKey, value: u.value }));
  const commit = txFacts(commitTx, built.pair.signedCommitHex, spent.map((s) => s.value), network);
  record.commit = commit;
  const commitOut0 = commitTx.getOutput(0);
  const commitAmount = Number(commitOut0.amount ?? 0n);
  const reveal = txFacts(revealTx, built.pair.revealTxHex, [commitAmount], network);
  record.reveal = reveal;

  // Fee.
  check('fee.rate_is_the_normalised_live_estimate', feeRate === normalizeFeeRate(rawEstimate), `provider estimate ${rawEstimate} -> ${feeRate} sat/vB (ceil, capped)`);
  check(
    'fee.sdk_built_at_the_same_rate',
    record.fee.sdkResolvedRate === feeRate,
    record.fee.sdkResolvedRate === null ? 'the SDK did not read a fee estimate during the build' : `the SDK resolved ${record.fee.sdkResolvedRate} sat/vB from the same provider`
  );
  check(
    'fee.commit_pays_at_least_the_rate',
    commit.feeSats >= feeRate * commit.vsize * 0.98,
    `commit fee ${commit.feeSats} sats over ${commit.vsize} vB (${commit.vsizeBasis}) = ${commit.feeRateSatVb} sat/vB vs ${feeRate} requested`
  );
  check(
    'fee.reveal_pays_at_least_the_rate',
    reveal.feeSats >= feeRate * reveal.vsize * 0.98,
    `reveal fee ${reveal.feeSats} sats over ${reveal.vsize} vB = ${reveal.feeRateSatVb} sat/vB vs ${feeRate} requested`
  );
  const postage = Number(revealTx.getOutput(0).amount ?? 0n);
  const actualSats = commit.feeSats + reveal.feeSats + postage;
  record.fee.actualSats = actualSats;
  record.fee.quoteAbsorbsUpToSatVb = Math.floor(((quote.quoteSats - POSTAGE_SATS) / (commit.vsize + reveal.vsize)) * 100) / 100;
  check(
    'fee.quote_with_buffer_covers_actual',
    quote.quoteSats >= actualSats,
    `quote ${quote.quoteSats} sats (fees x${QUOTE_BUFFER} + ${POSTAGE_SATS} postage; ${quote.unbufferedQuoteSats} unbuffered) vs actual ${actualSats} (commit ${commit.feeSats} + reveal ${reveal.feeSats} + postage ${postage}); absorbs a move up to ${record.fee.quoteAbsorbsUpToSatVb} sat/vB`
  );

  // Inputs.
  const declared = selection.selected.map(outpointOf);
  check(
    'inputs.exact_declared_set_in_order',
    commit.inputs.length === declared.length && commit.inputs.every((i, n) => i.outpoint === declared[n]),
    `commit spends [${commit.inputs.map((i) => i.outpoint).join(', ')}]; declared [${declared.join(', ')}]`
  );
  check('inputs.every_input_classified_clean', selected.every((s) => s.status === 'spendable'), selected.map((s) => `${s.outpoint} ${s.status}`).join('; '));
  check('inputs.rbf_signalled', commit.inputs.every((i) => i.sequence === RBF_SEQUENCE), `sequence ${commit.inputs.map((i) => '0x' + i.sequence.toString(16)).join(', ')}`);
  check('inputs.cover_outputs_plus_fee', commit.feeSats > 0, `inputs ${spent.reduce((n, s) => n + s.value, 0)} = outputs ${commit.outputs.reduce((n, o) => n + o.value, 0)} + fee ${commit.feeSats}`);

  // Commit outputs and signature.
  const out0 = commit.outputs[0];
  check('commit.output0_is_p2tr_commit', out0?.scriptType === 'tr' && commitAmount >= MIN_DUST, `vout 0 ${out0?.scriptType} ${out0?.address} ${commitAmount} sats`);
  check('commit.at_most_two_outputs', commit.outputs.length >= 1 && commit.outputs.length <= 2, `${commit.outputs.length} output(s)`);
  const change = commit.outputs[1];
  check(
    'commit.change_returns_to_deposit_address',
    change ? change.address === input.depositAddress && change.value >= MIN_DUST : true,
    change ? `vout 1 pays ${change.address} ${change.value} sats` : 'no change output (leftover below dust folded into the fee)'
  );
  if (input.signer.kind === 'local-key') {
    const sig = verifyCommitSignatures(commitTx, spent);
    check('commit.signed_by_deposit_key', commit.final && sig.ok, sig.detail);
  } else {
    check('commit.signed_by_deposit_key', 'skipped', 'unsigned mode: no key for the deposit address; Turnkey signs this in production');
  }

  // Reveal.
  const revealIn = revealTx.getInput(0);
  check(
    'reveal.spends_commit_output0',
    revealTx.inputsLength === 1 && !!revealIn.txid && hex.encode(revealIn.txid) === commit.txid && revealIn.index === 0,
    `reveal input ${reveal.inputs[0]?.outpoint}; commit txid ${commit.txid}`
  );
  check('reveal.rbf_signalled', reveal.inputs.every((i) => i.sequence === RBF_SEQUENCE), `sequence 0x${(revealIn.sequence ?? 0).toString(16)}`);
  const rOut = reveal.outputs[0];
  check(
    'reveal.single_output_pays_deposit_address',
    reveal.outputs.length === 1 && rOut?.address === input.depositAddress,
    `${reveal.outputs.length} output(s); vout 0 pays ${rOut?.address} ${rOut?.value} sats`
  );
  check('reveal.postage_at_least_dust', postage >= MIN_DUST, `${postage} sats`);

  const witness = revealIn.finalScriptWitness;
  if (witness && witness.length === 3) {
    const [sig, leaf, controlBlock] = witness;
    const cb = btc.TaprootControlBlock.decode(controlBlock);
    const internalKeyHex = hex.encode(cb.internalKey);
    const rebuilt = btc.p2tr(cb.internalKey, { script: leaf }, scureNetwork(network), true);
    const rebuiltAddress = rebuilt.address ?? '';
    record.revealKey = {
      internalKeyHex,
      controlBlockHex: hex.encode(controlBlock),
      leafVersion: cb.version,
      leafScriptBytes: leaf.length,
      commitAddress: out0?.address ?? '',
      rebuiltCommitAddress: rebuiltAddress,
      secondBuildInternalKeyHex: secondInternalKey,
    };
    check(
      'reveal.commit_output_derives_from_reveal_key_and_envelope',
      rebuiltAddress === out0?.address && hex.encode(rebuilt.script) === hex.encode(commitOut0.script ?? new Uint8Array()),
      `p2tr(internal key ${internalKeyHex.slice(0, 16)}…, leaf) = ${rebuiltAddress}; commit vout 0 = ${out0?.address}`
    );
    let sigOk = false;
    try {
      const digest = revealTx.preimageWitnessV1(0, [commitOut0.script!], 0x00, [BigInt(commitAmount)], -1, leaf, cb.version & 0xfe);
      sigOk = sig.length === 64 && schnorr.verify(sig, digest, cb.internalKey);
    } catch {
      sigOk = false;
    }
    check('reveal.schnorr_signature_by_reveal_key', sigOk, `64-byte schnorr signature verifies against the control block's internal key (script-path spend)`);
    check(
      'reveal.key_is_fresh_per_build',
      secondInternalKey === null ? 'skipped' : secondInternalKey !== internalKeyHex,
      secondInternalKey === null ? 'second build unavailable' : `second build of the same payload used internal key ${secondInternalKey.slice(0, 16)}…, a different random key`
    );
    const commitHexLower = built.pair.signedCommitHex.toLowerCase();
    const payloadHex = hex.encode(payloadBytes);
    const payloadWindow = payloadHex.length >= 64 ? payloadHex.slice(0, 64) : payloadHex;
    check(
      'commit.reveals_nothing_precomputable',
      !commitHexLower.includes(internalKeyHex) && !commitHexLower.includes(payloadWindow),
      'the commit carries only the tweaked output key: neither the reveal internal key nor the payload bytes appear in it'
    );
    try {
      const env = parseEnvelope(leaf);
      const bodySha = hex.encode(sha256(env.body));
      record.envelope = { contentType: env.contentType, bodyBytes: env.body.length, bodySha256: bodySha, metadataBytes: env.metadata.length };
      check('envelope.pubkey_is_reveal_key', hex.encode(env.pubkey) === internalKeyHex, 'the leaf script checks the same key the control block names');
      check('envelope.body_is_the_payload', bodySha === payloadSha && env.body.length === payloadBytes.length, `body sha256 ${bodySha.slice(0, 16)}… (${env.body.length} bytes) == payload`);
      check('envelope.content_type_is_the_payloads', env.contentType === input.payload.contentType, `${env.contentType}`);
      const metaText = new TextDecoder('utf-8', { fatal: false }).decode(env.metadata);
      const expectedDid = btcoDidFromSatoshi(built.satoshi, network);
      check(
        'envelope.metadata_names_the_did_sat',
        metaText.includes(expectedDid) && metaText.includes('OriginalsCelAnchor'),
        `${env.metadata.length} bytes of CBOR metadata carry ${expectedDid} and the OriginalsCelAnchor service`
      );
      record.sat = {
        satoshi: built.satoshi,
        identityOutpoint: declared[0],
        did: expectedDid,
        inscriptionId: built.inscriptionId,
        landsAt: `first sat of ${declared[0]} -> commit vout 0 (offset 0 of ${commitAmount} sats) -> reveal vout 0 (offset 0 of ${postage} sats) -> ${rOut?.address}`,
      };
    } catch (e) {
      check('envelope.parses', false, (e as Error).message);
    }
  } else {
    check('reveal.has_script_path_witness', false, `expected a 3-item witness (signature, envelope, control block); got ${witness?.length ?? 0}`);
  }

  // Where the sat lands.
  check(
    'sat.identity_is_first_input_and_lands_at_deposit_address',
    !!built.satoshi && commit.inputs[0]?.outpoint === declared[0] && out0?.n === 0 && rOut?.address === input.depositAddress && built.inscriptionId === `${reveal.txid}i0`,
    `sat ${built.satoshi} (first sat of ${declared[0]}) becomes ${btcoDidFromSatoshi(built.satoshi, network)}; inscription ${built.inscriptionId}`
  );

  // Broadcast safety and the log.
  check(
    'broadcast.nothing_left_the_process',
    provider.broadcastAttempts.length === 0 && provider.submitRefusals >= 1 && built.lifecycleRejected,
    `broadcastTransaction attempts: ${provider.broadcastAttempts.length}; submitInscription refusals: ${provider.submitRefusals}; the lifecycle call rejected`
  );
  check('asset.log_rolled_back', asset.currentLayer !== 'did:btco', `asset layer after the dry run: ${asset.currentLayer} (no migrate event kept for an inscription that never happened)`);

  return record;
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

export function renderRecord(r: DryRunRecord): string {
  const L: string[] = [];
  const h = (s: string) => { L.push(''); L.push(`-- ${s} --`); };
  L.push(
    r.source === 'mock'
      ? `== INSCRIPTION DRY RUN: MOCK PROVIDER (${r.network}): proves the harness, not mainnet ==`
      : `== INSCRIPTION DRY RUN: LIVE READS (${r.network}): nothing broadcast ==`
  );
  L.push(`at ${r.createdAt}`);
  L.push(`broadcastTransaction attempts: ${r.broadcast.attempts}; submitInscription refusals: ${r.broadcast.submitRefusals}; lifecycle rejected: ${r.broadcast.lifecycleRejected}`);

  h('Payload');
  L.push(`${r.payload.filename} (${r.payload.contentType}), ${r.payload.bytes} bytes, sha256 ${r.payload.sha256}`);
  L.push(`Original: ${r.asset.didCel}`);
  L.push(`published as: ${r.asset.didWebvh ?? '(not published)'}; CEL events before inscription: ${r.asset.celEvents}`);

  h('Fee');
  L.push(`provider estimate (1 block): ${r.fee.rawEstimate} -> normalised ${r.fee.feeRateSatVb} sat/vB (ceil, capped at 10,000)`);
  L.push(`SDK resolved during the build: ${r.fee.sdkResolvedRate ?? '(none)'} sat/vB`);
  L.push(`content-size hint: ${r.fee.contentBytes} bytes; quoted inputs: ${r.fee.quotedInputs}`);
  L.push(`deposit quote: ${r.fee.quoteSats} sats = fees x${QUOTE_BUFFER} + ${POSTAGE_SATS} postage (unbuffered ${r.fee.unbufferedQuoteSats})`);
  if (r.fee.actualSats !== null) L.push(`actual pair: ${r.fee.actualSats} sats; the quote absorbs a fee move up to ${r.fee.quoteAbsorbsUpToSatVb} sat/vB`);

  h(`Deposit address ${r.deposit.address}`);
  L.push(`classification: ${r.deposit.classification.ok ? 'ok' : `FAILED (${r.deposit.classification.reason})`}; unchecked: ${r.deposit.classification.unchecked}; spendable ${r.deposit.spendableSats} sats; shortfall ${r.deposit.shortfallSats}`);
  for (const c of r.deposit.candidates) {
    L.push(`  ${c.outpoint}  ${String(c.value).padStart(9)} sats  ${c.status}${c.inscriptions.length ? ` [${c.inscriptions.join(', ')}]` : ''}${c.reason ? ` (${c.reason})` : ''}`);
  }

  h('Inputs selected (largest first, until the quote is covered)');
  if (r.selection.length === 0) L.push('(none: nothing to build)');
  for (const s of r.selection) {
    L.push(`  #${s.index}${s.index === 0 ? ' identity' : '        '}  ${s.outpoint}  ${s.value} sats  rank ${s.rank}  running total ${s.runningTotal}  ${s.status}`);
  }

  const tx = (name: string, t: TxFacts | null) => {
    h(`${name} transaction`);
    if (!t) { L.push('(not built)'); return; }
    L.push(`txid ${t.txid}`);
    L.push(`${t.final ? 'fully signed' : 'UNSIGNED (witness absent)'}; vsize ${t.vsize} vB (${t.vsizeBasis}); fee ${t.feeSats} sats = ${t.feeRateSatVb} sat/vB`);
    for (const i of t.inputs) L.push(`  in  ${i.outpoint}  ${i.value} sats  seq 0x${i.sequence.toString(16)}${i.rbf ? ' (RBF)' : ''}  witness items ${i.witnessItems}`);
    for (const o of t.outputs) L.push(`  out ${o.n}  ${o.scriptType.padEnd(5)} ${o.address}  ${o.value} sats`);
    L.push(`hex ${t.hex}`);
  };
  tx('Commit', r.commit);
  tx('Reveal', r.reveal);

  if (r.revealKey) {
    h('Reveal key');
    L.push(`internal (reveal) key: ${r.revealKey.internalKeyHex}`);
    L.push(`control block: ${r.revealKey.controlBlockHex}`);
    L.push(`leaf version 0x${r.revealKey.leafVersion.toString(16)}, envelope script ${r.revealKey.leafScriptBytes} bytes`);
    L.push(`p2tr(internal key, envelope) = ${r.revealKey.rebuiltCommitAddress}; commit vout 0 = ${r.revealKey.commitAddress}`);
    L.push(`second build's internal key: ${r.revealKey.secondBuildInternalKeyHex ?? '(unavailable)'}`);
  }
  if (r.envelope) {
    h('Envelope');
    L.push(`content type ${r.envelope.contentType}; body ${r.envelope.bodyBytes} bytes sha256 ${r.envelope.bodySha256}; metadata ${r.envelope.metadataBytes} bytes`);
  }
  if (r.sat) {
    h('Where the sat lands');
    L.push(`sat ${r.sat.satoshi} -> ${r.sat.did}`);
    L.push(`inscription ${r.sat.inscriptionId}`);
    L.push(r.sat.landsAt);
  }
  if (r.buildError) {
    h('Build error');
    L.push(r.buildError);
  }

  h('Checklist');
  for (const c of r.checks) L.push(`[${c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'SKIP'}] ${c.id}: ${c.detail}`);
  const fails = r.checks.filter((c) => c.ok === false).length;
  const skips = r.checks.filter((c) => c.ok === 'skipped').length;
  L.push('');
  L.push(
    fails === 0
      ? `VERDICT: ${r.checks.length - skips} pass, 0 fail, ${skips} skipped. ${r.source === 'mock' ? 'The harness holds against the mock; this says nothing about mainnet.' : 'Broadcasting this pair would have been correct as far as these properties reach.'}`
      : `VERDICT: ${fails} FAIL. Broadcasting this pair would NOT have been correct.`
  );
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Fixtures for the mock path, shared with the tests.
// ---------------------------------------------------------------------------

/** A stand-in for the QuickNode ordinal lookup: answers from a fixed map, throws for anything unknown. */
export function fixtureOrdinalLookup(inscribed: Record<string, string[]>, opts: { failOn?: string[] } = {}): OrdinalLookup {
  return {
    async outpointInscriptions(outpoint) {
      const key = outpointOf(outpoint);
      if (opts.failOn?.includes(key)) throw new Error(`fixture: ${key} cannot be classified`);
      return inscribed[key] ?? [];
    },
  };
}

/** Deposits at the mock address: two clean outputs and one carrying an inscription that must never be spent. */
export function mockCandidates(scriptPubKey: string): { candidates: FundingUtxo[]; inscribed: Record<string, string[]> } {
  const candidates: FundingUtxo[] = [
    { txid: 'a'.repeat(64), vout: 0, value: 12_000, scriptPubKey },
    { txid: 'b'.repeat(64), vout: 1, value: 4_000, scriptPubKey },
    { txid: 'c'.repeat(64), vout: 0, value: 546, scriptPubKey },
  ];
  return { candidates, inscribed: { [`${'c'.repeat(64)}:0`]: [`${'d'.repeat(64)}i0`] } };
}

// A fixed throwaway key for the mock record, the same pattern the server tests
// use. It funds nothing anywhere; it is never printed.
const MOCK_PRIVATE_KEY = hex.decode('4'.repeat(64));

export function mockDryRunInput(overrides: Partial<DryRunInput> = {}): DryRunInput {
  const network: DryRunNetwork = 'regtest';
  const { address, scriptPubKey } = depositAddressOf(MOCK_PRIVATE_KEY, network);
  const { candidates, inscribed } = mockCandidates(scriptPubKey);
  return {
    network,
    depositAddress: address,
    candidates,
    ordinalLookup: fixtureOrdinalLookup(inscribed),
    reads: new OrdMockProvider({ feeRate: 5 }),
    signer: localKeySigner(MOCK_PRIVATE_KEY),
    payload: defaultPayload(),
    webvhDomain: 'originals.build',
    source: 'mock',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

async function liveDryRunInput(env: Record<string, string | undefined>): Promise<DryRunInput> {
  const endpoint = env.QUICKNODE_ENDPOINT!;
  const chain = serverBtcNetwork(env);
  const network: DryRunNetwork = chain === 'mainnet' ? 'mainnet' : 'testnet';
  const depositAddress = env.DRY_RUN_ADDRESS;
  if (!depositAddress) {
    throw new Error('Set DRY_RUN_ADDRESS to the funded P2WPKH deposit address the inscription would spend from.');
  }
  let signer: DryRunSigner = unsignedCommitSigner();
  if (env.DRY_RUN_WIF) {
    const privateKey = btc.WIF(scureNetwork(network)).decode(env.DRY_RUN_WIF.trim());
    const derived = depositAddressOf(privateKey, network).address;
    if (derived !== depositAddress) {
      throw new Error(`DRY_RUN_WIF funds ${derived}, not DRY_RUN_ADDRESS. Refusing to sign for an address the key does not control.`);
    }
    signer = localKeySigner(privateKey);
  }
  const indexer = resolveIndexer(env, network);
  console.error(`Reading ${chain} via QuickNode ${new URL(endpoint).host}; deposits via ${indexer.api}${indexer.authToken ? ' (authenticated)' : ''}.`);
  const utxos = await fetchAddressUtxos({ ...indexer, address: depositAddress, network });
  if (utxos.unconfirmedSats > 0) console.error(`  ${utxos.unconfirmedSats} sats unconfirmed at the address are not candidates.`);
  return {
    network,
    depositAddress,
    candidates: utxos.confirmed,
    ordinalLookup: cachedOrdinalLookup(quickNodeOrdinalLookup({ endpoint })),
    reads: new QuickNodeProvider({ endpoint, expectedNetwork: network }),
    signer,
    payload: env.DRY_RUN_PAYLOAD ? payloadFromFile(env.DRY_RUN_PAYLOAD) : defaultPayload(),
    webvhDomain: env.DRY_RUN_WEBVH_HOST ?? env.VITE_WEBVH_HOST ?? 'originals.build',
    source: 'live',
  };
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const input = env.QUICKNODE_ENDPOINT ? await liveDryRunInput(env) : mockDryRunInput();
  if (!env.QUICKNODE_ENDPOINT) {
    console.error('QUICKNODE_ENDPOINT is unset: running against the mock provider. This record proves the harness, not mainnet.');
  }
  const record = await dryRunInscription(input);
  console.log(renderRecord(record));
  if (env.DRY_RUN_OUT) {
    writeFileSync(env.DRY_RUN_OUT, JSON.stringify(record, null, 2) + '\n');
    console.error(`record written to ${env.DRY_RUN_OUT}`);
  }
  return record.checks.some((c) => c.ok === false) ? 1 : 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`❌ ${(e as Error).message}`);
      process.exit(1);
    });
}
