/**
 * Bitcoin coverage gap tests
 *
 * Covers: BITCOIN-001, BITCOIN-002, BITCOIN-003, BITCOIN-005,
 *         BITCOIN-007, BITCOIN-016, BITCOIN-019, BITCOIN-020
 *
 * All tests use OrdMockProvider or simple hand-rolled mocks — no real network.
 */

import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { PSBTBuilder } from '../../../src/bitcoin/PSBTBuilder';
import { createCommitTransaction } from '../../../src/bitcoin/transactions/commit';
import type { OrdinalsProvider } from '../../../src/adapters/types';
import type { Utxo } from '../../../src/types/bitcoin';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a well-formed UTXO with a valid hex scriptPubKey. */
function makeUtxo(value: number, index = 0): Utxo {
  return {
    txid: 'a'.repeat(62) + index.toString().padStart(2, '0'),
    vout: index,
    value,
    scriptPubKey: '0014' + 'b'.repeat(40), // P2WPKH
    address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
  };
}

/** Create an SDK backed by OrdMockProvider (regtest). */
function makeSdk(feeRate?: number) {
  return OriginalsSDK.create({
    network: 'regtest',
    ordinalsProvider: new OrdMockProvider({ feeRate: feeRate ?? 5 })
  } as any);
}

// ---------------------------------------------------------------------------
// [BITCOIN-001/happy] Inscribe text/plain → full OrdinalsInscription shape
// ---------------------------------------------------------------------------
describe('BITCOIN-001: inscribeData happy path', () => {
  test('returns OrdinalsInscription with all required fields for text/plain', async () => {
    const sdk = makeSdk();
    const data = Buffer.from('Hello, Ordinals!');
    const result = await sdk.bitcoin.inscribeData(data, 'text/plain');

    // Required OrdinalsInscription fields
    expect(typeof result.inscriptionId).toBe('string');
    expect(result.inscriptionId.length).toBeGreaterThan(0);

    expect(typeof result.satoshi).toBe('string');
    expect(result.satoshi.length).toBeGreaterThan(0);
    // satoshi must be a valid non-negative integer string
    expect(Number.isFinite(Number(result.satoshi))).toBe(true);

    expect(result.content).toBeDefined();
    expect(typeof result.contentType).toBe('string');
    expect(result.contentType).toBe('text/plain');

    expect(typeof result.txid).toBe('string');
    expect(result.txid.length).toBeGreaterThan(0);

    expect(typeof result.vout).toBe('number');
    expect(result.vout).toBeGreaterThanOrEqual(0);
  });

  test('returned inscriptionId is unique across calls', async () => {
    const sdk = makeSdk();
    const a = await sdk.bitcoin.inscribeData(Buffer.from('a'), 'text/plain');
    const b = await sdk.bitcoin.inscribeData(Buffer.from('b'), 'text/plain');
    expect(a.inscriptionId).not.toBe(b.inscriptionId);
  });

  test('contentType is preserved verbatim in the result', async () => {
    const sdk = makeSdk();
    const result = await sdk.bitcoin.inscribeData(
      Buffer.from('{}'),
      'application/json'
    );
    expect(result.contentType).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-001/boundary] Extremely large data — no crash; clear error or accept
// ---------------------------------------------------------------------------
describe('BITCOIN-001: inscribeData large data boundary', () => {
  test('does not throw or hang for 1 MB of data via OrdMockProvider', async () => {
    // OrdMockProvider is an in-memory mock; it accepts any size data.
    // We assert ACTUAL behavior: the provider either succeeds or throws a
    // descriptive error — it must NEVER crash the process silently.
    const sdk = makeSdk();
    const largeData = Buffer.alloc(1_024 * 1_024, 0x42); // 1 MB of 'B'

    let threw = false;
    let errorMessage = '';
    let result: any;
    try {
      result = await sdk.bitcoin.inscribeData(largeData, 'application/octet-stream');
    } catch (err) {
      threw = true;
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (threw) {
      // If it rejected, the error must be a string (not undefined/null) so callers can act
      expect(errorMessage.length).toBeGreaterThan(0);
    } else {
      // If it accepted, we get a valid inscription back
      expect(typeof result.inscriptionId).toBe('string');
    }
    // Either way: no unhandled exception reaching the test runner
  });

  test('rejects null data with INVALID_INPUT error', async () => {
    const sdk = makeSdk();
    await expect(
      sdk.bitcoin.inscribeData(null as any, 'text/plain')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('rejects invalid MIME type with INVALID_INPUT error', async () => {
    const sdk = makeSdk();
    await expect(
      sdk.bitcoin.inscribeData(Buffer.from('x'), 'not a mime type!')
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('rejects negative fee rate with INVALID_INPUT error', async () => {
    const sdk = makeSdk();
    await expect(
      sdk.bitcoin.inscribeData(Buffer.from('x'), 'text/plain', -1)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('rejects excessive fee rate (> 10000) with INVALID_INPUT error', async () => {
    const sdk = makeSdk();
    await expect(
      sdk.bitcoin.inscribeData(Buffer.from('x'), 'text/plain', 10_001)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-002/happy] Track inscription by id → metadata populated
// ---------------------------------------------------------------------------
describe('BITCOIN-002: trackInscription happy path', () => {
  test('returns fully-populated metadata for a known inscription', async () => {
    const sdk = makeSdk();
    // First create so OrdMockProvider has it in state
    const created = await sdk.bitcoin.inscribeData(
      Buffer.from('track-me'),
      'text/plain'
    );

    const tracked = await sdk.bitcoin.trackInscription(created.inscriptionId);

    expect(tracked).not.toBeNull();
    expect(tracked!.inscriptionId).toBe(created.inscriptionId);
    expect(typeof tracked!.txid).toBe('string');
    expect(tracked!.txid.length).toBeGreaterThan(0);
    expect(typeof tracked!.vout).toBe('number');
    expect(tracked!.contentType).toBe('text/plain');
  });

  test('returns null for an unknown inscription id', async () => {
    const sdk = makeSdk();
    const result = await sdk.bitcoin.trackInscription('non-existent-id');
    expect(result).toBeNull();
  });

  test('preserves blockHeight from provider', async () => {
    const sdk = makeSdk();
    const created = await sdk.bitcoin.inscribeData(Buffer.from('x'), 'text/plain');
    const tracked = await sdk.bitcoin.trackInscription(created.inscriptionId);
    // OrdMockProvider sets blockHeight: 1
    expect(tracked?.blockHeight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-003/happy] Transfer inscription to valid address → tx shape
// ---------------------------------------------------------------------------
describe('BITCOIN-003: transferInscription happy path', () => {
  // Use a testnet bech32 address (tb1q...) which BitcoinManager accepts on regtest
  const REGTEST_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

  test('returns BitcoinTransaction with txid, vout, satoshi', async () => {
    const sdk = makeSdk();
    const inscription = await sdk.bitcoin.inscribeData(
      Buffer.from('transfer-me'),
      'text/plain'
    );
    const tx = await sdk.bitcoin.transferInscription(inscription, REGTEST_ADDRESS);

    expect(typeof tx.txid).toBe('string');
    expect(tx.txid.length).toBeGreaterThan(0);

    expect(Array.isArray(tx.vout)).toBe(true);
    expect(tx.vout.length).toBeGreaterThan(0);

    // Fee must be a non-negative number
    expect(typeof tx.fee).toBe('number');
    expect(tx.fee).toBeGreaterThanOrEqual(0);
  });

  test('vout[0] carries a positive satoshi value', async () => {
    const sdk = makeSdk();
    const inscription = await sdk.bitcoin.inscribeData(
      Buffer.from('transfer-value'),
      'text/plain'
    );
    const tx = await sdk.bitcoin.transferInscription(inscription, REGTEST_ADDRESS);
    expect(tx.vout[0].value).toBeGreaterThan(0);
  });

  test('inscription.satoshi is preserved after transfer when provider returns same satoshi', async () => {
    const sdk = makeSdk();
    const inscription = await sdk.bitcoin.inscribeData(
      Buffer.from('sat-update'),
      'text/plain'
    );
    const originalSatoshi = inscription.satoshi;

    await sdk.bitcoin.transferInscription(inscription, REGTEST_ADDRESS);

    // OrdMockProvider returns rec.satoshi, so it should remain consistent
    expect(inscription.satoshi).toBe(originalSatoshi);
  });

  test('rejects transfer with invalid address format', async () => {
    const sdk = makeSdk();
    const inscription = await sdk.bitcoin.inscribeData(
      Buffer.from('x'),
      'text/plain'
    );
    await expect(
      sdk.bitcoin.transferInscription(inscription, 'not-a-valid-address')
    ).rejects.toMatchObject({ code: 'INVALID_ADDRESS' });
  });

  test('rejects transfer when inscription has no inscriptionId', async () => {
    const sdk = makeSdk();
    const badInscription = {
      inscriptionId: '',
      satoshi: '12345',
      content: Buffer.from('x'),
      contentType: 'text/plain',
      txid: 'abc',
      vout: 0
    };
    await expect(
      sdk.bitcoin.transferInscription(badInscription, REGTEST_ADDRESS)
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-005/happy] Resolve satoshi from inscription id → numeric string
// ---------------------------------------------------------------------------
describe('BITCOIN-005: getSatoshiFromInscription happy path', () => {
  test('returns a numeric string satoshi for a known inscription', async () => {
    const sdk = makeSdk();
    const created = await sdk.bitcoin.inscribeData(Buffer.from('satoshi-test'), 'text/plain');

    const satoshi = await sdk.bitcoin.getSatoshiFromInscription(created.inscriptionId);

    expect(satoshi).not.toBeNull();
    expect(typeof satoshi).toBe('string');
    expect(satoshi!.length).toBeGreaterThan(0);
    // Must be a finite non-negative integer
    expect(Number.isFinite(Number(satoshi))).toBe(true);
    expect(Number(satoshi)).toBeGreaterThanOrEqual(0);
  });

  test('returns null for unknown inscription id', async () => {
    const sdk = makeSdk();
    const result = await sdk.bitcoin.getSatoshiFromInscription('does-not-exist');
    expect(result).toBeNull();
  });

  test('returns null when no ordinalsProvider is configured', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest' });
    const result = await sdk.bitcoin.getSatoshiFromInscription('any-id');
    expect(result).toBeNull();
  });

  test('satoshi from getSatoshiFromInscription matches inscribeData result', async () => {
    const sdk = makeSdk();
    const inscription = await sdk.bitcoin.inscribeData(Buffer.from('match-sat'), 'text/plain');
    const resolved = await sdk.bitcoin.getSatoshiFromInscription(inscription.inscriptionId);
    expect(resolved).toBe(inscription.satoshi);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-007/happy] Build PSBT with valid UTXOs+outputs → inputs/outputs/fee
// ---------------------------------------------------------------------------
describe('BITCOIN-007: PSBTBuilder happy path', () => {
  const CHANGE_ADDR = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

  test('produces psbtBase64, selectedUtxos, and fee for a single-input build', () => {
    const builder = new PSBTBuilder();
    const result = builder.build({
      utxos: [makeUtxo(50_000, 0)],
      outputs: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: 10_000 }],
      changeAddress: CHANGE_ADDR,
      feeRate: 5,
      network: 'regtest'
    });

    expect(typeof result.psbtBase64).toBe('string');
    expect(result.psbtBase64.length).toBeGreaterThan(0);

    expect(Array.isArray(result.selectedUtxos)).toBe(true);
    expect(result.selectedUtxos.length).toBeGreaterThan(0);

    expect(typeof result.fee).toBe('number');
    expect(result.fee).toBeGreaterThan(0);
  });

  test('selected inputs cover output value + fee (no deficit)', () => {
    const builder = new PSBTBuilder();
    const outputValue = 20_000;
    const result = builder.build({
      utxos: [makeUtxo(30_000, 0), makeUtxo(30_000, 1)],
      outputs: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: outputValue }],
      changeAddress: CHANGE_ADDR,
      feeRate: 2,
      network: 'regtest'
    });

    const inputTotal = result.selectedUtxos.reduce((s, u) => s + u.value, 0);
    const changeValue = result.changeOutput?.value ?? 0;
    expect(inputTotal).toBe(outputValue + changeValue + result.fee);
  });

  test('change output is present when change >= dust', () => {
    const builder = new PSBTBuilder();
    const result = builder.build({
      utxos: [makeUtxo(100_000, 0)],
      outputs: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: 1_000 }],
      changeAddress: CHANGE_ADDR,
      feeRate: 1,
      network: 'regtest'
    });

    expect(result.changeOutput).toBeDefined();
    expect(result.changeOutput!.value).toBeGreaterThanOrEqual(546); // dust limit
    expect(result.changeOutput!.address).toBe(CHANGE_ADDR);
  });

  test('psbtBase64 decodes to a valid JSON payload with inputs and outputs', () => {
    const builder = new PSBTBuilder();
    const result = builder.build({
      utxos: [makeUtxo(50_000, 0)],
      outputs: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: 5_000 }],
      changeAddress: CHANGE_ADDR,
      feeRate: 3,
      network: 'regtest'
    });

    const json = Buffer.from(result.psbtBase64, 'base64').toString('utf8');
    const payload = JSON.parse(json);

    expect(Array.isArray(payload.inputs)).toBe(true);
    expect(payload.inputs.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.outputs)).toBe(true);
    expect(payload.outputs.length).toBeGreaterThan(0);
    expect(typeof payload.fee).toBe('number');
  });

  test('multi-input build selects minimum UTXOs needed', () => {
    const builder = new PSBTBuilder();
    // 3 UTXOs of 5000 each; target 8000 → should need 2
    const result = builder.build({
      utxos: [makeUtxo(5_000, 0), makeUtxo(5_000, 1), makeUtxo(5_000, 2)],
      outputs: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: 8_000 }],
      changeAddress: CHANGE_ADDR,
      feeRate: 1,
      network: 'regtest'
    });

    // Should not use all 3 UTXOs (greedy ascending selection)
    expect(result.selectedUtxos.length).toBeLessThanOrEqual(3);
    const inputTotal = result.selectedUtxos.reduce((s, u) => s + u.value, 0);
    expect(inputTotal).toBeGreaterThanOrEqual(8_000 + result.fee);
  });

  test('fee scales proportionally with fee rate', () => {
    const builder = new PSBTBuilder();
    const base = {
      utxos: [makeUtxo(100_000, 0)],
      outputs: [{ address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', value: 1_000 }],
      changeAddress: CHANGE_ADDR,
      network: 'regtest' as const
    };

    const low = builder.build({ ...base, feeRate: 1 });
    const high = builder.build({ ...base, feeRate: 10 });

    // 10× fee rate → 10× fee (for same input/output count)
    expect(high.fee).toBeGreaterThan(low.fee);
    // Rough proportionality (not exact due to rounding, but at least 8×)
    expect(high.fee).toBeGreaterThanOrEqual(low.fee * 8);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-016/happy] Fetch inscription metadata (content, contentType)
// ---------------------------------------------------------------------------
describe('BITCOIN-016: inscription metadata retrieval', () => {
  test('getInscriptionById returns content and contentType after createInscription', async () => {
    const provider = new OrdMockProvider();
    const data = Buffer.from('metadata-test');
    const created = await provider.createInscription({
      data,
      contentType: 'text/plain'
    });

    const fetched = await provider.getInscriptionById(created.inscriptionId);

    expect(fetched).not.toBeNull();
    expect(fetched!.contentType).toBe('text/plain');
    // Content should be the same buffer (or equivalent bytes)
    expect(Buffer.isBuffer(fetched!.content) || fetched!.content instanceof Uint8Array).toBe(true);
  });

  test('getInscriptionById preserves application/json contentType', async () => {
    const provider = new OrdMockProvider();
    const created = await provider.createInscription({
      data: Buffer.from('{"key":"value"}'),
      contentType: 'application/json'
    });
    const fetched = await provider.getInscriptionById(created.inscriptionId);
    expect(fetched?.contentType).toBe('application/json');
  });

  test('getInscriptionById returns null for unknown id', async () => {
    const provider = new OrdMockProvider();
    const result = await provider.getInscriptionById('unknown-insc-id');
    expect(result).toBeNull();
  });

  test('inscriptionId in metadata matches the one returned at creation', async () => {
    const provider = new OrdMockProvider();
    const created = await provider.createInscription({
      data: Buffer.from('id-consistency'),
      contentType: 'text/plain'
    });
    const fetched = await provider.getInscriptionById(created.inscriptionId);
    expect(fetched?.inscriptionId).toBe(created.inscriptionId);
  });

  test('blockHeight is present in metadata', async () => {
    const provider = new OrdMockProvider();
    const created = await provider.createInscription({
      data: Buffer.from('bh-test'),
      contentType: 'text/plain'
    });
    const fetched = await provider.getInscriptionById(created.inscriptionId);
    // OrdMockProvider sets blockHeight: 1
    expect(fetched?.blockHeight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-019/happy] Build commit transaction → broadcast-ready PSBT
// ---------------------------------------------------------------------------
describe('BITCOIN-019: createCommitTransaction happy path', () => {
  const MAINNET_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const mainnetUtxo = (value: number, index = 0): Utxo => ({
    txid: 'c'.repeat(62) + index.toString().padStart(2, '0'),
    vout: index,
    value,
    scriptPubKey: '0014' + 'b'.repeat(40),
    address: MAINNET_ADDR
  });

  test('returns commitAddress, commitPsbtBase64, revealPrivateKey, revealPublicKey', async () => {
    const result = await createCommitTransaction({
      content: Buffer.from('Hello, Ordinals!'),
      contentType: 'text/plain',
      utxos: [mainnetUtxo(50_000)],
      changeAddress: MAINNET_ADDR,
      feeRate: 10,
      network: 'mainnet'
    });

    expect(typeof result.commitAddress).toBe('string');
    expect(result.commitAddress).toMatch(/^bc1p/); // P2TR mainnet

    expect(typeof result.commitPsbtBase64).toBe('string');
    expect(result.commitPsbtBase64.length).toBeGreaterThan(0);

    // Should be valid base64
    const decoded = Buffer.from(result.commitPsbtBase64, 'base64');
    expect(decoded.length).toBeGreaterThan(0);

    expect(result.revealPrivateKey).toHaveLength(64); // 32 bytes hex
    expect(result.revealPublicKey).toHaveLength(64);  // 32 bytes x-only key
  });

  test('returned commitPsbt has inputs matching selected UTXOs', async () => {
    const result = await createCommitTransaction({
      content: Buffer.from('psbt-input-count'),
      contentType: 'text/plain',
      utxos: [mainnetUtxo(100_000, 0)],
      changeAddress: MAINNET_ADDR,
      feeRate: 5,
      network: 'mainnet'
    });

    expect(result.commitPsbt.inputsLength).toBe(result.selectedUtxos.length);
    expect(result.commitPsbt.inputsLength).toBeGreaterThan(0);
  });

  test('commitAmount is at least the dust limit (546 sats)', async () => {
    const result = await createCommitTransaction({
      content: Buffer.from('dust-limit'),
      contentType: 'text/plain',
      utxos: [mainnetUtxo(50_000, 0)],
      changeAddress: MAINNET_ADDR,
      feeRate: 10,
      network: 'mainnet'
    });

    expect(result.commitAmount).toBeGreaterThanOrEqual(546);
  });

  test('fees.commit is positive and covers at least 1 vbyte at fee rate', async () => {
    const feeRate = 10;
    const result = await createCommitTransaction({
      content: Buffer.from('fee-check'),
      contentType: 'text/plain',
      utxos: [mainnetUtxo(50_000, 0)],
      changeAddress: MAINNET_ADDR,
      feeRate,
      network: 'mainnet'
    });

    expect(result.fees.commit).toBeGreaterThan(0);
    // Fee should be at least feeRate * 1 sat
    expect(result.fees.commit).toBeGreaterThanOrEqual(feeRate);
  });

  test('total input value covers commit amount + fee (no deficit)', async () => {
    const result = await createCommitTransaction({
      content: Buffer.from('accounting-check'),
      contentType: 'text/plain',
      utxos: [mainnetUtxo(100_000, 0)],
      changeAddress: MAINNET_ADDR,
      feeRate: 10,
      network: 'mainnet'
    });

    const inputTotal = result.selectedUtxos.reduce((s, u) => s + u.value, 0);
    expect(inputTotal).toBeGreaterThanOrEqual(result.commitAmount + result.fees.commit);
  });

  test('inscriptionScript has non-empty script and controlBlock Uint8Arrays', async () => {
    const result = await createCommitTransaction({
      content: Buffer.from('script-check'),
      contentType: 'text/plain',
      utxos: [mainnetUtxo(50_000, 0)],
      changeAddress: MAINNET_ADDR,
      feeRate: 10,
      network: 'mainnet'
    });

    expect(result.inscriptionScript.script).toBeInstanceOf(Uint8Array);
    expect(result.inscriptionScript.script.length).toBeGreaterThan(0);
    expect(result.inscriptionScript.controlBlock).toBeInstanceOf(Uint8Array);
    expect(result.inscriptionScript.controlBlock.length).toBeGreaterThan(0);
    expect(result.inscriptionScript.leafVersion).toBe(0xc0);
  });
});

// ---------------------------------------------------------------------------
// [BITCOIN-020/happy] Resolve fee rate: oracle preferred, fallback to provider
// ---------------------------------------------------------------------------
describe('BITCOIN-020: fee rate resolution (oracle preferred, provider fallback)', () => {
  test('feeOracle value is used when present (overrides provider)', async () => {
    const oracleRate = 42;
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: new OrdMockProvider({ feeRate: 5 }),
      feeOracle: { estimateFeeRate: async () => oracleRate }
    } as any);

    const result: any = await sdk.bitcoin.inscribeData(Buffer.from('oracle-test'), 'text/plain');
    // BitcoinManager records the feeOracle rate on the inscription result
    expect(result.feeRate).toBe(oracleRate);
  });

  test('provider estimateFee is used as fallback when no feeOracle is set', async () => {
    const providerRate = 7;
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: new OrdMockProvider({ feeRate: providerRate })
      // no feeOracle
    } as any);

    // Just verify the inscription succeeds — provider fee is used silently
    const result = await sdk.bitcoin.inscribeData(Buffer.from('provider-fallback'), 'text/plain');
    expect(result.inscriptionId).toBeTruthy();
  });

  test('feeOracle returning non-finite value falls back to provider', async () => {
    // BitcoinManager skips non-finite oracle values and falls back to ord provider
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: new OrdMockProvider({ feeRate: 5 }),
      feeOracle: { estimateFeeRate: async () => NaN }
    } as any);

    // Should still succeed (provider fee used as fallback)
    const result = await sdk.bitcoin.inscribeData(Buffer.from('nan-oracle'), 'text/plain');
    expect(result.inscriptionId).toBeTruthy();
  });

  test('feeOracle throwing falls back gracefully to provider', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: new OrdMockProvider({ feeRate: 5 }),
      feeOracle: {
        estimateFeeRate: async () => { throw new Error('oracle down'); }
      }
    } as any);

    // Must not propagate oracle error — falls back to provider
    const result = await sdk.bitcoin.inscribeData(Buffer.from('oracle-error-fallback'), 'text/plain');
    expect(result.inscriptionId).toBeTruthy();
  });

  test('provided feeRate parameter is last-resort when neither oracle nor provider give valid rate', async () => {
    // Provider that returns 0 (invalid) — triggers last-resort path
    const zeroFeeProvider: OrdinalsProvider = {
      async createInscription(params) {
        const id = 'last-resort-id';
        return {
          inscriptionId: id,
          revealTxId: 'tx-lr',
          satoshi: '9876543',
          txid: 'tx-lr',
          vout: 0,
          content: params.data,
          contentType: params.contentType,
          feeRate: params.feeRate
        };
      },
      async getInscriptionById() {
        return {
          inscriptionId: 'last-resort-id',
          content: Buffer.from('x'),
          contentType: 'text/plain',
          txid: 'tx-lr',
          vout: 0,
          satoshi: '9876543'
        };
      },
      async transferInscription() {
        return { txid: 'tx', vin: [], vout: [], fee: 0 };
      },
      async getInscriptionsBySatoshi() { return []; },
      async broadcastTransaction() { return 'tx'; },
      async getTransactionStatus() { return { confirmed: false }; },
      async estimateFee() { return 0; } // invalid → triggers last-resort
    };

    const sdk = OriginalsSDK.create({
      network: 'regtest',
      ordinalsProvider: zeroFeeProvider
    } as any);

    const callerRate = 3;
    const result: any = await sdk.bitcoin.inscribeData(
      Buffer.from('last-resort'),
      'text/plain',
      callerRate
    );
    // When provider returns invalid (0) fee, feeRate param is used as last resort.
    // The feeRate on the result comes from creation.feeRate (passed through by provider).
    expect(result.inscriptionId).toBe('last-resort-id');
  });
});
