/**
 * The dry-run harness (#526) is itself under test: it must drive the shipped
 * build-and-sign path to the broadcast step and no further, judge the pair
 * mechanically, and fail LOUDLY if a broadcast ever gets through.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { OrdMockProvider } from '@originals/sdk/testing';
import { generateArtwork } from '../src/sdk/artwork';
import {
  BROADCAST_REFUSED_SENTINEL,
  DryRunBroadcastRefused,
  decodeEnvelope,
  mockFixture,
  neverBroadcast,
  p2wpkhAddressOf,
  privateKeyFromWif,
  renderReport,
  runDryRun,
  summarizeTx,
  type DryRunReport,
} from './dry-run-inscription';

const payload = { content: generateArtwork('Dry run test', 'Artwork', 1).svg, contentType: 'image/svg+xml', filename: 'artwork.svg' };
const dataDir = () => mkdtempSync(join(tmpdir(), 'dry-run-test-'));

const failed = (r: DryRunReport) => r.checks.filter((c) => c.result === 'fail').map((c) => `${c.id}: ${c.detail}`);
const byId = (r: DryRunReport, id: string) => r.checks.find((c) => c.id === id)!;

describe('neverBroadcast', () => {
  test('reads pass through; every spend-shaped method rejects and is counted', async () => {
    const { provider, attempts } = neverBroadcast(new OrdMockProvider());
    expect(await provider.estimateFee(1)).toBe(5);
    expect(await provider.getFirstSatOfOutput!({ txid: 'a'.repeat(64), vout: 0 })).toMatch(/^\d+$/);
    await expect(provider.broadcastTransaction('00')).rejects.toBeInstanceOf(DryRunBroadcastRefused);
    await expect(provider.createInscription({ data: new Uint8Array(1), contentType: 'text/plain' })).rejects.toThrow(BROADCAST_REFUSED_SENTINEL);
    await expect(provider.transferInscription('x', 'y')).rejects.toThrow(BROADCAST_REFUSED_SENTINEL);
    await expect((provider as unknown as { submitInscription: () => Promise<unknown> }).submitInscription()).rejects.toThrow(BROADCAST_REFUSED_SENTINEL);
    expect(attempts).toEqual(['broadcastTransaction', 'createInscription', 'transferInscription', 'submitInscription']);
  });

  test('the sentinel is not mistaken for an "already known" broadcast success', async () => {
    const { isAlreadyKnownTxError } = await import('../server/bitcoin');
    expect(isAlreadyKnownTxError(new DryRunBroadcastRefused('broadcastTransaction'))).toBe(false);
  });
});

describe('runDryRun against the mock provider', () => {
  test('mainnet: every property holds, both transactions are built and signed, nothing is broadcast', async () => {
    const report = await runDryRun({
      network: 'mainnet',
      mode: 'mock',
      payload,
      world: (contentBytes) => mockFixture({ network: 'mainnet', contentBytes }),
      webvhDomain: 'originals.build',
      dataDir: dataDir(),
    });
    expect(failed(report)).toEqual([]);
    expect(report.verdict).toBe('pass');
    expect(report.signing).toBe('local-key');
    expect(report.address.startsWith('bc1q')).toBe(true);

    // The fixture forces a two-input selection and an excluded inscribed output.
    expect(report.selection?.selected).toHaveLength(2);
    expect(report.candidates.filter((c) => c.classification === 'inscribed')).toHaveLength(1);
    expect(report.candidates.filter((c) => c.classification === 'inscribed').every((c) => !c.selected)).toBe(true);
    expect(report.candidates.find((c) => c.role === 'identity')?.value).toBe(Math.max(...report.candidates.map((c) => c.value)));

    // Both raw transactions parse; the reveal spends the commit; postage and change go home.
    const commit = btc.Transaction.fromRaw(hex.decode(report.commit!.hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    const reveal = btc.Transaction.fromRaw(hex.decode(report.reveal!.hex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    expect(commit.id).toBe(report.commit!.txid);
    expect(hex.encode(reveal.getInput(0).txid!)).toBe(commit.id);
    expect(report.reveal!.outputs[0].address).toBe(report.address);
    expect(report.commit!.outputs[1].address).toBe(report.address);
    expect(report.commit!.outputs[0].scriptType).toBe('tr');
    expect(commit.getInput(0).finalScriptWitness).toHaveLength(2);
    expect(reveal.getInput(0).finalScriptWitness).toHaveLength(3);

    // Fee math: at least the live rate, inside the 1.5x quote.
    expect(report.commit!.feeRateSatVb!).toBeGreaterThanOrEqual(report.fee.routeRateSatVb!);
    expect(report.reveal!.feeRateSatVb!).toBeGreaterThanOrEqual(report.fee.routeRateSatVb!);
    expect(report.fee.rederivedQuoteSats).toBe(report.fee.quotedCostSats);

    // The envelope carries the payload and names the did:btco of the identity sat.
    expect(report.envelope?.bodySha256).toBe(report.payload.sha256);
    expect(report.envelope?.contentType).toBe('image/svg+xml');
    expect(report.expectedDid).toBe(`did:btco:${report.satoshi}`);
    expect(report.inscriptionId).toBe(`${report.reveal!.txid}i0`);

    // Never broadcast: the route stopped at the provider refusal, the pair is persisted as signed.
    expect(report.server.inscribeStatus).toBe(502);
    expect(report.server.inscribeBody?.error).toBe('commit_broadcast_failed');
    expect(String(report.server.inscribeBody?.message)).toContain(BROADCAST_REFUSED_SENTINEL);
    expect(report.server.recordStatus).toBe('signed');
    expect(report.server.broadcastAttempts).toEqual(['broadcastTransaction', 'broadcastTransaction']);
    expect(report.server.broadcastRouteCalls).toBe(0);
    expect(report.freshness.firstInternalKey).not.toBe(report.freshness.secondInternalKey);

    const text = renderReport(report);
    expect(text).toContain(report.commit!.hex);
    expect(text).toContain(report.reveal!.hex);
    expect(text).toContain('[PASS] never.broadcast');
    expect(text).toContain('PASS: every property holds');
    expect(text).not.toMatch(/\[FAIL\]/);
  }, 30_000);

  test('testnet: same path, tb1 addresses and the did:btco:test prefix', async () => {
    const report = await runDryRun({
      network: 'testnet',
      mode: 'mock',
      payload,
      world: (contentBytes) => mockFixture({ network: 'testnet', contentBytes }),
      webvhDomain: 'localhost',
      dataDir: dataDir(),
    });
    expect(failed(report)).toEqual([]);
    expect(report.address.startsWith('tb1q')).toBe(true);
    expect(report.expectedDid).toBe(`did:btco:test:${report.satoshi}`);
    expect(report.commit!.outputs[0].address.startsWith('tb1p')).toBe(true);
  }, 30_000);

  test('without a key the commit is left unsigned and the record says so (incomplete, not pass)', async () => {
    const report = await runDryRun({
      network: 'mainnet',
      mode: 'mock',
      payload,
      world: (contentBytes) => {
        const f = mockFixture({ network: 'mainnet', contentBytes });
        return { ...f, privateKey: undefined, address: f.address };
      },
      webvhDomain: 'originals.build',
      dataDir: dataDir(),
    });
    expect(failed(report)).toEqual([]);
    expect(report.verdict).toBe('incomplete');
    expect(report.signing).toBe('unsigned');
    expect(byId(report, 'commit.signed').result).toBe('skip');
    expect(report.commit!.inputs.every((i) => i.witnessItems === 0)).toBe(true);
    // The reveal still spends the (witness-independent) commit txid.
    expect(report.reveal!.inputs[0].outpoint).toBe(`${report.commit!.txid}:0`);
    expect(renderReport(report)).toContain('INCOMPLETE');
  }, 30_000);

  test('an unavailable ordinal check offers nothing to spend, so nothing is built', async () => {
    const report = await runDryRun({
      network: 'mainnet',
      mode: 'mock',
      payload,
      world: (contentBytes) => mockFixture({ network: 'mainnet', contentBytes, ordinals: null }),
      webvhDomain: 'originals.build',
      dataDir: dataDir(),
    });
    expect(report.verdict).toBe('fail');
    expect(byId(report, 'deposit.read').result).toBe('fail');
    expect(byId(report, 'selection.funded').result).toBe('fail');
    expect(report.commit).toBeNull();
    expect(report.server.broadcastAttempts).toEqual([]);
  }, 30_000);

  /**
   * The property the harness exists for. If the guard is bypassed and the
   * build path reaches a working broadcast, the run must not quietly pass:
   * the SDK resolves, and the harness reports that as the failure it is.
   */
  test('fails loudly if a broadcast ever gets through', async () => {
    const report = await runDryRun({
      network: 'mainnet',
      mode: 'mock',
      payload,
      world: (contentBytes) => mockFixture({ network: 'mainnet', contentBytes }),
      webvhDomain: 'originals.build',
      dataDir: dataDir(),
      unsafeGuardForTests: (inner) => ({ provider: inner, attempts: [] }),
    });
    expect(report.verdict).toBe('fail');
    const never = byId(report, 'never.broadcast');
    expect(never.result).toBe('fail');
    expect(never.detail).toContain('RESOLVED');
    expect(report.server.inscribeStatus).toBe(200);
    expect(renderReport(report)).toContain('[FAIL] never.broadcast');
  }, 30_000);
});

