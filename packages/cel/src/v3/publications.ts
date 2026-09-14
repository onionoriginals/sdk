import { normalizeAssetId } from "./identity.js";
import { freeze } from "./immutable.js";
import { CelError } from "./errors.js";
import { parseAssetAlias, type BitcoinNetwork } from "./dids.js";
import { parseDocument, eventDigest } from "./profile.js";
import {
  verifyHistory,
  type VerifiedHistory,
  type AssetState,
  type DeepReadonly,
} from "./history.js";
import { canonicalizeValue } from "./values.js";
import { digestBytes } from "./primitives.js";

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
    | { status: "unavailable" | "unsupported" }
    | {
        status: "complete";
        mediaType: string;
        bytes: Uint8Array;
        metadata: Uint8Array | null;
      };
}
/**
 * How the snapshot's chain facts (tip, active block hashes, reveal transaction
 * membership) were established, distinct from indexer enumeration completeness.
 * `node-validated` never certifies that no later/omitted publication exists —
 * only an independent index can corroborate enumeration completeness.
 */
export interface ChainEvidence {
  /**
   * `provider-asserted`: the same provider that supplied Ordinals data also
   * asserted these chain facts, with no independent cross-check.
   * `node-validated`: a separately configured Bitcoin node independently
   * confirmed the chain tip, active block hashes, and reveal transaction
   * membership this snapshot relies on.
   */
  assurance: "unavailable" | "provider-asserted" | "node-validated";
  /** Non-secret label identifying the independent source (e.g. a host name). Never a credential. */
  source?: string;
}
/** Adapter assertions for one complete, stable view. Core does not authenticate RPC providers or validate Bitcoin consensus. */
export interface SatSnapshot {
  network: BitcoinNetwork;
  sat: string;
  tipBefore: ChainTip;
  tipAfter: ChainTip;
  indexTip: ChainTip;
  indexHealthy: boolean;
  enumerationComplete: boolean;
  /** Active-chain blocks established by the adapter at this snapshot; includes complete ordered reveal tx lists. */
  blocks: { height: number; hash: string; txids: string[] }[];
  publications: PublicationObservation[];
  /** Explicit null means observed absent/unbound, not a missing provider response. */
  ownership: { owner: string | null; satpoint: string | null };
  /** Optional provider claim, never sufficient to upgrade core resolution above provider-asserted. */
  chainEvidence?: { assurance: 'provider-asserted' | 'node-validated'; source?: string };
}
export type ResolutionFailure =
  | "invalid"
  | "incomplete"
  | "inconsistent-evidence"
  | "chain-changed"
  | "unsupported-capability"
  | "not-found"
  | "identity-mismatch";
export interface PublicationEvidence {
  inscriptionId: string;
  position: CreationPosition;
  eventDigests: string[];
  /** Only these inline bytes were matched; referenced/remote resources are not thereby verified. */
  inlineResourceIds: string[];
  inlineContentStatus: "not-inline" | "matched" | "unmatched";
}
/**
 * `bitcoin-inline` means these exact current bytes were matched inline in an accepted
 * publication; `referenced` means the current state names this resource but no accepted
 * publication in this snapshot carried its bytes on-chain. A resource can regress from
 * `bitcoin-inline` to `referenced` after an update changes its digest.
 */
export type ResourceAvailability = "bitcoin-inline" | "referenced";
export interface ResourceAvailabilityRecord {
  id: string;
  version: number;
  availability: ResourceAvailability;
}
/**
 * All inscription ids an independently configured second Ordinals index
 * currently reports for the queried sat. `source` is a non-secret label for
 * that source (never credentials or a full URL), carried into diagnostics.
 * This corroborates enumeration completeness; it is a separate dimension
 * from chain/index consistency and does not itself validate Bitcoin facts.
 */
