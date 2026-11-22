/**
 * did:og entry state (P14.4–P14.7) and the transition rules between an entry
 * and its parent: the resource and its versions (P4.1–P4.4, P14.6), editors
 * and grants (P5.15, P5.16), deactivation (P6.5), previews and body modes
 * (P9.30, P14.5), aliases and anchoring (P3.9, P9.10, P9.34) and `supersedes`
 * (P6.9, P14.4). Signer binding and authority labels are the verifier's; this
 * module judges what an entry's own bytes and its branch say.
 */
import { isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";
import { parseDidWebvh } from "../webvh/index.js";
import { isDeactivation, isDigest, type OgEntry } from "./log.js";
import { OG_LIMITS, reject } from "./rules.js";

export type BitcoinNetwork = "mainnet" | "signet" | "testnet" | "regtest";
export const NETWORKS: readonly BitcoinNetwork[] = ["mainnet", "signet", "testnet", "regtest"];
/** P14.5, P9.10: the did:btco prefix of each network. PROVISIONAL (the did:btco method does not yet define them, S30). */
export const NETWORK_PREFIX: Readonly<Record<BitcoinNetwork, string>> = { mainnet: "", signet: "sig:", testnet: "test:", regtest: "reg:" };
export const MAX_SAT = 2_099_999_997_689_999n;

export interface SignerRef {
  did: string;
  verificationMethod: string;
  versionId: string;
}

export interface Descriptor {
  mediaType: string;
  size: number;
  digest: string;
}

export interface Grant {
  did: string;
  name: boolean;
  metadata: boolean;
  resource: boolean;
}

export type BodyMode = "preview" | "full" | "none";

export interface Asset {
  name: string;
  status: "active" | "deactivated";
  network: BitcoinNetwork;
  resource: Descriptor;
  aliases: string[];
  metadata?: JsonObject;
  editors?: Grant[];
  preview?: Descriptor;
  body?: BodyMode;
}

export interface OgState {
  id: string;
  operation: "create" | "update" | "deactivate";
  author: SignerRef;
  editor?: SignerRef;
  asset: Asset;
  transitions: Array<{ from: string | null; to: string }>;
  supersedes?: string[];
}

export const stateOf = (entry: OgEntry): OgState => entry.state as unknown as OgState;

// ---------------------------------------------------------------------------
// DIDs

export type SignerMethod = "did:webvh" | "did:vh" | "did:btco";

/** P5.8: the signer DID methods the baseline profile lists. */
export function signerMethodOf(did: string): SignerMethod | undefined {
  if (did.startsWith("did:webvh:")) return "did:webvh";
  if (/^did:vh:[1-9A-HJ-NP-Za-km-z]+$/.test(did)) return "did:vh";
  if (did.startsWith("did:btco:")) return "did:btco";
  return undefined;
}

export interface BtcoDid {
  did: string;
  network: BitcoinNetwork;
  sat: bigint;
}

/** P9.10, P14.12: `did:btco:` with an optional `sig:`, `test:` or `reg:`, then a sat number with no sign or leading zero, within the supply. */
export function parseBtco(did: string): BtcoDid | undefined {
  const m = /^did:btco:((sig|test|reg):)?(0|[1-9][0-9]{0,15})$/.exec(did);
  if (!m) return undefined;
  const sat = BigInt(m[3]);
  if (sat > MAX_SAT) return undefined;
  const network = ({ "": "mainnet", "sig:": "signet", "test:": "testnet", "reg:": "regtest" } as const)[(m[1] ?? "") as "" | "sig:" | "test:" | "reg:"];
  return { did, network, sat };
}

export function btcoDid(network: BitcoinNetwork, sat: bigint | number | string): string {
  return `did:btco:${NETWORK_PREFIX[network]}${String(sat)}`;
}

/**
 * The identity key of a DID for uniqueness and exclusion checks (P5.14,
 * P5.15): a did:webvh is its SCID, whatever its location; other DIDs are
 * themselves.
 */
export function identityKey(did: string): string {
  if (did.startsWith("did:webvh:")) {
    try {
      return `did:webvh:${parseDidWebvh(did).scid}`;
    } catch {
      return did;
    }
  }
  return did;
}

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._%-]$/;

// ---------------------------------------------------------------------------
// Shapes

function exactly(value: JsonValue | undefined, members: readonly string[], rule: string, what: string): JsonObject {
  if (!isJsonObject(value)) reject(rule, "STATE_SHAPE", `${what} must be an object`);
  const keys = Object.keys(value).sort();
  const want = [...members].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) reject(rule, "STATE_MEMBERS", `${what} has exactly ${members.join(", ")}`);
  return value;
}

