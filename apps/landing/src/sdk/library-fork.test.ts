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

  // The library row says so after a refresh, rather than listing it as fine.
  const { items } = await listLibrary();
  const row = items.find((i) => i.did === created.did);
  expect(row?.problem).toMatch(/fork unresolved/i);
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
