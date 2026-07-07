import { DUST_LIMIT_SATS, Utxo, ResourceUtxo } from '../types/index.js';


/**
 * True when a UTXO carries an ordinal: an inscription id is recorded on the
 * outpoint OR it is flagged with the first-class `hasResource` marker
 * (ResourceUtxo). Spending such a UTXO as a plain payment/fee input transfers
 * or burns the ordinal it carries. This is THE shared exclusion predicate —
 * every selector (selectUtxos here, utxo-selection.ts, PSBTBuilder,
 * transactions/commit.ts) must use it (or `isProtectedUtxo`) so a new
 * protection marker is added in exactly one place.
 */
export function carriesOrdinal(u: Utxo): boolean {
  return !!(u.inscriptions && u.inscriptions.length > 0) || (u as ResourceUtxo).hasResource === true;
}

/**
 * True when a UTXO must not be auto-selected as a plain payment/fee input:
 * it carries an ordinal (see `carriesOrdinal`) or is wallet-locked.
 */
export function isProtectedUtxo(u: Utxo): boolean {
  return u.locked === true || carriesOrdinal(u);
}

export interface FeeEstimateOptions {
  bytesPerInput?: number;
  bytesPerOutput?: number;
  baseTxBytes?: number;
}

export interface SelectionOptions {
  feeRateSatsPerVb: number; // sats/vbyte
  targetAmountSats: number; // includes recipient output value
  allowLocked?: boolean;
  /**
   * Whether inscription-bearing UTXOs are excluded from selection.
   * Defaults to true: spending an inscribed UTXO as a plain payment input
   * transfers or burns the ordinal it carries. Pass false explicitly to
   * opt in to spending inscribed UTXOs.
   */
  forbidInscriptionBearingInputs?: boolean;
  changeAddress?: string;
  feeEstimate?: FeeEstimateOptions;
}

export interface SelectionResult {
  selected: Utxo[];
  feeSats: number;
  changeSats: number;
}

/**
 * Default per-component vsize estimates. The SDK's transaction paths accept
 * only segwit funding UTXOs (see isSegwitScriptPubKey), so the per-input
 * constant is the P2WPKH ~68 vB used by every other estimator
 * (utxo-selection.ts, PSBTBuilder, commit.ts) — a legacy P2PKH input would be
 * ~148 vB, which is exactly why legacy inputs are rejected rather than
 * silently under-fee'd.
 */
export const DEFAULT_FEE_ESTIMATE: Required<FeeEstimateOptions> = {
  bytesPerInput: 68,
  bytesPerOutput: 34,
  baseTxBytes: 10
};

/**
 * Conservative sizing for inputs whose scriptPubKey is unknown and therefore
 * cannot be verified as segwit: assume legacy P2PKH (~148 vB) so the fee
 * quote never underpays if the input turns out not to be a witness input.
 */
export const UNCLASSIFIED_INPUT_VBYTES = 148;

/** Script classes the fee estimators can size. */
export type ScriptClass = 'p2wpkh' | 'p2wsh' | 'p2tr' | 'segwit-other' | 'legacy' | 'unknown';

/** P2WPKH input: 41 vB base + ~107-byte witness (sig + pubkey) / 4 ≈ 68 vB. */
export const P2WPKH_INPUT_VBYTES = 68;
/** P2TR key-path input: 41 vB base + 66-byte witness (schnorr sig) / 4 = 57.5 vB. */
export const P2TR_INPUT_VBYTES = 57.5;
/**
 * P2WSH input, sized conservatively. The witness carries the full witness
 * script plus its stack arguments, so the true size depends on the script: a
 * 2-of-3 CHECKMULTISIG spend is ~105 vB (2×72-byte sigs + 105-byte script,
 * witness-discounted). 120 vB covers that common worst case with margin —
 * underestimating here builds transactions that pay BELOW the requested fee
 * rate and stall in the mempool (issue #344), so when uncertain we overpay.
 */
export const P2WSH_INPUT_VBYTES = 120;

