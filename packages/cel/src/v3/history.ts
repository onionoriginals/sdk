import { assetIdFromDigest, normalizeAssetId, sameAssetIdentity } from "./identity.js";
import { freeze, type DeepReadonly } from "./immutable.js";
import { CelError, requireThat } from "./errors.js";
import { validateDocument } from "./profile.js";
import { verifyEntry } from "./proofs.js";
import { copyValue, type JsonObject } from "./values.js";
import { parseAssetDid } from "./dids.js";
import type { CelDocument, Resource } from "./types.js";

export type { DeepReadonly } from "./immutable.js";
export interface AssetState {
  /** Stable RFC 6920 name of the genesis event; not a DID. */
  assetId: string;
  /** @deprecated Read compatibility for the Originals 3.0 alias, not DID-method identity. */
  didCel: string;
  alias: string;
  aliases: string[];
  layer: "cel" | "webvh" | "btco";
  controller: string;
  controllers: {
    controller: string;
    fromEntry: number;
    throughEntry?: number;
  }[];
  createdAt: string;
  name?: string;
  metadata: JsonObject;
  resources: (Resource & { version: number })[];
  active: boolean;
  deactivatedAt?: string;
  head: string;
  entryCount: number;
}
export interface VerifiedHistory {
  readonly status: "authenticated";
  readonly scope: "controller-history";
  readonly bitcoinAcceptance: "unverified" | "not-applicable";
  readonly webvhBinding: "unverified" | "not-applicable";
  /**
   * Freshness/non-equivocation of the presented history, separate from signature-chain
   * authentication. `"unknown"` when no checkpoint was supplied: a first-time verifier
   * cannot know this is the latest or only branch. `"checkpoint-consistent"` when a
   * supplied checkpoint's asset identity and head digest were confirmed to equal or be
   * extended by this result. `"externally-anchored"` is reserved for witness/anchoring
   * evidence outside this function's scope.
   */
  readonly freshness: "unknown" | "checkpoint-consistent" | "externally-anchored";
  readonly state: DeepReadonly<AssetState>;
}
const verified = new WeakSet<VerifiedHistory>();

/**
 * A portable, serializable record of a previously authenticated state: asset identity,
 * head digest and entry count. Unlike a `prefix`, a checkpoint carries no object identity
 * and can be persisted, transmitted to a different verifier, or reloaded after a restart.
 */
export interface HistoryCheckpoint {
  readonly assetId: string;
  readonly head: string;
  readonly entryCount: number;
}

/** Extract a portable checkpoint from an authenticated result, for the caller to persist. */
export function checkpointFromHistory(history: VerifiedHistory): HistoryCheckpoint {
  return {
    assetId: history.state.assetId,
    head: history.state.head,
    entryCount: history.state.entryCount,
  };
}

function copyState(state: DeepReadonly<AssetState>): AssetState {
  // A derived state can outlive one document's size/value limits. Its components
  // were bounded at their entry boundaries and are immutable plain data.
  return {
    ...state,
    aliases: [...state.aliases],
    controllers: state.controllers.map((c) => ({ ...c })),
    metadata: copyValue(state.metadata) as JsonObject,
    resources: state.resources.map(({ url, ...r }) => ({
      ...r,
      ...(url ? { url: [...url] } : {}),
    })),
  };
}

/** Shared deterministic transition engine. Input must already pass validateDocument. No network I/O. */
function apply(
  document: CelDocument,
  prefix?: VerifiedHistory,
  onEntry?: (entryCount: number, head: string) => void,
): AssetState {
  let state = prefix ? copyState(prefix.state) : undefined;
  for (const entry of document.log) {
    const proof = verifyEntry(entry),
      operation = entry.event.operation;
    const expectedController =
      state?.controller ??
      (operation.type === "create" ? operation.data.controller : undefined);
    requireThat(
      proof.signers.every((controller) => controller === expectedController),
      "CEL_AUTHORITY",
      "Every proof must be from the current controller",
    );
    if (!state) {
      requireThat(
        operation.type === "create",
        "CEL_GENESIS",
        "History must start with create",
      );
      const didCel = "did:cel:" + proof.digest,
        data = operation.data;
      const assetId = assetIdFromDigest(proof.digest);
      state = {
        assetId,
        didCel,
        alias: assetId,
        aliases: [assetId],
        layer: "cel",
        controller: data.controller,
        controllers: [{ controller: data.controller, fromEntry: 0 }],
        createdAt: data.createdAt,
        ...(data.name !== undefined ? { name: data.name } : {}),
        metadata: data.metadata ?? {},
        resources: data.resources.map((r) => ({ ...r, version: 1 })),
        active: true,
        head: proof.digest,
        entryCount: 1,
      };
      onEntry?.(1, proof.digest);
      continue;
    }
    requireThat(
      state.active,
      "CEL_DEACTIVATED",
      "Deactivated history is terminal",
    );
    requireThat(
      operation.type !== "create" && entry.event.previousEvent === state.head,
      "CEL_CHAIN",
      "Entry must extend the immediate accepted head",
    );
    switch (operation.type) {
      case "update": {
        const data = operation.data;
        if (data.name !== undefined) state.name = data.name;
        if (data.metadata !== undefined) state.metadata = data.metadata;
        for (const replacement of data.resources ?? []) {
          const index = state.resources.findIndex(
            (resource) => resource.id === replacement.id,
          );
          requireThat(
            index >= 0 &&
              state.resources[index].digestMultibase ===
                replacement.previousDigestMultibase,
            "CEL_RESOURCE_PREVIOUS",
            "Resource must exist and match its current digest",
          );
          const { previousDigestMultibase: _previous, ...resource } =
            replacement;
          state.resources[index] = {
            ...resource,
            version: state.resources[index].version + 1,
          };
        }
        break;
      }
      case "rotateKey":
        requireThat(
          operation.data.newController !== state.controller,
          "CEL_ROTATION",
          "Rotation must change the controller",
        );
        state.controllers[state.controllers.length - 1].throughEntry =
          state.entryCount;
        state.controller = operation.data.newController;
        state.controllers.push({
          controller: state.controller,
          fromEntry: state.entryCount + 1,
        });
        break;
      case "deactivate":
        state.active = false;
        state.deactivatedAt = operation.data.deactivatedAt;
        break;
      case "migrate": {
        const data = operation.data,
          destination = parseAssetDid(data.to);
        parseAssetDid(data.from);
        requireThat(
          (data.from === state.alias ||
            (state.layer === "cel" && sameAssetIdentity(data.from, state.assetId))) &&
            data.layer === destination.method &&
            data.layer ===
              (state.layer === "cel"
                ? "webvh"
                : state.layer === "webvh"
                  ? "btco"
                  : null),
          "CEL_MIGRATION",
          "Migration must follow the current cel → webvh → btco aliases",
        );
        // Retain a historical alias only when it occurs in authenticated signed history.
        if (!state.aliases.includes(data.from)) state.aliases.push(data.from);
        state.alias = data.to;
        state.aliases.push(data.to);
        state.layer = data.layer;
        break;
      }
    }
    state.head = proof.digest;
    state.entryCount++;
    onEntry?.(state.entryCount, state.head);
  }
  requireThat(state, "CEL_GENESIS", "Empty history");
  return state;
}

