import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { addNonWitnessUtxos } from './psbt-prevtx';

/** A real previous transaction, built locally so the test needs no network. */
function prevTx(amount: bigint, script: Uint8Array) {
  const t = new btc.Transaction({ allowUnknownOutputs: true });
  // Output first: setting finalScriptSig marks the input signed, after which
  // @scure refuses to add outputs.
  t.addOutput({ script, amount });
  t.addInput({
    txid: hex.decode('11'.repeat(32)),
    index: 0,
    finalScriptSig: hex.decode('00'),
  });
  return { raw: hex.encode(t.toBytes(true, true)), txid: t.id };
}

const SCRIPT = hex.decode('001471bde27a6a6b30922bb994c66c743966e104e458');
const AMOUNT = 14_580n;

function psbtSpending(txid: string, amount = AMOUNT, script = SCRIPT) {
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({ txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script, amount } });
  tx.addOutput({ script, amount: amount - 1_000n });
  return base64.encode(tx.toPSBT());
}

describe('the PSBT gains the previous transaction Turnkey demands', () => {
  const { raw, txid } = prevTx(AMOUNT, SCRIPT);

  test('an input with only witnessUtxo gains nonWitnessUtxo', async () => {
    const before = btc.Transaction.fromPSBT(base64.decode(psbtSpending(txid)));
    expect(before.getInput(0).nonWitnessUtxo).toBeUndefined();

    const out = await addNonWitnessUtxos(psbtSpending(txid), async () => raw);
    const after = btc.Transaction.fromPSBT(base64.decode(out));
    expect(after.getInput(0).nonWitnessUtxo).toBeDefined();
    // And the witness data it was already signing against is untouched.
    expect(after.getInput(0).witnessUtxo?.amount).toBe(AMOUNT);
  });

  test('an input that already has one is left alone and costs no fetch', async () => {
    const once = await addNonWitnessUtxos(psbtSpending(txid), async () => raw);
    let fetches = 0;
    await addNonWitnessUtxos(once, async () => {
      fetches += 1;
      return raw;
    });
    expect(fetches).toBe(0);
  });
});

describe('the previous transaction is verified, not trusted', () => {
  const { raw, txid } = prevTx(AMOUNT, SCRIPT);

  /**
   * It arrives from an indexer and becomes what the signer is told it is
   * spending. A substituted transaction is the fee-inflation attack that
   * non_witness_utxo exists to prevent, so it is checked here rather than
   * assumed away.
   */
  test('a transaction that hashes to something else is refused', async () => {
    const other = prevTx(999_999n, SCRIPT);
    await expect(addNonWitnessUtxos(psbtSpending(txid), async () => other.raw)).rejects.toThrow(
      /hashes to .*, not/
    );
  });

  test('an amount that disagrees with the PSBT is refused', async () => {
    // Hash matches (we ask about its own txid) but the PSBT was built for more.
    const small = prevTx(1_000n, SCRIPT);
    await expect(
      addNonWitnessUtxos(psbtSpending(small.txid, AMOUNT, SCRIPT), async () => small.raw)
    ).rejects.toThrow(/1000 sats, but the PSBT was built for 14580/);
  });

  test('a different script at that output is refused', async () => {
    const elsewhere = prevTx(AMOUNT, hex.decode('0014' + '22'.repeat(20)));
    await expect(
      addNonWitnessUtxos(psbtSpending(elsewhere.txid, AMOUNT, SCRIPT), async () => elsewhere.raw)
    ).rejects.toThrow(/pays a different script/);
  });

  test('a missing output index is refused', async () => {
    const one = prevTx(AMOUNT, SCRIPT);
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: one.txid, index: 5, sequence: 0xfffffffd, witnessUtxo: { script: SCRIPT, amount: AMOUNT } });
    tx.addOutput({ script: SCRIPT, amount: 1_000n });
    await expect(
      addNonWitnessUtxos(base64.encode(tx.toPSBT()), async () => one.raw)
    ).rejects.toThrow(/has no output 5/);
  });

  test('anything that is not raw hex is refused', async () => {
    for (const bad of ['', 'nothex', 'abc']) {
      await expect(addNonWitnessUtxos(psbtSpending(txid), async () => bad)).rejects.toThrow(/not raw hex|hashes to/);
    }
  });
});