function checkSignerRef(value: JsonValue | undefined, what: string): SignerRef {
  if (Array.isArray(value)) reject("P14.4", "AUTHOR_ARRAY", `${what} is one signer reference, not an array (D13)`);
  const ref = exactly(value, ["did", "verificationMethod", "versionId"], "P14.4", what);
  if (typeof ref.did !== "string" || typeof ref.verificationMethod !== "string" || typeof ref.versionId !== "string") {
    reject("P5.1", "SIGNER_REF", `${what}'s did, verificationMethod and versionId are strings`);
  }
  if (!signerMethodOf(ref.did)) reject("P5.8", "SIGNER_METHOD", `${what} ${ref.did} uses a DID method the profile does not list`);
  return ref as unknown as SignerRef;
}

/** P14.6: `type/subtype` without parameters. */
export function isMediaType(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(value);
}

export function checkDescriptor(value: JsonValue | undefined, what: string, rule = "P14.6"): Descriptor {
  if (isJsonObject(value) && "algorithm" in value) reject("P4.2", "DIGEST_ALGORITHM", `${what} names a digest algorithm outside the pinned set`);
  const d = exactly(value, ["digest", "mediaType", "size"], rule, what);
  if (!isMediaType(d.mediaType)) reject(rule, "MEDIA_TYPE", `${what}'s mediaType is type/subtype with no parameters`);
  if (typeof d.size !== "number" || !Number.isSafeInteger(d.size) || d.size < 0) reject(rule, "DESCRIPTOR_SIZE", `${what}'s size is a non-negative integer`);
  if (!isDigest(d.digest)) reject("P14.7", "DIGEST_ENCODING", `${what}'s digest is not a z-base58btc SHA-256 multihash`);
  return d as unknown as Descriptor;
}

function utf16Length(text: string): number {
  return text.length;
}

const isImage = (mediaType: string) => mediaType.split("/")[0].toLowerCase() === "image";