export interface IndependentEnumeration {
  source: string;
  inscriptionIds: readonly string[];
}
export type SatResolution = Readonly<
  | {
      status: ResolutionFailure;
      reason: string;
      scope: "sat";
      crossSatCanonicality: "unknown";
      chainEvidence: Readonly<ChainEvidence>;
    }
  | {
      /**
       * The complete observation contains only unconfirmed publications for this sat:
       * something was broadcast, but nothing has reached this snapshot's confirmation
       * depth yet, so no boundary could be evaluated either way. Distinct from
       * `not-found`, which means either no publications were observed for this sat at
       * all, or confirmed data was inspected and no valid boundary was found in it.
       */
      status: "pending";
      reason: string;
      scope: "sat";
      crossSatCanonicality: "unknown";
      chainEvidence: Readonly<ChainEvidence>;
      /** Unconfirmed publication ids observed for this sat, in snapshot order. */
      pending: readonly string[];
    }
  | {
      status: "accepted";
      scope: "sat";
      crossSatCanonicality: "unknown";
      tip: Readonly<ChainTip>;
      state: DeepReadonly<AssetState>;
      history: VerifiedHistory;
      ownership: Readonly<SatSnapshot["ownership"]>;
      publications: readonly DeepReadonly<PublicationEvidence>[];
      pending: readonly string[];
      diagnostics: readonly Readonly<{ inscriptionId: string; code: string }>[];
      webvhBinding: "unverified";
      /** Scoped to chain facts only; never implies verified enumeration completeness. */
      chainEvidence: Readonly<ChainEvidence>;
      /** Per current resource, whether its exact bytes were recovered from this snapshot's accepted publications. */
      resourceAvailability: readonly Readonly<ResourceAvailabilityRecord>[];
      /**
       * "cross-checked" only when a caller-supplied independent enumeration
       * source was consulted and reported no inscription absent from this
       * snapshot; otherwise the snapshot's own completeness is an
       * unauthenticated provider assertion. A compromised or incomplete
       * provider can still omit history no independent source observed.
       */
      enumerationAssurance: "provider-asserted" | "cross-checked";
    }
>;
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validTip = (tip: ChainTip | undefined): boolean =>
  !!tip && integer(tip.height) && hash(tip.hash);
const sameTip = (a: ChainTip, b: ChainTip): boolean =>
  a.height === b.height && a.hash === b.hash;
const failure = (status: ResolutionFailure, reason: string): SatResolution => ({
  status,
  reason,
  scope: "sat",
  crossSatCanonicality: "unknown",
  chainEvidence: { assurance: "provider-asserted" },
});

/** Resolve a sat from complete observations using the same signature/authority fold as offline history.
 * The result is qualified to the supplied chain/index snapshot and provider trust.
 * No network requests, stale-state cache, live ownership inference or partial-head success.
 */