/** P2WPKH output: 8 (value) + 1 (script len) + 22 (script) = 31 vB. */
export const P2WPKH_OUTPUT_VBYTES = 31;
/** P2WSH / P2TR output: 8 + 1 + 34 = 43 vB. Also the conservative default. */
export const WITNESS_32B_OUTPUT_VBYTES = 43;
/** Legacy P2PKH output: 8 + 1 + 25 = 34 vB. */
export const P2PKH_OUTPUT_VBYTES = 34;
/** Legacy P2SH output: 8 + 1 + 23 = 32 vB. */
export const P2SH_OUTPUT_VBYTES = 32;

/**
 * Classify a scriptPubKey by script class so fee estimators can size the
 * input's witness correctly instead of assuming P2WPKH for every segwit
 * program (issue #344 — that assumption underpays for P2WSH).
 */
export function classifyScriptPubKey(scriptPubKeyHex?: string): ScriptClass {
  if (!scriptPubKeyHex) return 'unknown';
  if (!isSegwitScriptPubKey(scriptPubKeyHex)) return 'legacy';
  const hex = scriptPubKeyHex.toLowerCase();
  const versionByte = parseInt(hex.slice(0, 2), 16);
  const pushLength = parseInt(hex.slice(2, 4), 16);
  if (versionByte === 0x00 && pushLength === 20) return 'p2wpkh';
  if (versionByte === 0x00 && pushLength === 32) return 'p2wsh';
  if (versionByte === 0x51 && pushLength === 32) return 'p2tr';
  return 'segwit-other';
}

/**
 * Virtual size to charge for spending an input with the given scriptPubKey.
 * Sizes are per script class; anything unclassifiable is charged at the
 * largest plausible width so the resulting fee never pays below the
 * requested rate (an overpay is bounded; an underpay strands the tx).
 */
export function inputVBytesForScriptPubKey(scriptPubKeyHex?: string): number {
  switch (classifyScriptPubKey(scriptPubKeyHex)) {
    case 'p2wpkh': return P2WPKH_INPUT_VBYTES;
    case 'p2tr': return P2TR_INPUT_VBYTES;
    case 'p2wsh': return P2WSH_INPUT_VBYTES;
    // Future witness versions / non-standard v0 programs: witness shape is
    // unknown, so charge the conservative P2WSH width.
    case 'segwit-other': return P2WSH_INPUT_VBYTES;
    default: return UNCLASSIFIED_INPUT_VBYTES;
  }
}

/**
 * Virtual size of an output paying the given address, classified by address
 * form (bech32 witness version + program length, or base58 prefix). Unknown
 * or unparseable addresses are charged at the largest standard output size
 * (43 vB) so the estimate errs toward overpaying rather than underpaying.
 */
export function outputVBytesForAddress(address?: string): number {
  if (!address) return WITNESS_32B_OUTPUT_VBYTES;
  const addr = address.toLowerCase();
  const sep = addr.lastIndexOf('1');
  if (/^(bc1|tb1|bcrt1)/.test(addr) && sep > 0) {
    const data = addr.slice(sep + 1);
    // bech32 data part: 1 version char + program (20 bytes → 32 chars,
    // 32 bytes → 52 chars) + 6 checksum chars.
    if (data.length === 39 && data.startsWith('q')) return P2WPKH_OUTPUT_VBYTES;
    return WITNESS_32B_OUTPUT_VBYTES;
  }
  // Base58: mainnet P2PKH '1', testnet P2PKH 'm'/'n'; mainnet P2SH '3', testnet P2SH '2'.
  if (/^[1mn]/.test(addr)) return P2PKH_OUTPUT_VBYTES;
  if (/^[32]/.test(addr)) return P2SH_OUTPUT_VBYTES;
  return WITNESS_32B_OUTPUT_VBYTES;
}

/**
 * True when a scriptPubKey hex string is a segwit witness program
 * (v0 P2WPKH/P2WSH, v1 P2TR, or any future v2–v16 program): a version opcode
 * (OP_0 or OP_1..OP_16) followed by a single direct push of 2–40 bytes.
 *
 * The SDK's fee estimators assume witness inputs (~68 vB) and its signers
 * provide only `witnessUtxo` data, so a legacy (P2PKH/P2SH) funding UTXO
 * would be fee-under-estimated AND unsignable — callers must reject them.
 */