/** P14.4, P14.5, P14.6, P5.15: an entry's state, alone. */
export function checkStateShape(entry: OgEntry, index: number): OgState {
  const raw = entry.state;
  const keys = Object.keys(raw);
  const allowed = new Set(["id", "operation", "author", "asset", "transitions", "editor", "supersedes"]);
  for (const k of keys) if (!allowed.has(k)) reject("P14.4", "STATE_MEMBERS", `state member ${k} is not defined`);
  for (const k of ["id", "operation", "author", "asset", "transitions"]) if (!(k in raw)) reject("P14.4", "STATE_MEMBERS", `state has no ${k}`);
  if ("editor" in raw && "supersedes" in raw) reject("P6.9", "EDITOR_SUPERSEDES", "an editor entry has no supersedes (P14.4)");
  if (index === 0 && "editor" in raw) reject("P5.16", "GENESIS_EDITOR", "only an author entry may be the genesis entry");
  if (typeof raw.id !== "string") reject("P14.4", "STATE_ID", "state.id is a string");
  const op = raw.operation;
  if (index === 0 ? op !== "create" : op !== "update" && op !== "deactivate") reject("P14.4", "OPERATION", `operation ${JSON.stringify(op)} is not allowed here`);
  checkSignerRef(raw.author, "author");
  if ("editor" in raw) checkSignerRef(raw.editor, "editor");

  const a = raw.asset;
  if (!isJsonObject(a)) reject("P14.4", "ASSET", "asset is an object");
  for (const k of ["authors", "parent", "readers"]) if (k in a) reject("P14.4", "ASSET_ADDITION", `asset.${k} is defined only by the experimental additions (D13)`);
  const assetAllowed = new Set(["name", "status", "network", "resource", "aliases", "metadata", "editors", "preview", "body"]);
  for (const k of Object.keys(a)) if (!assetAllowed.has(k)) reject("P14.4", "ASSET_MEMBERS", `asset member ${k} is not defined`);
  if (!("resource" in a)) reject("P4.1", "NO_RESOURCE", "the state has no resource");
  if (Array.isArray(a.resource)) reject("P4.1", "RESOURCES", "the state has exactly one resource");
  for (const k of ["name", "status", "network", "aliases"]) if (!(k in a)) reject(k === "network" ? "P9.34" : "P14.5", "ASSET_MEMBERS", `asset has no ${k}`);
  if (typeof a.name !== "string") reject("P4.6", "NAME", "name is a string, never null");
  if (utf16Length(a.name) < 1 || utf16Length(a.name) > 1024) reject("P14.5", "NAME_LENGTH", "name is 1 to 1,024 UTF-16 code units");
  if ("metadata" in a && !isJsonObject(a.metadata)) reject("P14.5", "METADATA", "metadata is a JSON object");
  if (a.status !== "active" && a.status !== "deactivated") reject("P14.5", "STATUS", "status is active or deactivated");
  if (typeof a.network !== "string" || !(NETWORKS as readonly string[]).includes(a.network)) reject("P9.34", "NETWORK", "network is mainnet, signet, testnet or regtest (P14.5)");
  const resource = checkDescriptor(a.resource, "resource");

  // Aliases (P14.5, P3.9).
  if (!Array.isArray(a.aliases)) reject("P14.5", "ALIASES", "aliases is an array");
  const seen = new Set<string>();
  let webvh = 0;
  let btco = 0;
  for (const alias of a.aliases) {
    if (typeof alias !== "string" || (!alias.startsWith("did:btco:") && !DID.test(alias))) reject("P3.9", "ALIASES", "every alias is a DID");
    if (seen.has(alias)) reject("P14.5", "ALIASES", `alias ${alias} is listed twice`);
    seen.add(alias);
    if (alias.startsWith("did:webvh:")) {
      try {
        parseDidWebvh(alias);
      } catch {
        reject("P14.5", "ALIASES", `${alias} is not a did:webvh`);
      }
      webvh++;
    } else if (alias.startsWith("did:btco:")) {
      if (!parseBtco(alias)) reject("P9.10", "BTCO_FORM", `${alias} is not a did:btco DID of this profile`);
      btco++;
    } else reject("P14.5", "ALIASES", `alias ${alias} is neither did:webvh nor did:btco`);
  }
  if (webvh > 1 || btco > 1) reject("P14.5", "ALIASES", "at most one did:webvh and one did:btco alias");
  if (index === 0 && a.aliases.length > 0) reject("P14.5", "GENESIS_ALIASES", "the genesis entry lists no alias");

  // Body mode and preview (P14.5, P9.30).
  if ("body" in a !== (btco > 0)) reject("P9.30", "BODY_PRESENCE", btco ? "an entry whose aliases list a did:btco DID signs its body mode" : "body is present only with a did:btco alias");
  if ("body" in a && a.body !== "preview" && a.body !== "full" && a.body !== "none") reject("P14.5", "BODY_MODE", "body is preview, full or none");
  if ("preview" in a) {
    if (!btco) reject("P9.30", "PREVIEW_UNANCHORED", "a preview is allowed only in an entry whose aliases list a did:btco DID");
    const p = checkDescriptor(a.preview, "preview", "P14.5");
    if (p.size < 1 || p.size > OG_LIMITS.previewBytes) reject("P9.30", "PREVIEW_SIZE", "a preview is 1 to 8,192 bytes (P14.5)");
    if (isImage(resource.mediaType) && p.mediaType !== "image/webp") reject("P9.30", "PREVIEW_TYPE", "the preview of an image version is image/webp");
  }
  if (("body" in a && a.body === "preview") !== "preview" in a) reject("P9.30", "BODY_PREVIEW", "body is preview exactly when preview is present (P14.5)");

  // Editors (P14.5, P5.15).
  if ("editors" in a) {
    if (!Array.isArray(a.editors) || a.editors.length === 0) reject("P5.15", "EDITORS_EMPTY", "editors is 1 to 32 grants; absence means none (P14.5)");
    if (a.editors.length > OG_LIMITS.editors) reject("P5.15", "EDITORS_LIMIT", "at most 32 editor grants (P14.13)", "limit-exceeded");
    const identities = new Set<string>();
    const author = (raw.author as JsonObject).did as string;
    for (const g of a.editors) {
      const grant = exactly(g, ["did", "metadata", "name", "resource"], "P14.5", "a grant");
      if (typeof grant.did !== "string" || typeof grant.name !== "boolean" || typeof grant.metadata !== "boolean" || typeof grant.resource !== "boolean") {
        reject("P14.5", "GRANT", "a grant's did is a string and its permissions booleans");
      }
      if (!signerMethodOf(grant.did)) reject("P5.15", "GRANT_METHOD", `editor ${grant.did} uses a DID method the profile does not list`);
      const key = identityKey(grant.did);
      if (identities.has(key)) reject("P5.15", "GRANT_DUPLICATE", `two grants name the identity of ${grant.did}`);
      identities.add(key);
      if (key === identityKey(author)) reject("P5.15", "GRANT_AUTHOR", "a grant names the author's identity");
      if (grant.did === raw.id || a.aliases.includes(grant.did)) reject("P5.15", "GRANT_SELF", "a grant names the Original or one of its aliases");
      if (a.aliases.some((x) => identityKey(x as string) === key)) reject("P5.15", "GRANT_SELF", "a grant names an alias of the Original");
    }
  }

  // Transitions (P14.4).
  if (!Array.isArray(raw.transitions) || raw.transitions.length > 1) reject("P14.4", "TRANSITIONS", "transitions has at most one item");
  for (const t of raw.transitions) {
    const tr = exactly(t, ["from", "to"], "P14.4", "a transition");
    if (!(tr.from === null || isDigest(tr.from)) || !isDigest(tr.to)) reject("P14.4", "TRANSITIONS", "a transition is {from, to} digests");
  }

  // supersedes (P14.4, P14.13).
  if ("supersedes" in raw) {
    const s = raw.supersedes;
    if (!Array.isArray(s) || s.length < 1 || s.length > OG_LIMITS.supersedes) reject("P14.4", "SUPERSEDES", "supersedes names 1 to 8 entries (P14.13)");
    if (!s.every((x) => typeof x === "string") || new Set(s).size !== s.length) reject("P14.4", "SUPERSEDES", "supersedes names distinct versionIds");
  }
  return raw as unknown as OgState;
}