export function resolveSat(
  snapshot: SatSnapshot,
  options: {
    expectedAssetId?: string;
    /**
     * All inscription ids a second, independently configured Ordinals index
     * currently reports for this sat. If it reports an id this snapshot
     * does not contain, resolution fails closed rather than accepting a
     * possibly-omitted history as complete: the primary provider cannot
     * earn "cross-checked" by simply not disagreeing with itself.
     */
    independentEnumeration?: IndependentEnumeration;
  } = {},
): SatResolution {
  const prefix =
    snapshot.network === "mainnet"
      ? ""
      : snapshot.network === "regtest"
        ? "reg:"
        : snapshot.network === "signet"
          ? "sig:"
          : snapshot.network === "testnet"
            ? "test:"
            : undefined;
  if (prefix === undefined || typeof snapshot.sat !== "string")
    return failure("invalid", "Invalid query network or sat");
  const queriedDid = "did:btco:" + prefix + snapshot.sat;
  let expectedAssetId: string | undefined;
  try {
    if (options.expectedAssetId !== undefined)
      expectedAssetId = normalizeAssetId(options.expectedAssetId);
    parseAssetAlias(queriedDid);
  } catch (error) {
    if (!(error instanceof CelError)) throw error;
    return failure("invalid", error.code);
  }
  if (
    ![snapshot.tipBefore, snapshot.tipAfter, snapshot.indexTip].every(validTip)
  )
    return failure("incomplete", "Missing chain/index tip");
  if (
    snapshot.chainEvidence !== undefined &&
    (typeof snapshot.chainEvidence !== "object" ||
      snapshot.chainEvidence === null ||
      !["provider-asserted", "node-validated"].includes(
        snapshot.chainEvidence.assurance,
      ) ||
      (snapshot.chainEvidence.source !== undefined &&
        typeof snapshot.chainEvidence.source !== "string"))
  )
    return failure("invalid", "Malformed chain evidence assurance");
  if (!sameTip(snapshot.tipBefore, snapshot.tipAfter))
    return failure("chain-changed", "Chain changed during observation");
  if (!snapshot.indexHealthy || !sameTip(snapshot.tipBefore, snapshot.indexTip))
    return failure("incomplete", "Index is not healthy at the chain tip");
  if (
    !snapshot.enumerationComplete ||
    !Array.isArray(snapshot.publications) ||
    !Array.isArray(snapshot.blocks)
  )
    return failure("incomplete", "Incomplete sat enumeration");
  let enumerationAssurance: "provider-asserted" | "cross-checked" =
    "provider-asserted";
  if (options.independentEnumeration) {
    const { inscriptionIds } = options.independentEnumeration;
    if (
      !Array.isArray(inscriptionIds) ||
      !inscriptionIds.every((id) => typeof id === "string")
    )
      return failure("incomplete", "Invalid independent enumeration evidence");
    const known = new Set(snapshot.publications.map((p) => p.id));
    if (inscriptionIds.some((id) => !known.has(id)))
      return failure(
        "inconsistent-evidence",
        "Independent enumeration source reports an inscription absent from the primary snapshot",
      );
    enumerationAssurance = "cross-checked";
  }
  if (
    !snapshot.ownership ||
    !Object.prototype.hasOwnProperty.call(snapshot.ownership, "owner") ||
    !Object.prototype.hasOwnProperty.call(snapshot.ownership, "satpoint") ||
    !(
      snapshot.ownership.owner === null ||
      typeof snapshot.ownership.owner === "string"
    ) ||
    !(
      snapshot.ownership.satpoint === null ||
      typeof snapshot.ownership.satpoint === "string"
    )
  )
    return failure("incomplete", "Missing live ownership observation");
  const blocks = new Map<number, SatSnapshot["blocks"][number]>();
  const blockHashes = new Set<string>();
  for (const block of snapshot.blocks) {
    if (
      !integer(block.height) ||
      !hash(block.hash) ||
      !Array.isArray(block.txids) ||
      !block.txids.length ||
      !block.txids.every(hash) ||
      new Set(block.txids).size !== block.txids.length
    )
      return failure("incomplete", "Invalid block transaction evidence");
    const existing = blocks.get(block.height);
    if (existing) {
      if (
        existing.hash !== block.hash ||
        existing.txids.length !== block.txids.length ||
        existing.txids.some((id, i) => id !== block.txids[i])
      )
        return failure(
          "inconsistent-evidence",
          "Conflicting blocks at one height",
        );
      continue;
    }
    if (blockHashes.has(block.hash))
      return failure(
        "inconsistent-evidence",
        "One block hash has multiple heights",
      );
    if (
      block.height > snapshot.tipBefore.height ||
      (block.height === snapshot.tipBefore.height &&
        block.hash !== snapshot.tipBefore.hash)
    )
      return failure("chain-changed", "Block disagrees with snapshot");
    blocks.set(block.height, block);
    blockHashes.add(block.hash);
  }
  const seen = new Map<string, string>(),
    positions = new Map<string, string>();
  const confirmationStates = new Map<string, boolean>();
  const ordered: (PublicationObservation & { creation: CreationPosition })[] =
      [],
    pending: string[] = [];
  for (const publication of snapshot.publications) {
    if (
      publication.network !== snapshot.network ||
      publication.sat !== snapshot.sat
    )
      return failure(
        "inconsistent-evidence",
        "Listed publication is assigned to another sat/network",
      );
    if (typeof publication.confirmed !== "boolean")
      return failure("incomplete", "Missing confirmation state");
    const confirmation = confirmationStates.get(publication.id);
    if (confirmation !== undefined && confirmation !== publication.confirmed)
      return failure(
        "inconsistent-evidence",
        "Conflicting confirmation states for one inscription",
      );
    confirmationStates.set(publication.id, publication.confirmed);
    if (publication.confirmed === false) {
      if (!pending.includes(publication.id)) pending.push(publication.id);
      continue;
    }
    if (
      publication.confirmed !== true ||
      !publication.body ||
      publication.body.status === "unavailable"
    )
      return failure("incomplete", "Unavailable publication observation");
    if (publication.body.status === "unsupported")
      return failure(
        "unsupported-capability",
        "Required provider capability is unavailable",
      );
    if (
      publication.body.status !== "complete" ||
      !(publication.body.bytes instanceof Uint8Array) ||
      !(
        publication.body.metadata === null ||
        publication.body.metadata instanceof Uint8Array
      ) ||
      typeof publication.body.mediaType !== "string"
    )
      return failure(
        "incomplete",
        "Content and metadata must be complete or explicitly absent",
      );
    const position = publication.creation;
    if (
      !position ||
      !integer(position.height) ||
      !integer(position.transactionIndex) ||
      !integer(position.inscriptionIndex) ||
      !hash(position.blockHash)
    )
      return failure("incomplete", "Missing confirmed creation position");
    const id = /^([0-9a-f]{64})i(0|[1-9]\d*)$/.exec(publication.id);
    if (
      !id ||
      id[1] !== publication.revealTxid ||
      id[2] !== String(position.inscriptionIndex)
    )
      return failure(
        "inconsistent-evidence",
        "Inscription identity disagrees with reveal position",
      );
    const block = blocks.get(position.height);
    if (!block)
      return failure("incomplete", "Missing creation block transaction list");
    if (block.hash !== position.blockHash)
      return failure(
        "chain-changed",
        "Publication block is not in the selected chain",
      );
    if (block.txids[position.transactionIndex] !== publication.revealTxid)
      return failure(
        "inconsistent-evidence",
        "Reveal txid is not at the observed block position",
      );
    const fingerprint = canonicalizeValue({
      position,
      type: publication.body.mediaType,
      content: digestBytes(publication.body.bytes),
      metadata:
        publication.body.metadata === null
          ? null
          : digestBytes(publication.body.metadata),
    });
    const existing = seen.get(publication.id);
    if (existing !== undefined) {
      if (existing !== fingerprint)
        return failure(
          "inconsistent-evidence",
          "Conflicting records for one inscription",
        );
      continue;
    }
    const tuple = [
      position.height,
      position.transactionIndex,
      position.inscriptionIndex,
    ].join(":");
    if (positions.has(tuple))
      return failure(
        "inconsistent-evidence",
        "Different inscriptions occupy one position",
      );
    positions.set(tuple, publication.id);
    seen.set(publication.id, fingerprint);
    ordered.push({ ...publication, creation: position });
  }
  ordered.sort(
    (a, b) =>
      a.creation.height - b.creation.height ||
      a.creation.transactionIndex - b.creation.transactionIndex ||
      a.creation.inscriptionIndex - b.creation.inscriptionIndex,
  );
  let history: VerifiedHistory | undefined,
    lastHeight = -1;
  const accepted: PublicationEvidence[] = [],
    diagnostics: { inscriptionId: string; code: string }[] = [],
    inlinedContent = new Set<string>();
  for (const publication of ordered) {
    const ignore = (code: string) =>
      diagnostics.push({ inscriptionId: publication.id, code });
    // Height is a publication gate, never an entry gate: a rotation and its
    // successor's update in this same document can be accepted together.
    if (history && publication.creation.height <= lastHeight) {
      ignore("CEL_PUBLICATION_HEIGHT");
      continue;
    }
    const body = publication.body;
    if (body.status !== "complete")
      return failure("incomplete", "Publication body changed");
    if (body.metadata === null && body.mediaType !== "application/cel") {
      ignore("CEL_UNRELATED");
      continue;
    }
    try {
      const document =
        body.metadata !== null
          ? parseDocument(body.metadata, "cbor")
          : parseDocument(body.bytes, "json");
      if (
        history &&
        document.log[0].event.previousEvent !== history.state.head
      ) {
        ignore("CEL_NONEXTENDING");
        continue;
      }
      const next = verifyHistory(document, history ? { prefix: history } : {});
      if (!history) {
        const last = document.log[document.log.length - 1].event.operation;
        if (
          last.type !== "migrate" ||
          last.data.layer !== "btco" ||
          next.state.alias !== queriedDid
        ) {
          ignore("CEL_BOUNDARY");
          continue;
        }
      }
      const contentDigest =
        body.metadata === null ? undefined : digestBytes(body.bytes);
      const inlineResourceIds =
        body.metadata === null
          ? []
          : next.state.resources
              .filter(
                (r) =>
                  r.mediaType === body.mediaType &&
                  r.digestMultibase === contentDigest,
              )
              .map((r) => r.id);
      const inlineContentStatus =
        body.metadata === null
          ? "not-inline"
          : inlineResourceIds.length
            ? "matched"
            : "unmatched";
      if (inlineContentStatus === "unmatched")
        ignore("CEL_INLINE_RESOURCE_MISMATCH");
      if (inlineResourceIds.length > 0) {
        inlinedContent.add(JSON.stringify([body.mediaType, contentDigest]));
      }
      // Choose the first valid boundary independent of a requested genesis filter.
      if (
        !history &&
        expectedAssetId !== undefined &&
        next.state.assetId !== expectedAssetId
      )
        return failure(
          "identity-mismatch",
          "Earliest valid boundary has a different genesis",
        );
      history = next;
      lastHeight = publication.creation.height;
      accepted.push({
        inscriptionId: publication.id,
        position: { ...publication.creation },
        eventDigests: document.log.map((e) => eventDigest(e.event)),
        inlineResourceIds,
        inlineContentStatus,
      });
    } catch (error) {
      if (!(error instanceof CelError)) throw error;
      if (error.status === "unsupported" && error.code === "CEL_WEBVH_IDNA")
        return failure("unsupported-capability", error.code);
      // Fully inspected disallowed or invalid profile candidates are ignorable;
      // unavailable bytes were rejected above, before application parsing.
      ignore(error.code);
    }
  }
  if (!history) {
    // No confirmed publication was even a candidate: everything observed is still
    // unconfirmed, so there is nothing yet to judge as valid or invalid. Report that
    // distinctly from "not-found" (confirmed data was inspected and rejected).
    if (ordered.length === 0 && pending.length > 0)
      return {
        status: "pending",
        reason: "Only unconfirmed publications observed; no confirmed boundary yet",
        scope: "sat",
        crossSatCanonicality: "unknown",
        chainEvidence: { assurance: "provider-asserted" },
        pending,
      };
    return failure(
      "not-found",
      "No valid boundary in the complete sat observations",
    );
  }
  // Snapshot data cannot select its own trust level. Explicit application-side
  // validation in the SDK may upgrade the resolved result after checking this view.
  const chainEvidence: ChainEvidence = { assurance: "provider-asserted" };
  const resourceAvailability: ResourceAvailabilityRecord[] =
    history.state.resources.map((resource) => ({
      id: resource.id,
      version: resource.version,
      availability: inlinedContent.has(JSON.stringify([resource.mediaType, resource.digestMultibase]))
        ? "bitcoin-inline"
        : "referenced",
    }));
  const result: SatResolution = {
    status: "accepted",
    scope: "sat",
    crossSatCanonicality: "unknown",
    tip: { ...snapshot.tipBefore },
    state: history.state,
    history,
    ownership: { ...snapshot.ownership },
    publications: accepted,
    pending,
    diagnostics,
    webvhBinding: "unverified",
    chainEvidence,
    resourceAvailability,
    enumerationAssurance,
  };
  freeze<unknown>(result);
  return result;
}
