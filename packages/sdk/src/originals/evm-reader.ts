/**
 * Reading an Original's token from the anchor contract (originals-spec PR 59,
 * P9.21, P9.22, P9.25, P14.20), into the `EvmTokenEvidence` that
 * `@originals/vh` verifies. EXPERIMENTAL; the spec pins no contract (P14.21),
 * so the caller supplies an `EvmAnchorPin`.
 *
 * For each provider the reader asks `eth_chainId`, block 0's hash and the
 * `finalized` block. Providers that report the listed chain ID and block-0
 * hash are serving the chain (P9.21); the reader takes the lowest of their
 * finalized block numbers as the common block (P9.22) and reads, from each
 * of them, that block's hash and then, at that block's hash: the code at the
 * pinned address, `ownerOf`, `publicationCount`, every `publication` and the
 * metadata and body of each record in ranges. It never reads the bytes of a
 * record whose own fields exceed the limits (P9.25). It uses no event logs
 * (P9.25). Records above the common block, read at `latest`, are returned
 * as `observed` (P9.22), fields only, when `observe` is set. With `from`, it
 * reads only the records from that index, resuming from a checkpoint the
 * verifier retained (P9.25).
 *
 * P9.22 (PR 59 a3ffdc1): a provider must serve the contract's state at the
 * finalized block, however far finality trails its head. One that cannot
 * (no such block, or a state read at it failing for any reason other than a
 * revert) is reported with `stateUnavailable`, which the verifier treats as
 * missing evidence; it is not dropped, so the read is not decided on the
 * other provider alone.
 *
 * The reader judges nothing: a provider serving another chain is still
 * reported, with what it reported and no state, and the verifier discards it
 * (P9.21); code with another hash is reported with that hash and no state
 * (the verifier reports unsupported; P9.21); providers that disagree are both
 * reported (the verifier reports missing evidence; P9.22). A provider that
 * fails is listed in `failures`, not in the evidence, so the verifier sees
 * fewer reads than providers asked.
 */
import { OriginalsError } from "@originals/vh";
import {
  ORIGINALS_INSCRIPTION_MAX_BYTES,
  anchorAddress,
  derivedTokenAlias,
  parseEvmAlias,
  requireSupported,
  type EvmAnchor,
  type EvmAnchorPin,
  type EvmProviderRead,
  type EvmRecord,
  type EvmTokenEvidence,
  type RetainedEvmBlock,
} from "@originals/vh/originals";
import { keccakHex } from "./evm-abi.js";
import { EvmRevert, EvmRpc, type BlockRef, type EvmFetch } from "./evm-rpc.js";

/** P14.20: a media type is at most 255 bytes. */
export const EVM_MAX_MEDIA_TYPE_BYTES = 255;

/** The anchor contract's read interface (P14.20). */
export const ANCHOR_READS = {
  ownerOf: "ownerOf(uint256)",
  publicationCount: "publicationCount(uint256)",
  publication: "publication(uint256,uint32)",
  metadata: "metadata(uint256,uint32,uint32,uint32)",
  body: "body(uint256,uint32,uint32,uint32)",
} as const;

export interface EvmProvider {
  /** The JSON-RPC endpoint. */
  url: string;
  /** How reports name it (P9.27: a report names the providers it used). Default `url`. */
  name?: string;
}

export interface ReadEvmTokenOptions {
  pin: EvmAnchorPin;
  /** One or more providers for the chain (P9.22: a verifier that uses two reads from both). */
  providers: ReadonlyArray<string | EvmProvider>;
  fetch?: EvmFetch;
  signal?: AbortSignal;
  /** Bytes per `metadata`/`body` call (P14.20 ranges). Default 65,536. */
  rangeBytes?: number;
  /** Also read records above the common block, at `latest`, as `observed` (P9.22). Default false. */
  observe?: boolean;
  /**
   * OPTIONAL, off by default. The finalized blocks the verifier relied on
   * before (P9.22). Each provider reports its current hash at each such
   * number on this chain, as `blockHashes`, so a replaced block is found
   * after finality has moved past it. P9.22 assumes finality holds and does
   * not require these reads; a hash that differs is the evidence on which the
   * verifier warns and discards what rested on that block.
   */
  retained?: ReadonlyArray<RetainedEvmBlock>;
  /**
   * P9.25 (MAY): read only the records from this index, resuming from a
   * retained checkpoint whose `records` it is (`EvmCheckpoint`). The verifier
   * accepts the read only with that checkpoint. Default 0, every record.
   */
  from?: number;
}

