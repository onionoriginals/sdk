/**
 * The landing server's half of anchoring (plan 011, PR 10b): the author's
 * browser prepares and signs, this server verifies again, persists and
 * broadcasts (P9.6, P9.18). The chain here is simulated; the regtest journey
 * (scripts/regtest/landing-anchor.ts) runs the same path on Core and ord.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, OriginalsSDK } from '@originals/sdk/originals';
import { prepareEntryInscription } from '@originals/sdk/originals/bitcoin';
import { createOriginalsAnchoring, createMoneyLogger, type AnchoringStatus } from '@originals/host';
import { INDEX, NETWORK, WALLET_ADDRESS, authorWithOriginal, fakeChain, headerClock, walletSigner } from './originals-chain-fixture';

const SUB = 'sub-org-anchoring';

function setup() {
  const chain = fakeChain();
  const dataDir = mkdtempSync(join(tmpdir(), 'originals-anchoring-'));
  const lines: string[] = [];
  const server = createOriginalsAnchoring({ dataDir, provider: chain.provider, clock: headerClock(), index: INDEX, money: createMoneyLogger((l) => lines.push(l)) });
  const events = () => lines.map((l) => JSON.parse(l.slice('[landing][money] '.length)) as { event: string; [k: string]: unknown });
  return { chain, dataDir, server, events };
}

type Author = Awaited<ReturnType<typeof authorWithOriginal>>;

/** The browser's prepare: verified as a fresh reader would (P9.18), signed by the holder, nothing sent. */
const prepare = (a: Author, chain: ReturnType<typeof fakeChain>, fundingUtxos = [chain.satUtxo, chain.fund(50_000)]) =>
  prepareEntryInscription({
    sdk: a.sdk, did: a.did, fundingUtxos, satSigner: walletSigner, changeAddress: WALLET_ADDRESS, feeRate: 2, network: NETWORK,
    provider: chain.provider, clock: headerClock(), index: INDEX, recoveryStore: null,
  });

const evidence = async (a: Author) => (await a.sdk.package(a.did)).bytes;

const asStatus = (s: unknown) => {
  if ((s as { ok?: boolean }).ok === false) throw new Error(`status refused: ${JSON.stringify(s)}`);
  return s as AnchoringStatus;
};

