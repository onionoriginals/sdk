/**
 * An Original moved up from an EVM chain to Bitcoin, on a disposable anvil
 * devnet and real Bitcoin Core 31.1 / ord 0.29.0 regtest (originals-spec PR 59,
 * EXPERIMENTAL; plan 011 phase 12). Local chains only: nothing here touches a
 * public network, testnet or mainnet.
 *
 * The journey, each step asserted:
 *  0. The anchor contract from `contracts/` is deployed on anvil through the
 *     deterministic deployment proxy with a zero salt (P14.21), and the devnet
 *     is added to an experimental pin's chains as an `operator` chain. Anvil's
 *     `finalized` block trails `latest` by two (`--slots-in-an-epoch 1`), so a
 *     publication is observed above the finalized block until three blocks
 *     are mined.
 *  1. The author acknowledges the genesis notice (P9.27) and creates an
 *     Original with an `anchor` member; it is anchored, its token minted
 *     (P14.19) and the anchoring publication sent. Recorded but not final, it
 *     is `pending-evm-finality`; final, the Original verifies as anchored on the
 *     devnet, attested by its operator, and current (P9.22, P9.23).
 *  2. An edit is published on the token and verifies as current (P9.20).
 *  3. A move entry to a sat the Bitcoin wallet holds (P9.28): the P9.29
 *     notice says the destination layer is Bitcoin and the move cannot be
 *     reversed. Before the departure is published, the Bitcoin writer refuses
 *     the arrival (EVM_DEPARTURE_NOT_FINAL).
 *  4. The departure is published on the token. Recorded above the finalized
 *     block it is pending, and the Bitcoin writer still refuses the arrival
 *     (EVM_DEPARTURE_NOT_FINAL, P9.29). Final, the token writer refers the
 *     arrival to the Bitcoin writer (EVM_ARRIVAL_ON_BITCOIN). Read from the
 *     token alone the arrival is unknown (the sat is unread); with the sat
 *     read, the Original is departed, not arrived.
 *  5. The arrival: the Bitcoin writer inscribes the whole log through the move
 *     entry on the sat (P9.17, P9.29); ord returns exactly those entries as
 *     metadata and the current version as the body. Unmined, it is pending
 *     Bitcoin acceptance (P9.4); mined, the Original reads anchored on Bitcoin
 *     and `moved-to-bitcoin` on the EVM side, owned (provisionally) by the
 *     sat's holder, with no EVM owner (P9.23, P9.29).
 *  6. Bitcoin is terminal (P9.10, P9.16): the token writer refuses further
 *     publications, referring them to the Bitcoin writer
 *     (EVM_ARRIVAL_ON_BITCOIN), and another move is refused
 *     (MOVE_NOT_FROM_EVM). A later edit is reinscribed on the same sat, one
 *     entry, by spending the output that holds it (P9.12, P9.13).
 *  7. A fresh reader with no copy of the log, given the sat read, the token
 *     read at its finalized block and the author's DID history: anchored on
 *     Bitcoin, the EVM stretch shows the anchoring entry, the edit and the
 *     departure in order, the entries before the anchoring entry are carried
 *     with claimed ordering, and ownership is the sat holder's output. Without
 *     the token read the log the sat carries still verifies, but the move is
 *     unconfirmed, the stretch's ordering claimed, with no owner and not
 *     current (P9.29, C12-273). This run found that a reader of the sat alone
 *     reported such an arrival anchored, owned and current; fixed in vh.
 *
 * Gated on local tooling: skips (exit 0) unless `anvil` is found on the PATH
 * or in ~/.foundry/bin and the contract is built or `forge` can build it.
 * Writes a JSON evidence summary to stdout (and to
 * $ORIGINALS_REGTEST_EVM_EVIDENCE when set).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { localSigner } from '@originals/vh/crypto';
import { createLog, serializeLog, signWith } from '@originals/vh/log';
import { EVM_CHAINS, decodeCbor, derivedTokenAlias, verifyOriginal, type AuthorDidEvidence, type EvmAnchorPin, type ListedChain } from '@originals/vh/originals';
import { RegtestProvider } from '../../packages/sdk/src/adapters/providers/RegtestProvider';
import type { InscriptionRecoveryRecord, InscriptionRecoveryStore } from '../../packages/sdk/src/bitcoin/inscription-recovery';
import type { BitcoinSigner } from '../../packages/sdk/src/types/common';
import type { Utxo } from '../../packages/sdk/src/types/bitcoin';
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias, keySigner, satEvidence } from '../../packages/sdk/src/originals/index';
import { prepareEntryInscription, readAnchored, submitEntryInscription } from '../../packages/sdk/src/originals/bitcoin-writer';
import { keccakHex } from '../../packages/sdk/src/originals/evm-abi';
import { EvmRpc, evmGenesisNotice, readEvmToken, waitForEvmReceipt, type EvmFetch, type EvmWallet } from '../../packages/sdk/src/originals/evm';
import { startRegtest } from './environment';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONTRACTS = join(ROOT, 'contracts');
const ARTIFACT = join(CONTRACTS, 'out/OriginalsAnchor.sol/OriginalsAnchor.json');
/** The deterministic deployment proxy anvil predeploys (P14.21). */
const PROXY = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
/** contracts/README.md (build at PR 59 a3ffdc1). */
const ADDRESS = '0x48f382c1d6c079bde4971c89e316841d2c9e79c2';
/** Anvil's unlocked dev accounts (its public, well-known test mnemonic): no key is handled here. */
const DEPLOYER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const MINTER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const CHAIN = 'eip155:31337';
/** The one Bitcoin index every read uses, reported as used (P9.11). */
const ORD = 'ord-0.29.0-regtest';

