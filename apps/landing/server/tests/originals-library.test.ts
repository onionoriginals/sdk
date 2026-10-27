/**
 * The account library's server half (@originals/host originals-library.ts) never hides
 * a record: damaged, unverified, forked or duplicated evidence is listed as an
 * explicit incomplete row with a problem, never dropped or labelled saved
 * (section 7; P6.6, P7.5).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { MemoryStore, OriginalsSDK, readZip } from '@originals/sdk/originals';
import { OriginalsError } from '@originals/vh';
import { FileStore } from '@originals/sdk/originals/fs';
import { createAnchoringLibrary, type OriginalsStore } from '@originals/host';
import { createLocalAuthor } from '../../src/sdk/local-author';

const keyOf = (did: string) => hex.encode(sha256(new TextEncoder().encode(did)));
const bytes = (text: string) => new TextEncoder().encode(text);

/** An unanchored Original, and two copies that each extend it differently: a fork off Bitcoin (P6.6). */
async function divergent() {
  const author = await createLocalAuthor(new Date('2026-10-22T11:00:00Z'));
  const a = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => author.evidence });
  const created = await a.create({ name: 'Harbor', resources: [{ id: 'photo.txt', mediaType: 'text/plain', bytes: bytes('one') }], author: author.ref, signer: author.signer });
  if (created.kind !== 'original') throw new Error('expected an Original');
  const did = created.original.did;
  const genesis = (await a.package(did)).bytes;
  const b = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => author.evidence });
  await b.import(genesis);
  await a.edit(did, { parent: created.original.checkpoint, name: 'Device A', author: author.ref, signer: author.signer });
  await b.edit(did, { parent: created.original.checkpoint, name: 'Device B', author: author.ref, signer: author.signer });
  return { did, genesis, branchA: (await a.package(did)).bytes, branchB: (await b.package(did)).bytes };
}

async function durable(dataDir: string, sub: string, did: string, packages: Uint8Array[], didFile: string = did) {
  const dir = join(dataDir, 'originals-anchoring', sub, keyOf(did));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'did'), didFile);
  const store = await FileStore.open(join(dir, 'store'));
  const sdk = OriginalsSDK.create({ store, authors: [] });
  for (const p of packages) await sdk.import(p);
  await store.close();
  return dir;
}

/** A hosted store that serves exactly these snapshot roots for the account. */
function hosting(roots: Array<Map<string, Uint8Array>>): OriginalsStore {
  return { evidenceFiles: () => roots.map((r) => new Map(r)) } as unknown as OriginalsStore;
}

const files = (zip: Uint8Array) => readZip(zip);

describe('damaged durable records stay visible (section 7)', () => {
  test('a record whose did file does not match its key is listed as incomplete, never skipped', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA } = await divergent();
    await durable(dataDir, 'alice', did, [branchA], 'did:vh:SomethingElse');
    const rows = await createAnchoringLibrary(dataDir).list('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ availability: 'incomplete' });
    expect(rows[0].problem).toBeTruthy();
    // Nothing is offered as this Original's evidence from a record that names another.
    expect(await createAnchoringLibrary(dataDir).evidence('alice', did)).toBeNull();
  });

  test('a record with no readable did file is listed as incomplete', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA } = await divergent();
    const dir = await durable(dataDir, 'alice', did, [branchA]);
    await rm(join(dir, 'did'));
    const rows = await createAnchoringLibrary(dataDir).list('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ availability: 'incomplete' });
    expect(rows[0].problem).toBeTruthy();
  });
});

