import type { Utxo } from '../types/bitcoin.js';
import {
  isSegwitScriptPubKey,
  isProtectedUtxo,
  inputVBytesForScriptPubKey,
  outputVBytesForAddress,
  P2WPKH_INPUT_VBYTES
} from './utxo.js';

export interface PsbtOutput {
  address: string;
  value: number;
}

export interface BuildPsbtParams {
  utxos: Utxo[];
  outputs: PsbtOutput[];
  changeAddress: string;
  feeRate: number; // sat/vB
  network: 'mainnet' | 'testnet' | 'regtest' | 'signet';
  dustLimit?: number;
  /**
   * Opt in to spending UTXOs that carry inscriptions/resources or are locked.
   * Defaults to false: inscription outputs are characteristically the smallest
   * UTXOs, so the ascending greedy selection below would otherwise
   * preferentially spend them as plain payment inputs.
   */
  allowOrdinalUtxos?: boolean;
}

export interface BuildPsbtResult {
  psbtBase64: string; // opaque PSBT representation (base64-encoded payload)
  selectedUtxos: Utxo[];
  fee: number;
  changeOutput?: PsbtOutput;
}

function estimateVBytes(inputs: Utxo[], outputVBytes: number[]): number {
  const overhead = 10; // base tx overhead
  // Inputs are sized by script class (P2WPKH 68, P2TR 57.5, P2WSH a
  // conservative 120) — a flat P2WPKH assumption underpays the requested fee
  // rate for P2WSH inputs (issue #344). build() rejects UTXOs with a KNOWN
  // non-segwit scriptPubKey up front, so an input without a scriptPubKey is
  // assumed P2WPKH here — charging it at legacy width would over-estimate
  // fees and spuriously fail (or over-fund) selections made from valid
  // segwit UTXOs that simply omit the field. The legacy size is only applied
  // defensively if a non-segwit script slips in.
  const inputSize = inputs.reduce(
    (sum, u) => sum + (u.scriptPubKey ? inputVBytesForScriptPubKey(u.scriptPubKey) : P2WPKH_INPUT_VBYTES),
    0
  );
  const outputSize = outputVBytes.reduce((sum, v) => sum + v, 0);
  return Math.ceil(overhead + inputSize + outputSize);
}

export class PSBTBuilder {
  constructor(private readonly dustLimit = 546) {}

  build(params: BuildPsbtParams): BuildPsbtResult {
    const { utxos, outputs, changeAddress, feeRate } = params;
    if (!utxos || utxos.length === 0) throw new Error('No UTXOs');
    if (!outputs || outputs.length === 0) throw new Error('No outputs');

    // The size estimate assumes ~68 vB witness inputs; a legacy input would
    // silently underpay the requested fee rate. Reject rather than under-fee.
    const legacy = utxos.filter(u => u.scriptPubKey && !isSegwitScriptPubKey(u.scriptPubKey));
    if (legacy.length > 0) {
      throw new Error(
        `Non-segwit (legacy) funding UTXOs are not supported: ` +
        legacy.map(u => `${u.txid}:${u.vout}`).join(', ') +
        `. Only segwit UTXOs (P2WPKH/P2WSH/P2TR) can be used.`
      );
    }

    // Ordinal safety (issue #249): exclude inscription-bearing, resource, and
    // locked UTXOs unless the caller explicitly opts in.
    const spendable = params.allowOrdinalUtxos === true ? utxos : utxos.filter(u => !isProtectedUtxo(u));
    if (spendable.length === 0) {
      throw new Error(
        'All available UTXOs carry inscriptions/resources or are locked and cannot be used for fees/payments. ' +
        'Add non-resource UTXOs, or pass allowOrdinalUtxos: true to override (dangerous).'
      );
    }

    // Sort UTXOs ascending by value for simple greedy selection
    const sorted = [...spendable].sort((a, b) => a.value - b.value);

    // Outputs (and the potential change output) are sized by their address's
    // script class — a P2TR/P2WSH output is 43 vB, not the 31 vB of P2WPKH.
    const outputSizes = outputs.map(o => outputVBytesForAddress(o.address));
    const changeSize = outputVBytesForAddress(changeAddress);

    // Start with smallest set to cover target + estimated fee; refine iteratively
    const targetValue = outputs.reduce((s, o) => s + o.value, 0);
    let selected: Utxo[] = [];
    let total = 0;

    const pick = () => {
      selected = [];
      total = 0;
      for (const u of sorted) {
        selected.push(u);
        total += u.value;
        const vbytes = estimateVBytes(selected, [...outputSizes, changeSize]); // + potential change
        const fee = Math.ceil(vbytes * feeRate);
        if (total >= targetValue + fee) break;
      }
      if (total < targetValue) throw new Error('Insufficient funds');
    };

    pick();
    const initialVBytes = estimateVBytes(selected, [...outputSizes, changeSize]);
    let fee = Math.ceil(initialVBytes * feeRate);
    let change = total - targetValue - fee;
    let includeChange = change >= this.dustLimit;

    // Re-estimate once we know whether change is included
    const finalVBytes = estimateVBytes(selected, includeChange ? [...outputSizes, changeSize] : outputSizes);
    fee = Math.ceil(finalVBytes * feeRate);
    change = total - targetValue - fee;
    includeChange = change >= this.dustLimit;

    let changeOutput: PsbtOutput | undefined;
    if (!includeChange) {
      // Inputs must still cover the outputs plus the required fee; otherwise
      // this would silently build a transaction paying below the requested
      // fee rate (possibly zero).
      if (total < targetValue + fee) {
        throw new Error('Insufficient funds');
      }
      // Add dust to fee
      fee = total - targetValue;
    } else {
      changeOutput = { address: changeAddress, value: change };
    }

    // Construct a minimal PSBT-like payload for dry-run/testing. We intentionally avoid
    // bringing heavy bitcoin libraries here; this builder focuses on deterministic
    // selection, fee estimation, and change handling.
    const payload = {
      version: 0,
      inputs: selected.map(u => ({ txid: u.txid, vout: u.vout })),
      outputs: [
        ...outputs.map(o => ({ address: o.address, value: o.value })),
        ...(changeOutput ? [changeOutput] : [])
      ],
      fee
    };
    // Base64 encode via Node when available; fallback to btoa if present
    const json = JSON.stringify(payload);
    let psbtBase64: string;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const B: any = (global as any).Buffer;
      psbtBase64 = B ? B.from(json, 'utf8').toString('base64') : (global as any).btoa(json);
    } catch {
      psbtBase64 = `psbt:${json}`;
    }

    return { psbtBase64, selectedUtxos: selected, fee, changeOutput };
  }
}

