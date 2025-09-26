import { DUST_LIMIT_SATS, Utxo } from '../types';

export interface FeeEstimateOptions {
  bytesPerInput?: number;
  bytesPerOutput?: number;
  baseTxBytes?: number;
}

export interface SelectionOptions {
  feeRateSatsPerVb: number; // sats/vbyte
  targetAmountSats: number; // includes recipient output value
  allowLocked?: boolean;
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
    throw new UtxoSelectionError('TOO_LOW_FEE', 'Fee rate must be positive');
  }
  if (targetAmountSats < DUST_LIMIT_SATS) {
    throw new UtxoSelectionError('DUST_OUTPUT', 'Target amount below dust limit');
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
  if (forbidInscriptionBearingInputs) {
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
    let fee = estimateFeeSats(selected.length, 2, feeRateSatsPerVb, feeEstimate);
    let required = targetAmountSats + fee;

    if (accumulated >= required) {
      // Compute change and dust policy
      let change = accumulated - required;
      if (change > 0 && change < DUST_LIMIT_SATS) {
        // If change would be dust, try recomputing fee for single output (recipient only)
        fee = estimateFeeSats(selected.length, 1, feeRateSatsPerVb, feeEstimate);
        required = targetAmountSats + fee;
        change = accumulated - required;
        if (change > 0 && change < DUST_LIMIT_SATS) {
          // Force add to fee (better than creating dust)
          change = 0;
        }
      }
      if (accumulated >= targetAmountSats + fee) {
        return { selected, feeSats: fee, changeSats: Math.max(0, change) };
      }
    }
  }

  // If we got here, insufficient funds with the given policy
  if (hasLocked && !allowLocked) {
    throw new UtxoSelectionError('CONFLICTING_LOCKS', 'Insufficient funds due to locked UTXOs');
  }
  throw new UtxoSelectionError('INSUFFICIENT_FUNDS', 'Unable to cover target amount plus fees');
}

