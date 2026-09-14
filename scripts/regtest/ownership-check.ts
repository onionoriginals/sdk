import assert from 'node:assert/strict';
import { join } from 'node:path';
import { OriginalsSDK, RegtestProvider, createBitcoinCoreContentValidator } from '../../packages/sdk/dist/index.js';
import { startRegtest } from './environment';

type Environment = Awaited<ReturnType<typeof startRegtest>>;

/** Exercises the public resolver with two real Core/ord instances, never saved or fabricated snapshots. */
export async function startOwnershipCheck(primary: Environment, sat: string, did: string) {
  const primaryProvider = new RegtestProvider(primary);
  const initialHeight = await primary.rpc<number>('getblockcount');
  const initialBlocks: string[] = [];
  for (let height = 1; height <= initialHeight; height++) {
    const hash = await primary.rpc<string>('getblockhash', [height]);
    initialBlocks.push(await primary.rpc<string>('getblock', [hash, 0]));
  }
  const independent = await startRegtest({ initialBlocks, logsDir: process.env.REGTEST_LOGS_DIR ? join(process.env.REGTEST_LOGS_DIR, 'independent-ownership') : undefined });
  const source = 'independent-regtest-ord';
  const observations: Array<{
    stage: string;
    primaryTip: { height: number; hash: string };
    independentTip: { height: number; hash: string };
    primaryOwnership: { owner: string | null; satpoint: string | null };
    independentOwnership: { owner: string | null; satpoint: string | null };
    ownershipAssurance: 'provider-asserted' | 'cross-checked';
  }> = [];
  // Reconstruct after restart so the provider reads Core's current cookie.
  const sdk = () => {
    const separator = independent.rpcAuth.indexOf(':');
    return OriginalsSDK.create({ network: 'regtest', satProvider: primaryProvider,
      independentEnumeration: { label: source, provider: new RegtestProvider(independent) },
      contentValidator: createBitcoinCoreContentValidator({ endpoint: independent.rpcUrl,
        rpcAuth: { username: independent.rpcAuth.slice(0, separator), password: independent.rpcAuth.slice(separator + 1) } }),
      enableLogging: false, logging: { level: 'error' } });
  };
  const observe = async (stage: string, assurance: 'provider-asserted' | 'cross-checked', owner?: string) => {
    const [first, second] = await Promise.all([
      primaryProvider.getSatSnapshot(sat), new RegtestProvider(independent).getSatSnapshot(sat),
    ]);
    assert.ok(first.publications.length > 0, 'a real mined CEL boundary is required');
    assert.deepEqual(second.publications.map(p => p.id), first.publications.map(p => p.id), 'same real inscriptions on both indexes');
    if (assurance === 'cross-checked') assert.deepEqual(first.tipBefore, second.tipBefore);
    else assert.notDeepEqual(first.tipBefore, second.tipBefore);
    const result = await sdk().lifecycle.resolveAssetFromSat(sat);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.equal(result.resolution.enumerationAssurance, 'cross-checked');
    assert.equal(result.resolution.contentAssurance, 'cross-checked', 'raw Core content evidence composes with index ownership checks');
    assert.equal(result.resolution.enumerationSource, source);
    assert.equal(result.resolution.ownershipAssurance, assurance, stage);
    assert.deepEqual(result.resolution.ownership, first.ownership);
    assert.deepEqual(result.resolution.tip, first.tipBefore);
    if (owner) assert.equal(result.resolution.ownership.owner, owner);
    const metadata = await sdk().did.resolveDIDWithMetadata(did);
    assert.equal(metadata.didResolutionMetadata.status, 'accepted');
    assert.equal(metadata.didDocumentMetadata.ownershipAssurance, assurance, `${stage}: DID metadata`);
    assert.equal(metadata.didDocumentMetadata.enumerationAssurance, 'cross-checked');
    assert.equal(metadata.didDocumentMetadata.contentAssurance, 'cross-checked');
    assert.deepEqual(metadata.didDocumentMetadata.ownership, first.ownership);
    assert.equal(metadata.didDocumentMetadata.head, result.asset.state.head);
    observations.push({ stage, primaryTip: first.tipBefore, independentTip: second.tipBefore,
      primaryOwnership: first.ownership, independentOwnership: second.ownership, ownershipAssurance: assurance });
    return { first, second };
  };
  const catchUp = async () => {
    const from = await independent.rpc<number>('getblockcount');
    const to = await primary.rpc<number>('getblockcount');
    assert.equal(await independent.rpc('getblockhash', [from]), await primary.rpc('getblockhash', [from]), 'catch-up starts at a common ancestor');
    for (let height = from + 1; height <= to; height++) {
      const hash = await primary.rpc<string>('getblockhash', [height]);
      const block = await primary.rpc<string>('getblock', [hash, 0]);
      assert.equal(await independent.rpc('submitblock', [block]), null);
    }
    await independent.sync();
  };
  try {
    const baseline = await OriginalsSDK.create({ network: 'regtest', satProvider: primaryProvider }).lifecycle.resolveAssetFromSat(sat);
    assert.equal(baseline.status, 'accepted');
    assert.equal(baseline.resolution.ownershipAssurance, 'provider-asserted', 'one real index alone does not corroborate itself');
    await observe('matching-tip-before-transfer', 'cross-checked');
    await primary.mine();
    const lagging = await observe('lagging-tip-same-owner', 'provider-asserted');
    assert.deepEqual(lagging.first.ownership, lagging.second.ownership, 'equal values at different heights still cannot earn assurance');
    assert.equal(lagging.first.tipBefore.height, lagging.second.tipBefore.height + 1);
    // Each index advances from the shared ancestor onto its own real branch.
    // A height-only gate would wrongly corroborate these identical holders.
    const [forkHash] = await independent.mine();
    const forked = await observe('same-height-different-hash', 'provider-asserted');
    assert.equal(forked.first.tipBefore.height, forked.second.tipBefore.height);
    assert.notEqual(forked.first.tipBefore.hash, forked.second.tipBefore.hash);
    assert.deepEqual(forked.first.ownership, forked.second.ownership);
    await independent.rpc('invalidateblock', [forkHash]);
    // ord observes the replacement once the chain grows beyond its old height.
    await primary.mine();
    await catchUp();
    await observe('fork-rejoined', 'cross-checked');
  } catch (error) {
    await independent.stop();
    throw error;
  }
  return {
    observations,
    async transferred(stage: string, owner: string) {
      const lagging = await observe(`${stage}-lagging-index`, 'provider-asserted', owner);
      assert.notDeepEqual(lagging.first.ownership, lagging.second.ownership, 'real transfer leaves the unsynced index with its old holder');
      await catchUp();
      const matched = await observe(`${stage}-indexes-agree`, 'cross-checked', owner);
      assert.deepEqual(matched.first.ownership, matched.second.ownership);
    },
    async finish() {
      await independent.restart();
      await observe('independent-restart', 'cross-checked');
      await independent.stop();
      const result = await sdk().lifecycle.resolveAssetFromSat(sat);
      assert.equal(result.status, 'incomplete', 'an unavailable configured index fails closed');
      const metadata = await sdk().did.resolveDIDWithMetadata(did);
      assert.equal(metadata.didResolutionMetadata.status, 'incomplete');
      assert.equal(metadata.didDocument, null);
      assert.notEqual(metadata.didDocumentMetadata.ownershipAssurance, 'cross-checked');
    },
    stop: () => independent.stop(),
  };
}