describe('submitting an anchoring pair (P9.6, P9.17, P9.18)', () => {
  test('the pair is persisted before anything is broadcast, then both transactions are sent', async () => {
    const { chain, dataDir, server, events } = setup();
    const a = await authorWithOriginal();
    const pair = await prepare(a, chain);
    expect(pair.versionId).toBe(a.anchoring);
    expect(pair.inFlightGuard).toBe('skipped');

    const broadcast = chain.provider.broadcastTransaction.bind(chain.provider);
    const heldAtFirstBroadcast: string[] = [];
    chain.provider.broadcastTransaction = (raw: unknown) => {
      if (heldAtFirstBroadcast.length === 0) {
        const root = join(dataDir, 'originals-anchoring', SUB);
        for (const key of readdirSync(root)) heldAtFirstBroadcast.push(...readdirSync(join(root, key, 'recovery')));
      }
      return broadcast(raw);
    };

    const sent = await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair });
    expect(sent).toMatchObject({ ok: true, outcome: 'sent', versionId: a.anchoring, broadcast: 'reveal_broadcast', commitTxId: pair.prepared.commitTxId });
    expect(heldAtFirstBroadcast).toContain(`${pair.prepared.commitTxId}.json`);
    expect(chain.sent.length).toBe(2);
    expect(events().map((e) => e.event)).toEqual(['originals_anchor_attempted', 'originals_anchor_broadcast']);
  });

  test('pending Bitcoin acceptance until the reveal confirms, then anchored with the holder reported apart (P9.18, P9.11)', async () => {
    const { chain, server } = setup();
    const a = await authorWithOriginal();
    const pair = await prepare(a, chain);
    await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair });

    const pending = asStatus(await server.status(SUB, a.did));
    expect(pending).toMatchObject({ publication: 'pending-bitcoin-acceptance', action: 'wait-for-confirmation', current: false, heads: { accepted: null, next: a.anchoring } });
    // Never the signed transactions: the status is ids and states only.
    expect(JSON.stringify(pending)).not.toContain(pair.prepared.signedCommitHex);
    expect(JSON.stringify(pending)).not.toContain(pair.prepared.revealTxHex);

    chain.mine();
    const anchored = asStatus(await server.status(SUB, a.did));
    expect(anchored).toMatchObject({
      publication: 'anchored', action: 'done', heads: { accepted: a.anchoring, committed: a.anchoring, queue: [] },
      ownership: { status: 'provisional', output: `${pair.prepared.revealTxId}:0`, indexes: [INDEX] },
      indexes: { used: [INDEX], compared: false },
      // Section 7: a current status always carries its notices, here none (P9.15).
      current: true, notices: [], listed: { unverifiable: [], waiting: [] },
    });
  });

  test('the same pair sent again (a lost answer) is answered from the record, never sent twice', async () => {
    const { chain, server } = setup();
    const a = await authorWithOriginal();
    const pair = await prepare(a, chain);
    await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair });
    const again = await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair });
    expect(again).toMatchObject({ ok: true, outcome: 'recorded', recoveryId: pair.prepared.commitTxId });
    expect(chain.sent.length).toBe(2);
  });

  test('a replacement the browser names is not honoured: only the server\'s own catch-up can call for one (P9.6)', async () => {
    const { chain, server } = setup();
    const a = await authorWithOriginal();
    const first = await prepare(a, chain);
    chain.refuseOnce.add(first.prepared.commitTxId);
    const failed = await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair: first });
    expect(failed).toMatchObject({ ok: true, outcome: 'sent' });
    expect(chain.sent.length).toBe(0);

    const second = await prepare(a, chain, [chain.satUtxo, chain.fund(50_000)]);
    const claimed = { ...second, replaces: [first.prepared.commitTxId] };
    const refused = await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair: claimed });
    expect(refused).toMatchObject({ ok: false, httpStatus: 409, code: 'PAIR_IN_FLIGHT' });
    expect(chain.sent.length).toBe(0);
  });

  test('a copy that diverges from the one held is an unresolved fork: neither branch is inscribed (P6.6, S1)', async () => {
    const { chain, server, events } = setup();
    const a = await authorWithOriginal();
    // A second copy of the same Original, edited differently from the same parent.
    const b = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => a.author.evidence });
    await b.import(await evidence(a));
    await b.edit(a.did, { parent: a.anchoring, name: 'Branch B', author: a.author.ref, signer: a.author.signer });
    await a.edit('Branch A');

    const pair = await prepare(a, chain);
    await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair });
    const sentBefore = chain.sent.length;
    const forked = await server.submit(SUB, { did: a.did, evidence: (await b.package(a.did)).bytes, pair });
    expect(forked).toMatchObject({ ok: false, httpStatus: 409, error: 'original_forked' });
    expect(chain.sent.length).toBe(sentBefore);
    expect(events().at(-1)).toMatchObject({ event: 'originals_anchor_refused', reason: 'original_forked' });
  });

  test('evidence for another Original, or evidence that does not verify, is refused before any read', async () => {
    const { chain, server } = setup();
    const a = await authorWithOriginal();
    const other = await authorWithOriginal();
    const pair = await prepare(a, chain);
    expect(await server.submit(SUB, { did: a.did, evidence: await evidence(other), pair })).toMatchObject({ ok: false, httpStatus: 422, error: 'evidence_mismatch' });
    expect(await server.submit(SUB, { did: a.did, evidence: new TextEncoder().encode('not a zip'), pair })).toMatchObject({ ok: false, error: 'evidence_not_verified' });
    expect(await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair: { versionId: 'x' } as never })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(chain.sent.length).toBe(0);
  });

  test('a status for an Original this account never submitted is not found', async () => {
    const { server } = setup();
    const a = await authorWithOriginal();
    expect(await server.status(SUB, a.did)).toMatchObject({ ok: false, httpStatus: 404, error: 'not_submitted' });
    expect(await server.status('another-sub', a.did)).toMatchObject({ ok: false, httpStatus: 404 });
  });
});

