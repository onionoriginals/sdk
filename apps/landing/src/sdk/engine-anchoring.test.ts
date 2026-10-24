/**
 * The engine's anchoring path (plan 011, PR 10b) against the landing's real
 * request handler, in process, over a simulated chain. The author signs with
 * a local did:vh key and the commit with a local wallet key: this is not
 * Turnkey evidence. The regtest journey runs the same path on Core and ord;
 * live Turnkey signing is #975's stage A.
 */
import { describe, expect, test } from 'bun:test';
import type { BitcoinSigner } from '@originals/sdk';
import { DemoEngine } from './engine';
import { AnchoringCancelledError, SigningSessionExpiredError, httpAnchoringTransport, memoryOutbox, type AnchoringTransport } from './anchoring';
import { HttpOrdinalsProvider } from './http-ordinals-provider';
import { createLocalAuthor } from './local-author';
import { generateArtwork } from './artwork';
import { WALLET_ADDRESS, fakeChain, walletSigner } from '../../server/tests/originals-chain-fixture';
import { inProcessLanding } from '../../server/tests/landing-server-fixture';

async function setup(opts: { satSigner?: BitcoinSigner; transport?: (t: AnchoringTransport) => AnchoringTransport } = {}) {
  const chain = fakeChain();
  const landing = inProcessLanding(chain);
  const outbox = memoryOutbox();
  const base = httpAnchoringTransport({ fetchImpl: landing.fetchImpl, provider: new HttpOrdinalsProvider({ fetchImpl: landing.fetchImpl }) });
  const engine = new DemoEngine({
    features: { bitcoinAnchoring: true },
    author: await createLocalAuthor(),
    anchoring: { transport: opts.transport ? opts.transport(base) : base, outbox, satSigner: opts.satSigner ?? walletSigner, network: 'regtest', index: 'ord-test' },
  });
  const art = generateArtwork('Harbor at dawn', 'Orbits', 7);
  await engine.create('Harbor at dawn', 'Orbits', art.svg);
  const funding = (utxos = [chain.satUtxo, chain.fund(50_000)]) => ({ fundingUtxos: utxos, changeAddress: WALLET_ADDRESS });
  return { chain, landing, outbox, engine, funding };
}

