/** Browser-side regression assertions, run through B3 preview_evaluate after
 * starting library-browser-fixture.ts and Vite on isolated loopback ports.
 * No production credentials or networks. Reload between seed and check.
 */
import { BrowserOriginalsStore } from '../src/sdk/browser-store';
import { DemoEngine } from '../src/sdk/engine';
import { accountOutboxName, listLibrary } from '../src/sdk/library';
import { httpAnchoringTransport, indexedDbOutbox } from '../src/sdk/anchoring';
import { HttpOrdinalsProvider } from '../src/sdk/http-ordinals-provider';
import { base64 } from '@scure/base';

const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
export async function seedPending() {
  const entry = await (await fetch('/api/__fixture/pair')).json();
  const store = new BrowserOriginalsStore('alice');
  const engine = new DemoEngine({ store });
  const state = await engine.importEvidence(base64.decode(entry.evidence));
  await indexedDbOutbox(accountOutboxName('alice')).put(state.did, entry);
  sessionStorage.setItem('pending-before-refresh', JSON.stringify(entry));
  return { did: state.did, entries: state.history.length, pairSaved: true };
}
export async function checkPendingAfterReload() {
  const entry = JSON.parse(sessionStorage.getItem('pending-before-refresh')!);
  const outbox = indexedDbOutbox(accountOutboxName('alice'));
  const before = await outbox.get(entry.did);
  check(JSON.stringify(before) === JSON.stringify(entry), 'Refresh changed the pair');
  const store = new BrowserOriginalsStore('alice');
  const engine = new DemoEngine({ authed: true, subOrgId: 'alice', store, features: { bitcoinAnchoring: true }, anchoring: {
    network: 'regtest', outbox,
    transport: httpAnchoringTransport({ provider: new HttpOrdinalsProvider() }),
    // Any signing attempt fails the check. Recovery must only resend.
    satSigner: { signAndFinalizeCommitPsbt: async () => { throw new Error('Duplicate signing'); } },
  } });
  await engine.open(entry.did);
  const countsBefore = await (await fetch('/api/__fixture/counts')).json();
  const after = await engine.inscribe();
  const countsAfter = await (await fetch('/api/__fixture/counts')).json();
  check(after.anchoring?.lastSent?.outcome === 'recorded', 'Not answered from durable record');
  check(after.anchoring?.lastSent?.commitTxId === entry.pair.prepared.commitTxId, 'Pair replaced');
  check(countsAfter.broadcasts === countsBefore.broadcasts, 'Duplicate broadcast');
  check(!(await outbox.get(entry.did)), 'Acknowledged pair still pending');
  return { did: entry.did, identicalPair: true, signatures: 0, additionalBroadcasts: 0, outcome: after.anchoring?.lastSent?.outcome };
}
export async function checkIsolation(account?: string) {
  const entry = JSON.parse(sessionStorage.getItem('pending-before-refresh')!);
  const list = await listLibrary(account);
  check(!list.items.some((i) => i.did === entry.did), 'Another account can list Alice evidence');
  check(!(await new BrowserOriginalsStore(account).get(entry.did)), 'Another account can open Alice log');
  check(!(await indexedDbOutbox(accountOutboxName(account)).get(entry.did)), 'Another account can read Alice pair');
  if (account) check((await fetch(`/api/originals/evidence?did=${encodeURIComponent(entry.did)}`)).status === 404, 'Server leaked Alice evidence');
  return { account: account ?? 'guest', evidenceIsolated: true, pairIsolated: true };
}
export async function checkAtomicCommit() {
  const store = new BrowserOriginalsStore('atomic-check');
  const first = new DemoEngine({ store, localAuthor: () => store.localAuthor() });
  const original = await first.create('Atomic browser check', 'Orbits', 'exact bytes');
  const a = new DemoEngine({ store: new BrowserOriginalsStore('atomic-check'), localAuthor: () => store.localAuthor() });
  const b = new DemoEngine({ store: new BrowserOriginalsStore('atomic-check'), localAuthor: () => store.localAuthor() });
  await Promise.all([a.open(original.did), b.open(original.did)]);
  const results = await Promise.allSettled([a.update('Branch A', 'Orbits', 'A'), b.update('Branch B', 'Orbits', 'B')]);
  check(results.filter((r) => r.status === 'fulfilled').length === 1, 'Concurrent commits both won');
  const fresh = new DemoEngine({ store: new BrowserOriginalsStore('atomic-check') });
  check((await fresh.open(original.did)).history.length === 2, 'Atomic head did not survive reopen');
  return { atomicHead: true, winners: 1, staleParents: 1 };
}
