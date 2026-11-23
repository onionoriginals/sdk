/**
 * Reading an anchored Original back from Bitcoin (P9.18, P9.31): the
 * anchoring sat's inscriptions as an ord 0.29.x explorer reports them, each
 * envelope from its reveal transaction, its position in chain order and its
 * confirmations, and the holder, all at one tip. No copy of the log and no
 * resource bytes. The inscriptions carry no signer history (D22): a did:webvh
 * author's log is resolved from its URL and added with `withResolvedSigner`.
 */
import { envelopesInWitness, parseTransaction, type BitcoinNetwork, type EvidenceSet, type InscriptionRead } from "@originals/vh/og";
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
  // The index read as the sat-read evidence input P14.25 defines, with the envelopes as inscription inputs.
  const satRead = {
    network: input.network,
    sat: Number(input.sat),
    tip,
    complete: true,
    holder: holder === null ? null : { address: holder },
    inscriptions: reads.map((r) => ({ id: r.id, height: r.height, txIndex: r.txIndex, inscriptionIndex: r.inscriptionIndex, confirmations: tip.height - r.height + 1 })),
  };
  const evidence: EvidenceSet = {
    original: input.original,
    checkpoint: null,
    inputs: [
      { kind: "sat-read" as const, source: `ord:${ord.base}/sat/${input.sat}`, bytes: new TextEncoder().encode(JSON.stringify(satRead)) },
      ...reads.map((r) => ({ kind: "inscription" as const, source: `index:${r.id}`, bytes: r.envelope })),
    ],
    network: input.network,
    tip,
    depth: input.depth ?? 1,
  };
  return { evidence, ordVersion, inscriptions: reads };
}

/**
 * The evidence set with a did:vh / did:webvh signer's log, as resolved from its URL, supplied as a signer
 * history with its source and obtained time (D22; P7.8, P7.17). The verifier checks each inscribed entry
 * at the version it names in this log.
 */
export function withResolvedSigner(evidence: EvidenceSet, signer: { did: string; url: string; log: string; obtained: string }): EvidenceSet {
  const source = `resolved:${signer.url}`;
  return {
    ...evidence,
    inputs: [...evidence.inputs, { kind: "signer-history", source, did: signer.did, bytes: new TextEncoder().encode(signer.log) }],
    signerHistories: [...(evidence.signerHistories ?? []), { did: signer.did, source, obtained: signer.obtained }],
  };
}