describe('anchoring an Original from the landing (plan 011, PR 10b)', () => {
  test('the anchoring entry names the sat, the pair goes through the server, and the label follows Bitcoin (P9.10, P9.18)', async () => {
    const { chain, engine, funding } = await setup();
    const state = await engine.inscribe({ funding: funding() });
    expect(state.layer).toBe('did:btco');
    expect(state.btcoDid).toMatch(/^did:btco:reg:5000000000$/);
    expect(state.history.map((h) => h.operation)).toEqual(['create', 'update']);
    expect(state.anchoring?.status).toMatchObject({ publication: 'pending-bitcoin-acceptance', action: 'wait-for-confirmation', current: false });
    expect(state.anchoring?.unpublished).toEqual([state.history[1].versionId]);
    // What Bitcoin will not hold is stated before anything is called anchored (P9.18).
    expect(state.anchoring?.offChain).toMatchObject({ replication: 'not-guaranteed' });
    expect(state.anchoring?.offChain?.resources.map((r) => r.resource).sort()).toEqual(['artwork.svg', 'metadata.json']);
    expect(chain.sent.length).toBe(2);

    chain.mine();
    const anchored = await engine.anchoringStatus();
    expect(anchored.anchoring?.status).toMatchObject({ publication: 'anchored', action: 'done', heldByThisAccount: true });
    expect(anchored.anchoring?.unpublished).toEqual([]);
  });

  test('a cancel after signing sends nothing; the retry reuses the committed anchoring entry, never signing it again', async () => {
    const controller = new AbortController();
    let signed = 0;
    const cancelling: BitcoinSigner = {
      async signAndFinalizeCommitPsbt(psbt) {
        signed++;
        if (signed === 1) controller.abort();
        return walletSigner.signAndFinalizeCommitPsbt(psbt);
      },
    };
    const { chain, engine, outbox, funding } = await setup({ satSigner: cancelling });
    const utxos = funding();
    await expect(engine.inscribe({ funding: utxos, signal: controller.signal })).rejects.toBeInstanceOf(AnchoringCancelledError);
    expect(chain.sent.length).toBe(0);
    expect(await outbox.get(engine.snapshot().did)).toBeUndefined();
    const entries = engine.snapshot().history.length;

    const state = await engine.inscribe({ funding: utxos });
    expect(state.history.length).toBe(entries);
    expect(state.anchoring?.lastSent).toMatchObject({ outcome: 'sent' });
    expect(chain.sent.length).toBe(2);
  });

  test('an expired session stops before the next signature; after signing in again, the retry finds the sat itself', async () => {
    let live = false;
    let expireNext = true;
    const expiring: BitcoinSigner = {
      async signAndFinalizeCommitPsbt(psbt) {
        if (expireNext) {
          expireNext = false;
          throw Object.assign(new Error('Turnkey error 16: expired api key'), { code: 16 });
        }
        return walletSigner.signAndFinalizeCommitPsbt(psbt);
      },
    };
    const { chain, engine, funding } = await setup({ satSigner: expiring });
    const fee = chain.fund(50_000);
    // Already expired: nothing is signed, not even the anchoring entry.
    await expect(engine.inscribe({ funding: funding([chain.satUtxo, fee]), sessionActive: () => live })).rejects.toBeInstanceOf(SigningSessionExpiredError);
    expect(engine.snapshot().history.length).toBe(1);

    live = true;
    // Turnkey says the key expired at the commit: the anchoring entry is committed, nothing is sent.
    await expect(engine.inscribe({ funding: funding([chain.satUtxo, fee]), sessionActive: () => live })).rejects.toBeInstanceOf(SigningSessionExpiredError);
    expect(engine.snapshot().history.length).toBe(2);
    expect(chain.sent.length).toBe(0);

    // A fresh selection in another order: the output holding the sat still goes first (P9.12).
    const state = await engine.inscribe({ funding: funding([fee, chain.satUtxo]), sessionActive: () => live });
    expect(state.history.length).toBe(2);
    expect(state.anchoring?.lastSent).toMatchObject({ outcome: 'sent' });
  });

  test('a lost answer is retried with the identical pair, which the server answers from its record (P9.6)', async () => {
    let drop = true;
    const { chain, engine, outbox, funding } = await setup({
      transport: (t) => ({
        ...t,
        submit: async (body) => {
          const answer = await t.submit(body);
          if (drop) {
            drop = false;
            throw new TypeError('Failed to fetch');
          }
          return answer;
        },
      }),
    });
    await expect(engine.inscribe({ funding: funding() })).rejects.toThrow('Failed to fetch');
    expect(await outbox.get(engine.snapshot().did)).toBeDefined();
    expect(chain.sent.length).toBe(2);
    expect(await engine.pendingHandOff()).toBe(true);

    const state = await engine.inscribe({ funding: funding() });
    expect(state.anchoring?.lastSent).toMatchObject({ outcome: 'recorded' });
    expect(chain.sent.length).toBe(2);
    expect(await engine.pendingHandOff()).toBe(false);
  });

  test('a revision after the anchor is inscribed on the same sat, spending the output that holds it (P9.12, P9.13)', async () => {
    const { chain, engine, funding } = await setup();
    await engine.inscribe({ funding: funding() });
    chain.mine();
    const revised = await engine.update('Harbor at dusk', 'Orbits', generateArtwork('Harbor at dusk', 'Orbits', 8).svg);
    const read = (await engine.anchoringStatus()).anchoring!;
    // The server's copy ends at the anchor; the revision is this browser's until it is submitted.
    expect(read.status).toMatchObject({ publication: 'anchored', action: 'done' });
    expect(read.unpublished).toEqual([revised.history.at(-1)!.versionId]);

    const state = await engine.inscribe({ funding: funding([chain.fund(50_000)]) });
    expect(state.anchoring?.lastSent).toMatchObject({ outcome: 'sent', versionId: revised.history.at(-1)!.versionId });
    chain.mine();
    expect((await engine.anchoringStatus()).anchoring?.status).toMatchObject({ publication: 'anchored', action: 'done', heads: { accepted: revised.history.at(-1)!.versionId } });
  });
});

