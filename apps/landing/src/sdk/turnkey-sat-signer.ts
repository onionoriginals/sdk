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
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

export class TurnkeySatSigner implements BitcoinSigner {
  private readonly client: TurnkeyBitcoinClient;
  private readonly signWith: string;

  constructor(opts: { client: TurnkeyBitcoinClient; signWith: string }) {
    this.client = opts.client;
    this.signWith = opts.signWith;
  }

  async signAndFinalizeCommitPsbt(psbtBase64: string): Promise<string> {
    const unsignedHex = hex.encode(base64.decode(psbtBase64));
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