const step = (label: string) => console.error(`[originals-evm-move] ${label}`);
const tool = (name: string): string | null => {
  const local = join(homedir(), '.foundry/bin', name);
  return existsSync(local) ? local : Bun.which(name);
};
const ANVIL = tool('anvil');
const FORGE = tool('forge');
if (!ANVIL || (!existsSync(ARTIFACT) && !FORGE)) {
  console.error('[originals-evm-move] skipped: anvil (and a built contract or forge) not found; install Foundry to run this journey');
  process.exit(0);
}
if (!existsSync(ARTIFACT)) {
  const build = Bun.spawnSync([FORGE!, 'build'], { cwd: CONTRACTS, stdout: 'pipe', stderr: 'pipe' });
  if (build.exitCode !== 0) throw new Error(`forge build failed: ${build.stderr.toString()}`);
}

const fetch = globalThis.fetch.bind(globalThis) as unknown as EvmFetch;
const evidence: Record<string, unknown> = {};
const random32 = () => crypto.getRandomValues(new Uint8Array(32));
/** The refusal code of a rejected call, or 'resolved'. */
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (error: unknown) => (error as { code?: string }).code ?? String(error));

step('starting anvil, Bitcoin Core and ord');
const port = 20_000 + Math.floor(Math.random() * 30_000);
const anvil = Bun.spawn([ANVIL, '--port', String(port), '--chain-id', '31337', '--slots-in-an-epoch', '1', '--silent'], { stdout: 'ignore', stderr: 'ignore' });
const url = `http://127.0.0.1:${port}`;
const rpc = new EvmRpc(url, { fetch });
let env: Awaited<ReturnType<typeof startRegtest>> | undefined;
try {
  for (let i = 0; ; i++) {
    try {
      await rpc.chainId();
      break;
    } catch (error) {
      if (i > 100) throw error;
      await Bun.sleep(100);
    }
  }
  env = await startRegtest({ indexAddresses: true, ...(process.env.ORIGINALS_REGTEST_LOGS ? { logsDir: process.env.ORIGINALS_REGTEST_LOGS } : {}) });
  const anvilVersion = Bun.spawnSync([ANVIL, '--version'], { stdout: 'pipe' }).stdout.toString().trim();
  evidence.revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT, stdout: 'pipe' }).stdout.toString().trim();
  evidence.versions = { ...env.versions, anvil: anvilVersion };
  const provider = new RegtestProvider(env);
  /** Mine anvil blocks so everything recorded so far is at or below the finalized block. */
  const finalizeEvm = async () => void (await rpc.request('anvil_mine', ['0x3']));

  step('0: deploy the anchor contract on anvil');
  const init = (JSON.parse(readFileSync(ARTIFACT, 'utf8')) as { bytecode: { object: string } }).bytecode.object;
  const deployTx = await rpc.request<string>('eth_sendTransaction', [{ from: DEPLOYER, to: PROXY, data: `0x${'00'.repeat(32)}${init.slice(2)}` }]);
  await waitForEvmReceipt(rpc, deployTx, { pollMs: 50 });
  // P9.21: the pinned code is read at the finalized block, so the deployment must be final first.
  await finalizeEvm();
  const code = await rpc.code(ADDRESS, 'latest');
  assert.notEqual(code, '0x', `no code at ${ADDRESS}: the artifact does not match contracts/README.md`);
  const devnet: ListedChain = { name: 'Anvil devnet', chain: CHAIN, chainId: 31337n, genesisHash: (await rpc.block(0))!.hash, classes: [{ from: 0, class: 'operator' }] };
  const pin: EvmAnchorPin = { address: ADDRESS, codeHash: keccakHex(code), chains: [...EVM_CHAINS, devnet] };
  evidence.contract = { address: ADDRESS, codeHash: pin.codeHash, deployTx, chain: CHAIN, genesisHash: devnet.genesisHash, class: 'operator' };
  const minter: EvmWallet = { address: MINTER, sendTransaction: (tx) => rpc.request<string>('eth_sendTransaction', [{ from: tx.from, to: tx.to, data: tx.data }]) };

  // The Bitcoin wallet: one key, P2WPKH, signing the commit locally.
  const walletKey = secp256k1.utils.randomSecretKey();
  const wallet = btc.p2wpkh(secp256k1.getPublicKey(walletKey, true), { ...btc.TEST_NETWORK, bech32: 'bcrt' });
  const satSigner: BitcoinSigner = {
    signAndFinalizeCommitPsbt(psbtBase64) {
      const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
      tx.sign(walletKey);
      tx.finalize();
      return Promise.resolve(tx.hex);
    },
  };
  const outputOf = async (txid: string, vout?: number): Promise<Utxo & { address?: string }> => {
    const tx = await env!.rpc<{ vout: Array<{ n: number; value: number; scriptPubKey: { address?: string; hex: string } }> }>('getrawtransaction', [txid, true]);
    const output = vout === undefined ? tx.vout.find((o) => o.scriptPubKey.address === wallet.address) : tx.vout[vout];
    assert.ok(output, `no wallet output in ${txid}`);
    return { txid, vout: output.n, value: Math.round(output.value * 100_000_000), scriptPubKey: output.scriptPubKey.hex, ...(output.scriptPubKey.address ? { address: output.scriptPubKey.address } : {}) };
  };
  const fundUtxo = async (amount = 0.01) => outputOf(await env!.fund(wallet.address!, amount));
  const records = new Map<string, InscriptionRecoveryRecord>();
  const recoveryStore: InscriptionRecoveryStore = {
    save: (r) => Promise.resolve(void records.set(r.recoveryId, structuredClone(r))),
    load: (id) => Promise.resolve(structuredClone(records.get(id))),
    list: () => Promise.resolve([...records.keys()]),
  };
  const clock = new InscriptionClock(async (height) => {
    const hash = await env!.rpc<string>('getblockhash', [height]);
    const header = await env!.rpc<{ time: number; previousblockhash?: string }>('getblockheader', [hash]);
    return { time: header.time, hash, ...(header.previousblockhash ? { prev: header.previousblockhash } : {}) };
  });

  // The author: a did:vh with one Originals key, separate from its update key (P5.11).
  const update = random32();
  const signingKey = random32();
  const updateKey = localSigner('Ed25519', update).publicKeyMultibase;
  const didGenesis = await createLog({
    versionTime: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [updateKey] },
    state: {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:vh:{SCID}',
      verificationMethod: [{ id: 'did:vh:{SCID}#orig', type: 'Multikey', controller: 'did:vh:{SCID}', publicKeyMultibase: localSigner('Ed25519', signingKey).publicKeyMultibase }],
      assertionMethod: ['did:vh:{SCID}#orig'],
    },
    sign: signWith(localSigner('Ed25519', update), { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${updateKey}#${updateKey}` }),
  });
  const authorDid = didGenesis.state.id as string;
  const author = { did: authorDid, verificationMethod: `${authorDid}#orig`, versionId: didGenesis.versionId };
  const authorEvidence: AuthorDidEvidence = { did: authorDid, log: serializeLog([didGenesis]) };
  const signer = keySigner({ keyType: 'Ed25519', secretKey: signingKey, verificationMethod: author.verificationMethod });

  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: [authorEvidence], evm: { pin, providers: { [CHAIN]: [url] }, fetch, pollMs: 50 } });
  const recorded = () => ({ recoveryStore, recoveryIds: [...records.keys()] });
  const storedLines = async (of: string) => (await sdk.committedLog(of)).trimEnd().split('\n');
  const carried = (metadata: Uint8Array | null | undefined) =>
    metadata ? (decodeCbor(metadata) as unknown[]).map((e) => `${JSON.stringify(e)}\n`).join('') : null;

  step('1: create on the EVM devnet, anchor, mint, publish');
  const photo = Uint8Array.from({ length: 4_000 }, (_, i) => (i * 31 + 7) % 256);
  const anchor = { chain: CHAIN, minter: MINTER };
  const genesisNotice = evmGenesisNotice(anchor, pin);
  assert.equal(genesisNotice.chain.trustClass, 'operator');
  const created = await sdk.create({ name: 'Harbor at dusk', resource: { mediaType: 'image/png', bytes: photo }, author, signer, anchor, acknowledged: genesisNotice });
  if (created.kind !== 'original') throw new Error('expected an Original');
  const did = created.original.did;
  const alias = derivedTokenAlias(did, anchor, pin);
  const anchoring = await sdk.anchor(did, { parent: created.original.checkpoint, author, signer });
  assert.deepEqual(anchoring.original.state.aliases, [alias]);
  const minted = await sdk.mintEvm(did, { wallet: minter });
  assert.equal(minted.owner, MINTER);
  const p0 = await sdk.prepareEvmPublication(did, { wallet: minter });
  assert.equal(p0.kind, 'anchoring');
  assert.deepEqual(p0.carries, [created.original.checkpoint, anchoring.original.checkpoint]);
  const s0 = await sdk.submitEvmPublication(did, p0, { wallet: minter, acknowledged: p0.notice });
  assert.equal(s0.status, 'pending-evm-finality', 'recorded above the finalized block, the anchoring publication is pending (P9.22, P9.27)');
  assert.equal((await sdk.evmPublicationStatus(did, s0)).status, 'pending-evm-finality');
  await finalizeEvm();
  const st0 = await sdk.evmPublicationStatus(did, s0);
  assert.equal(st0.status, 'finalized');
  assert.equal(st0.original?.report.evm?.status, 'anchored');
  assert.equal(st0.original?.report.ordering, 'evm-attested-by-operator');
  assert.equal(st0.original?.report.evm?.owner?.address, MINTER);
  assert.equal(st0.original?.current, true, JSON.stringify(st0.original?.report.reasons));
  evidence.evmAnchor = { did, token: alias, mintTx: minted.txHash, publication: { kind: p0.kind, carries: p0.carries, txHashes: s0.txHashes, index: s0.index }, status: [s0.status, st0.status], ordering: st0.original?.report.ordering, owner: MINTER };

  step('2: edit on the token');
  const edit = await sdk.edit(did, { parent: anchoring.original.checkpoint, name: 'Harbor at night', author, signer });
  assert.equal(edit.original.current, false, 'an edit is the local log until published (P9.12)');
  const p1 = await sdk.prepareEvmPublication(did, { wallet: minter });
  assert.equal(p1.kind, 'entry');
  const s1 = await sdk.submitEvmPublication(did, p1, { wallet: minter, acknowledged: p1.notice });
  await finalizeEvm();
  const onToken = await sdk.get(did);
  assert.equal(onToken.head, edit.original.checkpoint);
  assert.equal(onToken.current, true, JSON.stringify(onToken.report.reasons));
  evidence.evmEdit = { versionId: edit.original.checkpoint, txHashes: s1.txHashes, index: s1.index };

  step('3: move entry to a Bitcoin sat');
  const satUtxo = await fundUtxo(0.001);
  const sat = await provider.getFirstSatOfOutput!(satUtxo);
  const satDid = btcoAlias('regtest', sat);
  const prepared = await sdk.prepareMove(did, { parent: edit.original.checkpoint, author, to: { sat: satDid } });
  assert.deepEqual(prepared.notice.to, { layer: 'bitcoin', name: 'Bitcoin' });
  assert.equal(prepared.notice.from.trustClass, 'operator');
  assert.deepEqual(prepared.notice.layersAbove, [], 'Bitcoin is the top layer (P9.29)');
  assert.equal(prepared.notice.irreversible, true);
  const moved = await sdk.move(did, { prepared, signer, acknowledged: prepared.notice });
  assert.equal(moved.original.state.anchor, undefined, 'the move entry removes the anchor member (P9.28)');
  assert.deepEqual(moved.original.state.aliases, [satDid]);
  const inscribeArrival = async () => prepareEntryInscription({ sdk, did, fundingUtxos: [satUtxo, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  const unpublished = await codeOf(inscribeArrival());
  assert.equal(unpublished, 'EVM_DEPARTURE_NOT_FINAL', 'no arrival before the departure is published (P9.29)');

  step('4: departure on the token');
  const p2 = await sdk.prepareEvmPublication(did, { wallet: minter });
  assert.equal(p2.kind, 'departure');
  assert.deepEqual(p2.carries, [moved.original.checkpoint]);
  const s2 = await sdk.submitEvmPublication(did, p2, { wallet: minter, acknowledged: p2.notice });
  assert.equal(s2.status, 'pending-evm-finality');
  const notFinal = await codeOf(inscribeArrival());
  assert.equal(notFinal, 'EVM_DEPARTURE_NOT_FINAL', 'the departure recorded above the finalized block is not final: no arrival yet (P9.22, P9.29)');
  const pendingAgain = await codeOf(sdk.prepareEvmPublication(did, { wallet: minter }));
  assert.equal(pendingAgain, 'EVM_PUBLICATION_PENDING');
  await finalizeEvm();
  const st2 = await sdk.evmPublicationStatus(did, s2);
  assert.equal(st2.status, 'finalized');
  // Read from the token alone, the destination sat is unread: the arrival is unknown, neither claimed nor denied (P9.29).
  assert.equal(st2.original?.report.evm?.status, 'unverified');
  assert.equal(st2.original?.report.evm?.arrival, 'unknown');
  assert.equal(st2.original?.report.evm?.destination, satDid);
  assert.equal(st2.original?.report.evm?.owner, null);
  assert.equal(st2.original?.current, false);
  // With the sat read, which holds no arrival yet: departed, not arrived.
  const between = await readAnchored(sdk, did, { provider, clock, index: ORD, ...recorded() });
  assert.equal(between.report.evm?.status, 'departed-not-arrived');
  assert.equal(between.report.evm?.arrival, 'not-arrived');
  assert.equal(between.report.evm?.destination, satDid);
  assert.equal(between.publication, 'not-anchored');
  assert.equal(between.current, false);
  const referred = await codeOf(sdk.prepareEvmPublication(did, { wallet: minter }));
  assert.equal(referred, 'EVM_ARRIVAL_ON_BITCOIN', 'the arrival is the Bitcoin writer\'s, not a token publication (P9.29)');
  evidence.departure = { versionId: moved.original.checkpoint, sat: satDid, txHashes: s2.txHashes, index: s2.index, status: [s2.status, st2.status], fromTokenAlone: { evm: st2.original?.report.evm?.status, arrival: st2.original?.report.evm?.arrival }, withSatRead: { evm: between.report.evm?.status, arrival: between.report.evm?.arrival, publication: between.publication }, refusedBeforePublished: unpublished, refusedBeforeFinal: notFinal, tokenWriter: referred };

  step('5: arrival on Bitcoin');
  const arrival = await inscribeArrival();
  assert.equal(arrival.versionId, moved.original.checkpoint);
  const all = [created.original.checkpoint, anchoring.original.checkpoint, edit.original.checkpoint, moved.original.checkpoint];
  assert.deepEqual(arrival.carries, all, 'the arrival carries the whole log through the move entry (P9.29, P9.17)');
  assert.equal(arrival.notice.permanent, true);
  const sent = await submitEntryInscription({ sdk, did, pair: arrival, provider, clock, index: ORD, recoveryStore });
  assert.equal(sent.broadcast, 'reveal_broadcast');
  const unmined = await readAnchored(sdk, did, { provider, clock, index: ORD, ...recorded() });
  assert.notEqual(unmined.report.anchoring?.status, 'anchored', 'a broadcast, unmined inscription must not count (P9.4)');
  assert.equal(unmined.publication, 'pending-bitcoin-acceptance');
  assert.equal(unmined.current, false);
  await env.mine();
  const arrived = await readAnchored(sdk, did, { provider, clock, index: ORD, ...recorded() });
  assert.equal(arrived.publication, 'anchored');
  assert.equal(arrived.report.anchoring?.status, 'anchored');
  assert.equal(arrived.report.evm?.status, 'moved-to-bitcoin');
  assert.equal(arrived.report.evm?.move, 'confirmed');
  assert.equal(arrived.report.evm?.arrival, 'arrived');
  assert.equal(arrived.report.evm?.owner, null, 'no EVM owner once on Bitcoin (P9.23)');
  assert.equal(arrived.report.ownership?.output, `${arrival.prepared.revealTxId}:0`);
  assert.equal(arrived.head, moved.original.checkpoint);
  // P9.29: the move entry keeps the ordering of the stretch that accepted it.
  assert.equal(arrived.report.ordering, 'evm-attested-by-operator');
  assert.equal(arrived.current, true, JSON.stringify(arrived.report.reasons));
  const snapshot = await provider.getSatSnapshot!(sat, { bodies: 'originals' });
  const onOrd = snapshot.publications.find((p) => p.id === arrival.prepared.inscriptionId);
  assert.ok(onOrd?.body.status === 'complete');
  const lines = await storedLines(did);
  assert.equal(carried(onOrd.body.metadata), `${lines.slice(0, 4).join('\n')}\n`, 'ord returns the stored entries, genesis through the move entry (P14.12)');
  assert.deepEqual(onOrd.body.bytes, photo, 'the body is the current resource version (P9.17)');
  assert.equal(onOrd.body.mediaType, 'image/png');
  evidence.arrival = {
    sat: satDid, commitTxId: arrival.prepared.commitTxId, revealTxId: arrival.prepared.revealTxId, inscription: arrival.prepared.inscriptionId,
    carries: arrival.carries, metadataBytes: onOrd.body.metadata?.length ?? 0, bodyBytes: onOrd.body.bytes.length,
    publication: [unmined.publication, arrived.publication], height: arrived.report.anchoring?.anchor?.height,
    evm: { status: arrived.report.evm?.status, move: arrived.report.evm?.move, arrival: arrived.report.evm?.arrival }, ordering: arrived.report.ordering, ownership: arrived.report.ownership,
  };

  step('6: Bitcoin is terminal; an edit is reinscribed on the sat');
  // The token writer does not read the sat; it refers every publication after a final departure to Bitcoin to the
  // Bitcoin writer, and publishes nothing on a token (P9.28, P9.29).
  assert.equal(await codeOf(sdk.prepareEvmPublication(did, { wallet: minter })), 'EVM_ARRIVAL_ON_BITCOIN');
  const later = await sdk.edit(did, { parent: moved.original.checkpoint, name: 'Harbor at night, on Bitcoin', author, signer });
  assert.equal(await codeOf(sdk.prepareMove(did, { parent: later.original.checkpoint, author, to: { chain: CHAIN, minter: MINTER } })), 'MOVE_NOT_FROM_EVM', 'anchored on Bitcoin, it does not move (P9.10, P9.28)');
  const holding = await outputOf(arrival.prepared.revealTxId, 0);
  const editPair = await prepareEntryInscription({ sdk, did, fundingUtxos: [holding, await fundUtxo()], satSigner, changeAddress: wallet.address!, feeRate: 2, network: 'regtest', provider, clock, index: ORD, recoveryStore });
  assert.deepEqual(editPair.carries, [later.original.checkpoint], 'after the arrival, one entry per inscription (P9.17)');
  assert.equal((await submitEntryInscription({ sdk, did, pair: editPair, provider, clock, index: ORD, recoveryStore })).broadcast, 'reveal_broadcast');
  await env.mine();
  const v5 = await readAnchored(sdk, did, { provider, clock, index: ORD });
  assert.equal(v5.head, later.original.checkpoint);
  assert.equal(v5.report.anchoring?.accepted.length, 1);
  assert.equal(v5.report.evm?.status, 'moved-to-bitcoin');
  assert.equal(v5.report.ownership?.output, `${editPair.prepared.revealTxId}:0`);
  assert.equal(v5.current, true, JSON.stringify(v5.report.reasons));
  evidence.bitcoinEdit = { versionId: later.original.checkpoint, inscription: editPair.prepared.inscriptionId, revealTxId: editPair.prepared.revealTxId, ownership: v5.report.ownership };

  step('7: fresh reader');
  const satRead = await provider.getSatSnapshot!(sat, { bodies: 'originals' });
  const satpoint = satRead.ownership.satpoint!;
  const holder = await outputOf(satpoint.split(':')[0], Number(satpoint.split(':')[1]));
  assert.equal(holder.address, wallet.address, 'the sat is held by the writer\'s wallet');
  const satEv = await satEvidence(satRead, { clock, ownerConfirmations: (await provider.getTransactionStatus(satpoint.split(':')[0])).confirmations ?? 0, index: ORD });
  const token = await readEvmToken({ alias }, { pin, providers: [{ url, name: 'anvil' }], fetch });
  assert.deepEqual(token.failures, []);
  const fresh = await verifyOriginal({ bitcoin: [satEv], evm: { pin, tokens: [token.evidence] }, authors: [authorEvidence], now: Date.now() });
  assert.equal(fresh.history.status, 'valid', JSON.stringify(fresh.history.failure));
  assert.equal(fresh.history.entries, 5);
  assert.equal(fresh.head, later.original.checkpoint);
  assert.equal(fresh.anchoring?.status, 'anchored');
  assert.equal(fresh.anchoring?.sat, satDid);
  assert.equal(fresh.anchoring?.copy, 'absent');
  assert.equal(fresh.evm?.status, 'moved-to-bitcoin');
  assert.equal(fresh.evm?.move, 'confirmed');
  assert.equal(fresh.evm?.owner, null);
  const [stretch] = fresh.evm!.stretches;
  assert.equal(fresh.evm!.stretches.length, 1);
  assert.equal(stretch.chain, CHAIN);
  assert.equal(stretch.class, 'operator');
  assert.deepEqual(stretch.entries, [anchoring.original.checkpoint, edit.original.checkpoint, moved.original.checkpoint], 'the token accepted the anchoring entry, the edit and the move entry, in order');
  assert.equal(stretch.departure?.versionId, moved.original.checkpoint);
  assert.equal(stretch.departure?.destination, satDid);
  assert.deepEqual(fresh.evm!.carried, { entries: [created.original.checkpoint], ordering: 'claimed' });
  assert.equal(fresh.ownership?.output, `${editPair.prepared.revealTxId}:0`, 'the owner is the holder of the sat (P9.23)');
  assert.equal(fresh.ownership?.status, 'provisional');
  assert.equal(fresh.identityEvidence.status, 'complete');
  assert.equal(fresh.current, true, JSON.stringify(fresh.reasons));
  // Without the token read, the EVM history cannot be checked: never anchored and current.
  const noToken = await verifyOriginal({ bitcoin: [satEv], evm: { pin, tokens: [] }, authors: [authorEvidence], now: Date.now() });
  // P9.29 (C12-273): the chain left was not read, so the move is unconfirmed, the entries accepted there have
  // claimed ordering, and there is no owner and no current result, though the log the arrival carries verifies.
  assert.equal(noToken.history.status, 'valid');
  assert.equal(noToken.history.entries, 5);
  assert.equal(noToken.anchoring?.status, 'anchored');
  assert.equal(noToken.anchoring?.copy, 'absent');
  assert.equal(noToken.evm?.move, 'unconfirmed');
  assert.equal(noToken.evm?.stretches[0]?.ordering, 'claimed');
  assert.deepEqual(noToken.evm?.stretches[0]?.entries, [anchoring.original.checkpoint, edit.original.checkpoint, moved.original.checkpoint]);
  assert.equal(noToken.evm?.owner, null);
  assert.equal(noToken.ownership, null, 'no owner while the move is unconfirmed (P9.29)');
  assert.ok(noToken.reasons.includes('move-unconfirmed'));
  assert.equal(noToken.current, false, 'without the departed token\'s read, the move is not established (P7.14, P9.29)');
  evidence.freshReader = {
    head: fresh.head, history: { status: fresh.history.status, entries: fresh.history.entries }, anchoring: fresh.anchoring?.status, copy: fresh.anchoring?.copy,
    evm: { status: fresh.evm?.status, move: fresh.evm?.move, chain: stretch.chain, class: stretch.class, entries: stretch.entries, departure: stretch.departure, carried: fresh.evm?.carried, block: stretch.block },
    ordering: fresh.ordering, ownership: fresh.ownership, holderAddress: holder.address, identity: fresh.identityEvidence.status, current: fresh.current,
    withoutToken: { anchoring: noToken.anchoring?.status ?? null, evm: noToken.evm?.status ?? null, move: noToken.evm?.move ?? null, stretchOrdering: noToken.evm?.stretches[0]?.ordering ?? null, ownership: noToken.ownership, current: noToken.current, reasons: noToken.reasons },
  };

  evidence.result = 'passed';
  const summary = JSON.stringify(evidence, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
  console.log(summary);
  if (process.env.ORIGINALS_REGTEST_EVM_EVIDENCE) await writeFile(process.env.ORIGINALS_REGTEST_EVM_EVIDENCE, summary);
} finally {
  anvil.kill();
  await env?.stop();
}