describe('durable rows are labelled saved only when the report verifies (section 7; P6.6)', () => {
  test('a complete, unforked record is listed as saved to the account', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA } = await divergent();
    await durable(dataDir, 'alice', did, [branchA]);
    const rows = await createAnchoringLibrary(dataDir).list('alice');
    expect(rows).toEqual([expect.objectContaining({ did, availability: 'server', title: 'Device A' })]);
    expect(rows[0].problem).toBeUndefined();
  });

  test('a record holding a fork is incomplete with a fork problem; no branch is saved (C12-23, P6.6, P9.16)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA, branchB } = await divergent();
    await durable(dataDir, 'alice', did, [branchA, branchB]);
    const rows = await createAnchoringLibrary(dataDir).list('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ did, availability: 'incomplete' });
    expect(rows[0].problem).toMatch(/fork/i);
    // The app cannot settle it: the copy says so, and keeps both exports.
    expect(rows[0].problem).toMatch(/does not offer/i);
    const refused = await createAnchoringLibrary(dataDir).evidence('alice', did).catch((e) => e);
    expect((refused as OriginalsError).code).toBe('EVIDENCE_DIVERGED');
  });

  test('a record with incomplete identity evidence is incomplete with a problem (P5.6)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA } = await divergent();
    const dir = await durable(dataDir, 'alice', did, [branchA]);
    await rm(join(dir, 'store', 'authors'), { recursive: true, force: true });
    const rows = await createAnchoringLibrary(dataDir).list('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ did, availability: 'incomplete' });
    expect(rows[0].problem).toBeTruthy();
  });
});

describe('hosted snapshots (section 7; P6.6)', () => {
  test('an unreadable manifest is listed as incomplete, and does not break evidence for another Original', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA } = await divergent();
    const broken = new Map([['originals-evidence.json', bytes('{not json')]]);
    const library = createAnchoringLibrary(dataDir, hosting([broken, files(branchA)]));
    const rows = await library.list('alice');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.did === did)).toMatchObject({ availability: 'server', title: 'Device A' });
    expect(rows.find((r) => r.did !== did)).toMatchObject({ availability: 'incomplete' });
    expect(rows.find((r) => r.did !== did)?.problem).toBeTruthy();
    const exported = await library.evidence('alice', did);
    expect(exported).not.toBeNull();
    expect((await OriginalsSDK.create({ authors: [] }).load(exported!)).report.original).toBe(did);
  });

  test('two hosted copies of one Original that diverge are a reported divergence, and neither is returned (C12-23, P6.6)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA, branchB } = await divergent();
    const library = createAnchoringLibrary(dataDir, hosting([files(branchA), files(branchB)]));
    const rows = await library.list('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ did, availability: 'incomplete' });
    expect(rows[0].problem).toMatch(/disagree/i);
    // Not a 404 that hides it: a distinct divergence the opened view can show (#996 review).
    const refused = await library.evidence('alice', did).catch((e) => e);
    expect(refused).toBeInstanceOf(OriginalsError);
    expect((refused as OriginalsError).code).toBe('EVIDENCE_DIVERGED');
  });

  test('evidence is the copy the list verified, not the first root that names the Original (P7.5)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA } = await divergent();
    const good = files(branchA);
    // Same manifest, but the log is not the signed one: it names the Original and fails verification.
    const damaged = new Map(good);
    const logKey = 'asset/did.jsonl';
    expect(good.has(logKey)).toBe(true);
    damaged.set(logKey, bytes('{"broken":true}\n'));
    const library = createAnchoringLibrary(dataDir, hosting([damaged, good]));
    const rows = await library.list('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ did, availability: 'server', title: 'Device A' });
    // The damaged copy is not hidden either.
    expect(rows[0].problem).toBeTruthy();
    const exported = await library.evidence('alice', did);
    const report = (await OriginalsSDK.create({ authors: [] }).load(exported!)).report;
    expect(report.history.status).toBe('valid');
    expect(report.state?.name).toBe('Device A');
  });

  test('identical duplicate snapshots are one saved row with no problem', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, branchA } = await divergent();
    const library = createAnchoringLibrary(dataDir, hosting([files(branchA), files(branchA)]));
    const rows = await library.list('alice');
    expect(rows).toEqual([expect.objectContaining({ did, availability: 'server' })]);
    expect(rows[0].problem).toBeUndefined();
  });
});