// ---------------------------------------------------------------------------
// Branch context and transitions

/** What a branch of the log says before an entry: computed from its genesis through its parent. */
export interface BranchContext {
  genesis: OgEntry;
  /** The parent, or undefined for the genesis entry. */
  parent?: OgEntry;
  /** The resource version number at the parent (P4.4), 0 before genesis. */
  version: number;
  /** The anchoring entry's aliases, once the branch has one (P9.10). */
  anchoredAliases?: string[];
  /** did:webvh aliases that the anchored branch has removed, which may not return (P9.10). */
  removedWebvh: string[];
  /** Whether the branch is deactivated (P6.5). */
  deactivated: boolean;
}

export function genesisContext(genesis: OgEntry): BranchContext {
  return { genesis, version: 0, removedWebvh: [], deactivated: false };
}

/** The context after `entry`, which passed `checkTransition` in `ctx`. */
export function advance(ctx: BranchContext, entry: OgEntry): BranchContext {
  const s = stateOf(entry);
  const next: BranchContext = {
    genesis: ctx.genesis,
    parent: entry,
    version: ctx.version + (s.transitions.length ? 1 : 0),
    anchoredAliases: ctx.anchoredAliases,
    removedWebvh: [...ctx.removedWebvh],
    deactivated: ctx.deactivated || s.asset.status === "deactivated",
  };
  if (!ctx.anchoredAliases && s.asset.aliases.some((a) => a.startsWith("did:btco:"))) next.anchoredAliases = [...s.asset.aliases];
  if (ctx.anchoredAliases && ctx.parent) {
    for (const a of stateOf(ctx.parent).asset.aliases) if (a.startsWith("did:webvh:") && !s.asset.aliases.includes(a) && !next.removedWebvh.includes(a)) next.removedWebvh.push(a);
  }
  return next;
}

export const isEditorEntry = (entry: OgEntry): boolean => "editor" in entry.state;

