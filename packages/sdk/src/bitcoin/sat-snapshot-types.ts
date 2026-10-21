/**
 * Provider-observed Bitcoin and Ordinals facts about one sat, and the
 * normalizers used to compare them across independently configured sources.
 * Generic chain evidence: nothing here interprets an asset log.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';

export type BitcoinNetwork = 'mainnet' | 'signet' | 'regtest' | 'testnet';

export interface ChainTip {
  height: number;
  hash: string;
}

export interface CreationPosition {
  height: number;
  blockHash: string;
  transactionIndex: number;
  inscriptionIndex: number;
}

export interface PublicationObservation {
  id: string;
  revealTxid: string;
  network: BitcoinNetwork;
  sat: string;
  confirmed: boolean;
  creation?: CreationPosition;
  body:
    | { status: 'unavailable' | 'unsupported' }
    /**
     * Observed, but its own body is not established, and the read goes on
     * (the holder of a sat, who has no authority over it, must not be able
     * to make every read of it fail; P9.12). `delegated`: ord serves another
     * inscription's bytes for it. `content-encoding`: its body is encoded
     * (P9.14 defines no encoding). Neither body nor metadata is read.
     * PROVISIONAL.
     */
    | { status: 'unsupported'; reason: 'delegated' | 'content-encoding'; mediaType: string | null }
    /**
     * Observed, but its body and metadata were not read because they would
     * pass the read's content-byte budget (`SatSnapshotBudget.maxContentBytes`).
     * The read goes on with later, smaller bodies. PROVISIONAL.
     */
    | { status: 'unavailable'; reason: 'over-budget'; mediaType: string | null; contentLength: number }
    | {
        status: 'complete';
        mediaType: string;
        bytes: Uint8Array;
        metadata: Uint8Array | null;
      };
}

/** Adapter assertions for one complete, stable view. Nothing here authenticates RPC providers or validates Bitcoin consensus. */
export interface SatSnapshot {
  network: BitcoinNetwork;
  sat: string;
  tipBefore: ChainTip;
  tipAfter: ChainTip;
  indexTip: ChainTip;
  indexHealthy: boolean;
  enumerationComplete: boolean;
  /** Active-chain blocks established by the adapter at this snapshot; includes complete ordered reveal tx lists. */
  blocks: { height: number; hash: string; txids: string[]; /** Header timestamp, seconds; inscription time needs it (P9.15). */ time?: number }[];
  publications: PublicationObservation[];
  /** Explicit null means observed absent/unbound, not a missing provider response. */
  ownership: { owner: string | null; satpoint: string | null };
  /** Optional provider claim about how the chain facts were established. */
  chainEvidence?: { assurance: 'provider-asserted' | 'node-validated'; source?: string };
}

/**
 * A confirmed inscription's media type and content digest, established
 * independently of the Ordinals indexer that served `SatSnapshot.publications`
 * (for example by parsing the reveal transaction's witness envelope from a
 * validating Bitcoin node).
 */
export interface IndependentContentEvidence {
  inscriptionId: string;
  mediaType: string;
  /** digestBytes() of the independently derived on-chain content bytes. */
  contentDigest: string;
  /** digestBytes() of the raw on-chain metadata tag, or null when the envelope carries none. */
  metadataDigest: string | null;
}

/** SHA-256 multihash of exact bytes, base64url-multibase encoded (`u` prefix). */
export function digestBytes(bytes: Uint8Array): string {
  return 'u' + base64urlnopad.encode(Uint8Array.from([0x12, 0x20, ...sha256(bytes)]));
}

const SATPOINT = /^([0-9a-fA-F]{64}):(\d+):(\d+)$/;
/**
 * Canonicalize a satpoint (`<64-hex-txid>:<vout>:<offset>`) for equality
 * comparison across independently configured sources. Only the txid's hex
 * casing is normalized. A value that doesn't match the expected shape is
 * returned unchanged, so a malformed satpoint still fails comparison.
 */
export function normalizeSatpoint(satpoint: string | null): string | null {
  if (satpoint === null) return null;
  const match = SATPOINT.exec(satpoint);
  return match ? `${match[1].toLowerCase()}:${match[2]}:${match[3]}` : satpoint;
}

const INSCRIPTION_ID = /^([0-9a-fA-F]{64})([iI]\d+)$/;
/**
 * Canonicalize an inscription id (`<64-hex-txid>i<index>`) for equality
 * comparison, mirroring {@link normalizeSatpoint}: only hex letter casing is
 * normalized; a malformed id is returned unchanged.
 */
export function normalizeInscriptionId(id: string): string {
  const match = INSCRIPTION_ID.exec(id);
  return match ? `${match[1].toLowerCase()}${match[2].toLowerCase()}` : id;
}

const TXID = /^[0-9a-fA-F]{64}$/;
/** Lowercase a 64-hex txid for comparison; any other value is returned unchanged (#821). */
export function normalizeTxid(txid: string): string {
  return TXID.test(txid) ? txid.toLowerCase() : txid;
}
