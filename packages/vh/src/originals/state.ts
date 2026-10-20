/**
 * The Originals asset state (plan 011 section 2.1). Every name, member and
 * encoding here is PROVISIONAL: the spec leaves the asset state schema and the
 * entry fields open (D1, D4). Each entry's state holds the full asset state,
 * never a delta, alongside the signed fields P5.1 requires.
 */
import { multibaseDecode, multibaseEncode, sha256Multihash, decodeSha256Multihash } from "../crypto/index.js";
import { OriginalsError, fail } from "../errors.js";
import { canonicalize, isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";
import { parseDidWebvh } from "../webvh/index.js";

/** PROVISIONAL (D1): the extension's method value; it implies vh-log:1.0. */
export const ORIGINALS_METHOD = "originals:1.0";

/** PROVISIONAL limits (P7.7). */
export const ORIGINALS_LIMITS = Object.freeze({
  entries: 10_000,
  entryBytes: 65_536,
  resources: 64,
  nameLength: 1_024,
  authorVersions: 1_000,
});

export type Operation = "create" | "update" | "deactivate";
/**
 * Operations later phases define: migrate (anchoring, PR 9). PROVISIONAL (D1):
 * publication is an ordinary update that lists a did:webvh alias (plan 011,
 * PR 7b), so there is no publish operation.
 */
const LATER_OPERATIONS = new Set(["migrate"]);

export interface ResourceDescriptor {
  id: string;
  mediaType: string;
  size: number;
  /** PROVISIONAL (D4): multibase base58btc of a sha2-256 multihash. */
  digest: string;
}

export interface AssetState {
  name: string;
  metadata?: JsonObject;
  status: "active" | "deactivated";
  resources: ResourceDescriptor[];
  aliases: string[];
}

/** The author DID, its verification method and its exact versionId (P5.1). */
export interface AuthorRef {
  did: string;
  verificationMethod: string;
  versionId: string;
}

export interface Transition {
  resource: string;
  from: string | null;
  to: string;
}

export interface EntryState {
  id: string;
  operation: Operation;
  author: AuthorRef;
  asset: AssetState;
  transitions: Transition[];
}

function invalid(code: string, message: string): never {
  throw new OriginalsError("invalid-evidence", code, message);
}

function members(value: unknown, required: string[], optional: string[], where: string): JsonObject {
  if (!isJsonObject(value)) invalid("STATE_MEMBERS", `${where} must be an object`);
  const keys = Object.keys(value);
  for (const key of required) if (!keys.includes(key)) invalid("STATE_MEMBERS", `${where} is missing ${key}`);
  for (const key of keys) if (!required.includes(key) && !optional.includes(key)) invalid("STATE_MEMBERS", `${where} has an undefined member ${key}`);
  return value;
}

/** The digest of exact bytes (P4.3): no decoding or normalization. */
export function resourceDigest(bytes: Uint8Array): string {
  return multibaseEncode(sha256Multihash(bytes));
}

/** Check a digest's encoding; an algorithm outside the SHA-256 set is an unsupported profile (P4.2). */
export function checkDigest(digest: unknown, where = "digest"): string {
  if (typeof digest !== "string") invalid("STATE_DIGEST", `${where} must be a string`);
  let raw: Uint8Array;
  try {
    raw = multibaseDecode(digest);
  } catch {
    return invalid("STATE_DIGEST", `${where} is not base58btc multibase`);
  }
  try {
    decodeSha256Multihash(raw);
  } catch (error) {
    if (error instanceof OriginalsError && error.category === "unsupported-profile") {
      fail("unsupported-profile", "STATE_DIGEST_ALGORITHM", `${where} uses a digest algorithm outside the SHA-256 set`);
    }
    invalid("STATE_DIGEST", `${where} is not a sha2-256 multihash`);
  }
  if (multibaseEncode(raw) !== digest) invalid("STATE_DIGEST", `${where} is not canonically encoded`);
  return digest;
}

const RESOURCE_ID = /^[A-Za-z0-9._-]{1,64}$/;
// RFC 6838 type/subtype, without parameters (PROVISIONAL).
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

export function checkDescriptor(value: unknown, where: string): ResourceDescriptor {
  const d = members(value, ["id", "mediaType", "size", "digest"], [], where);
  if (typeof d.id !== "string" || !RESOURCE_ID.test(d.id)) invalid("STATE_RESOURCE", `${where}.id must be 1-64 of A-Z a-z 0-9 . _ -`);
  if (typeof d.mediaType !== "string" || !MEDIA_TYPE.test(d.mediaType)) invalid("STATE_RESOURCE", `${where}.mediaType is not a media type`);
  if (typeof d.size !== "number" || !Number.isSafeInteger(d.size) || d.size < 0) invalid("STATE_RESOURCE", `${where}.size must be a non-negative integer`);
  checkDigest(d.digest, `${where}.digest`);
  return d as unknown as ResourceDescriptor;
}

export function checkAuthorRef(value: unknown): AuthorRef {
  let a: JsonObject;
  try {
    a = members(value, ["did", "verificationMethod", "versionId"], [], "state.author");
  } catch (error) {
    if (error instanceof OriginalsError) invalid("STATE_AUTHOR", error.message);
    throw error;
  }
  if (typeof a.did !== "string" || typeof a.verificationMethod !== "string" || typeof a.versionId !== "string") {
    invalid("STATE_AUTHOR", "state.author members must be strings");
  }
  return a as unknown as AuthorRef;
}

export function checkAsset(value: unknown): AssetState {
  const a = members(value, ["name", "status", "resources", "aliases"], ["metadata"], "state.asset");
  if (typeof a.name !== "string" || a.name.length === 0 || a.name.length > ORIGINALS_LIMITS.nameLength) {
    invalid("STATE_NAME", `the name must be a string of 1 to ${ORIGINALS_LIMITS.nameLength} characters`);
  }
  if (a.metadata !== undefined && !isJsonObject(a.metadata)) invalid("STATE_METADATA", "metadata must be an object when present");
  if (a.status !== "active" && a.status !== "deactivated") invalid("STATE_STATUS", "status must be active or deactivated");
  if (!Array.isArray(a.resources)) invalid("STATE_MEMBERS", "state.asset.resources must be an array");
  if (a.resources.length > ORIGINALS_LIMITS.resources) fail("limit-exceeded", "STATE_TOO_MANY_RESOURCES", `at most ${ORIGINALS_LIMITS.resources} resources`);
  const ids = new Set<string>();
  a.resources.forEach((r, i) => {
    const d = checkDescriptor(r, `state.asset.resources[${i}]`);
    if (ids.has(d.id)) invalid("STATE_RESOURCE", `resource ${d.id} is listed twice`);
    ids.add(d.id);
  });
  if (!Array.isArray(a.aliases) || !a.aliases.every((x) => typeof x === "string")) invalid("STATE_ALIASES", "aliases must be an array of DIDs");
  // PROVISIONAL (plan 011, PR 7b): at most one did:webvh alias. did:btco aliases arrive with anchoring (PR 9).
  for (const alias of a.aliases) {
    if (alias.startsWith("did:btco:")) fail("unsupported-profile", "STATE_ALIASES_UNSUPPORTED", "did:btco aliases arrive with anchoring (plan 011, PR 9)");
    if (!alias.startsWith("did:webvh:")) invalid("STATE_ALIASES", `${alias} is not a did:webvh alias`);
    try {
      parseDidWebvh(alias);
    } catch {
      invalid("STATE_ALIASES", `${alias} is not a valid did:webvh`);
    }
  }
  if (a.aliases.length > 1) invalid("STATE_ALIASES", "an Original lists at most one did:webvh alias");
  return a as unknown as AssetState;
}

/** The transitions an entry must list: every resource whose digest changed (P4.2, P4.4). */
export function expectedTransitions(previous: AssetState | undefined, next: AssetState): Transition[] {
  return next.resources.flatMap((r) => {
    const before = previous?.resources.find((p) => p.id === r.id);
    if (before && before.digest === r.digest) return [];
    return [{ resource: r.id, from: before?.digest ?? null, to: r.digest }];
  });
}

export interface EntryStateContext {
  scid: string;
  index: number;
  previous?: EntryState;
  deactivatedParameter: boolean;
}

/** Validate an entry's state against the Originals rules and its predecessor. */
export function checkEntryState(state: JsonObject, ctx: EntryStateContext): EntryState {
  const s = members(state, ["id", "operation", "author", "asset", "transitions"], [], "state");
  if (s.id !== `did:vh:${ctx.scid}`) invalid("STATE_ID", "state.id must be the Original's did:vh");
  const operation = s.operation;
  if (typeof operation !== "string") invalid("STATE_OPERATION", "operation must be a string");
  if (LATER_OPERATIONS.has(operation)) fail("unsupported-profile", "STATE_OPERATION_UNSUPPORTED", `${operation} is not supported by this verifier yet`);
  if (ctx.index === 0 ? operation !== "create" : operation !== "update" && operation !== "deactivate") {
    invalid("STATE_OPERATION", ctx.index === 0 ? "the first entry must be a create" : "a later entry is an update or a deactivate");
  }
  checkAuthorRef(s.author);
  const asset = checkAsset(s.asset);

  // PROVISIONAL (plan 011, PR 7b): layers move one way. An Original starts local, and
  // once published keeps a did:webvh alias, moving only within that alias's SCID (P9.3).
  if (ctx.index === 0 && asset.aliases.length > 0) invalid("STATE_ALIASES", "an Original starts local: genesis lists no alias");
  const before = ctx.previous?.asset.aliases[0];
  if (before !== undefined) {
    const now = asset.aliases[0];
    if (now === undefined) invalid("STATE_ALIASES", "a published Original keeps its did:webvh alias");
    if (parseDidWebvh(now).scid !== parseDidWebvh(before).scid) invalid("STATE_ALIASES", "a did:webvh alias moves only within its own SCID (P9.3)");
  }

  // Deactivation agrees in both directions (P6.5).
  const deactivating = operation === "deactivate";
  if (deactivating !== ctx.deactivatedParameter || deactivating !== (asset.status === "deactivated")) {
    invalid("STATE_DEACTIVATION", "operation deactivate, status deactivated and VH deactivated: true must agree");
  }

  // The resource set is fixed at genesis (P4.1).
  const previous = ctx.previous?.asset;
  if (previous) {
    const was = previous.resources.map((r) => r.id).join("\n");
    const now = asset.resources.map((r) => r.id).join("\n");
    if (was !== now) invalid("STATE_RESOURCE_SET", "resources cannot be added, removed, renamed or reordered after genesis");
    for (const r of asset.resources) {
      const before = previous.resources.find((p) => p.id === r.id)!;
      if (before.digest === r.digest && (before.mediaType !== r.mediaType || before.size !== r.size)) {
        invalid("STATE_RESOURCE", `resource ${r.id} changed its descriptor without changing its bytes`);
      }
    }
  } else if (asset.resources.length === 0) {
    invalid("STATE_RESOURCE_SET", "genesis must name at least one resource");
  }

  if (!Array.isArray(s.transitions)) invalid("STATE_MEMBERS", "state.transitions must be an array");
  s.transitions.forEach((t, i) => {
    const m = members(t, ["resource", "from", "to"], [], `state.transitions[${i}]`);
    if (m.from !== null) checkDigest(m.from, `state.transitions[${i}].from`);
    checkDigest(m.to, `state.transitions[${i}].to`);
  });
  if (deactivating && s.transitions.length > 0) invalid("STATE_TRANSITIONS", "a deactivation changes no resource");
  if (canonicalize(s.transitions) !== canonicalize(expectedTransitions(previous, asset) as unknown as JsonValue)) {
    invalid("STATE_TRANSITIONS", "transitions must list exactly the resources whose digest changed, in resource order");
  }
  return s as unknown as EntryState;
}