/** Whether this entry is the branch's anchoring entry: the first whose aliases list a did:btco DID (P9.10). */
export function isAnchoringEntry(ctx: BranchContext, entry: OgEntry): boolean {
  return !ctx.anchoredAliases && stateOf(entry).asset.aliases.some((a) => a.startsWith("did:btco:"));
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

/**
 * Check `entry`'s state in its branch context: its shape, then every rule
 * that relates it to the genesis entry and its parent. Throws an OgRuleError
 * naming the rule it breaks.
 */
export function checkTransition(ctx: BranchContext, entry: OgEntry, index: number): OgState {
  const s = checkStateShape(entry, index);
  const scid = ctx.genesis.parameters.scid as string;
  if (s.id !== `did:og:${scid}`) reject("P3.1", "STATE_ID", "state.id is not did:og and the SCID (P14.4)");
  const deactivation = index > 0 && isDeactivation(entry);
  if ((s.operation === "deactivate") !== deactivation || (s.asset.status === "deactivated") !== deactivation) {
    reject("P6.5", "DEACTIVATION_MISMATCH", "operation, the deactivated parameter and status agree");
  }
  const resource = s.asset.resource;
  if (index === 0) {
    if (!same(s.transitions, [{ from: null, to: resource.digest }])) reject("P14.4", "TRANSITIONS", "the genesis entry's transition is {from: null, to}");
    return s;
  }
  const parent = ctx.parent!;
  const p = stateOf(parent);
  if (ctx.deactivated) reject("P6.5", "AFTER_DEACTIVATION", "no entry follows a deactivation on its branch");
  if (s.author.did !== p.author.did) reject("P5.8", "AUTHOR_CHANGED", "the author DID is fixed at genesis");
  if (s.asset.network !== stateOf(ctx.genesis).asset.network) reject("P9.34", "NETWORK_CHANGED", "every entry carries the genesis network unchanged (P14.5)");

  // Resource and transitions (P14.4, P14.6, P4.4).
  const pr = p.asset.resource;
  const digestChanged = resource.digest !== pr.digest;
  const typeChanged = resource.mediaType !== pr.mediaType;
  if (!digestChanged && resource.size !== pr.size) reject("P14.6", "SIZE_WITHOUT_DIGEST", "size does not change unless digest changes");
  const want = digestChanged || typeChanged ? [{ from: pr.digest, to: resource.digest }] : [];
  if (!same(s.transitions, want)) reject("P14.4", "TRANSITIONS", digestChanged || typeChanged ? "a changed resource carries {from, to}" : "an entry that does not change the resource carries no transition");

  // Aliases and anchoring (P9.10, P9.34, P5.13).
  const btco = s.asset.aliases.find((a) => a.startsWith("did:btco:"));
  const network = s.asset.network;
  if (btco && parseBtco(btco)!.network !== network) reject("P9.34", "BTCO_NETWORK", "the did:btco alias names a sat on the genesis network (P9.10)");
  if (btco && s.author.did === btco) reject("P5.13", "AUTHOR_SAT", "the anchoring sat is not the author DID's own sat (T9-023)");
  if (btco && s.asset.editors?.some((g) => g.did === btco)) reject("P5.15", "GRANT_SAT", "a grant names the anchoring sat's did:btco");
  if (ctx.anchoredAliases) {
    const anchoredBtco = ctx.anchoredAliases.find((a) => a.startsWith("did:btco:"))!;
    if (btco !== anchoredBtco) reject("P9.10", "BTCO_CHANGED", "after anchoring every entry keeps the did:btco alias");
    for (const a of s.asset.aliases) {
      if (!a.startsWith("did:webvh:")) continue;
      if (!ctx.anchoredAliases.includes(a)) reject("P9.10", "WEBVH_AFTER_ANCHOR", "after anchoring no entry adds a did:webvh alias the anchoring entry did not list");
      const wasRemoved = ctx.removedWebvh.includes(a) || !p.asset.aliases.includes(a);
      if (wasRemoved) reject("P9.10", "WEBVH_READDED", "a removed did:webvh alias is not added again");
    }
  }

  // Previews (P9.30).
  const anchoring = isAnchoringEntry(ctx, entry);
  if (!anchoring && !digestChanged && s.asset.preview && !same(s.asset.preview, p.asset.preview)) {
    reject("P9.30", "PREVIEW_CHANGED", p.asset.preview ? "an entry that does not change the digest carries its parent's preview or none" : "no preview is named until an entry changes the digest");
  }

  // Editor entries (P5.16).
  if (s.editor) {
    if (s.operation !== "update") reject("P5.16", "EDITOR_OPERATION", "an editor entry's operation is update");
    if (!same(s.author, p.author)) reject("P5.16", "EDITOR_AUTHOR", "an editor entry's author reference equals its parent's");
    const grant = p.asset.editors?.find((g) => g.did === s.editor!.did);
    if (!grant) reject("P5.17", "NO_GRANT", `the parent grants ${s.editor.did} nothing`);
    const allowedChanges = new Set<string>();
    if (grant.name) allowedChanges.add("name");
    if (grant.metadata) allowedChanges.add("metadata");
    if (grant.resource) for (const k of ["resource", "preview", "body"]) allowedChanges.add(k);
    const keys = new Set([...Object.keys(s.asset), ...Object.keys(p.asset)]);
    for (const k of keys) {
      const a = (s.asset as unknown as Record<string, unknown>)[k];
      const b = (p.asset as unknown as Record<string, unknown>)[k];
      if (same(a, b)) continue;
      if (!allowedChanges.has(k)) reject(k === "body" || k === "preview" ? "P9.30" : "P5.16", "OUTSIDE_GRANT", `the editor's grant does not allow changing ${k}`, "outside-grant");
    }
    // A preview or body change goes with a new version only (P9.30, P5.16).
    if (!digestChanged && !typeChanged && (!same(s.asset.preview, p.asset.preview) || !same(s.asset.body, p.asset.body))) {
      reject("P9.30", "EDITOR_PREVIEW", "an editor entry that does not change the resource carries its parent's preview and body unchanged");
    }
  }
  return s;
}
