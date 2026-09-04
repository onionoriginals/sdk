/**
 * The inscription dry run (#526) is only evidence if the harness itself is
 * proven: that it drives the real build-and-sign path, that it judges the
 * properties the ticket names, and above all that it cannot broadcast, and
 * fails loudly if the path it drives ever tries to.
 */
import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { OrdMockProvider } from '@originals/sdk/testing';
import { MAX_FEE_RATE_SAT_VB, normalizeFeeRate } from '../server/bitcoin';
import {
  DryRunBroadcastRefused,
  depositAddressOf,
  dryRunInscription,
  fixtureOrdinalLookup,
  localKeySigner,
  main,
  mockCandidates,
  mockDryRunInput,
  neverBroadcastProvider,
  parseEnvelope,
  payloadFromFile,
  renderRecord,
  unsignedCommitSigner,
  type Check,
  type DryRunRecord,
  type ReadProvider,
} from './dry-run-inscription';

const failed = (r: DryRunRecord) => r.checks.filter((c) => c.ok === false).map((c) => c.id);
const skipped = (r: DryRunRecord) => r.checks.filter((c) => c.ok === 'skipped').map((c) => c.id);
const byId = (r: DryRunRecord, id: string): Check => r.checks.find((c) => c.id === id)!;

/** A read provider that records any attempt to reach its write paths. */
function spyReads(): ReadProvider & { writes: string[] } {
  const inner = new OrdMockProvider({ feeRate: 5 });
  const writes: string[] = [];
  return {
    writes,
    estimateFee: (b) => inner.estimateFee(b),
    getFirstSatOfOutput: (o) => inner.getFirstSatOfOutput(o),
    getTransactionStatus: (t) => inner.getTransactionStatus(t),
    // Present on the inner object, must never be reached through the wrapper.
    broadcastTransaction: async (hexOrObj: unknown) => { writes.push(`broadcast:${String(hexOrObj).slice(0, 8)}`); return 'leaked'; },
    submitInscription: async () => { writes.push('submit'); return { commitTxId: 'x', revealTxId: 'y', status: 'reveal_broadcast' as const }; },
  } as ReadProvider & { writes: string[] };
}

describe('neverBroadcastProvider: the write paths throw and the inner provider is never reached', () => {
  test('broadcastTransaction records the attempt and throws', async () => {
    const reads = spyReads();
    const p = neverBroadcastProvider(reads);
    await expect(p.broadcastTransaction('0200')).rejects.toBeInstanceOf(DryRunBroadcastRefused);
    expect(p.broadcastAttempts).toEqual(['0200']);
    expect(reads.writes).toEqual([]);
  });

  test('submitInscription captures the pair, counts the refusal, and throws', async () => {
    const reads = spyReads();
    const p = neverBroadcastProvider(reads);
    const params = {
      signedCommitHex: '01',
      revealTxHex: '02',
      fundingUtxos: [{ txid: 'a'.repeat(64), vout: 0, value: 1 }],
      fundingUtxo: { txid: 'a'.repeat(64), vout: 0, value: 1 },
      changeAddress: 'bcrt1q',
    };
    await expect(p.submitInscription!(params)).rejects.toBeInstanceOf(DryRunBroadcastRefused);
    expect(p.captured).toEqual({ signedCommitHex: '01', revealTxHex: '02', fundingUtxos: params.fundingUtxos, changeAddress: 'bcrt1q' });
    expect(p.submitRefusals).toBe(1);
    expect(reads.writes).toEqual([]);
  });

  test('createInscription and transferInscription are refused rather than forwarded', async () => {
    const p = neverBroadcastProvider(spyReads());
    await expect(p.createInscription({ data: new Uint8Array([1]), contentType: 'text/plain' })).rejects.toThrow(/DRY RUN/);
    await expect(p.transferInscription('x', 'y')).rejects.toThrow(/DRY RUN/);
  });

  test('estimateFee serves the route-normalised rate and records the raw estimate', async () => {
    const p = neverBroadcastProvider({ ...spyReads(), estimateFee: async () => 4.2 });
    expect(await p.estimateFee(1)).toBe(5);
    expect(p.feeEstimates).toEqual([{ blocks: 1, raw: 4.2, normalized: 5 }]);
  });
});

