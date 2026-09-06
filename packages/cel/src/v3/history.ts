import { freeze, type DeepReadonly } from "./immutable.js";
import { CelError, requireThat } from "./errors.js";
import { validateDocument } from "./profile.js";
import { verifyEntry } from "./proofs.js";
import { copyValue, type JsonObject } from "./values.js";
import { parseAssetDid } from "./dids.js";
import type { CelDocument, Resource } from "./types.js";

export type { DeepReadonly } from "./immutable.js";
export interface AssetState {
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
  readonly state: DeepReadonly<AssetState>;
}
const verified = new WeakSet<VerifiedHistory>();

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
function apply(document: CelDocument, prefix?: VerifiedHistory): AssetState {
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
      state = {
        didCel,
        alias: didCel,
        aliases: [didCel],
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
          data.from === state.alias &&
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
        state.alias = data.to;
        state.aliases.push(data.to);
        state.layer = data.layer;
        break;
      }
    }
    state.head = proof.digest;
    state.entryCount++;
  }
  requireThat(state, "CEL_GENESIS", "Empty history");
  return state;
}

/** Verify all signatures, links and authorized state transitions atomically.
 * A prefix must be an immutable result from this verifier, not a caller-supplied state.
 * Bitcoin acceptance and WebVH method binding always require separate observations.
 */
export function verifyHistory(
  input: unknown,
  options: { prefix?: VerifiedHistory; expectedDid?: string } = {},
): VerifiedHistory {
  const document = validateDocument(input),
    prefix = options.prefix;
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
  const state = apply(document, prefix);
  if (options.expectedDid !== undefined) {
    requireThat(
      parseAssetDid(options.expectedDid).method === "cel" &&
        options.expectedDid === state.didCel,
      "CEL_IDENTITY",
      "Requested identity differs from derived genesis",
    );
  }
  const result: VerifiedHistory = {
    status: "authenticated",
    scope: "controller-history",
    bitcoinAcceptance: state.layer === "btco" ? "unverified" : "not-applicable",
    webvhBinding: state.layer === "cel" ? "not-applicable" : "unverified",
    // The state is constructed here, then recursively frozen (never a caller assertion).
    state: freeze(state),
  };
  Object.freeze(result);
  verified.add(result);
  return result;
}
