/**
 * `Utxo.prevTxHex` — the optional whole previous transaction some signers
 * demand for a SegWit v0 input.
 *
 * From the first real mainnet inscription: Turnkey answered
 *   code 3: input 0 is missing non_witness_utxo for SegWit v0 input
 * because the commit builder attaches only `witnessUtxo`. BIP-143 does not
 * need more, so the default is unchanged; supplying prevTxHex opts in.
 */
import { describe, it, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { createCommitTransaction } from '../../../../src/bitcoin/transactions/commit.js';
import type { Utxo } from '../../../../src/types/bitcoin.js';

const changeAddress = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const SCRIPT_HEX = '0014' + 'b'.repeat(40);
const VALUE = 100_000;

/** A genuine previous transaction paying VALUE to SCRIPT_HEX at vout 0. */
function prevTx(amount = BigInt(VALUE), scriptHex = SCRIPT_HEX) {
  const t = new btc.Transaction({ allowUnknownOutputs: true });
  t.addOutput({ script: Uint8Array.from(Buffer.from(scriptHex, 'hex')), amount });
  t.addInput({
    txid: Uint8Array.from(Buffer.from('11'.repeat(32), 'hex')),
    index: 0,
    finalScriptSig: Uint8Array.from([0])
  });
  return { hex: Buffer.from(t.toBytes(true, true)).toString('hex'), txid: t.id };
}

const build = (utxo: Utxo) =>
  createCommitTransaction({
    content: Buffer.from('hello'),
    contentType: 'text/plain',
    utxos: [utxo],
    changeAddress,
    feeRate: 2,
    network: 'regtest'
  });

describe('prevTxHex is optional and off by default', () => {
  it('a UTXO without it produces the same witness-only input as before', async () => {
    const p = prevTx();
    const commit = await build({ txid: p.txid, vout: 0, value: VALUE, scriptPubKey: SCRIPT_HEX });
    expect(commit.commitPsbt.getInput(0).witnessUtxo).toBeDefined();
    expect(commit.commitPsbt.getInput(0).nonWitnessUtxo).toBeUndefined();
  });

  it('supplying it attaches the whole previous transaction alongside witnessUtxo', async () => {
    const p = prevTx();
    const commit = await build({
      txid: p.txid, vout: 0, value: VALUE, scriptPubKey: SCRIPT_HEX, prevTxHex: p.hex
    });
    expect(commit.commitPsbt.getInput(0).nonWitnessUtxo).toBeDefined();
    expect(commit.commitPsbt.getInput(0).witnessUtxo).toBeDefined();
  });
});

describe('a supplied prevTxHex is verified, never trusted', () => {
  /**
   * `nonWitnessUtxo` is how a signer learns an input's true value, so an
   * unchecked one IS the fee-inflation attack: substitute a transaction
   * claiming a larger input and the signer approves a far larger fee.
   */
  it('refuses a transaction that hashes to a different txid', async () => {
    const real = prevTx();
    const other = prevTx(BigInt(999_999));
    await expect(
      build({ txid: real.txid, vout: 0, value: VALUE, scriptPubKey: SCRIPT_HEX, prevTxHex: other.hex })
    ).rejects.toThrow(/hashes to/);
  });

  it('refuses a value that disagrees with the UTXO', async () => {
    const p = prevTx();
    await expect(
      build({ txid: p.txid, vout: 0, value: VALUE + 1, scriptPubKey: SCRIPT_HEX, prevTxHex: p.hex })
    ).rejects.toThrow(/sats, but the UTXO says/);
  });

  it('refuses an output index the previous transaction does not have', async () => {
    const p = prevTx();
    await expect(
      build({ txid: p.txid, vout: 7, value: VALUE, scriptPubKey: SCRIPT_HEX, prevTxHex: p.hex })
    ).rejects.toThrow(/has no output 7/);
  });

  it('refuses anything that is not raw transaction hex', async () => {
    const p = prevTx();
    await expect(
      build({ txid: p.txid, vout: 0, value: VALUE, scriptPubKey: SCRIPT_HEX, prevTxHex: 'nothex' })
    ).rejects.toThrow(/not raw transaction hex/);
  });

  /**
   * An empty string is a SUPPLIED value — a fetch that came back with nothing —
   * not an absent one. Truthiness treated it as absent, so the input silently
   * lost its nonWitnessUtxo and the signer failed later with its own, less
   * useful error.
   */
  it('refuses an empty prevTxHex rather than silently skipping it', async () => {
    const p = prevTx();
    await expect(
      build({ txid: p.txid, vout: 0, value: VALUE, scriptPubKey: SCRIPT_HEX, prevTxHex: '' })
    ).rejects.toThrow(/not raw transaction hex/);
  });

  /** Consumers classify by code, not by parsing message text (CLAUDE.md). */
  it('reports a stable error code, not a bare Error', async () => {
    const p = prevTx();
    try {
      await build({ txid: p.txid, vout: 0, value: VALUE + 1, scriptPubKey: SCRIPT_HEX, prevTxHex: p.hex });
      throw new Error('expected a rejection');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('INVALID_PREV_TX');
    }
  });
});
