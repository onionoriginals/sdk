/**
 * One process of the restart journey (scripts/regtest/originals-restart.ts,
 * #975), regtest only. Every run starts with no in-memory state: it opens the
 * durable stores named in its environment, does one thing, prints one JSON
 * line on stdout and exits.
 *
 *   submit  prepare the next entry's pair and submit it, then stop for good
 *           after the commit is broadcast and the record persisted, before the
 *           reveal is sent; prints {"event":"halted-before-reveal",...} and
 *           waits to be killed (SIGKILL by the parent)
 *   step    one `catchUp` step, read only (no broadcast)
 *   resume  `catchUp`, which must say resume, then `resumeEntryInscription`
 *           (which re-verifies the log through the entry first, P9.18)
 *   read    a fresh reader: a new empty store, no author list, only the
 *           author's evidence package and the sat read from ord and Core
 *
 * Environment: ORIGINALS_CHILD_{RPC_URL,ORD_URL,RPC_AUTH} (the local regtest
 * node and index), ORIGINALS_CHILD_STORE (FileStore root),
 * ORIGINALS_CHILD_RECOVERY (fileRecoveryStore directory), ORIGINALS_CHILD_DID,
 * ORIGINALS_CHILD_WALLET_KEY (the disposable regtest key holding the sat, hex),
 * ORIGINALS_CHILD_FEE_UTXO (JSON, submit), ORIGINALS_CHILD_SAT and
 * ORIGINALS_CHILD_PACKAGE (read).
 *
 * The signer is a disposable local key, not Turnkey.
 */
import { readFile } from 'node:fs/promises';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { RegtestProvider } from '../../packages/sdk/src/adapters/providers/RegtestProvider';
import type { BitcoinSigner } from '../../packages/sdk/src/types/common';
import type { Utxo } from '../../packages/sdk/src/types/bitcoin';
import { parseBtcoAlias, verifyOriginal } from '@originals/vh/originals';
import { InscriptionClock, OriginalsSDK, readEvidence, satEvidence } from '../../packages/sdk/src/originals/index';
import { FileStore, fileRecoveryStore } from '../../packages/sdk/src/originals/fs-store';
import { catchUp, prepareEntryInscription, resumeEntryInscription, submitPreparedInscriptionOnSat, type CatchUpStep } from '../../packages/sdk/src/originals/bitcoin-writer';

/** The one index every read uses, reported as used (P9.11). */
export const ORD_INDEX = 'ord-0.29.0-regtest';

export interface ChildEndpoints { rpcUrl: string; ordUrl: string; rpcAuth: string }

/** The disposable regtest wallet: one key, P2WPKH, signing commits locally. */
export function localWallet(secretKeyHex: string): { address: string; satSigner: BitcoinSigner } {
  const key = hex.decode(secretKeyHex);
  const address = btc.p2wpkh(secp256k1.getPublicKey(key, true), { ...btc.TEST_NETWORK, bech32: 'bcrt' }).address!;
  const satSigner: BitcoinSigner = {
    signAndFinalizeCommitPsbt(psbtBase64) {
      const tx = btc.Transaction.fromPSBT(Buffer.from(psbtBase64, 'base64'), { allowUnknownOutputs: true });
      tx.sign(key);
      tx.finalize();
      return Promise.resolve(tx.hex);
    },
  };
  return { address, satSigner };
}

