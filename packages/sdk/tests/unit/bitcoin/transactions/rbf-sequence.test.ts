/**
 * Every input the SDK builds must signal BIP-125 opt-in RBF (sequence
 * 0xfffffffd). @scure/btc-signer defaults to the final sequence, which would
 * make a fee-spiked commit un-bumpable with real BTC parked in the mempool.
 */
import { describe, it, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import {
  createCommitTransaction,
  createRevealTransaction,
  RBF_SEQUENCE
} from '../../../../src/bitcoin/transactions/commit.js';
import type { Utxo } from '../../../../src/types/bitcoin.js';

const sampleUtxo: Utxo = {
  txid: `${'a'.repeat(62)}00`,
  vout: 0,
  value: 100000,
  scriptPubKey: '0014' + 'b'.repeat(40),
  address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
};
const changeAddress = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

describe('RBF signaling', () => {
  it('RBF_SEQUENCE is a BIP-125 replaceable sequence', () => {
    expect(RBF_SEQUENCE).toBe(0xfffffffd);
    expect(RBF_SEQUENCE).toBeLessThan(0xfffffffe); // < MAX-1 opts in to RBF
  });

  it('commit transaction inputs signal RBF', async () => {
    const commit = await createCommitTransaction({
      content: Buffer.from('hello'),
      contentType: 'text/plain',
      utxos: [sampleUtxo],
      changeAddress,
      feeRate: 2,
      network: 'regtest'
    });
    for (let i = 0; i < commit.commitPsbt.inputsLength; i++) {
      expect(commit.commitPsbt.getInput(i).sequence).toBe(RBF_SEQUENCE);
    }
  });

  it('reveal transaction input signals RBF (in the final serialized tx)', async () => {
    const commit = await createCommitTransaction({
      content: Buffer.from('hello'),
      contentType: 'text/plain',
      utxos: [sampleUtxo],
      changeAddress,
      feeRate: 2,
      network: 'regtest'
    });
    const reveal = await createRevealTransaction({
      commitTxId: 'bb'.repeat(32),
      commitVout: 0,
      commitAmount: commit.commitAmount,
      revealPrivateKey: commit.revealPrivateKey,
      revealPublicKey: commit.revealPublicKey,
      inscriptionScript: commit.inscriptionScript,
      destinationAddress: changeAddress,
      feeRate: 2,
      network: 'regtest'
    });
    const tx = btc.Transaction.fromRaw(Buffer.from(reveal.revealTxHex, 'hex'), {
      allowUnknownInputs: true
    });
    expect(tx.getInput(0).sequence).toBe(RBF_SEQUENCE);
  });
});
