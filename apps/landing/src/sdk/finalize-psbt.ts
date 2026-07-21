/**
 * Finalize a partially-signed PSBT into broadcast-ready raw tx hex.
 *
 * This is the second half of the recommended Turnkey signing path: Turnkey
 * signTransaction({ type: 'TRANSACTION_TYPE_BITCOIN' }) returns a PSBT with
 * signatures attached but NOT finalized (it owns sighash/DER/low-S). @scure/
 * btc-signer assembles the final witness and serializes the network tx. The
 * SDK's inscribe-on-sat path expects raw hex from the BitcoinSigner, never a
 * PSBT, so finalization MUST happen here.
 */
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';

export class FinalizePsbtError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FinalizePsbtError';
  }
}

export function finalizeSignedPsbt(partiallySignedPsbtBase64: string): string {
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromPSBT(base64.decode(partiallySignedPsbtBase64), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
  } catch (e) {
    throw new FinalizePsbtError(
      `Could not parse the signed PSBT returned by the signer: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
  try {
    // Finalize EVERY input — an input still missing its signature (Turnkey did
    // not sign it) throws here, which is the correct fail-closed behavior: a
    // partially-finalized tx must never reach broadcast.
    tx.finalize();
  } catch (e) {
    throw new FinalizePsbtError(
      `Signed PSBT could not be finalized (an input is unsigned or non-standard): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
  return hex.encode(tx.extract());
}