/** What to read: the token alias, or the Original and its anchor member, from which it derives (P14.19). */
export type EvmTokenRef = { alias: string } | { original: string; anchor: EvmAnchor };

export interface EvmProviderFailure {
  provider: string;
  code: string;
  message: string;
}

export interface EvmReadResult {
  evidence: EvmTokenEvidence;
  /** Providers that could not be read, or whose records could not be (then also `records: null`). */
  failures: EvmProviderFailure[];
  /** The common block, the lower of the matching providers' finalized blocks (P9.22); null when none matched. */
  commonBlock: number | null;
}

/** Whether a record's own fields put it over the limits, so its bytes are never read (P9.25, P14.20). */
export function recordExceedsLimits(r: Pick<EvmRecord, "index" | "metadataLength" | "bodyLength" | "bodyOf" | "mediaType">): boolean {
  const mediaTypeBytes = new TextEncoder().encode(r.mediaType).length;
  if (mediaTypeBytes > EVM_MAX_MEDIA_TYPE_BYTES) return true;
  return r.bodyOf === r.index ? r.metadataLength + r.bodyLength > ORIGINALS_INSCRIPTION_MAX_BYTES : r.metadataLength > ORIGINALS_INSCRIPTION_MAX_BYTES;
}

function inconsistent(provider: string, message: string): never {
  throw new OriginalsError("incomplete-evidence", "EVM_PROVIDER_INCONSISTENT", `${provider}: ${message}`, { provider });
}

const asNumber = (v: unknown) => Number(v);

/** One record's fields at `at` (P14.20). */
async function recordFields(rpc: EvmRpc, address: string, tokenId: bigint, index: number, at: BlockRef): Promise<EvmRecord> {
  const [timestamp, metadataLength, bodyLength, bodyOf, mediaType] = await rpc.call(address, ANCHOR_READS.publication, ["uint256", "uint32"], [tokenId, index], ["uint64", "uint32", "uint32", "uint32", "string"], at);
  return { index, timestamp: asNumber(timestamp), metadataLength: asNumber(metadataLength), bodyLength: asNumber(bodyLength), bodyOf: asNumber(bodyOf), mediaType: mediaType as string };
}

/** `length` bytes of a record's metadata or body, in ranges (P14.20); each range must be exactly as long as asked. */
async function readBytes(rpc: EvmRpc, address: string, which: "metadata" | "body", tokenId: bigint, index: number, length: number, at: BlockRef, range: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += range) {
    const want = Math.min(range, length - offset);
    const [chunk] = (await rpc.call(address, ANCHOR_READS[which], ["uint256", "uint32", "uint32", "uint32"], [tokenId, index, offset, want], ["bytes"], at)) as [Uint8Array];
    if (chunk.length !== want) inconsistent(rpc.url, `${which}(${index}) at ${offset} returned ${chunk.length} bytes, not ${want}`);
    out.set(chunk, offset);
  }
  return out;
}

/** Every record of the token at `at` from index `from`, with the bytes of each record within the limits (P9.25). */
async function readRecords(rpc: EvmRpc, address: string, tokenId: bigint, at: BlockRef, range: number, from: number): Promise<EvmRecord[]> {
  const [count] = await rpc.call(address, ANCHOR_READS.publicationCount, ["uint256"], [tokenId], ["uint32"], at);
  if (Number(count) < from) inconsistent(rpc.url, `the token has ${count} records, fewer than the checkpoint's ${from}`);
  const records: EvmRecord[] = [];
  const byIndex = new Map<number, EvmRecord>();
  for (let index = from; index < Number(count); index++) {
    const r = await recordFields(rpc, address, tokenId, index, at);
    records.push(r);
    byIndex.set(index, r);
    // P9.25: decided from the record's own fields; such a record never makes evidence missing.
    if (recordExceedsLimits(r)) continue;
    r.metadata = await readBytes(rpc, address, "metadata", tokenId, index, r.metadataLength, at, range);
    if (r.bodyOf === index) {
      r.body = await readBytes(rpc, address, "body", tokenId, index, r.bodyLength, at, range);
      continue;
    }
    // A record that refers to a body names an earlier record of this token that stored its own, and
    // holds that body's length as its `bodyLength` (P14.20). The pinned contract cannot record
    // anything else, so another answer is the provider's. A referred record before `from` was
    // checked when the checkpoint was made; its bytes are `body(index)`'s.
    const ref = byIndex.get(r.bodyOf);
    if (r.bodyOf > index || (r.bodyOf >= from && (!ref || ref.bodyOf !== ref.index || ref.bodyLength !== r.bodyLength || ref.mediaType !== r.mediaType))) {
      inconsistent(rpc.url, `record ${index} refers to record ${r.bodyOf}, which is not an earlier record with that stored body`);
    }
    // The same block's state: the referred record's bytes are the bytes `body(index)` returns.
    r.body = ref?.body ?? (await readBytes(rpc, address, "body", tokenId, index, r.bodyLength, at, range));
  }
  return records;
}

