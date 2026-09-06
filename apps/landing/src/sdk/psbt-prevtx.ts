import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';

/**
 * Add `nonWitnessUtxo` (the whole previous transaction) to every PSBT input
 * that lacks it.
 *
 * Turnkey refuses a SegWit v0 input carrying only `witnessUtxo`:
 *
 *   code 3: input 0 is missing non_witness_utxo for SegWit v0 input;
 *           provide both witness_utxo and non_witness_utxo
 *
 * BIP-143 does not need the full previous transaction to compute a v0 sighash,
 * and the SDK's commit builder supplies only `witnessUtxo` for that reason.
 * Turnkey requires it anyway — historically to defend against the fee-inflation
 * attack on hardware signers, which learn the true input amount only from the
 * full previous transaction. So this is a signer-specific requirement, patched
 * at the signer rather than in the SDK's protocol code.
 *
 * The previous transaction arrives over the network and is what the signer will
 * be told it is spending, so it is VERIFIED, never trusted: it must hash to the
 * txid the input names, and the output at `index` must match the `witnessUtxo`
 * already in the PSBT byte for byte. A mismatch is refused rather than signed.
 */
export async function addNonWitnessUtxos(
  psbtBase64: string,
  fetchRawTx: (txid: string) => Promise<string>
): Promise<string> {
  const { base64 } = await import('@scure/base');
  const tx = btc.Transaction.fromPSBT(base64.decode(psbtBase64), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });

  for (let i = 0; i < tx.inputsLength; i += 1) {
    const input = tx.getInput(i);
    if (input.nonWitnessUtxo || !input.witnessUtxo || !input.txid) continue;
    const txid = hex.encode(input.txid);
    const raw = await fetchRawTx(txid);
    tx.updateInput(i, {
      nonWitnessUtxo: verifiedPrevTx(raw, txid, input.index ?? 0, input.witnessUtxo),
    });
  }
  return base64.encode(tx.toPSBT());
}

/**
 * The previous transaction's bytes, once proved to be the right ones. Returns
 * bytes rather than a boolean so a caller cannot forget to check.
 */
function verifiedPrevTx(
  rawHex: string,
  expectedTxid: string,
  index: number,
  witnessUtxo: { script: Uint8Array; amount: bigint }
): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(rawHex) || rawHex.length % 2 !== 0) {
    throw new Error(`Previous transaction for ${expectedTxid} was not raw hex.`);
  }
  const bytes = hex.decode(rawHex);
  const prev = btc.Transaction.fromRaw(bytes, { allowUnknownInputs: true, allowUnknownOutputs: true });
  // Double-SHA256 of the serialised transaction. Nothing else establishes that
  // the indexer returned the transaction we actually asked about.
  if (prev.id !== expectedTxid) {
    throw new Error(`Previous transaction hashes to ${prev.id}, not ${expectedTxid}.`);
  }
  // Checked before getOutput, which throws a bare "Wrong output index=5" that
  // names neither the transaction nor why we were looking.
  if (index < 0 || index >= prev.outputsLength) {
    throw new Error(`Previous transaction ${expectedTxid} has no output ${index}.`);
  }
  const out = prev.getOutput(index);
  if (!out?.script || typeof out.amount !== 'bigint') {
    throw new Error(`Previous transaction ${expectedTxid} has no output ${index}.`);
  }
  if (out.amount !== witnessUtxo.amount) {
    throw new Error(
      `Output ${expectedTxid}:${index} is ${out.amount} sats, but the PSBT was built for ${witnessUtxo.amount}.`
    );
  }
  if (hex.encode(out.script) !== hex.encode(witnessUtxo.script)) {
    throw new Error(`Output ${expectedTxid}:${index} pays a different script than the PSBT expects.`);
  }
  return bytes;
}