export function rpcClient({ rpcUrl, rpcAuth }: ChildEndpoints) {
  return async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(rpcUrl, {
      method: 'POST', headers: { authorization: `Basic ${btoa(rpcAuth)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'originals-restart', method, params }), signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json() as { result: T; error: { message: string } | null };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

export function headerClock(rpc: ReturnType<typeof rpcClient>): InscriptionClock {
  return new InscriptionClock(async (height) => {
    const hash = await rpc<string>('getblockhash', [height]);
    // prev (Core's previousblockhash) lets the clock check each block extends the one before it.
    const header = await rpc<{ time: number; previousblockhash?: string }>('getblockheader', [hash]);
    return { time: header.time, hash, ...(header.previousblockhash ? { prev: header.previousblockhash } : {}) };
  });
}

const summary = (step: CatchUpStep) => ({
  action: step.action,
  ...('versionId' in step ? { versionId: step.versionId } : {}),
  ...('recoveryId' in step ? { recoveryId: step.recoveryId } : {}),
  ...('broadcast' in step ? { broadcast: step.broadcast } : {}),
  ...('reason' in step ? { reason: step.reason } : {}),
  ...(step.action === 'refused' ? { commit: step.commit, ifRevealed: step.ifRevealed, error: step.error.code } : {}),
  committed: step.pending.committed, accepted: step.pending.accepted, acceptedHeight: step.pending.acceptedHeight, publication: step.pending.publication,
  queue: step.pending.queue, current: step.pending.view.current, recoveryIssues: step.pending.recoveryIssues,
});

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(mode: string): Promise<Record<string, unknown>> {
  const endpoints = { rpcUrl: need('ORIGINALS_CHILD_RPC_URL'), ordUrl: need('ORIGINALS_CHILD_ORD_URL'), rpcAuth: need('ORIGINALS_CHILD_RPC_AUTH') };
  const provider = new RegtestProvider(endpoints);
  const rpc = rpcClient(endpoints);
  const clock = headerClock(rpc);

  if (mode === 'read') {
    // No store of the writer's, no author list: only the package and Bitcoin.
    const sdk = OriginalsSDK.create({ store: await FileStore.open(need('ORIGINALS_CHILD_READER_STORE')), authors: [] });
    const zip = new Uint8Array(await readFile(need('ORIGINALS_CHILD_PACKAGE')));
    const sat = parseBtcoAlias(need('ORIGINALS_CHILD_SAT'));
    const snapshot = await provider.getSatSnapshot!(sat.sat);
    const satpoint = snapshot.ownership.satpoint;
    const ownerConfirmations = satpoint ? (await provider.getTransactionStatus(satpoint.split(':')[0])).confirmations ?? 0 : 0;
    const evidence = await satEvidence(snapshot, { clock, ownerConfirmations, index: ORD_INDEX });
    const loaded = await sdk.load(zip, { bitcoin: [evidence] });
    const contents = readEvidence(zip);
    const r = loaded.report;
    const ids = contents.log.trimEnd().split('\n').map((l) => (JSON.parse(l) as { versionId: string }).versionId);
    // The same sat with no copy of the log: Bitcoin carries it whole (P9.17); only the off-chain
    // signer DID histories and the bytes come from the package (P9.18).
    const alone = await verifyOriginal({ bitcoin: [evidence], authors: contents.authors.map(({ retrievedFrom: _, ...a }) => a), now: Date.now() });
    return {
      mode, pid: process.pid, store: need('ORIGINALS_CHILD_READER_STORE'),
      provider: { kind: 'RegtestProvider', ord: endpoints.ordUrl, core: endpoints.rpcUrl, indexesConsulted: 1 },
      snapshot: { network: snapshot.network, sat: snapshot.sat, tip: snapshot.tipAfter, indexHealthy: snapshot.indexHealthy, enumerationComplete: snapshot.enumerationComplete, satpoint },
      evidenceIndex: evidence.index,
      manifest: loaded.manifest, packageVersionIds: ids,
      history: r.history, authorBinding: r.authorBinding, identityEvidence: { status: r.identityEvidence.status, author: r.identityEvidence.author, latestVersionId: r.identityEvidence.latestVersionId },
      ordering: r.ordering, head: r.head, checkpoint: r.checkpoint, current: r.current, reasons: loaded.reasons,
      anchoring: r.anchoring, ownership: r.ownership, state: { name: r.state?.name },
      fromBitcoinAlone: {
        copy: alone.anchoring?.copy, anchoring: alone.anchoring?.status, head: alone.head, entries: alone.history.entries, history: alone.history.status,
        authorBinding: alone.authorBinding.status, identity: alone.identityEvidence.status, resources: alone.resources.status,
        anchor: alone.anchoring?.anchor?.inscription, accepted: alone.anchoring?.accepted.map((a) => a.inscription),
      },
      resources: {
        status: r.resources.status, missing: r.resources.missing.length, failures: r.resources.failures.length,
        versions: r.resources.versions.map((v) => {
          const data = contents.bytes[v.digest];
          return { resource: v.resource, version: v.version, digest: v.digest, bytes: v.bytes, sha256: data ? hex.encode(sha256(data)) : null, length: data?.length ?? null };
        }),
      },
    };
  }

  const did = need('ORIGINALS_CHILD_DID');
  const storeRoot = need('ORIGINALS_CHILD_STORE');
  const recoveryDir = need('ORIGINALS_CHILD_RECOVERY');
  // The author's DID evidence is in the durable store; nothing is passed in memory.
  const sdk = OriginalsSDK.create({ store: await FileStore.open(storeRoot), authors: [], freshness: 'asserted' });
  const recoveryStore = fileRecoveryStore(recoveryDir);
  const base = { mode, pid: process.pid, store: storeRoot, recovery: recoveryDir, recordedBefore: await recoveryStore.list() };

  if (mode === 'step') {
    return { ...base, step: summary(await catchUp({ sdk, did, provider, clock, index: ORD_INDEX, recoveryStore })) };
  }

  if (mode === 'resume') {
    const plan = await catchUp({ sdk, did, provider, clock, index: ORD_INDEX, recoveryStore });
    if (plan.action !== 'resume') throw new Error(`expected catchUp to resume a recorded pair, got ${JSON.stringify(summary(plan))}`);
    const resumed = await resumeEntryInscription({ sdk, did, provider, clock, index: ORD_INDEX, recoveryStore, recoveryId: plan.recoveryId });
    const after = await catchUp({ sdk, did, provider, clock, index: ORD_INDEX, recoveryStore });
    return {
      ...base, plan: summary(plan),
      resumed: { recoveryId: resumed.recoveryId, commitTxId: resumed.commitTxId, revealTxId: resumed.revealTxId, inscriptionId: resumed.inscriptionId, broadcast: resumed.broadcast, error: resumed.error ?? null },
      after: summary(after), record: (await recoveryStore.load(plan.recoveryId))?.broadcast,
    };
  }

  if (mode === 'submit') {
    const { address, satSigner } = localWallet(need('ORIGINALS_CHILD_WALLET_KEY'));
    const plan = await catchUp({ sdk, did, provider, clock, index: ORD_INDEX, recoveryStore });
    if (plan.action !== 'prepare') throw new Error(`expected catchUp to prepare, got ${JSON.stringify(summary(plan))}`);
    const [txid, vout] = plan.pending.view.report.ownership!.output.split(':');
    const tx = await rpc<{ vout: Array<{ n: number; value: number; scriptPubKey: { hex: string } }> }>('getrawtransaction', [txid, true]);
    const out = tx.vout[Number(vout)];
    const holding: Utxo = { txid, vout: out.n, value: Math.round(out.value * 100_000_000), scriptPubKey: out.scriptPubKey.hex };
    const fee = JSON.parse(need('ORIGINALS_CHILD_FEE_UTXO')) as Utxo;
    const pair = await prepareEntryInscription({ sdk, did, fundingUtxos: [holding, fee], satSigner, changeAddress: address, feeRate: 2, network: 'regtest', provider, clock, index: ORD_INDEX, recoveryStore });
    // The kill point: the state machine asks to broadcast the reveal only after the
    // commit is out and `reveal_broadcast_unknown` is durably saved. Here the process
    // reports that, from a fresh read of the record file, and never sends the reveal.
    const halting = Object.create(provider) as RegtestProvider;
    halting.broadcastTransaction = async (raw: unknown) => {
      if (raw !== pair.prepared.revealTxHex) return provider.broadcastTransaction(raw as string);
      const persisted = await fileRecoveryStore(recoveryDir).load(pair.prepared.commitTxId);
      const inMempool = await rpc('getmempoolentry', [pair.prepared.commitTxId]).then(() => true, () => false);
      console.log(JSON.stringify({
        ...base, event: 'halted-before-reveal', plan: summary(plan), versionId: pair.versionId,
        recoveryId: pair.prepared.commitTxId, commitTxId: pair.prepared.commitTxId, revealTxId: pair.prepared.revealTxId, inscriptionId: pair.prepared.inscriptionId,
        persisted: persisted?.broadcast ?? null, commitInMempool: inMempool,
      }));
      setInterval(() => undefined, 1 << 30); // keep the process alive until it is killed
      return new Promise<string>(() => { /* never: the parent kills this process */ });
    };
    await submitPreparedInscriptionOnSat({ prepared: pair.prepared, provider: halting, recoveryStore });
    throw new Error('submit returned: the halt before the reveal was not reached');
  }
  throw new Error(`unknown mode ${mode}`);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await main(process.argv[2] ?? '')));
    process.exit(0);
  } catch (error) {
    console.error(`[originals-writer-child] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  }
}