export function isSegwitScriptPubKey(scriptPubKeyHex: string): boolean {
  const hex = scriptPubKeyHex.toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return false;
  const totalBytes = hex.length / 2;
  const versionByte = parseInt(hex.slice(0, 2), 16);
  const pushLength = parseInt(hex.slice(2, 4), 16);
  const isVersionOpcode = versionByte === 0x00 || (versionByte >= 0x51 && versionByte <= 0x60);
  return isVersionOpcode && pushLength >= 2 && pushLength <= 40 && totalBytes === 2 + pushLength;
}

export function estimateFeeSats(numInputs: number, numOutputs: number, feeRateSatsPerVb: number, feeEstimate: FeeEstimateOptions = {}): number {
  const est = { ...DEFAULT_FEE_ESTIMATE, ...feeEstimate };
  const bytes = est.baseTxBytes + numInputs * est.bytesPerInput + numOutputs * est.bytesPerOutput;
  return Math.ceil(bytes * feeRateSatsPerVb);
}

export class UtxoSelectionError extends Error {
  code: 'INSUFFICIENT_FUNDS' | 'TOO_LOW_FEE' | 'DUST_OUTPUT' | 'CONFLICTING_LOCKS' | 'SAT_SAFETY' | 'UNSUPPORTED_INPUT';
  constructor(code: UtxoSelectionError['code'], message?: string) {
    super(message || code);
    this.code = code;
  }
}

