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
import { saveState, stepVerify, type AnchorState, type Ctx } from '../../../src/og/anchor.js';
import type { ChainBackend, OrdExplorer } from '../../../src/og/chain.js';

const addr = (fill: number) => btc.p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(fill)), undefined, scureNetwork('regtest')).address!;

describe('anchoring receipt (P9.11, T7-074)', () => {
  test('reveal destination A, observed holder B: the run passes and records the two roles distinctly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-receipt-'));
    try {
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
      const parts = anchoringPublication([genesis, anchoring], author, bytes);
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
        fetchAuthorLog: async () => a.log,
      };
      const run = await stepVerify(ctx, { out: join(dir, 'last-run.json') });
      expect(parseTransaction(signed.hex.at(-1)!).txid).toBe(revealTxid);
      expect(run.report.bitcoin?.holder.address).toBe(observedHolder);
      expect(run.holder).toBe(observedHolder);
      expect(run.revealDestination).toBe(revealDestination);
      expect(run.holder).not.toBe(run.revealDestination);
      expect(run.transferCheck).toBe(true);
      expect(run.passed).toBe(true);
      const receipt = JSON.parse(readFileSync(join(dir, 'last-run.json'), 'utf8'));
      expect(receipt).toMatchObject({ holder: observedHolder, revealDestination, passed: true });
      expect(said.some((l) => l.includes(`holder at the tip ${observedHolder}`))).toBe(true);
      expect(said.some((l) => l.includes(`no longer at the reveal destination ${revealDestination}`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
