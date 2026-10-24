import { expect, test } from 'bun:test';
import { MemoryStore } from '@originals/sdk/originals';
import { DemoEngine } from './engine';
import { createLocalAuthor } from './local-author';

test('refresh reopens exact committed history and bytes without a signer (C12-01, P7.5)', async () => {
  const store = new MemoryStore();
  const author = await createLocalAuthor();
  const first = new DemoEngine({ store, author });
  await first.create('Saved', 'Orbits', 'first');
  const before = await first.update('Revised', 'Orbits', 'second');
  const reopened = new DemoEngine({ store });
  const after = await reopened.open(before.did);
  expect(after.history).toEqual(before.history);
  expect(after.resource).toEqual(before.resource);
  expect(after.author).toBe(before.author);
  expect((after.provenance as any).current).toBe(false);
  const stranger = new DemoEngine();
  expect((await stranger.importEvidence(await reopened.evidencePackage())).history).toEqual(before.history);
});

test('untrusted import refuses corrupt evidence and keeps existing work (C12-02, P7.5)', async () => {
  const engine = new DemoEngine();
  const saved = await engine.create('Kept', 'Orbits', 'bytes');
  await expect(engine.importEvidence(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  expect(engine.snapshot().did).toBe(saved.did);
  expect(engine.snapshot().history).toEqual(saved.history);
});

test('opening evidence does not grant a different author authority (P5.3, P7.5)', async () => {
  const engine = new DemoEngine();
  await engine.create('Kept', 'Orbits', 'bytes');
  const reader = new DemoEngine({ author: await createLocalAuthor() });
  await reader.importEvidence(await engine.evidencePackage());
  await expect(reader.update('Wrong author', 'Orbits', 'changed')).rejects.toThrow(/author/i);
});

test('import verifies the signed history, not just a readable ZIP (C12-02, P7.5)', async () => {
  const { readEvidence, writeEvidence } = await import('@originals/sdk/originals');
  const source = new DemoEngine();
  const original = await source.create('Authentic', 'Orbits', 'bytes');
  const contents = readEvidence(await source.evidencePackage());
  const line = JSON.parse(contents.log.trim());
  line.state.asset.name = 'Forged title';
  contents.log = `${JSON.stringify(line)}\n`;
  const target = new DemoEngine();
  await expect(target.importEvidence(writeEvidence(contents))).rejects.toThrow();
  await expect(target.open(original.did)).rejects.toThrow();
});

test('an old unscoped pair can be adopted only by its verified author and deposit account (P5.3, P9.6)', async () => {
  const { legacySubmissionBelongs } = await import('./library');
  const { base64 } = await import('@scure/base');
  const { authorWithOriginal, fakeChain, headerClock, walletSigner, WALLET_ADDRESS, INDEX } = await import('../../server/tests/originals-chain-fixture');
  const { prepareEntryInscription } = await import('@originals/sdk/originals/bitcoin');
  const a = await authorWithOriginal();
  const chain = fakeChain();
  const pair = await prepareEntryInscription({ sdk: a.sdk, did: a.did, fundingUtxos: [chain.satUtxo, chain.fund(50_000)], satSigner: walletSigner, changeAddress: WALLET_ADDRESS, feeRate: 2, network: 'regtest', provider: chain.provider, clock: headerClock(), index: INDEX, recoveryStore: null });
  const entry = { pair, evidence: base64.encode((await a.sdk.package(a.did)).bytes), savedAt: new Date().toISOString() };
  expect(await legacySubmissionBelongs(entry, a.did, a.author.ref.did, WALLET_ADDRESS)).toBe(true);
  expect(await legacySubmissionBelongs(entry, a.did, 'did:vh:other-account', WALLET_ADDRESS)).toBe(false);
  expect(await legacySubmissionBelongs(entry, a.did, a.author.ref.did, 'another-deposit-address')).toBe(false);
  expect(await legacySubmissionBelongs({ ...entry, evidence: 'AAAA' }, a.did, a.author.ref.did, WALLET_ADDRESS)).toBe(false);
});

test('the saved Stage A Original reopens from its committed export in a fresh consumer (C12-01, P7.5)', async () => {
  const zip = new Uint8Array(await Bun.file(new URL('../../../../docs/regtest/receipts/originals-live-turnkey-975-2026-10-24.zip', import.meta.url)).arrayBuffer());
  const reader = new DemoEngine();
  const state = await reader.importEvidence(zip, 'did:vh:QmRBdNNBMkjWTtXDhGTMY3E5eWKY7nGaAfMHDYXKxehtTB');
  expect(state.history.length).toBe(4);
  expect(state.history.at(-1)?.versionId).toBe('4-QmTfH5NP9qQs2YUTUafCodBefqHdeW4udiKwpgsWbG1MYS');
  expect(state.btcoDid).toBe('did:btco:reg:5000000000');
  expect((state.provenance as any).authorBinding.status).toBe('valid');
  expect((state.provenance as any).identityEvidence.status).toBe('complete');
  expect((state.provenance as any).resources.status).toBe('available');
  // The export is evidence for a copy, not a fresh Bitcoin read (P9.17).
  expect((state.provenance as any).current).toBe(false);
});
