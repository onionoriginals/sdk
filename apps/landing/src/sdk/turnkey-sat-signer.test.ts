import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { TurnkeySatSigner } from './turnkey-sat-signer';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';

const priv = hex.decode('2222222222222222222222222222222222222222222222222222222222222222');
const pub = secp256k1.getPublicKey(priv, true);
const p2wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);

// Build the UNSIGNED commit PSBT the SDK would hand the signer (base64).
function unsignedCommitPsbtBase64(): string {
  const tx = new btc.Transaction();
  tx.addInput({ txid: hex.decode('c'.repeat(64)), index: 0, witnessUtxo: { script: p2wpkh.script, amount: 30_000n } });
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
    const signer = new TurnkeySatSigner({ client: mockClient, signWith: 'tb1quseraddr' });
    const rawHex = await signer.signAndFinalizeCommitPsbt(unsignedCommitPsbtBase64());
    const parsed = btc.Transaction.fromRaw(hex.decode(rawHex));
    expect(parsed.inputsLength).toBe(1);
    expect(parsed.getInput(0).finalScriptWitness).toBeDefined();
  });

  test('rejects when Turnkey returns nothing signable', async () => {
    const bad: TurnkeyBitcoinClient = {
      async signTransaction() { return { signedTransaction: '' }; },
      async createWalletAccounts() { throw new Error('x'); },
      async getWallets() { throw new Error('x'); },
    };
    const signer = new TurnkeySatSigner({ client: bad, signWith: 'tb1quseraddr' });
    await expect(signer.signAndFinalizeCommitPsbt(unsignedCommitPsbtBase64())).rejects.toThrow();
  });
});
