/**
 * Reading an anchored Original back from Bitcoin (P9.18, P9.31): the
 * anchoring sat's inscriptions as an ord 0.29.x explorer reports them, each
 * envelope from its reveal transaction, its position in chain order and its
 * confirmations, and the holder, all at one tip. Nothing else: no copy of the
 * log, no signer DID host and no resource bytes.
 */
import { btcoDid, envelopesInWitness, parseTransaction, type BitcoinNetwork, type EvidenceSet, type InscriptionRead } from "@originals/vh/og";
import type { ChainBackend, OrdExplorer } from "./chain.js";

export interface SatReadBack {
  evidence: EvidenceSet;
  ordVersion: string;
  inscriptions: Array<InscriptionRead & { metaprotocol: string | null; contentType: string | null }>;
}

/** Read the P9.18 evidence set for an Original anchored on `sat`. Throws if the tip moves during the read (P9.31). */
export async function readSatEvidence(input: { original: string; network: BitcoinNetwork; sat: bigint; ord: OrdExplorer; chain: ChainBackend; depth?: number }): Promise<SatReadBack> {
  const { ord, chain } = input;
  const ordVersion = await ord.version();
  const height = await ord.height();
  const ids = await input.ord.satInscriptions(input.sat);
  const reads: SatReadBack["inscriptions"] = [];
  let holder: string | null = null;
  const blockCache = new Map<number, string[]>();
  for (const id of ids) {
    const info = await ord.inscription(id);
    const [txid, n] = id.split("i");
    const tx = parseTransaction(await chain.txHex(txid));
    const envelopes = tx.inputs.flatMap((i) => envelopesInWitness(i.witness));
    const envelope = envelopes[Number(n)];
    if (!envelope) throw new Error(`no envelope ${n} in ${txid}`);
    if (!blockCache.has(info.height)) blockCache.set(info.height, await chain.blockTxids(info.height));
    const txIndex = blockCache.get(info.height)!.indexOf(txid);
    if (txIndex < 0) throw new Error(`${txid} is not in block ${info.height}`);
    reads.push({
      id, sat: String(info.sat ?? ""), height: info.height, txIndex, inscriptionIndex: Number(n), confirmations: height - info.height + 1,
      envelope, metaprotocol: info.metaprotocol ?? null, contentType: info.content_type ?? null,
    });
    const satpoint = info.satpoint.split(":").slice(0, 2).join(":");
    holder = (await ord.output(satpoint)).address ?? null;
  }
  if ((await ord.height()) !== height) throw new Error("the explorer's tip moved during the read; read again (P9.31)");
  const tip = { height, hash: await ord.blockhash(height) };
  const sat = btcoDid(input.network, input.sat);
  const evidence: EvidenceSet = {
    original: input.original,
    checkpoint: null,
    inputs: reads.map((r) => ({ kind: "inscription" as const, source: `index:${r.id}`, bytes: r.envelope })),
    network: input.network,
    tip,
    depth: input.depth ?? 1,
    sats: [{ sat, index: `ord ${ordVersion} at ${ord.base}`, complete: true, holder, inscriptions: reads }],
  };
  return { evidence, ordVersion, inscriptions: reads };
}
