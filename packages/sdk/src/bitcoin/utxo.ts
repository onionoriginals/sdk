import { DUST_LIMIT_SATS, Utxo } from '../types/index.js';

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

export const DEFAULT_FEE_ESTIMATE: Required<FeeEstimateOptions> = {
  bytesPerInput: 148,
  bytesPerOutput: 34,
  baseTxBytes: 10
};

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

  // Filter UTXOs based on policy
  let candidateUtxos = utxos.slice().filter(u => typeof u.value === 'number' && u.value > 0);
  const hasLocked = candidateUtxos.some(u => u.locked);
  if (hasLocked && !allowLocked) {
    // If excluding locked leaves insufficient funds, surface a specific error later; but first mark conflict
    // We'll check after filtering
  }

  if (!allowLocked) {
    candidateUtxos = candidateUtxos.filter(u => !u.locked);
  }
  if (forbidInscriptionBearingInputs !== false) {
    candidateUtxos = candidateUtxos.filter(u => !u.inscriptions || u.inscriptions.length === 0);
  }

  // Greedy accumulate until amount + fee is satisfied. Start with 2 outputs (recipient + change), adjust if change is dust.
  const selected: Utxo[] = [];
  let accumulated = 0;

  // Sort largest first to reduce change outputs and input count
  candidateUtxos.sort((a, b) => b.value - a.value);

  // We'll iteratively include inputs and recompute fee until covered
  for (const utxo of candidateUtxos) {
    selected.push(utxo);
    accumulated += utxo.value;

    // Assume two outputs initially
    const fee = estimateFeeSats(selected.length, 2, feeRateSatsPerVb, feeEstimate);
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
  if (hasLocked && !allowLocked) {
    const err = new UtxoSelectionError('CONFLICTING_LOCKS', 'CONFLICTING_LOCKS');
    throw err;
  }
  const err = new UtxoSelectionError('INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS');
  throw err;
}

