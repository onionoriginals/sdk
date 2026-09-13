/// <reference path="../../../packages/sdk/src/types/external-shims.d.ts" />
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { RegtestProvider } from '../../../packages/sdk/src/adapters/providers/RegtestProvider';
import { createCommitTransaction, createRevealTransaction } from '../../../packages/sdk/src/bitcoin/transactions/commit';
import { createBitcoinCoreChainValidator } from '../../../packages/sdk/src/v3/chain-validation';
import { startRegtest } from '../../../scripts/regtest/environment';

// Run from the repository root after installing workspace dependencies:
// BITCOIND_BIN=/absolute/path/bitcoind ORD_BIN=/absolute/path/ord bun apps/landing/scripts/sat-snapshot-no-address.ts
// Optional: REGTEST_RECEIPT=/absolute/path/receipt.json and REGTEST_LOGS_DIR=/absolute/path/logs.
// A real ord/Core capability regression. Only disposable regtest coins are used.
const env = await startRegtest({ indexAddresses: false });
let independent: Awaited<ReturnType<typeof startRegtest>> | undefined;
try {
  const provider = new RegtestProvider(env);
  const ord = async <T>(path: string): Promise<T> => {
    const response = await fetch(env.ordUrl + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, `ord ${path}`);
    return response.json() as Promise<T>;
  };
  const assertCapabilities = async () => {
    const status = await ord<{ address_index: boolean; sat_index: boolean; inscription_index: boolean }>('/status');
    assert.equal(status.address_index, false);
    assert.equal(status.sat_index, true);
    assert.equal(status.inscription_index, true);
    return status;
  };
  await assertCapabilities();
  const key = secp256k1.utils.randomSecretKey();
  const payment = (secret: Uint8Array) => btc.p2wpkh(secp256k1.getPublicKey(secret, true), { ...btc.TEST_NETWORK, bech32: 'bcrt' });
  const owner = payment(key);
  const recipient = payment(secp256k1.utils.randomSecretKey());
  // Core reports the exact newly funded transaction, so this setup does not
  // require or bypass RegtestProvider's address-dependent UTXO methods.
  const fund = async () => {
    const txid = await env.fund(owner.address!);
    const transaction = await env.rpc<{ vout: Array<{ n: number; value: number; scriptPubKey: { address?: string; hex: string } }> }>('getrawtransaction', [txid, true]);
    const output = transaction.vout.find(output => output.scriptPubKey.address === owner.address);
    assert.ok(output);
    return { txid, vout: output.n, value: Math.round(output.value * 100_000_000), scriptPubKey: output.scriptPubKey.hex };
  };
  const funding = await fund();
  const indexedOutput = await ord<{ sat_ranges: Array<[number, number]> }>(`/output/${funding.txid}:${funding.vout}`);
  assert.ok(indexedOutput.sat_ranges.length);
  const satoshi = String(indexedOutput.sat_ranges[0][0]);
  const png = new Uint8Array(await readFile(new URL('../../../docs/regtest/examples/content.png', import.meta.url)));
  const commit = await createCommitTransaction({ content: png, contentType: 'image/png', utxos: [funding], exactUtxos: true,
    changeAddress: owner.address!, feeRate: 2, network: 'regtest' });
  const signedCommit = btc.Transaction.fromPSBT(Buffer.from(commit.commitPsbtBase64, 'base64'), { allowUnknownOutputs: true });
  signedCommit.sign(key); signedCommit.finalize();
  const reveal = await createRevealTransaction({ commitTxId: signedCommit.id, commitVout: 0, commitAmount: commit.commitAmount,
    revealPrivateKey: commit.revealPrivateKey, revealPublicKey: commit.revealPublicKey, inscriptionScript: commit.inscriptionScript,
    destinationAddress: owner.address!, feeRate: 2, network: 'regtest' });
  await env.rpc('sendrawtransaction', [signedCommit.hex]);
  await env.rpc('sendrawtransaction', [reveal.revealTxHex]);
  await env.mine();
  const before = await provider.getSatSnapshot(satoshi);
  assert.equal(before.indexHealthy, true);
  assert.equal(before.enumerationComplete, true);
  assert.deepEqual(before.publications.map(item => item.id), [reveal.inscriptionId]);
  assert.ok(before.publications[0].body.status === 'complete');
  assert.deepEqual(before.publications[0].body.bytes, png);
  assert.deepEqual(before.ownership, { owner: owner.address!, satpoint: `${reveal.revealTxId}:0:0` });

  const feeFunding = await fund();
  const revealTransaction = btc.Transaction.fromRaw(Buffer.from(reveal.revealTxHex, 'hex'));
  const postage = revealTransaction.getOutput(0).amount!;
  const transfer = new btc.Transaction();
  transfer.addInput({ txid: reveal.revealTxId, index: 0, witnessUtxo: { script: owner.script, amount: postage } });
  transfer.addInput({ txid: feeFunding.txid, index: feeFunding.vout, witnessUtxo: { script: owner.script, amount: BigInt(feeFunding.value) } });
  transfer.addOutput({ script: recipient.script, amount: postage });
  transfer.addOutput({ script: owner.script, amount: BigInt(feeFunding.value - 1000) });
  transfer.sign(key); transfer.finalize();
  await env.rpc('sendrawtransaction', [transfer.hex]);
  await env.mine();
  const after = await provider.getSatSnapshot(satoshi);
  assert.deepEqual(after.publications, before.publications, 'transfer changes no publication evidence');
  assert.deepEqual(after.ownership, { owner: recipient.address!, satpoint: `${transfer.id}:0:0` });
  assert.notDeepEqual(after.ownership, before.ownership);
  assert.equal(after.enumerationComplete, true);
  assert.equal(after.indexHealthy, true);
  assert.ok(after.tipAfter.height > before.tipAfter.height);
  // A genuinely separate Core process validates the primary's raw blocks before
  // starting its own ord index; it does not trust the indexer's JSON assertions.
  const initialBlocks: string[] = [];
  for (let height = 1; height <= after.tipAfter.height; height++) {
    initialBlocks.push(await env.rpc<string>('getblock', [await env.rpc<string>('getblockhash', [height]), 0]));
  }
  independent = await startRegtest({ indexAddresses: false, initialBlocks });
  const validator = () => {
    const separator = independent!.rpcAuth.indexOf(':');
    return createBitcoinCoreChainValidator({ endpoint: independent!.rpcUrl,
      rpcAuth: { username: independent!.rpcAuth.slice(0, separator), password: independent!.rpcAuth.slice(separator + 1) } });
  };
  await validator()(after);
  const altered = structuredClone(after);
  altered.blocks[0].txids = ['f'.repeat(64)];
  await assert.rejects(validator()(altered), { code: 'SAT_SNAPSHOT_CHAIN_DISAGREEMENT' });
  await independent.rpc('invalidateblock', [after.tipAfter.hash]);
  await assert.rejects(validator()(after), { code: 'SAT_SNAPSHOT_CHAIN_DISAGREEMENT' });
  await independent.rpc('reconsiderblock', [after.tipAfter.hash]);
  await independent.sync();
  await validator()(after);
  await independent.restart();
  await validator()(after); // Reload Core's rotated cookie after restart.
  const status = await assertCapabilities();
  const receipt = { checkedAt: new Date().toISOString(), versions: env.versions, network: 'regtest', addressIndex: status.address_index,
    satoshi, inscriptionId: reveal.inscriptionId, pngBytes: png.length, ownershipBefore: before.ownership, ownershipAfter: after.ownership,
    tipBefore: before.tipAfter, tipAfter: after.tipAfter,
    checks: ['real ord address index disabled', 'complete sat enumeration', 'exact PNG bytes', 'initial owner and satpoint',
      'real confirmed sat transfer', 'fresh owner and satpoint', 'unchanged publication evidence', 'separate Core validates imported raw blocks', 'independent Core validates real inscription blocks',
      'fabricated block transactions rejected', 'independent reorg rejected', 'reconsider and authenticated restart validated'], success: true };
  if (process.env.REGTEST_RECEIPT) await writeFile(process.env.REGTEST_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  try { await independent?.stop(); } finally { await env.stop(); }
}