describe('prefixes and Bitcoin-settled forks are not divergence (#996 review; P7.6, P9.16)', () => {
  test('a hosted copy that is a prefix of another is stale, not divergent: the longer one is served', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'library-'));
    const { did, genesis, branchA } = await divergent();
    const library = createAnchoringLibrary(dataDir, hosting([files(genesis), files(branchA)]));
    const rows = await library.list('alice');
    expect(rows).toEqual([expect.objectContaining({ did, availability: 'server', title: 'Device A' })]);
    const report = (await OriginalsSDK.create({ authors: [] }).load((await library.evidence('alice', did))!)).report;
    expect(report.state?.name).toBe('Device A');
  });

  test('a durable record holding a stale pre-anchor branch is saved once Bitcoin shows the anchor (decision C; C12-23, P9.16)', async () => {
    const { landing, did, dir } = await preAnchorFork({ mine: true });
    // Without Bitcoin the copy reports a fork; judged against the sat, the anchor's branch is the history.
    expect((await createAnchoringLibrary(landing.dataDir).list('sub-engine'))[0]).toMatchObject({ did, availability: 'incomplete' });
    const before = await retainedAnchor(dir, did);
    const library = createAnchoringLibrary(landing.dataDir, undefined, { bitcoin: landing.anchoring.bitcoinEvidence });
    const rows = await library.list('sub-engine');
    expect(rows).toEqual([expect.objectContaining({ did, availability: 'server' })]);
    expect(rows[0].problem).toBeUndefined();
    expect(await library.evidence('sub-engine', did)).toBeInstanceOf(Uint8Array);
    // The read path writes no retained anchor: only the writer does, under its own lock (round-2 review).
    expect(await retainedAnchor(dir, did)).toEqual(before);
  });
});

/** An Original anchored by the in-process landing, whose durable record also holds a stale pre-anchor branch. */
async function preAnchorFork(opts: { mine: boolean }) {
  const { DemoEngine } = await import('../../src/sdk/engine');
  const { httpAnchoringTransport, memoryOutbox } = await import('../../src/sdk/anchoring');
  const { HttpOrdinalsProvider } = await import('../../src/sdk/http-ordinals-provider');
  const { inProcessLanding } = await import('./landing-server-fixture');
  const { WALLET_ADDRESS, fakeChain, walletSigner } = await import('./originals-chain-fixture');
  const chain = fakeChain();
  const landing = inProcessLanding(chain);
  const author = await createLocalAuthor();
  const transport = httpAnchoringTransport({ fetchImpl: landing.fetchImpl, provider: new HttpOrdinalsProvider({ fetchImpl: landing.fetchImpl }) });
  const engine = new DemoEngine({ features: { bitcoinAnchoring: true }, author, anchoring: { transport, outbox: memoryOutbox(), satSigner: walletSigner, network: 'regtest', index: 'ord-test' } });
  const { did } = await engine.create('Harbor', 'Orbits', 'harbor');
  const other = new DemoEngine({ author });
  await other.importEvidence(await engine.evidencePackage());
  await other.update('Harbor elsewhere', 'Orbits', 'elsewhere');
  const stale = await other.evidencePackage();
  await engine.inscribe({ funding: { fundingUtxos: [chain.satUtxo, chain.fund(50_000)], changeAddress: WALLET_ADDRESS } });
  if (opts.mine) chain.mine();
  const dir = join(landing.dataDir, 'originals-anchoring', 'sub-engine', keyOf(did));
  const store = await FileStore.open(join(dir, 'store'));
  expect((await OriginalsSDK.create({ store, authors: [] }).import(stale)).status).toBe('conflict');
  await store.close();
  return { landing, did, dir };
}

async function retainedAnchor(dir: string, did: string) {
  const store = await FileStore.open(join(dir, 'store'));
  try { return await store.getRetainedAnchor(did); } finally { await store.close(); }
}