export function selectUtxos(utxos: Utxo[], options: SelectionOptions): SelectionResult {
  const { feeRateSatsPerVb, targetAmountSats, allowLocked, forbidInscriptionBearingInputs, feeEstimate } = options;
  if (feeRateSatsPerVb <= 0) {
    const err = new UtxoSelectionError('TOO_LOW_FEE', 'TOO_LOW_FEE');
    throw err;
  }
  if (targetAmountSats < DUST_LIMIT_SATS) {
    const err = new UtxoSelectionError('DUST_OUTPUT', 'DUST_OUTPUT');
    throw err;
  }

  // Filter UTXOs based on policy. UTXOs with a known non-segwit scriptPubKey
  // are excluded: the fee estimate assumes witness inputs and the signing
  // paths only supply witnessUtxo data, so selecting one would produce an
  // under-fee'd, unsignable transaction. UTXOs without a scriptPubKey cannot
  // be classified here; they pass through but are fee-sized conservatively
  // at legacy width (UNCLASSIFIED_INPUT_VBYTES) below so the quote never
  // underpays.
  const isNonSegwit = (u: Utxo): boolean =>
    !!u.scriptPubKey && !isSegwitScriptPubKey(u.scriptPubKey);
  // Track excluded non-segwit UTXOs so a wallet whose funds sit in legacy
  // outputs gets an UNSUPPORTED_INPUT diagnosis instead of a misleading
  // INSUFFICIENT_FUNDS ("add more funds" would not help).
  const hasExcludedNonSegwit = utxos.some(u =>
    typeof u.value === 'number' && u.value > 0 && isNonSegwit(u)
  );
  let candidateUtxos = utxos.slice().filter(u =>
    typeof u.value === 'number' && u.value > 0 && !isNonSegwit(u)
  );
  const forbidInscribed = forbidInscriptionBearingInputs !== false;
  const isInscribed = carriesOrdinal;
  // CONFLICTING_LOCKS is only an accurate diagnosis when unlocking could
  // actually help — i.e. a locked UTXO exists that selection would otherwise
  // be allowed to use. A locked UTXO that is also inscription-protected
  // would still be excluded after unlocking.
  const hasUsefulLocked = candidateUtxos.some(u => u.locked && !(forbidInscribed && isInscribed(u)));
  if (!allowLocked) {
    candidateUtxos = candidateUtxos.filter(u => !u.locked);
  }
  if (forbidInscribed) {
    candidateUtxos = candidateUtxos.filter(u => !isInscribed(u));
  }

  // Greedy accumulate until amount + fee is satisfied. Start with 2 outputs (recipient + change), adjust if change is dust.
  const selected: Utxo[] = [];
  let accumulated = 0;

  // Sort largest first to reduce change outputs and input count
  candidateUtxos.sort((a, b) => b.value - a.value);

  // Per-input sizing: verified segwit inputs are priced by script class
  // (P2WPKH 68, P2TR 57.5, P2WSH conservative 120 — issue #344: charging
  // P2WPKH width for a P2WSH input underpays the requested fee rate);
  // unclassified inputs (no scriptPubKey) are priced at conservative legacy
  // width. An explicit bytesPerInput override applies to every input.
  const est = { ...DEFAULT_FEE_ESTIMATE, ...feeEstimate };
  const perInputOverridden = feeEstimate?.bytesPerInput !== undefined;
  const inputVBytes = (u: Utxo): number =>
    perInputOverridden ? est.bytesPerInput : inputVBytesForScriptPubKey(u.scriptPubKey);
  // The change output is sized by the change address's script class when one
  // is provided (a P2TR/P2WSH change output is 43 vB, not the P2WPKH-ish
  // default); an explicit bytesPerOutput override applies to every output.
  const perOutputOverridden = feeEstimate?.bytesPerOutput !== undefined;
  const changeOutputVBytes = !perOutputOverridden && options.changeAddress
    ? outputVBytesForAddress(options.changeAddress)
    : est.bytesPerOutput;
  const feeForSelection = (numOutputs: number): number => {
    // numOutputs is 1 (recipient only) or 2 (recipient + change).
    const outputBytes = numOutputs >= 2
      ? (numOutputs - 1) * est.bytesPerOutput + changeOutputVBytes
      : numOutputs * est.bytesPerOutput;
    const bytes = est.baseTxBytes
      + selected.reduce((sum, u) => sum + inputVBytes(u), 0)
      + outputBytes;
    return Math.ceil(bytes * feeRateSatsPerVb);
  };

  // We'll iteratively include inputs and recompute fee until covered
  for (const utxo of candidateUtxos) {
    selected.push(utxo);
    accumulated += utxo.value;

    // Assume two outputs initially
    const fee = feeForSelection(2);
    const required = targetAmountSats + fee;

    if (accumulated >= required) {
      let change = accumulated - required;
      let feeSats = fee;
      if (change > 0 && change < DUST_LIMIT_SATS) {
        // A dust change output is not worth creating. Drop it and fold the
        // remainder into the fee so the reported feeSats matches what the
        // transaction actually pays (overpay is bounded by the dust limit).
        // Re-pricing with a 1-output fee and keeping the change would
        // underpay the requested fee rate once the change output is added.
        feeSats = accumulated - targetAmountSats;
        change = 0;
      }
      return { selected, feeSats, changeSats: change };
    }

    // A two-output (recipient + change) transaction is not yet fundable, but a
    // changeless one might be: with no change output the entire remainder above
    // the recipient amount becomes fee. This is a valid solution as long as
    // that remainder covers the single-output fee. Without this branch a wallet
    // holding exactly enough for a changeless spend — accumulated in
    // [target + fee(1out), target + fee(2out)) — was wrongly rejected with
    // INSUFFICIENT_FUNDS. Overpay is bounded by one output's cost.
    const feeChangeless = feeForSelection(1);
    if (accumulated - targetAmountSats >= feeChangeless) {
      return { selected, feeSats: accumulated - targetAmountSats, changeSats: 0 };
    }
  }

  // If we got here, insufficient funds with the given policy
  if (hasUsefulLocked && !allowLocked) {
    const err = new UtxoSelectionError('CONFLICTING_LOCKS', 'CONFLICTING_LOCKS');
    throw err;
  }
  if (hasExcludedNonSegwit) {
    throw new UtxoSelectionError(
      'UNSUPPORTED_INPUT',
      'Selection failed and non-segwit (legacy P2PKH/P2SH) UTXOs were excluded: the SDK signs only ' +
      'witness inputs, so those funds cannot be spent here. Fund the wallet with segwit UTXOs.'
    );
  }
  const err = new UtxoSelectionError('INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS');
  throw err;
}

