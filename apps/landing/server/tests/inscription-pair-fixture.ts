import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';

/** Real single-leaf inscription witness for structural HTTP route fixtures. */
export function inscriptionFixture(privateKey: Uint8Array) {
  const script = btc.Script.encode([
    schnorr.getPublicKey(privateKey), 'CHECKSIG', 0, 'IF',
    new TextEncoder().encode('ord'), new Uint8Array([1]),
    new TextEncoder().encode('text/plain'), 0,
    new TextEncoder().encode('route fixture'), 'ENDIF',
  ]);
  const payment = btc.p2tr(schnorr.getPublicKey(privateKey), { script }, btc.TEST_NETWORK, true);
  return {
    address: payment.address!,
    script: payment.script,
    finalize(reveal: btc.Transaction, commit: btc.Transaction) {
      const output = commit.getOutput(0);
      const message = reveal.preimageWitnessV1(0, [output.script!], btc.SigHash.DEFAULT, [output.amount!], undefined, script, 0xc0);
      reveal.updateInput(0, { finalScriptWitness: [
        schnorr.sign(message, privateKey, new Uint8Array(32)), script,
        btc.TaprootControlBlock.encode(payment.tapLeafScript![0][0]),
      ] }, true);
    },
  };
}
