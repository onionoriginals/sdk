/**
 * SDK BitcoinSigner backed by the user's Turnkey session key.
 *
 * The SDK's inscribe-on-sat path builds the commit PSBT and hands it here as
 * base64; we convert to hex, sign the P2WPKH funding input via Turnkey
 * signTransaction (SIGHASH_ALL; Turnkey owns sighash/DER/low-S), then finalize
 * with @scure/btc-signer into broadcast-ready hex (the SDK rejects a returned
 * PSBT). Only the COMMIT is signed here — the reveal is self-signed by the SDK's
 * ephemeral key. Signing is silent within the Turnkey session window.
 */
import type { BitcoinSigner } from '@originals/sdk';
import { base64, hex } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { finalizeSignedPsbt } from './finalize-psbt';
import { addNonWitnessUtxos } from './psbt-prevtx';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

export class TurnkeySatSigner implements BitcoinSigner {
  private readonly client: TurnkeyBitcoinClient;
  private readonly signWith: string;
  private readonly fetchRawTx: (txid: string) => Promise<string>;

  constructor(opts: {
    client: TurnkeyBitcoinClient;
    signWith: string;
    /** Injected so the network call is testable and swappable. */
    fetchRawTx?: (txid: string) => Promise<string>;
  }) {
    this.client = opts.client;
    this.signWith = opts.signWith;
    this.fetchRawTx = opts.fetchRawTx ?? defaultFetchRawTx;
  }

  async signAndFinalizeCommitPsbt(psbtBase64: string): Promise<string> {
    // Turnkey rejects a SegWit v0 input carrying only witness_utxo:
    //   code 3: input 0 is missing non_witness_utxo for SegWit v0 input
    // BIP-143 does not need the previous transaction to compute the sighash,
    // so the SDK does not attach one. Turnkey wants it regardless, and the
    // browser verifies each one hashes to the txid the PSBT names.
    const withPrevTxs = await addNonWitnessUtxos(psbtBase64, this.fetchRawTx);
    const unsignedHex = hex.encode(base64.decode(withPrevTxs));
    const result = await this.client.signTransaction({
      signWith: this.signWith,
      unsignedTransaction: unsignedHex,
      type: 'TRANSACTION_TYPE_BITCOIN',
    });
    const signed = result?.signedTransaction;
    if (!signed) {
      throw new Error('TurnkeySatSigner: Turnkey signTransaction returned no signedTransaction.');
    }
    // Turnkey may return raw hex (already finalized) or a partially-signed PSBT.
    // Raw hex round-trips through Transaction.fromRaw; anything else is a PSBT
    // (hex or base64) that finalizeSignedPsbt assembles into broadcast-ready hex.
    try {
      const raw = btc.Transaction.fromRaw(hex.decode(signed), { allowUnknownInputs: true, allowUnknownOutputs: true });
      if (raw.getInput(0).finalScriptWitness) return hex.encode(raw.extract());
    } catch { /* not raw finalized hex — treat as PSBT below */ }
    const psbtBase64Out = /^[0-9a-fA-F]+$/.test(signed) ? base64.encode(hex.decode(signed)) : signed;
    return finalizeSignedPsbt(psbtBase64Out);
  }
}

/** Ask our own server, which scopes the lookup to this account's deposits. */
async function defaultFetchRawTx(txid: string): Promise<string> {
  const res = await fetch(`/api/btc/prevtx?txid=${encodeURIComponent(txid)}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(
      `Could not load the previous transaction ${txid} the signer needs${
        body?.message ? `: ${body.message}` : ` (HTTP ${res.status})`
      }.`
    );
  }
  const body = (await res.json()) as { hex?: string };
  if (!body.hex) throw new Error(`The server returned no transaction for ${txid}.`);
  return body.hex;
}
