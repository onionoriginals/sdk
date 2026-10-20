/**
 * Bitcoin evidence for anchored Originals (plan 012; plan 011 PR 9a).
 *
 * `InscriptionClock` computes inscription times (P9.15): the greatest block
 * timestamp of a block and all its ancestors, so it never decreases along the
 * chain even when a block's own timestamp does. It follows reorganisations by
 * block hash. `satEvidence` turns a sat
 * snapshot from the SDK's sat reader into the evidence `verifyOriginal`
 * takes. A publication whose body the reader could not establish fails the
 * whole read: a copy is no substitute for what Bitcoin includes (VH-Log PR 2).
 */
import { OriginalsError } from "@originals/vh";
import type { SatEvidence, SatInscription } from "@originals/vh/originals";
import type { BitcoinNetwork, SatSnapshot } from "../bitcoin/sat-snapshot-types.js";

/** The block at a height on the active chain: its header timestamp in seconds and its hash. */
export type BlockHeader = (height: number) => Promise<{ time: number; hash: string }>;

/**
 * Running maximum of block timestamps from genesis. The first call walks the
 * headers it has not seen; later calls reuse the cached maxima. PROVISIONAL:
 * a deployed adapter keeps this cache durable, since a mainnet walk reads
 * every header once.
 */
export class InscriptionClock {
  private readonly blocks: Array<{ hash: string; max: number }> = [];

  constructor(private readonly header: BlockHeader) {}

  /**
   * Inscription time at `height`, epoch milliseconds. Given the block's
   * `hash`, a cache built on a chain since reorganised is first rewound to the
   * fork point, and a block no longer on the active chain is refused.
   */
  async at(height: number, hash?: string): Promise<number> {
    if (!Number.isInteger(height) || height < 0) throw new OriginalsError("invalid-evidence", "BLOCK_HEIGHT_INVALID", `${height} is not a block height`);
    if (hash !== undefined && this.blocks[height] && this.blocks[height].hash !== hash) await this.rewind(height);
    for (let h = this.blocks.length; h <= height; h++) {
      const block = await this.read(h);
      this.blocks.push({ hash: block.hash, max: Math.max(block.time, this.blocks[h - 1]?.max ?? 0) });
    }
    if (hash !== undefined && this.blocks[height].hash !== hash) {
      throw new OriginalsError("invalid-evidence", "BLOCK_NOT_ON_CHAIN", `block ${hash} is not at height ${height} on the active chain`);
    }
    return this.blocks[height].max * 1000;
  }

  /** Drop cached blocks from the highest at or below `height` that the active chain no longer has. */
  private async rewind(height: number): Promise<void> {
    let h = Math.min(height, this.blocks.length - 1);
    while (h >= 0 && (await this.read(h)).hash !== this.blocks[h].hash) h--;
    this.blocks.length = h + 1;
  }

  private async read(height: number): Promise<{ time: number; hash: string }> {
    const block = await this.header(height);
    if (!Number.isInteger(block?.time) || block.time < 0 || typeof block.hash !== "string" || !block.hash) {
      throw new OriginalsError("unavailable-bytes", "BLOCK_TIME_UNAVAILABLE", `no header for block ${height}`);
    }
    return block;
  }
}

const PREFIX: Record<BitcoinNetwork, string> = { mainnet: "", signet: "sig:", testnet: "test:", regtest: "reg:" };

/** The did:btco alias of a sat on a network (plan 012 §3.5, PROVISIONAL prefixes). */
export function btcoAlias(network: BitcoinNetwork, sat: string): string {
  return `did:btco:${PREFIX[network]}${sat}`;
}

export interface SatEvidenceOptions {
  clock: InscriptionClock;
  /** Confirmations of the output now holding the sat; the adapter reports it (P9.11). */
  ownerConfirmations: number;
  /** How many independent indexes agreed on the sat's location. */
  indexes?: number;
}

/** The evidence `verifyOriginal` takes, from one sat snapshot. */
export async function satEvidence(snapshot: SatSnapshot, options: SatEvidenceOptions): Promise<SatEvidence> {
  if (!snapshot.enumerationComplete || !snapshot.indexHealthy) {
    throw new OriginalsError("unavailable-bytes", "SAT_READ_INCOMPLETE", `the sat ${snapshot.sat} was not read in full`);
  }
  const tip = snapshot.tipAfter;
  const inscriptions: SatInscription[] = [];
  for (const p of snapshot.publications) {
    if (p.body.status !== "complete" || !p.creation) {
      throw new OriginalsError("unavailable-bytes", "SAT_READ_INCOMPLETE", `inscription ${p.id} on sat ${snapshot.sat} could not be read`);
    }
    const confirmations = p.confirmed ? tip.height - p.creation.height + 1 : 0;
    inscriptions.push({
      id: p.id,
      height: p.creation.height,
      transactionIndex: p.creation.transactionIndex,
      inscriptionIndex: p.creation.inscriptionIndex,
      confirmations,
      inscriptionTime: await options.clock.at(p.creation.height, p.creation.blockHash),
      mediaType: p.body.mediaType,
      content: p.body.bytes,
    });
  }
  const satpoint = snapshot.ownership.satpoint;
  const output = satpoint ? satpoint.split(":").slice(0, 2).join(":") : null;
  return {
    sat: btcoAlias(snapshot.network, snapshot.sat),
    tip: { height: tip.height, hash: tip.hash },
    inscriptions,
    owner: output
      ? { output, ...(snapshot.ownership.owner ? { address: snapshot.ownership.owner } : {}), confirmations: options.ownerConfirmations }
      : null,
    indexes: options.indexes ?? 1,
  };
}
