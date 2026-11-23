// The anchoring command's receipt (last-run.json): the holder is the one observed at the verified
// tip (P9.11), kept apart from the reveal destination, and the transfer check depends only on the
// publications' depth (P7.22, T7-074). Driven through stepVerify with stub chain and ord backends.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { schnorr } from '@noble/curves/secp256k1.js';
import { parseTransaction } from '@originals/vh/og';
import { generateKeyFile } from '../../../src/og/keys.js';
import { createAuthorDid } from '../../../src/og/author-did.js';
import { anchoringPublication, createAnchoringEntry, createGenesis, type AuthorRef } from '../../../src/og/original.js';
import { scureNetwork, signChain } from '../../../src/og/inscribe.js';
import { authorWarnings, loadState, saveState, stepBroadcast, stepVerify, type AnchorState, type Ctx } from '../../../src/og/anchor.js';
import type { ChainBackend, OrdExplorer } from '../../../src/og/chain.js';

const addr = (fill: number) => btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(fill)), undefined, scureNetwork('regtest')).address!;

describe('anchoring receipt (P9.11, T7-074)', () => {
  /** An anchored Original read back through stub backends; `served` is what the author's URL returns. */
  async function receipt(dir: string, served: (log: string) => string | null) {
      const keyFile = join(dir, 'keys.json');
      const keys = generateKeyFile(keyFile);
      const a = await createAuthorDid(keys, { path: ['authors', 'receipt'], now: new Date('2026-11-22T00:00:00Z') });
      const author: AuthorRef = { did: a.did, verificationMethod: a.verificationMethod, versionId: a.versionId, log: a.log, signer: keys.assertion };
      const bytes = new TextEncoder().encode('# Receipt\n');
      const file = join(dir, 'notes.md');
      await Bun.write(file, bytes);
      const sat = 5000n;
      const genesis = await createGenesis({ name: 'Receipt', bytes, mediaType: 'text/markdown', network: 'regtest', author });
      const anchoring = await createAnchoringEntry(genesis, { sat, network: 'regtest', body: 'full', author });
      const parts = anchoringPublication([genesis, anchoring], bytes);
      const revealDestination = addr(2);
      const observedHolder = addr(3);
      const secret = new Uint8Array(32).fill(9);
      const signed = signChain({ secret, network: 'regtest', envelopes: parts.map((p) => p.envelope), holder: revealDestination, feeRate: 2, funding: { txid: 'ab'.repeat(32), vout: 0, amount: 100_000n } });
      const state: AnchorState = {
        version: 1, network: 'regtest',
        author: { did: a.did, url: a.url, log: a.log, verificationMethod: a.verificationMethod, versionId: a.versionId, resolved: true },
        original: { file, name: 'Receipt', mediaType: 'text/markdown', digest: genesis.state.transitions[0].to, size: bytes.length, body: 'full', previewMessage: '', genesis },
        reveal: { secretHex: '09'.repeat(32), fundingAddress: 'unused', fundingAmount: '100000', holder: revealDestination, feeRate: 2, postage: '1000', estimatedParts: parts.length, estimatedFees: [] },
        funding: { txid: 'ab'.repeat(32), vout: 0, amount: '100000', sat: sat.toString() },
        anchoringEntry: anchoring,
        signed: { hex: signed.hex, txids: signed.txids, postage: signed.postage.toString(), fees: signed.fees.map(String), parts: parts.length },
      };
      saveState(dir, state);

      // The reveal was mined at height 300; the tip is 309, so the publication is 10 deep. The sat has since
      // moved to B by a transaction with one confirmation, which the explorer reports as its output (P9.11).
      const revealTxid = signed.txids.at(-1)!;
      const hexById = new Map(signed.txids.map((t, k) => [t, signed.hex[k]]));
      const chain: ChainBackend = {
        name: 'stub-chain', utxos: async () => [], broadcast: async () => '', feeRate: async () => 2,
        txHex: async (txid) => hexById.get(txid)!,
        txConfirmations: async () => 10,
        tip: async () => ({ height: 309, hash: 'f'.repeat(64) }),
        blockTxids: async () => ['00'.repeat(32), ...signed.txids.slice(1)],
      };
      const ids = signed.txids.slice(1).map((t) => `${t}i0`);
      const ord = {
        base: 'stub-ord', version: async () => '0.29.1', height: async () => 309, blockhash: async () => 'f'.repeat(64),
        satInscriptions: async () => ids,
        inscription: async (id: string) => ({ id, height: 300, sat: Number(sat), satpoint: `${'cd'.repeat(32)}:0:0`, metaprotocol: 'og', content_type: id.startsWith(revealTxid) ? 'text/markdown' : null }),
        output: async () => ({ address: observedHolder }),
        firstSat: async () => sat,
      } as unknown as OrdExplorer;
      const said: string[] = [];
      const ctx: Ctx = {
        stateDir: dir, keyFile, network: 'regtest', chain, ord, pollMs: 1, timeoutMs: 5_000,
        io: { say: (l) => said.push(l), confirm: async () => true, sleep: async () => {} },
        fetchAuthorLog: async () => served(a.log),
      };
      const run = await stepVerify(ctx, { out: join(dir, 'last-run.json') });
      return { run, said, a, signed, revealTxid, revealDestination, observedHolder };
  }

  test('reveal destination A, observed holder B: the run passes and records the two roles distinctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-receipt-'));
    try {
      const { run, said, a, signed, revealTxid, revealDestination, observedHolder } = await receipt(dir, (log) => log);
      // D22: the author's log comes from its URL, supplied as the resolved signer history.
      expect(run.report.signers).toEqual([expect.objectContaining({ did: a.did, role: 'author', source: a.url, obtained: run.publicHost.obtained, freshness: 'not-established' })]);
      expect(run.publicHost).toMatchObject({ served: true, verifies: true, reachesNamedVersions: true });
      expect(run.warnings).toEqual([]);
      expect(parseTransaction(signed.hex.at(-1)!).txid).toBe(revealTxid);
      expect(run.report.bitcoin?.holder.address).toBe(observedHolder);
      expect(run.holder).toBe(observedHolder);
      expect(run.revealDestination).toBe(revealDestination);
      expect(run.holder).not.toBe(run.revealDestination);
      expect(run.transferCheck).toBe(true);
      expect(run.passed).toBe(true);
      const record = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
      expect(record).toMatchObject({ holder: observedHolder, revealDestination, passed: true });
      expect(said.some((l) => l.includes(`holder at the tip ${observedHolder}`))).toBe(true);
      expect(said.some((l) => l.includes(`no longer at the reveal destination ${revealDestination}`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D22: the author log not served: signer-history-missing, the anchor undetermined, the run not passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-receipt-'));
    try {
      const { run, a } = await receipt(dir, () => null);
      expect(run.report.axes).toMatchObject({ outcome: 'incomplete', bitcoin: 'undetermined', identity: 'incomplete' });
      expect(run.report.diagnostics).toContainEqual(expect.objectContaining({ code: 'signer-history-missing', item: { kind: 'signer', id: a.did } }));
      expect(run.report.entries.some((e) => e.status === 'accepted')).toBe(false);
      expect(run.publicHost).toMatchObject({ served: false, verifies: false });
      expect(run.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('D22: a served log that is not the author DID\'s is no evidence: never passed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-receipt-'));
    try {
      const { run } = await receipt(dir, (log) => log.replace('"versionTime":"', '"versionTime":"1'));
      expect(run.report.axes).toMatchObject({ outcome: 'incomplete', bitcoin: 'undetermined' });
      expect(run.publicHost).toMatchObject({ served: true, verifies: false });
      expect(run.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('author warnings beside the report (D22)', () => {
  const doc = (keys: string[]) => ({ id: 'did:webvh:x:a', verificationMethod: keys.map((k, i) => ({ id: `did:webvh:x:a#key-${i + 1}`, type: 'Multikey', controller: 'did:webvh:x:a', publicKeyMultibase: k })), assertionMethod: keys.map((_, i) => `did:webvh:x:a#key-${i + 1}`) });
  const v1 = { versionId: '1-a', document: doc(['zA']), deactivated: false };
  test('none while the newest version lists the key', () => {
    expect(authorWarnings({ ok: true, versions: [v1] }, 'did:webvh:x:a#key-1', '1-a')).toEqual([]);
  });
  test('a newer version that removes the key, or deactivates the DID, is a warning, never a failure', () => {
    expect(authorWarnings({ ok: true, versions: [v1, { versionId: '2-b', document: doc(['zB']), deactivated: false }] }, 'did:webvh:x:a#key-1', '1-a')[0]).toMatch(/2-b no longer lists the key/);
    expect(authorWarnings({ ok: true, versions: [v1, { versionId: '2-b', document: doc(['zA']), deactivated: true }] }, 'did:webvh:x:a#key-1', '1-a')[0]).toMatch(/deactivated at its newest version 2-b/);
  });
});

describe('broadcast (P9.18, P9.6)', () => {
  async function signedState() {
    const dir = mkdtempSync(join(tmpdir(), 'og-broadcast-'));
    const keyFile = join(dir, 'keys.json');
    const keys = generateKeyFile(keyFile);
    const a = await createAuthorDid(keys, { path: ['authors', 'broadcast'], now: new Date('2026-11-22T00:00:00Z') });
    const author: AuthorRef = { did: a.did, verificationMethod: a.verificationMethod, versionId: a.versionId, log: a.log, signer: keys.assertion };
    const bytes = new TextEncoder().encode('# Broadcast\n');
    const file = join(dir, 'notes.md');
    await Bun.write(file, bytes);
    const genesis = await createGenesis({ name: 'Broadcast', bytes, mediaType: 'text/markdown', network: 'regtest', author });
    const anchoring = await createAnchoringEntry(genesis, { sat: 5000n, network: 'regtest', body: 'full', author });
    saveState(dir, {
      version: 1, network: 'regtest',
      author: { did: a.did, url: a.url, log: a.log, verificationMethod: a.verificationMethod, versionId: a.versionId, resolved: true },
      original: { file, name: 'Broadcast', mediaType: 'text/markdown', digest: genesis.state.transitions[0].to, size: bytes.length, body: 'full', previewMessage: '', genesis },
      reveal: { secretHex: '09'.repeat(32), fundingAddress: 'unused', fundingAmount: '100000', holder: addr(2), feeRate: 2, postage: '1000', estimatedParts: 1, estimatedFees: [] },
      funding: { txid: 'ab'.repeat(32), vout: 0, amount: '100000', sat: '5000' },
      anchoringEntry: anchoring,
    });
    return { dir, keyFile };
  }
  const chainWith = (seen: (txid: string) => number | null, sent: string[]): ChainBackend => ({
    name: 'stub', utxos: async () => [], feeRate: async () => 2, txHex: async () => '', tip: async () => ({ height: 1, hash: 'h' }), blockTxids: async () => [],
    txConfirmations: async (txid) => seen(txid),
    broadcast: async (hex) => { sent.push(hex); return parseTransaction(hex).txid; },
  });
  const ctxOf = (dir: string, keyFile: string, chain: ChainBackend, said: string[]): Ctx => ({
    stateDir: dir, keyFile, network: 'regtest', chain, ord: {} as OrdExplorer, pollMs: 1, timeoutMs: 1_000,
    io: { say: (l) => said.push(l), confirm: async () => true, sleep: async () => {} },
  });

  test('T9-041, T9-111: pending only while the network is seen to hold a transaction; otherwise submitted, not observed', async () => {
    const { dir, keyFile } = await signedState();
    try {
      const sent: string[] = [];
      const said: string[] = [];
      // The backend never sees the transactions (rejected, evicted, or a provider without a mempool view).
      await stepBroadcast(ctxOf(dir, keyFile, chainWith(() => null, sent), said));
      expect(loadState(dir, 'regtest').broadcast!.map((b) => b.status)).toEqual(['submitted-not-observed', 'submitted-not-observed']);
      expect(said.filter((l) => /pending/.test(l))).toEqual([]);
      expect(said.filter((l) => /submitted, not observed/.test(l))).toHaveLength(2);
      // Once the mempool holds them, they are pending Bitcoin acceptance.
      const pending: string[] = [];
      await stepBroadcast(ctxOf(dir, keyFile, chainWith(() => 0, sent), pending));
      expect(loadState(dir, 'regtest').broadcast!.map((b) => b.status)).toEqual(['pending', 'pending']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T9-127: a rebroadcast sends the same transactions; no entry is re-signed or rebased', async () => {
    const { dir, keyFile } = await signedState();
    try {
      const first: string[] = [];
      await stepBroadcast(ctxOf(dir, keyFile, chainWith(() => null, first), []));
      const signedBefore = loadState(dir, 'regtest').signed!;
      const anchoringBefore = loadState(dir, 'regtest').anchoringEntry;
      const second: string[] = [];
      await stepBroadcast(ctxOf(dir, keyFile, chainWith(() => null, second), []));
      expect(second).toEqual(first);
      expect(loadState(dir, 'regtest').signed).toEqual(signedBefore);
      expect(loadState(dir, 'regtest').anchoringEntry).toEqual(anchoringBefore);
      // A transaction the network already holds is not sent again.
      const third: string[] = [];
      await stepBroadcast(ctxOf(dir, keyFile, chainWith(() => 0, third), []));
      expect(third).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