describe('fork checks against Bitcoin fail safe (round-2 review; P6.6, P9.16)', () => {
  test('Bitcoin accepting the other branch is not a settlement: incomplete, and no evidence is served (P9.13)', async () => {
    const { postAnchorFork } = await import('./post-anchor-fork-fixture');
    const f = await postAnchorFork();
    // A record whose committed log is A's dropped branch, with B's inscribed branch kept beside it.
    await durable(f.landing.dataDir, 'other-sub', f.did, [f.branchA, f.branchB]);
    const library = createAnchoringLibrary(f.landing.dataDir, undefined, { bitcoin: f.landing.anchoring.bitcoinEvidence });
    const rows = await library.list('other-sub');
    expect(rows[0]).toMatchObject({ did: f.did, availability: 'incomplete' });
    expect(rows[0].problem).toMatch(/Bitcoin accepted the other branch/);
    const refused = await library.evidence('other-sub', f.did).catch((e) => e);
    expect((refused as OriginalsError).code).toBe('EVIDENCE_DIVERGED');
  });

  test('a fork after the anchor that Bitcoin has not reached stands: incomplete, and no evidence is served (round 3; P6.6, P9.16)', async () => {
    const { postAnchorFork } = await import('./post-anchor-fork-fixture');
    const f = await postAnchorFork({ inscribeB: false });
    await durable(f.landing.dataDir, 'other-sub', f.did, [f.branchA, f.branchB]);
    const library = createAnchoringLibrary(f.landing.dataDir, undefined, { bitcoin: f.landing.anchoring.bitcoinEvidence });
    const rows = await library.list('other-sub');
    expect(rows[0]).toMatchObject({ did: f.did, availability: 'incomplete' });
    expect(rows[0].problem).toMatch(/fork unresolved/i);
    expect(rows[0].problem).not.toMatch(/other branch/);
    expect((await library.evidence('other-sub', f.did).catch((e) => e) as OriginalsError).code).toBe('EVIDENCE_DIVERGED');
  });

  test('a sat reader that throws leaves the fork standing, said as unchecked', async () => {
    const { landing, did } = await preAnchorFork({ mine: true });
    const library = createAnchoringLibrary(landing.dataDir, undefined, { bitcoin: async () => { throw new Error('index down'); } });
    const rows = await library.list('sub-engine');
    expect(rows[0]).toMatchObject({ did, availability: 'incomplete' });
    expect(rows[0].problem).toMatch(/fork unresolved/i);
    expect(rows[0].problem).toMatch(/Bitcoin could not be read/);
    expect((await library.evidence('sub-engine', did).catch((e) => e) as OriginalsError).code).toBe('EVIDENCE_DIVERGED');
  });

  test('a sat that does not show the anchor yet leaves the fork standing', async () => {
    const { landing, did } = await preAnchorFork({ mine: false });
    const library = createAnchoringLibrary(landing.dataDir, undefined, { bitcoin: landing.anchoring.bitcoinEvidence });
    const rows = await library.list('sub-engine');
    expect(rows[0]).toMatchObject({ did, availability: 'incomplete' });
    expect(rows[0].problem).toMatch(/fork unresolved/i);
    expect(rows[0].problem).not.toMatch(/Bitcoin could not be read/);
  });

  test('a sat read that never answers times out and is treated as unchecked', async () => {
    const { landing, did } = await preAnchorFork({ mine: true });
    const library = createAnchoringLibrary(landing.dataDir, undefined, { bitcoin: () => new Promise(() => undefined), bitcoinTimeoutMs: 50 });
    const started = Date.now();
    const rows = await library.list('sub-engine');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(rows[0]).toMatchObject({ did, availability: 'incomplete' });
    expect(rows[0].problem).toMatch(/Bitcoin could not be read/);
  });

  test('a sat read is cached per alias for a minute', async () => {
    const { landing } = await preAnchorFork({ mine: true });
    let reads = 0;
    let now = 1_000_000;
    const library = createAnchoringLibrary(landing.dataDir, undefined, { bitcoin: (alias) => { reads++; return landing.anchoring.bitcoinEvidence(alias); }, now: () => now });
    await library.list('sub-engine');
    await library.list('sub-engine');
    expect(reads).toBe(1);
    now += 61_000;
    await library.list('sub-engine');
    expect(reads).toBe(2);
  });

});