/** Verify all signatures, links and authorized state transitions atomically.
 * A prefix must be an immutable result from this verifier, not a caller-supplied state.
 * Bitcoin acceptance and WebVH method binding always require separate observations.
 * A `checkpoint` is a portable freshness claim, independently confirmed here, never trusted.
 */
export function verifyHistory(
  input: unknown,
  options: {
    prefix?: VerifiedHistory;
    expectedAssetId?: string;
    /** @deprecated Use expectedAssetId. */ expectedDid?: string;
    checkpoint?: HistoryCheckpoint;
  } = {},
): VerifiedHistory {
  const document = validateDocument(input),
    prefix = options.prefix,
    checkpoint = options.checkpoint;
  if (prefix !== undefined)
    requireThat(
      verified.has(prefix),
      "CEL_PREFIX",
      "Prefix must come from this verifier",
    );
  if (!prefix && document.log[0].event.operation.type !== "create") {
    // A delta is only history-required after its own proofs and internal links pass.
    let previous: string | undefined;
    for (const entry of document.log) {
      requireThat(
        entry.event.operation.type !== "create" &&
          (!previous || entry.event.previousEvent === previous),
        "CEL_CHAIN",
        "Invalid delta chain",
      );
      previous = verifyEntry(entry).digest;
    }
    throw new CelError(
      "history-required",
      "CEL_HISTORY_REQUIRED",
      "Delta needs its authenticated prior history",
    );
  }
  // Only collected when a checkpoint is presented, to prove equal-or-extends against it
  // from entries this call actually authenticated, never from the checkpoint's own say-so.
  const observedHeads = checkpoint ? new Map<number, string>() : undefined;
  const state = apply(
    document,
    prefix,
    observedHeads && ((entryCount, head) => observedHeads.set(entryCount, head)),
  );
  for (const expected of [options.expectedAssetId, options.expectedDid]) {
    if (expected === undefined) continue;
    requireThat(normalizeAssetId(expected) === state.assetId,
      "CEL_IDENTITY", "Requested identity differs from derived genesis");
  }
  let freshness: VerifiedHistory["freshness"] = "unknown";
  if (checkpoint) {
    requireThat(
      sameAssetIdentity(checkpoint.assetId, state.assetId),
      "CEL_CHECKPOINT_ASSET",
      "Checkpoint asset identity differs from the presented history",
    );
    requireThat(
      checkpoint.entryCount <= state.entryCount,
      "CEL_CHECKPOINT_ROLLBACK",
      "Presented history is behind the recipient's checkpoint",
    );
    const headAtCheckpoint =
      checkpoint.entryCount === (prefix?.state.entryCount ?? 0)
        ? prefix?.state.head
        : observedHeads!.get(checkpoint.entryCount);
    requireThat(
      headAtCheckpoint === checkpoint.head,
      "CEL_CHECKPOINT_FORK",
      "Presented history diverges from the recipient's checkpoint",
    );
    freshness = "checkpoint-consistent";
  }
  const result: VerifiedHistory = {
    status: "authenticated",
    scope: "controller-history",
    bitcoinAcceptance: state.layer === "btco" ? "unverified" : "not-applicable",
    webvhBinding: state.layer === "cel" ? "not-applicable" : "unverified",
    freshness,
    // The state is constructed here, then recursively frozen (never a caller assertion).
    state: freeze(state),
  };
  Object.freeze(result);
  verified.add(result);
  return result;
}