interface Head {
  provider: string;
  rpc: EvmRpc;
  chainId: bigint;
  genesisHash: string;
  finalized: { number: number; hash: string };
}

/**
 * Read one token from every provider (P9.21, P9.22, P9.25). Throws only for
 * what the caller got wrong (an unsupported chain, an alias of another
 * contract); provider trouble is in `failures` and in the evidence.
 */
export async function readEvmToken(ref: EvmTokenRef, options: ReadEvmTokenOptions): Promise<EvmReadResult> {
  const { pin } = options;
  const alias = "alias" in ref ? ref.alias : derivedTokenAlias(ref.original, ref.anchor, pin);
  const parsed = parseEvmAlias(alias);
  // P14.21: the address fixed for this chain, which may differ from the common one.
  const address = anchorAddress(pin, parsed.chain);
  if (parsed.contract !== address) throw new OriginalsError("invalid-evidence", "EVM_ALIAS_CONTRACT", `${alias} names a contract other than the anchor contract pinned for ${parsed.chain} (P14.18, P14.21)`);
  const { listed } = requireSupported(parsed.chain, pin);
  const range = options.rangeBytes ?? 65_536;
  if (!Number.isSafeInteger(range) || range < 1) throw new OriginalsError("invalid-evidence", "INPUT_INVALID", "rangeBytes is a positive integer");
  const from = options.from ?? 0;
  if (!Number.isSafeInteger(from) || from < 0) throw new OriginalsError("invalid-evidence", "INPUT_INVALID", "from is a non-negative integer");
  const failures: EvmProviderFailure[] = [];
  const fail = (provider: string, error: unknown) =>
    failures.push({ provider, code: error instanceof OriginalsError ? error.code : error instanceof EvmRevert ? "EVM_CALL_REVERTED" : "EVM_READ_FAILED", message: (error as Error)?.message ?? String(error) });

  const providers = options.providers.map((p) => (typeof p === "string" ? { url: p } : p));
  if (providers.length === 0) throw new OriginalsError("invalid-evidence", "INPUT_INVALID", "name at least one provider");

  // P9.21: which chain each provider serves, and its finalized block (P9.22).
  const heads = await Promise.all(
    providers.map(async (p): Promise<Head | null> => {
      const name = p.name ?? p.url;
      const rpc = new EvmRpc(p.url, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}) });
      try {
        const chainId = await rpc.chainId();
        const genesis = await rpc.block(0);
        const finalized = await rpc.block("finalized");
        if (!genesis || !finalized) throw new OriginalsError("incomplete-evidence", "EVM_NO_FINALIZED_BLOCK", `${name} reported no block 0 or no finalized block`);
        return { provider: name, rpc, chainId, genesisHash: genesis.hash, finalized: { number: finalized.number, hash: finalized.hash } };
      } catch (error) {
        fail(name, error);
        return null;
      }
    }),
  );
  const serving = (h: Head) => h.chainId === listed.chainId && h.genesisHash === listed.genesisHash.toLowerCase();
  const matching = heads.filter((h): h is Head => h !== null && serving(h));
  // P9.22: the lower of the finalized block numbers; a provider ahead is not in disagreement.
  const common = matching.length ? Math.min(...matching.map((h) => h.finalized.number)) : null;

  const reads: EvmProviderRead[] = [];
  await Promise.all(
    heads.map(async (h) => {
      if (!h) return;
      const base = { provider: h.provider, chainId: h.chainId, genesisHash: h.genesisHash, finalized: h.finalized.number };
      if (!serving(h) || common === null) {
        // P9.21: not serving the listed chain; its answers are not evidence, so none are read.
        reads.push({ ...base, block: h.finalized, codeHash: null, owner: null, records: null });
        return;
      }
      // P9.22: a provider that cannot serve state at the common block is not usable for this read.
      const unusable = (block: { number: number; hash: string }, error: unknown) => {
        fail(h.provider, error);
        reads.push({ ...base, block, codeHash: null, owner: null, records: null, stateUnavailable: true });
      };
      let block: { number: number; hash: string } | null;
      try {
        block = h.finalized.number === common ? h.finalized : await h.rpc.block(common);
      } catch (error) {
        unusable({ number: common, hash: "0x" }, error);
        return;
      }
      if (!block) {
        unusable({ number: common, hash: "0x" }, new OriginalsError("incomplete-evidence", "EVM_NO_BLOCK", `${h.provider} has no block ${common}`));
        return;
      }
      const at: BlockRef = { blockHash: block.hash };
      let code: Uint8Array;
      try {
        code = await h.rpc.code(address, at);
      } catch (error) {
        unusable({ number: common, hash: block.hash }, error);
        return;
      }
      try {
        const codeHash = code.length === 0 ? null : keccakHex(code);
        const read: EvmProviderRead = { ...base, block: { number: common, hash: block.hash }, codeHash, owner: null, records: null, ...(from > 0 ? { from } : {}) };
        // P9.21: no read is relied on unless the code at the address is the pinned code.
        if (codeHash !== pin.codeHash.toLowerCase()) {
          reads.push(read);
          return;
        }
        try {
          const [owner] = await h.rpc.call(address, ANCHOR_READS.ownerOf, ["uint256"], [parsed.tokenId], ["address"], at);
          read.owner = owner as string;
        } catch (error) {
          if (!(error instanceof EvmRevert)) {
            unusable(read.block, error);
            return;
          }
          read.owner = null; // ownerOf reverts for a token that does not exist (ERC-721).
        }
        try {
          read.records = await readRecords(h.rpc, address, parsed.tokenId, at, range, from);
        } catch (error) {
          // P9.25: records that cannot be read from state are missing evidence, never a partial log.
          read.records = null;
          fail(h.provider, error);
        }
        if (options.observe && read.records) {
          // Observed records only label publications (P9.27); failing to read them costs no evidence.
          try {
            read.observed = await observed(h.rpc, address, parsed.tokenId, from + read.records.length);
          } catch (error) {
            fail(h.provider, error);
          }
        }
        const earlier = (options.retained ?? []).filter((b) => b.chain === parsed.chain && b.number <= common);
        if (earlier.length > 0) {
          read.blockHashes = [];
          for (const b of earlier) {
            const got = b.number === common ? block : await h.rpc.block(b.number);
            if (got) read.blockHashes.push({ number: b.number, hash: got.hash });
          }
        }
        reads.push(read);
      } catch (error) {
        fail(h.provider, error);
      }
    }),
  );
  // Report reads in the order the providers were given.
  const order = new Map(providers.map((p, i) => [p.name ?? p.url, i]));
  reads.sort((a, b) => (order.get(a.provider) ?? 0) - (order.get(b.provider) ?? 0));
  return { evidence: { chain: parsed.chain, alias, reads }, failures, commonBlock: common };
}

/** Records at `latest` beyond the `from` that count at the common block (P9.22): fields only. */
async function observed(rpc: EvmRpc, address: string, tokenId: bigint, from: number): Promise<EvmRecord[]> {
  const latest = await rpc.block("latest");
  if (!latest) return [];
  const at: BlockRef = { blockHash: latest.hash };
  const [count] = await rpc.call(address, ANCHOR_READS.publicationCount, ["uint256"], [tokenId], ["uint32"], at);
  const out: EvmRecord[] = [];
  for (let index = from; index < Number(count); index++) out.push(await recordFields(rpc, address, tokenId, index, at));
  return out;
}