test('fresh engine reopens an uncertain pair and resends without any signer or funding (P9.6)', async () => {
  let drop = true;
  let signed = 0;
  const { chain, engine, outbox, funding, landing } = await setup({
    satSigner: { signAndFinalizeCommitPsbt: (psbt) => { signed++; return walletSigner.signAndFinalizeCommitPsbt(psbt); } },
    transport: (t) => ({ ...t, submit: async (body) => {
      const answer = await t.submit(body);
      if (drop) { drop = false; throw new Error('answer lost'); }
      return answer;
    } }),
  });
  await expect(engine.inscribe({ funding: funding() })).rejects.toThrow('answer lost');
  const before = engine.snapshot();
  const waiting = await outbox.get(before.did);
  const transport = httpAnchoringTransport({ fetchImpl: landing.fetchImpl, provider: new HttpOrdinalsProvider({ fetchImpl: landing.fetchImpl }) });
  const reopened = new DemoEngine({ authed: true, subOrgId: 'sub-engine', features: { bitcoinAnchoring: true }, anchoring: { transport, outbox, network: 'regtest', index: 'ord-test' } });
  await reopened.importEvidence(await engine.evidencePackage());
  expect(await reopened.pendingHandOff()).toBe(true);
  expect((await reopened.inscribe()).anchoring?.lastSent?.outcome).toBe('recorded');
  expect(reopened.snapshot().history).toEqual(before.history);
  expect(signed).toBe(1);
  expect(chain.sent.length).toBe(2);
  expect(await outbox.get(before.did)).toBeUndefined();
  expect(waiting?.pair.prepared.commitTxId).toBe(reopened.snapshot().anchoring?.lastSent?.commitTxId);
  chain.mine();
  const verified = await reopened.verifyBitcoin();
  expect(verified.bitcoinVerification?.history.status).toBe('valid');
  expect(verified.bitcoinVerification?.authorBinding.status).toBe('valid');
  expect(verified.bitcoinVerification?.anchoring?.status).toBe('anchored');
  expect(verified.bitcoinVerification?.head).toBe(before.history.at(-1)?.versionId);
  expect(verified.bitcoinVerification?.resources.status).toBe('available');
  expect(verified.bitcoinVerification?.ownership?.status).toBe('provisional');
});

test('reauth or a disabled writer never discards an uncertain signed pair (P9.6)', async () => {
  const { AnchoringSubmitError } = await import('./anchoring');
  let attempt = 0;
  const { engine, outbox, funding, chain } = await setup({ transport: (t) => ({ ...t, submit: async (body) => {
    attempt++;
    if (attempt === 2) throw new AnchoringSubmitError(401, { error: 'unauthorized' });
    if (attempt === 3) throw new AnchoringSubmitError(404, { error: 'bitcoin_anchoring_off' });
    const answer = await t.submit(body);
    if (attempt === 1) throw new Error('answer lost');
    return answer;
  } }) });
  await expect(engine.inscribe({ funding: funding() })).rejects.toThrow('answer lost');
  const did = engine.snapshot().did;
  const saved = await outbox.get(did);
  await expect(engine.inscribe()).rejects.toThrow('unauthorized');
  expect(await outbox.get(did)).toEqual(saved);
  await expect(engine.inscribe()).rejects.toThrow('bitcoin_anchoring_off');
  expect(await outbox.get(did)).toEqual(saved);
  expect((await engine.inscribe()).anchoring?.lastSent?.outcome).toBe('recorded');
  expect(chain.sent.length).toBe(2);
});
