/**
 * Tests for reveal transaction creation (taproot script-path spend of the commit output)
 */
import { describe, it, expect } from 'bun:test';
import {
  createCommitTransaction,
  createRevealTransaction
} from '../../../../src/bitcoin/transactions/commit.js';
import type { Utxo } from '../../../../src/types/bitcoin.js';
import * as btc from '@scure/btc-signer';
import * as ordinals from 'micro-ordinals';

// A funded, spendable regtest P2WPKH utxo + change address, mirroring the
// inline fixtures used by commit.test.ts (no shared fixture module exists).
const sampleUtxo: Utxo = {
  txid: `${'a'.repeat(62)}00`,
  vout: 0,
  value: 100000,
  scriptPubKey: '0014' + 'b'.repeat(40), // Mock P2WPKH scriptPubKey
  address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
};
const sampleChangeAddress = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

describe('createRevealTransaction', () => {
  it('builds a finalized reveal that actually reveals the inscription (3-item script-path witness)', async () => {
    const content = Buffer.from('hello', 'utf8');
    const contentType = 'text/plain';
    const commit = await createCommitTransaction({
      content,
      contentType,
      utxos: [sampleUtxo],
      changeAddress: sampleChangeAddress,
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
      destinationAddress: sampleChangeAddress,
      feeRate: 2,
      network: 'regtest'
    });

    expect(reveal.inscriptionId).toBe(`${reveal.revealTxId}i0`);
    expect(reveal.postageValue).toBeGreaterThanOrEqual(546);
    // Parses back as a valid signed tx with exactly one input carrying a witness.
    const tx = btc.Transaction.fromRaw(Buffer.from(reveal.revealTxHex, 'hex'), { allowUnknownInputs: true });
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);

    // CRITICAL: prove this is a SCRIPT-PATH spend that reveals the inscription,
    // not a key-path spend that only moves the sat. A key-path witness is a
    // single 64-byte signature; the reveal must carry the 3-item envelope
    // stack [schnorr sig, envelope script, control block].
    const witness = tx.getInput(0).finalScriptWitness;
    expect(witness).toBeDefined();
    expect(witness!.length).toBe(3);

    // The parsed inscription must round-trip to exactly what was committed.
    const parsed = ordinals.parseWitness(witness!);
    expect(parsed).toBeDefined();
    expect(parsed!.length).toBe(1);
    expect(parsed![0].tags.contentType).toBe(contentType);
    expect(Buffer.from(parsed![0].body).equals(content)).toBe(true);
  });

  it('throws when the commit amount cannot cover the reveal fee + dust', async () => {
    await expect(createRevealTransaction({
      commitTxId: 'bb'.repeat(32), commitVout: 0, commitAmount: 300,
      revealPrivateKey: 'ab'.repeat(32), revealPublicKey: 'ab'.repeat(32),
      inscriptionScript: { script: new Uint8Array([0x51]), controlBlock: new Uint8Array(33), leafVersion: 0xc0 },
      destinationAddress: sampleChangeAddress, feeRate: 2, network: 'regtest'
    })).rejects.toThrow();
  });
});
