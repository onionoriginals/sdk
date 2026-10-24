/**
 * Reopening a forked Original (owner decision S1; P6.6, P9.16). Two devices
 * extend the same Original differently; the second copy is imported beside
 * the first. Off Bitcoin no branch is current: the reopened Original reports
 * the fork, refuses to revise, publish or anchor either branch, and the
 * library row carries the problem after a refresh.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { IDBFactory } from 'fake-indexeddb';
import { DemoEngine, ForkUnresolvedError } from './engine';
import { BrowserOriginalsStore } from './browser-store';
import { createLocalAuthor } from './local-author';
import { listLibrary } from './library';
import { indexedDbOutbox, type AnchoringTransport } from './anchoring';
import { WALLET_ADDRESS, fakeChain } from '../../server/tests/originals-chain-fixture';
import { base64 } from '@scure/base';

const original = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
beforeEach(() => { (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory(); });
afterAll(() => { (globalThis as { indexedDB?: IDBFactory }).indexedDB = original; });

/** A transport that fails the test if anything reaches the network. */
const offline = new Proxy({}, { get: () => { throw new Error('nothing may reach the network for a forked Original'); } }) as AnchoringTransport;

test('a reopened fork is reported, and revise, publish and anchor are refused (C12-23, C12-143, P6.6, P9.16)', async () => {
  const author = await createLocalAuthor();
  const options = { author, features: { bitcoinAnchoring: true, hostedPublication: true }, anchoring: { transport: offline, outbox: indexedDbOutbox('originals-anchoring-outbox:guest'), network: 'regtest' as const } };
  const deviceA = new DemoEngine({ store: new BrowserOriginalsStore(), ...options });
  const created = await deviceA.create('Shared', 'Orbits', 'first');
  const deviceB = new DemoEngine({ author });
  await deviceB.importEvidence(await deviceA.evidencePackage());
  await deviceB.update('Device B', 'Orbits', 'second on B');
  await deviceA.update('Device A', 'Orbits', 'second on A');
  // The conflict is reported on import, and the other branch is kept (P6.6).
  await expect(deviceA.importEvidence(await deviceB.evidencePackage(), created.did)).rejects.toThrow(/conflict/i);

  // After a refresh: reopen from this browser's store.
  const reopened = new DemoEngine({ store: new BrowserOriginalsStore(), ...options });
  const state = await reopened.open(created.did);
  expect(state.fork).toBeDefined();
  expect(state.fork!.branches.length).toBeGreaterThanOrEqual(2);
  expect((state.provenance as { current: boolean }).current).toBe(false);
  const entries = state.history.length;

  // Neither branch is extended without the author choosing it (P6.6).
  await expect(reopened.update('More on A', 'Orbits', 'third')).rejects.toBeInstanceOf(ForkUnresolvedError);
  await expect(reopened.publish()).rejects.toBeInstanceOf(ForkUnresolvedError);
  const chain = fakeChain();
  await expect(reopened.inscribe({ funding: { fundingUtxos: [chain.satUtxo], changeAddress: WALLET_ADDRESS } })).rejects.toBeInstanceOf(ForkUnresolvedError);
  expect((await new DemoEngine({ store: new BrowserOriginalsStore() }).open(created.did)).history.length).toBe(entries);

  // A pending submission carrying B's branch is in the outbox too: the row says
  // "fork unresolved" once, not that and "conflicting history" both.
  await options.anchoring.outbox.put(created.did, { pair: { versionId: 'x', prepared: { commitTxId: 'c', revealTxId: 'r' } } as never, evidence: base64.encode(await deviceB.evidencePackage()), savedAt: 'now' });

  // The library row says so after a refresh, rather than listing it as fine.
  const { items } = await listLibrary();
  const row = items.find((i) => i.did === created.did);
  expect(row?.problem).toMatch(/fork unresolved/i);
  expect(row?.problem?.match(/fork unresolved/gi)).toHaveLength(1);
  expect(row?.problem).not.toMatch(/conflicting history/i);
});

test('a library row whose fork Bitcoin settled is not flagged (decision C; P9.16)', async () => {
  const { httpAnchoringTransport, memoryOutbox } = await import('./anchoring');
  const { HttpOrdinalsProvider } = await import('./http-ordinals-provider');
  const { inProcessLanding } = await import('../../server/tests/landing-server-fixture');
  const { walletSigner } = await import('../../server/tests/originals-chain-fixture');
  const chain = fakeChain();
  const landing = inProcessLanding(chain);
  const transport = httpAnchoringTransport({ fetchImpl: landing.fetchImpl, provider: new HttpOrdinalsProvider({ fetchImpl: landing.fetchImpl }) });
  const anchoring = { transport, outbox: memoryOutbox(), satSigner: walletSigner, network: 'regtest' as const, index: 'ord-test' };
  const author = await createLocalAuthor();
  const engine = new DemoEngine({ store: new BrowserOriginalsStore(), author, features: { bitcoinAnchoring: true }, anchoring });
  const { did } = await engine.create('Harbor', 'Orbits', 'harbor');
  const other = new DemoEngine({ author });
  await other.importEvidence(await engine.evidencePackage());
  await other.update('Harbor elsewhere', 'Orbits', 'elsewhere');
  const stale = await other.evidencePackage();
  await engine.inscribe({ funding: { fundingUtxos: [chain.satUtxo, chain.fund(50_000)], changeAddress: WALLET_ADDRESS } });
  chain.mine();
  await expect(engine.importEvidence(stale, did)).rejects.toThrow(/conflict/i);

  // Judged without Bitcoin the row would be flagged; with a Bitcoin read it is not.
  const judge = (store: BrowserOriginalsStore) => new DemoEngine({ store, anchoring });
  const { items } = await listLibrary(undefined, undefined, { engine: judge });
  expect(items.find((i) => i.did === did)?.problem).toBeUndefined();
});

test('an unforked Original reopens with no fork and can be revised (P6.6)', async () => {
  const author = await createLocalAuthor();
  const first = new DemoEngine({ store: new BrowserOriginalsStore(), author });
  const created = await first.create('Alone', 'Orbits', 'first');
  const reopened = new DemoEngine({ store: new BrowserOriginalsStore(), author });
  const state = await reopened.open(created.did);
  expect(state.fork).toBeUndefined();
  expect((await reopened.update('Alone, revised', 'Orbits', 'second')).history.length).toBe(2);
  const { items } = await listLibrary();
  expect(items.find((i) => i.did === created.did)?.problem).toBeUndefined();
});