describe('helpers', () => {
  test('decodeEnvelope reads content type, body and metadata back out of an ord leaf script', () => {
    const body = new TextEncoder().encode('hello, sat');
    const meta = new Uint8Array([0xa1, 0x61, 0x78, 0x01]); // CBOR {"x":1}
    const script = btc.Script.encode([
      new Uint8Array(32), 'CHECKSIG', 0, 'IF', new TextEncoder().encode('ord'),
      new Uint8Array([1]), new TextEncoder().encode('text/plain'),
      new Uint8Array([5]), meta,
      0, body, 'ENDIF',
    ]);
    const decoded = decodeEnvelope(script);
    expect(decoded.contentType).toBe('text/plain');
    expect(hex.encode(decoded.body)).toBe(hex.encode(body));
    expect(hex.encode(decoded.metadata)).toBe(hex.encode(meta));
  });

  test('privateKeyFromWif accepts a compressed WIF for the right network only', () => {
    const { base58check } = require('@scure/base') as typeof import('@scure/base');
    const priv = hex.decode('7'.repeat(64));
    const wif = (version: number, compressed = true) =>
      base58check(sha256).encode(new Uint8Array([version, ...priv, ...(compressed ? [1] : [])]));
    expect(hex.encode(privateKeyFromWif(wif(0x80), 'mainnet'))).toBe(hex.encode(priv));
    expect(hex.encode(privateKeyFromWif(wif(0xef), 'testnet'))).toBe(hex.encode(priv));
    expect(() => privateKeyFromWif(wif(0xef), 'mainnet')).toThrow(/not a mainnet WIF/);
    expect(() => privateKeyFromWif(wif(0x80, false), 'mainnet')).toThrow(/COMPRESSED/);
    expect(p2wpkhAddressOf(priv, 'mainnet')).toBe(btc.p2wpkh(secp256k1.getPublicKey(priv, true), btc.NETWORK).address);
  });

  test('summarizeTx prices the fee from known input values', () => {
    const priv = hex.decode('8'.repeat(64));
    const p2 = btc.p2wpkh(secp256k1.getPublicKey(priv, true), btc.NETWORK);
    const tx = new btc.Transaction();
    tx.addInput({ txid: 'a'.repeat(64), index: 1, sequence: 0xfffffffd, witnessUtxo: { script: p2.script, amount: 10_000n } });
    tx.addOutputAddress(p2.address!, 9_000n, btc.NETWORK);
    tx.sign(priv);
    tx.finalize();
    const s = summarizeTx(hex.encode(tx.extract()), 'mainnet', [10_000]);
    expect(s.feeSats).toBe(1_000);
    expect(s.inputs[0]).toMatchObject({ outpoint: `${'a'.repeat(64)}:1`, sequence: 0xfffffffd, witnessItems: 2 });
    expect(s.outputs[0]).toMatchObject({ value: 9_000, address: p2.address, scriptType: 'wpkh' });
    expect(summarizeTx(hex.encode(tx.extract()), 'mainnet', [null]).feeSats).toBeNull();
  });
});
