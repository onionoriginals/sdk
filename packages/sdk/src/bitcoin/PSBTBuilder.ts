import type { Utxo } from '../types/bitcoin.js';
import { isSegwitScriptPubKey } from './utxo.js';

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
}

export interface BuildPsbtResult {
  psbtBase64: string; // opaque PSBT representation (base64-encoded payload)
  selectedUtxos: Utxo[];
  fee: number;
  changeOutput?: PsbtOutput;
}

function estimateVBytes(inputs: Utxo[], outputs: number): number {
  const overhead = 10;       // base tx overhead
  const segwitInSize = 68;   // rough P2WPKH/any-segwit input size
  const legacyInSize = 148;  // legacy P2PKH sizing
  const outSize = 31;        // P2WPKH output size
  // build() rejects UTXOs with a KNOWN non-segwit scriptPubKey up front, so
  // an input without a scriptPubKey is assumed segwit here — charging it at
  // legacy width would over-estimate fees and spuriously fail (or over-fund)
  // selections made from valid segwit UTXOs that simply omit the field. The
  // legacy size is only applied defensively if a non-segwit script slips in.
  const inputSize = inputs.reduce(
    (sum, u) => sum + (!u.scriptPubKey || isSegwitScriptPubKey(u.scriptPubKey) ? segwitInSize : legacyInSize),
    0
  );
  return Math.ceil(overhead + inputSize + outputs * outSize);
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

    // Sort UTXOs ascending by value for simple greedy selection
    const sorted = [...utxos].sort((a, b) => a.value - b.value);

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
        const vbytes = estimateVBytes(selected, outputs.length + 1); // +1 potential change
        const fee = Math.ceil(vbytes * feeRate);
        if (total >= targetValue + fee) break;
      }
      if (total < targetValue) throw new Error('Insufficient funds');
    };

    pick();
    const initialVBytes = estimateVBytes(selected, outputs.length + 1);
    let fee = Math.ceil(initialVBytes * feeRate);
    let change = total - targetValue - fee;
    let includeChange = change >= this.dustLimit;

    // Re-estimate once we know whether change is included
    const finalVBytes = estimateVBytes(selected, outputs.length + (includeChange ? 1 : 0));
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

