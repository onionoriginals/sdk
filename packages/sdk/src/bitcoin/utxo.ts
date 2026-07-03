import { DUST_LIMIT_SATS, Utxo, ResourceUtxo } from '../types/index.js';

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
  code: 'INSUFFICIENT_FUNDS' | 'TOO_LOW_FEE' | 'DUST_OUTPUT' | 'CONFLICTING_LOCKS' | 'SAT_SAFETY';
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
  let candidateUtxos = utxos.slice().filter(u =>
    typeof u.value === 'number' && u.value > 0 &&
    (!u.scriptPubKey || isSegwitScriptPubKey(u.scriptPubKey))
  );
  const forbidInscribed = forbidInscriptionBearingInputs !== false;
  // A UTXO carries an ordinal either because an inscription id is recorded on it
  // OR because it is flagged with the first-class `hasResource` marker
  // (ResourceUtxo). Spending such a UTXO as a plain payment/fee input transfers
  // or burns the ordinal it carries, so both markers must exclude it. The sibling
  // selectors in utxo-selection.ts (`carriesResource`) and transactions/commit.ts
  // (`isProtected`) already check both; this path previously only checked
  // `inscriptions`, letting a `hasResource: true` UTXO be spent as a fee input.
  const isInscribed = (u: Utxo): boolean =>
    !!(u.inscriptions && u.inscriptions.length > 0) || (u as ResourceUtxo).hasResource === true;
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

  // Per-input sizing: verified segwit inputs use the (possibly overridden)
  // bytesPerInput; unclassified inputs (no scriptPubKey) are priced at
  // conservative legacy width unless the caller explicitly overrode
  // bytesPerInput (an explicit override applies to every input).
  const est = { ...DEFAULT_FEE_ESTIMATE, ...feeEstimate };
  const perInputOverridden = feeEstimate?.bytesPerInput !== undefined;
  const inputVBytes = (u: Utxo): number =>
    perInputOverridden || (u.scriptPubKey && isSegwitScriptPubKey(u.scriptPubKey))
      ? est.bytesPerInput
      : UNCLASSIFIED_INPUT_VBYTES;
  const feeForSelection = (numOutputs: number): number => {
    const bytes = est.baseTxBytes
      + selected.reduce((sum, u) => sum + inputVBytes(u), 0)
      + numOutputs * est.bytesPerOutput;
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
  }

  // If we got here, insufficient funds with the given policy
  if (hasUsefulLocked && !allowLocked) {
    const err = new UtxoSelectionError('CONFLICTING_LOCKS', 'CONFLICTING_LOCKS');
    throw err;
  }
  const err = new UtxoSelectionError('INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS');
  throw err;
}