describe('the sweep (P9.6, P9.18)', () => {
  test('resumes a pair whose reveal never went out, sending the same bytes', async () => {
    const { chain, server, events } = setup();
    const a = await authorWithOriginal();
    const pair = await prepare(a, chain);
    chain.refuseOnce.add(pair.prepared.revealTxId);
    const sent = await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair });
    expect(sent).toMatchObject({ ok: true, broadcast: 'reveal_broadcast_unknown' });
    expect(chain.sent.length).toBe(1);
    expect(asStatus(await server.status(SUB, a.did)).action).toBe('resume');

    expect(await server.sweep()).toEqual({ examined: 1, resumed: 1, failed: 0 });
    expect(chain.sent.at(-1)).toBe(pair.prepared.revealTxHex);
    expect(events().at(-1)).toMatchObject({ event: 'originals_anchor_resumed', did: a.did });
    chain.mine();
    expect(asStatus(await server.status(SUB, a.did)).publication).toBe('anchored');
  });

  test('never prepares: the next entry waits for the holder to sign it', async () => {
    const { chain, server } = setup();
    const a = await authorWithOriginal();
    await a.edit('Harbor, revised');
    const pair = await prepare(a, chain);
    await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair });
    chain.mine();
    const waiting = asStatus(await server.status(SUB, a.did));
    expect(waiting).toMatchObject({ action: 'prepare', publication: 'anchored', heads: { accepted: a.anchoring } });
    const sentBefore = chain.sent.length;
    expect(await server.sweep()).toEqual({ examined: 1, resumed: 0, failed: 0 });
    expect(chain.sent.length).toBe(sentBefore);
  });
});

describe('reinscribing the Original\'s own sat (plan 011, PR 10b; P9.12, P9.13)', () => {
  test('the next entry spends the output holding the sat and lands one block later', async () => {
    const { chain, server } = setup();
    const a = await authorWithOriginal();
    const anchor = await prepare(a, chain);
    await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair: anchor });
    chain.mine();

    const revised = await a.edit('Harbor, revised');
    const next = await prepare(a, chain, [chain.holderUtxo(), chain.fund(50_000)]);
    expect(next).toMatchObject({ versionId: revised, carries: [revised] });
    expect(next.prepared.fundingUtxos[0]).toMatchObject({ txid: anchor.prepared.revealTxId, vout: 0 });
    expect(await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair: next })).toMatchObject({ ok: true, outcome: 'sent', versionId: revised });
    chain.mine();
    expect(asStatus(await server.status(SUB, a.did))).toMatchObject({ publication: 'anchored', action: 'done', heads: { accepted: revised, committed: revised } });
  });

  test('a pair whose sat has since moved is refused at submit, nothing sent (P9.6)', async () => {
    const { chain, server } = setup();
    const a = await authorWithOriginal();
    const anchor = await prepare(a, chain);
    await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair: anchor });
    chain.mine();
    await a.edit('Harbor, revised');
    const stale = await prepare(a, chain, [chain.holderUtxo(), chain.fund(50_000)]);
    // Another pair spends the sat first.
    const winner = await prepare(a, chain, [chain.holderUtxo(), chain.fund(50_000)]);
    await chain.provider.broadcastTransaction(winner.prepared.signedCommitHex);
    chain.mine();
    const sentBefore = chain.sent.length;
    expect(await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair: stale })).toMatchObject({ ok: false, httpStatus: 409, code: 'SAT_MOVED' });
    expect(chain.sent.length).toBe(sentBefore);
  });
});

test('durable library discovers anchoring without summaries and exports verified evidence per account (P7.5, P9.18)', async () => {
  const { chain, dataDir, server } = setup();
  const a = await authorWithOriginal();
  const pair = await prepare(a, chain);
  await server.submit(SUB, { did: a.did, evidence: await evidence(a), pair });
  chain.mine();
  const { createAnchoringLibrary } = await import('@originals/host');
  const library = createAnchoringLibrary(dataDir);
  expect(await library.list('another-account')).toEqual([]);
  expect(await library.evidence('another-account', a.did)).toBeNull();
  expect(await library.list(SUB)).toMatchObject([{ did: a.did, availability: 'server' }]);
  const zip = await library.evidence(SUB, a.did);
  const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
  const loaded = await reader.load(zip!);
  expect(loaded.report.original).toBe(a.did);
  expect(loaded.report.history.status).toBe('valid');
  expect(loaded.report.authorBinding.status).toBe('valid');
  expect(loaded.report.resources.status).toBe('available');
  expect(chain.sent.length).toBe(2); // discovery/export never broadcast
  await expect(library.list('../escape')).rejects.toThrow();
});
