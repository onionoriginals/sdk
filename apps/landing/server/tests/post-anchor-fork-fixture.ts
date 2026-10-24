/**
 * A post-anchor divergence on the simulated chain (#996 round-2 review):
 * device A anchors an Original and Bitcoin accepts the anchor; A then commits
 * a revision v3a it never submits; device B, from the anchored copy, commits
 * v3b and inscribes it on the sat. Bitcoin's accepted head is v3b, so A's
 * v3a is on a branch Bitcoin dropped (P9.13, P9.16).
 */
import { DemoEngine } from '../../src/sdk/engine';
import { httpAnchoringTransport, memoryOutbox, type AnchoringTransport } from '../../src/sdk/anchoring';
import { HttpOrdinalsProvider } from '../../src/sdk/http-ordinals-provider';
import { createLocalAuthor } from '../../src/sdk/local-author';
import type { OriginalsStore } from '@originals/sdk/originals';
import { inProcessLanding } from './landing-server-fixture';
import { WALLET_ADDRESS, fakeChain, walletSigner } from './originals-chain-fixture';

export async function postAnchorFork(opts: { storeA?: OriginalsStore; transport?: (t: AnchoringTransport) => AnchoringTransport } = {}) {
  const chain = fakeChain();
  const landing = inProcessLanding(chain);
  const author = await createLocalAuthor();
  const base = httpAnchoringTransport({ fetchImpl: landing.fetchImpl, provider: new HttpOrdinalsProvider({ fetchImpl: landing.fetchImpl }) });
  const anchoring = () => ({ transport: opts.transport ? opts.transport(base) : base, outbox: memoryOutbox(), satSigner: walletSigner, network: 'regtest' as const, index: 'ord-test' });
  const a = new DemoEngine({ ...(opts.storeA ? { store: opts.storeA } : {}), features: { bitcoinAnchoring: true }, author, anchoring: anchoring() });
  const { did } = await a.create('Harbor', 'Orbits', 'harbor');
  await a.inscribe({ funding: { fundingUtxos: [chain.satUtxo, chain.fund(50_000)], changeAddress: WALLET_ADDRESS } });
  chain.mine();
  const anchored = await a.evidencePackage();
  const anchorHead = a.snapshot().history.at(-1)!.versionId;

  const b = new DemoEngine({ features: { bitcoinAnchoring: true }, author, anchoring: anchoring() });
  await b.importEvidence(anchored, did);
  const v3b = (await b.update('Harbor from B', 'Orbits', 'harbor b')).history.at(-1)!.versionId;
  await b.inscribe({ funding: { fundingUtxos: [chain.fund(50_000)], changeAddress: WALLET_ADDRESS } });
  chain.mine();

  // A's revision is committed locally and never submitted.
  const v3a = (await a.update('Harbor from A', 'Orbits', 'harbor a')).history.at(-1)!.versionId;
  return { chain, landing, author, a, b, did, anchorHead, v3a, v3b, branchA: await a.evidencePackage(), branchB: await b.evidencePackage(), anchoring };
}
