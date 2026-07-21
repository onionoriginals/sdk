import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { finalizeSignedPsbt } from './finalize-psbt';

// A deterministic P2WPKH key on testnet (TEST_NETWORK params).
const priv = hex.decode('1111111111111111111111111111111111111111111111111111111111111111');
const pub = secp256k1.getPublicKey(priv, true);

// Build a partially-signed (NOT finalized) P2WPKH PSBT — the exact shape
// Turnkey signTransaction returns. We stand in for Turnkey by signing locally.
function turnkeyLikePartiallySignedPsbt(): string {
  const p2wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);
  const tx = new btc.Transaction();
  // A synthetic funding input (segwit → witnessUtxo carries amount + script).
  tx.addInput({
    txid: hex.decode('a'.repeat(64)),
    index: 0,
    witnessUtxo: { script: p2wpkh.script, amount: 20_000n },
  });
  tx.addOutputAddress(
    'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
    12_000n,
    btc.TEST_NETWORK
  );
  tx.sign(priv); // signs but does NOT finalize
  return base64.encode(tx.toPSBT());
}

describe('SPIKE: Turnkey signTransaction → scure finalize (P2WPKH testnet4)', () => {
  test('finalizeSignedPsbt turns a partially-signed P2WPKH PSBT into broadcast-ready hex with a witness', () => {
    const partiallySigned = turnkeyLikePartiallySignedPsbt();
    const rawHex = finalizeSignedPsbt(partiallySigned);

    // Broadcast-ready hex must parse as a raw (non-PSBT) transaction...
    const parsed = btc.Transaction.fromRaw(hex.decode(rawHex));
    expect(parsed.inputsLength).toBe(1);
    // ...and the single P2WPKH input must carry a finalized witness.
    const input = parsed.getInput(0);
    expect(input.finalScriptWitness).toBeDefined();
    expect((input.finalScriptWitness as Uint8Array[]).length).toBeGreaterThan(0);
  });

  test('finalizeSignedPsbt throws on an unsigned PSBT', () => {
    const p2wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);
    const tx = new btc.Transaction();
    tx.addInput({ txid: hex.decode('b'.repeat(64)), index: 0, witnessUtxo: { script: p2wpkh.script, amount: 20_000n } });
    tx.addOutputAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 12_000n, btc.TEST_NETWORK);
    const unsigned = base64.encode(tx.toPSBT());
    expect(() => finalizeSignedPsbt(unsigned)).toThrow();
  });
});