describe('normalizeFeeRate: the one rule the /api/btc/fee route applies', () => {
  test('rounds up to a whole sat/vB', () => {
    expect(normalizeFeeRate(1)).toBe(1);
    expect(normalizeFeeRate(2.01)).toBe(3);
  });
  test('never floors an unusable estimate', () => {
    for (const bad of [0, -1, NaN, Infinity, undefined, '5']) {
      expect(() => normalizeFeeRate(bad)).toThrow(/unusable/);
    }
  });
  test('refuses an estimate over the cap', () => {
    expect(() => normalizeFeeRate(MAX_FEE_RATE_SAT_VB + 1)).toThrow(/maximum/);
    expect(normalizeFeeRate(MAX_FEE_RATE_SAT_VB)).toBe(MAX_FEE_RATE_SAT_VB);
  });
});

describe('dryRunInscription against the mock provider', () => {
  test('builds and signs the pair through the real lifecycle, refuses at the seam, and every property passes', async () => {
    const reads = spyReads();
    const record = await dryRunInscription(mockDryRunInput({ reads }));

    expect(failed(record)).toEqual([]);
    expect(skipped(record)).toEqual([]);
    expect(record.checks.length).toBeGreaterThanOrEqual(30);

    // Nothing reached the network, and the harness can prove it.
    expect(reads.writes).toEqual([]);
    expect(record.broadcast).toEqual({ attempts: 0, submitRefusals: 2, lifecycleRejected: true });
    expect(record.asset.layerAfterDryRun).toBe('did:webvh');

    // The artefacts the ticket names are all present.
    expect(record.commit?.hex).toMatch(/^[0-9a-f]+$/);
    expect(record.reveal?.hex).toMatch(/^[0-9a-f]+$/);
    expect(record.commit?.final).toBe(true);
    expect(record.reveal?.final).toBe(true);
    expect(record.fee.feeRateSatVb).toBe(5);
    expect(record.fee.sdkResolvedRate).toBe(5);
    expect(record.fee.quoteSats).toBeGreaterThan(record.fee.unbufferedQuoteSats);
    expect(record.fee.actualSats).toBeLessThanOrEqual(record.fee.quoteSats);
    expect(record.selection.map((s) => s.outpoint)).toEqual([`${'a'.repeat(64)}:0`, `${'b'.repeat(64)}:1`]);
    expect(record.selection[0].index).toBe(0);
    expect(record.revealKey?.rebuiltCommitAddress).toBe(record.revealKey?.commitAddress);
    expect(record.revealKey?.secondBuildInternalKeyHex).not.toBe(record.revealKey?.internalKeyHex);
    expect(record.envelope?.bodySha256).toBe(record.payload.sha256);
    expect(record.sat?.did).toBe(`did:btco:reg:${record.sat?.satoshi}`);
    expect(record.sat?.inscriptionId).toBe(`${record.reveal?.txid}i0`);
    expect(record.reveal?.outputs[0].address).toBe(record.deposit.address);
    expect(record.commit?.outputs[1].address).toBe(record.deposit.address);

    // The reveal really spends the commit it was built on.
    const reveal = btc.Transaction.fromRaw(hex.decode(record.reveal!.hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    expect(hex.encode(reveal.getInput(0).txid!)).toBe(record.commit!.txid);
  }, 30_000);

  test('the inscription-bearing deposit is classified and never selected', async () => {
    const record = await dryRunInscription(mockDryRunInput());
    const inscribed = record.deposit.candidates.find((c) => c.outpoint.startsWith('c'.repeat(64)));
    expect(inscribed?.status).toBe('inscribed');
    expect(inscribed?.inscriptions).toEqual([`${'d'.repeat(64)}i0`]);
    expect(record.selection.some((s) => s.outpoint === inscribed?.outpoint)).toBe(false);
    expect(record.commit?.inputs.some((i) => i.outpoint === inscribed?.outpoint)).toBe(false);
  }, 30_000);

  test('an unclassifiable deposit stops the run before anything is built', async () => {
    const input = mockDryRunInput();
    const { inscribed } = mockCandidates(input.candidates[0].scriptPubKey);
    input.ordinalLookup = fixtureOrdinalLookup(inscribed, { failOn: [`${'b'.repeat(64)}:1`] });
    const record = await dryRunInscription(input);
    expect(byId(record, 'deposit.classification_established').ok).toBe(false);
    expect(record.deposit.classification.ok).toBe(false);
    expect(record.selection).toEqual([]);
    expect(record.commit).toBeNull();
    expect(byId(record, 'broadcast.nothing_left_the_process').ok).toBe(true);
    expect(failed(record)).toContain('deposit.classification_established');
  }, 30_000);

  test('no ordinal lookup at all means nothing is offered, exactly as the routes behave', async () => {
    const record = await dryRunInscription(mockDryRunInput({ ordinalLookup: undefined }));
    expect(record.deposit.candidates.every((c) => c.status === 'unclassified')).toBe(true);
    expect(record.commit).toBeNull();
    expect(failed(record)).toContain('deposit.classification_established');
  }, 30_000);

  test('a deposit short of the quote selects nothing and does not build', async () => {
    const input = mockDryRunInput();
    input.candidates = [{ ...input.candidates[0], value: 3_000 }];
    const record = await dryRunInscription(input);
    expect(record.deposit.shortfallSats).toBeGreaterThan(0);
    expect(record.selection).toEqual([]);
    expect(record.commit).toBeNull();
    expect(failed(record)).toEqual(['deposit.covers_quote']);
  }, 30_000);

  test('unsigned mode builds the real reveal on an unsigned commit and skips only the signature check', async () => {
    const record = await dryRunInscription(mockDryRunInput({ signer: unsignedCommitSigner() }));
    expect(failed(record)).toEqual([]);
    expect(skipped(record)).toEqual(['commit.signed_by_deposit_key']);
    expect(record.commit?.final).toBe(false);
    expect(record.commit?.vsizeBasis).toBe('estimated');
    expect(record.reveal?.final).toBe(true);
    expect(record.signer).toEqual({ kind: 'unsigned' });
  }, 30_000);

  test('a signer that returns a commit for a different funding set is caught by the SDK before the seam', async () => {
    const other = localKeySigner(hex.decode('5'.repeat(64)));
    const record = await dryRunInscription(mockDryRunInput({ signer: other }));
    // The wrong key cannot sign the P2WPKH inputs, so finalize throws inside the signer.
    expect(record.buildError).toMatch(/build did not reach the submit seam/);
    expect(record.commit).toBeNull();
    expect(byId(record, 'build.reached_submit_seam').ok).toBe(false);
    expect(byId(record, 'broadcast.nothing_left_the_process').ok).toBe(true);
  }, 30_000);

  test('if the build path ever bypasses the submit seam and broadcasts directly, the run fails loudly', async () => {
    const reads = spyReads();
    // No submit seam: the SDK falls back to broadcastTransaction(commit), which throws.
    const provider = neverBroadcastProvider(reads, { withoutSubmitSeam: true });
    const record = await dryRunInscription(mockDryRunInput({ reads, provider }));
    expect(reads.writes).toEqual([]);
    expect(provider.broadcastAttempts.length).toBe(1);
    expect(record.broadcast.attempts).toBe(1);
    expect(record.buildError).toMatch(/broadcastTransaction refused/);
    expect(record.commit).toBeNull();
    expect(failed(record)).toEqual(['build.reached_submit_seam', 'broadcast.nothing_left_the_process']);
    expect(renderRecord(record)).toContain('VERDICT: 2 FAIL');
  }, 30_000);

  test('a live fee estimate flows into the build: a higher rate raises both fees and the quote', async () => {
    const cheap = await dryRunInscription(mockDryRunInput({ reads: new OrdMockProvider({ feeRate: 2 }) }));
    const input = mockDryRunInput({ reads: new OrdMockProvider({ feeRate: 8 }) });
    input.candidates = input.candidates.map((c) => ({ ...c, value: c.value * 3 }));
    const dear = await dryRunInscription(input);
    expect(failed(cheap)).toEqual([]);
    expect(failed(dear)).toEqual([]);
    expect(dear.fee.feeRateSatVb).toBe(8);
    expect(dear.fee.quoteSats).toBeGreaterThan(cheap.fee.quoteSats);
    expect(dear.commit!.feeSats).toBeGreaterThan(cheap.commit!.feeSats);
    expect(dear.reveal!.feeSats).toBeGreaterThan(cheap.reveal!.feeSats);
  }, 60_000);

  test('the record renders with both raw hexes and a mechanical verdict', async () => {
    const record = await dryRunInscription(mockDryRunInput());
    const text = renderRecord(record);
    expect(text).toContain('MOCK PROVIDER');
    expect(text).toContain(`hex ${record.commit!.hex}`);
    expect(text).toContain(`hex ${record.reveal!.hex}`);
    expect(text).toContain('VERDICT: ');
    expect(text).not.toContain('[FAIL]');
    expect(text).not.toContain(hex.encode(hex.decode('4'.repeat(64))));
  }, 30_000);
});

describe('parseEnvelope', () => {
  test('reads content type, metadata chunks and a chunked body out of an ord envelope', () => {
    const pubkey = new Uint8Array(32).fill(7);
    const body = new Uint8Array(600).fill(9);
    const script = btc.Script.encode([
      pubkey, 'CHECKSIG', 0, 'IF',
      new TextEncoder().encode('ord'),
      new Uint8Array([1]), new TextEncoder().encode('text/plain'),
      new Uint8Array([5]), new Uint8Array([0xa1, 0x61, 0x61]),
      new Uint8Array([5]), new Uint8Array([0x01]),
      0,
      body.slice(0, 520), body.slice(520),
      'ENDIF',
    ]);
    const env = parseEnvelope(script);
    expect(hex.encode(env.pubkey)).toBe(hex.encode(pubkey));
    expect(env.contentType).toBe('text/plain');
    expect(hex.encode(env.metadata)).toBe('a1616101');
    expect(hex.encode(env.body)).toBe(hex.encode(body));
  });

  test('refuses a script that is not an envelope', () => {
    expect(() => parseEnvelope(btc.Script.encode([new Uint8Array(32), 'CHECKSIG']))).toThrow(/leaf script/);
  });
});

describe('inputs and payloads', () => {
  test('depositAddressOf derives the P2WPKH address for each network', () => {
    const key = hex.decode('4'.repeat(64));
    expect(depositAddressOf(key, 'mainnet').address).toMatch(/^bc1q/);
    expect(depositAddressOf(key, 'testnet').address).toMatch(/^tb1q/);
    expect(depositAddressOf(key, 'regtest').address).toMatch(/^bcrt1q/);
  });

  test('payloadFromFile refuses binary formats the engine cannot carry', () => {
    expect(() => payloadFromFile('/nowhere/image.png')).toThrow(/text file/);
  });

  test('the mock CLI path exits 0 with an all-pass record and never touches the network', async () => {
    const lines: string[] = [];
    const realLog = console.log;
    const realErr = console.error;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    console.error = () => undefined;
    let code: number;
    try {
      code = await main({});
    } finally {
      console.log = realLog;
      console.error = realErr;
    }
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('MOCK PROVIDER');
    expect(out).toContain('broadcastTransaction attempts: 0');
    expect(out).not.toContain('[FAIL]');
  }, 30_000);
});
