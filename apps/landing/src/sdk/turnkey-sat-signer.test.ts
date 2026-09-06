import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { TurnkeySatSigner } from './turnkey-sat-signer';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

const priv = hex.decode('2222222222222222222222222222222222222222222222222222222222222222');
const pub = secp256k1.getPublicKey(priv, true);
const p2wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);

// The previous transaction the funding input spends. Turnkey requires the
// whole thing for a SegWit v0 input, so the signer fetches and attaches it —
// and the browser checks it hashes to the txid the PSBT names, so this fixture
// has to be the real transaction rather than an arbitrary blob.
function fundingPrevTx() {
  const t = new btc.Transaction({ allowUnknownOutputs: true });
  t.addOutput({ script: p2wpkh.script, amount: 30_000n });
  t.addInput({ txid: hex.decode('a'.repeat(64)), index: 0, finalScriptSig: hex.decode('00') });
  return { raw: hex.encode(t.toBytes(true, true)), txid: t.id };
}
const PREV = fundingPrevTx();
const fetchRawTx = async (txid: string) => {
  if (txid !== PREV.txid) throw new Error(`unexpected txid ${txid}`);
  return PREV.raw;
};

// Build the UNSIGNED commit PSBT the SDK would hand the signer (base64).
function unsignedCommitPsbtBase64(): string {
  const tx = new btc.Transaction();
  tx.addInput({ txid: PREV.txid, index: 0, witnessUtxo: { script: p2wpkh.script, amount: 30_000n } });
  tx.addOutputAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 20_000n, btc.TEST_NETWORK);
  return base64.encode(tx.toPSBT());
}

// Mock Turnkey: signs the given unsigned PSBT (hex) locally and returns a
// partially-signed PSBT — exactly Turnkey signTransaction's shape.
const mockClient: TurnkeyBitcoinClient = {
  async signTransaction({ unsignedTransaction, type }) {
    expect(type).toBe('TRANSACTION_TYPE_BITCOIN');
    const tx = btc.Transaction.fromPSBT(hex.decode(unsignedTransaction), { allowUnknownInputs: true, allowUnknownOutputs: true });
    tx.sign(priv); // partially-signed, NOT finalized
    return { signedTransaction: hex.encode(tx.toPSBT()) };
  },
  async createWalletAccounts() { throw new Error('not used'); },
  async getWallets() { throw new Error('not used'); },
};

describe('TurnkeySatSigner', () => {
  test('signAndFinalizeCommitPsbt returns broadcast-ready hex with a witness', async () => {
    const signer = new TurnkeySatSigner({ client: mockClient, signWith: 'tb1quseraddr', fetchRawTx });
    const rawHex = await signer.signAndFinalizeCommitPsbt(unsignedCommitPsbtBase64());
    const parsed = btc.Transaction.fromRaw(hex.decode(rawHex));
    expect(parsed.inputsLength).toBe(1);
    expect(parsed.getInput(0).finalScriptWitness).toBeDefined();
  });

  // The live failure: Turnkey answered "code 3: input 0 is missing
  // non_witness_utxo for SegWit v0 input", because the SDK attaches only
  // witnessUtxo. What reaches Turnkey must now carry both.
  test('what reaches Turnkey carries the full previous transaction', async () => {
    let seen: string | undefined;
    const capture: TurnkeyBitcoinClient = {
      async signTransaction({ unsignedTransaction }) {
        seen = unsignedTransaction;
        const tx = btc.Transaction.fromPSBT(hex.decode(unsignedTransaction), { allowUnknownInputs: true, allowUnknownOutputs: true });
        tx.sign(priv);
        return { signedTransaction: hex.encode(tx.toPSBT()) };
      },
      async createWalletAccounts() { throw new Error('not used'); },
      async getWallets() { throw new Error('not used'); },
      async getWalletAccounts() { throw new Error('not used'); },
    };
    await new TurnkeySatSigner({ client: capture, signWith: 'tb1quseraddr', fetchRawTx }).signAndFinalizeCommitPsbt(
      unsignedCommitPsbtBase64()
    );
    const sent = btc.Transaction.fromPSBT(hex.decode(seen!), { allowUnknownInputs: true, allowUnknownOutputs: true });
    expect(sent.getInput(0).nonWitnessUtxo).toBeDefined();
    expect(sent.getInput(0).witnessUtxo).toBeDefined();
  });

  test('rejects when Turnkey returns nothing signable', async () => {
    const bad: TurnkeyBitcoinClient = {
      async signTransaction() { return { signedTransaction: '' }; },
      async createWalletAccounts() { throw new Error('x'); },
      async getWallets() { throw new Error('x'); },
    };
    const signer = new TurnkeySatSigner({ client: bad, signWith: 'tb1quseraddr', fetchRawTx });
    await expect(signer.signAndFinalizeCommitPsbt(unsignedCommitPsbtBase64())).rejects.toThrow();
  });
});
