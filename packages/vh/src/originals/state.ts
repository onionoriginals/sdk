/**
 * The Originals asset state (plan 011 section 2.1). Every name, member and
 * encoding here is PROVISIONAL: the spec leaves the asset state schema and the
 * entry fields open (D1, D4). Each entry's state holds the full asset state,
 * never a delta, alongside the signed fields P5.1 requires.
 */
import { multibaseDecode, multibaseEncode, sha256Multihash, sha256MultihashAsync, decodeSha256Multihash } from "../crypto/index.js";
import { OriginalsError, fail } from "../errors.js";
import { canonicalize, isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";
import { parseDidWebvh } from "../webvh/index.js";
import { parseBtcoAlias } from "./btco.js";
import { LAYER_RANK, checkAnchor, evmAliasOf, layerOfAnchor, parseEvmAlias, tokenIdOf, type EvmAnchor, type EvmAnchorPin } from "./evm.js";

/** PROVISIONAL (D1): the extension's method value; it implies vh-log:1.0. */
export const ORIGINALS_METHOD = "originals:1.0";

/**
 * The profile's limits (P7.7, P14.13), decided by the owner on 21 October 2026
 * (D4, D6; originals-spec #50). There is no resource limit: an Original is
 * exactly one resource (P4.1; owner decision, 1 November 2026,
 * originals-spec #53). `nameLength` counts UTF-16 code units (P14.5,
 * decided in originals-spec #51).
 */
export const ORIGINALS_LIMITS = Object.freeze({
  entries: 10_000,
  entryBytes: 65_536,
  nameLength: 1_024,
  authorVersions: 1_000,
  /** Editor grants in one asset state (P5.15, P7.7). */
  editors: 32,
});

export type Operation = "create" | "update" | "deactivate";
/*
 * There are no publish or migrate operations (P9.10; P14.4, PROVISIONAL,
 * section 14): publication is an update that lists a did:webvh alias,
 * and anchoring is an update that lists the sat's did:btco alias.
 */

/**
 * The descriptor of the Original's one resource at a version (P4.1, P4.2,
 * P14.6; originals-spec #53): exactly `{mediaType, size, digest}`.
 */
export interface ResourceDescriptor {
  mediaType: string;
  size: number;
  /** A sha2-256 multihash (P14.7, decided), multibase base58btc (the encoding is PROVISIONAL, D4). */
  digest: string;
}

/**
 * An editor grant (P5.15). PROVISIONAL member names (D4): one editor DID and
 * exactly which content it may change: the name, the metadata, and new
 * versions of the Original's one resource (originals-spec #53).
 */
export interface EditorGrant {
  did: string;
  name: boolean;
  metadata: boolean;
  resource: boolean;
}

export interface AssetState {
  name: string;
  metadata?: JsonObject;
  status: "active" | "deactivated";
  /** The Original's one resource, at its version in this entry (P4.1, P14.5). */
  resource: ResourceDescriptor;
  aliases: string[];
  /** The editor grants (P5.15). Absent means no editors; PROVISIONAL: an empty list is not used. */
  editors?: EditorGrant[];
  /**
   * The anchor chain and minter (P14.18, P9.19; originals-spec PR 59,
   * proposed, EXPERIMENTAL). Absent means the anchor chain is Bitcoin.
   */
  anchor?: EvmAnchor;
}

/** The author DID, its verification method and its exact versionId (P5.1). */
export interface AuthorRef {
  did: string;
  verificationMethod: string;
  versionId: string;
}

/** An editor entry's editor reference: the editor DID, its verification method and exact versionId (P5.16). */
export type EditorRef = AuthorRef;

/**
 * A resource transition (P14.4; originals-spec #53): `from` is the previous
 * digest, or null in the genesis entry; `to` is the new digest. An entry lists
 * at most one.
 */
export interface Transition {
  from: string | null;
  to: string;
}

export interface EntryState {
  id: string;
  operation: Operation;
  author: AuthorRef;
  /** Present only in an editor entry (P5.16). */
  editor?: EditorRef;
  asset: AssetState;
  transitions: Transition[];
}

/** The identity that signs an entry: its editor for an editor entry, otherwise its author (P5.2, P5.16). */
export function signerOf(state: EntryState): { role: "author" | "editor"; ref: AuthorRef } {
  return state.editor ? { role: "editor", ref: state.editor } : { role: "author", ref: state.author };
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

/**
 * `resourceDigest` with the platform's native SHA-256 when there is one
 * (`sha256Async`): the same digest, much faster on a large resource. Use it
 * wherever the caller can await.
 */
export async function resourceDigestAsync(bytes: Uint8Array): Promise<string> {
  return multibaseEncode(await sha256MultihashAsync(bytes));
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

// RFC 6838 type/subtype, without parameters (PROVISIONAL).
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

export function checkDescriptor(value: unknown, where: string): ResourceDescriptor {
  let d: JsonObject;
  try {
    d = members(value, ["mediaType", "size", "digest"], [], where);
  } catch (error) {
    if (error instanceof OriginalsError) invalid("STATE_RESOURCE", `${error.message}: a resource descriptor is exactly {mediaType, size, digest} (P14.6)`);
    throw error;
  }
  if (typeof d.mediaType !== "string" || !MEDIA_TYPE.test(d.mediaType)) invalid("STATE_RESOURCE", `${where}.mediaType is not a media type`);
  if (typeof d.size !== "number" || !Number.isSafeInteger(d.size) || d.size < 0) invalid("STATE_RESOURCE", `${where}.size must be a non-negative integer`);
  checkDigest(d.digest, `${where}.digest`);
  return d as unknown as ResourceDescriptor;
}

function checkRef(value: unknown, where: "author" | "editor"): AuthorRef {
  const code = where === "author" ? "STATE_AUTHOR" : "STATE_EDITOR";
  let a: JsonObject;
  try {
    a = members(value, ["did", "verificationMethod", "versionId"], [], `state.${where}`);
  } catch (error) {
    if (error instanceof OriginalsError) invalid(code, error.message);
    throw error;
  }
  if (typeof a.did !== "string" || typeof a.verificationMethod !== "string" || typeof a.versionId !== "string") {
    invalid(code, `state.${where} members must be strings`);
  }
  return a as unknown as AuthorRef;
}

export function checkAuthorRef(value: unknown): AuthorRef {
  return checkRef(value, "author");
}

export function checkEditorRef(value: unknown): EditorRef {
  return checkRef(value, "editor");
}

/** The signer DID methods the baseline profile lists (P5.8, P5.15). */
const LISTED_METHODS = ["did:vh:", "did:webvh:", "did:btco:"];

function scidOfWebvh(did: string): string | undefined {
  try {
    return parseDidWebvh(did).scid;
  } catch {
    return undefined;
  }
}

const DID_VH = /^did:vh:[1-9A-HJ-NP-Za-km-z]{46}$/;
// did:btco[:sig|:test|:reg]:<sat>, a canonical decimal sat number within the supply (did:btco v0.2.0;
// P9.10, P14.12). The method does not yet define the network prefixes: proposed upstream as
// decentralized-identity/labs-ordinals-plus#4 [S30].
const DID_BTCO = /^did:btco:(?:(?:sig|test|reg):)?(0|[1-9]\d{0,15})$/;
const MAX_SAT = 2_099_999_997_689_999n;

/** True when `did` is a well-formed DID of a listed method, with no path, query or fragment (P5.15). */
function wellFormedSigner(did: string): boolean {
  if (/[?#/]/.test(did)) return false;
  if (did.startsWith("did:vh:")) return DID_VH.test(did);
  if (did.startsWith("did:webvh:")) return scidOfWebvh(did) !== undefined;
  const sat = DID_BTCO.exec(did)?.[1];
  return sat !== undefined && BigInt(sat) <= MAX_SAT;
}

/**
 * P5.15: the editor grants. Each editor DID is unique, uses a listed method,
 * and is neither the author DID nor a DID of the author's identity: for a
 * did:webvh author, any did:webvh with its SCID, which is the author's DID at
 * another location after a move (P5.14). Each grant says, as booleans,
 * whether the editor may change the name, the metadata and the resource:
 * `resource` allows new versions of the Original's one resource (P5.15;
 * originals-spec #53). The number of grants is limited (P7.7).
 */
function checkEditors(value: unknown, authorDid: string | undefined): EditorGrant[] {
  const bad: (message: string) => never = (message) => invalid("STATE_EDITORS", message);
  if (!Array.isArray(value)) bad("state.asset.editors must be an array of grants");
  if (value.length === 0) bad("state.asset.editors is omitted when there are no editors (PROVISIONAL)");
  if (value.length > ORIGINALS_LIMITS.editors) fail("limit-exceeded", "STATE_TOO_MANY_EDITORS", `at most ${ORIGINALS_LIMITS.editors} editor grants (P7.7)`);
  const seen = new Set<string>();
  const authorScid = authorDid?.startsWith("did:webvh:") ? scidOfWebvh(authorDid) : undefined;
  return value.map((item, i) => {
    let g: JsonObject;
    try {
      g = members(item, ["did", "name", "metadata", "resource"], [], `state.asset.editors[${i}]`);
    } catch (error) {
      if (error instanceof OriginalsError) bad(`state.asset.editors[${i}]: ${error.message}`);
      throw error;
    }
    if (typeof g.did !== "string" || !/^did:[a-z0-9]+:\S+$/.test(g.did)) bad(`state.asset.editors[${i}].did is not a DID`);
    const did = g.did;
    // The author's DID with a path, query or fragment still names the author's identity.
    const bare = did.replace(/[?#/].*$/, "");
    if (bare === authorDid || (authorScid !== undefined && scidOfWebvh(bare) === authorScid)) bad("an editor cannot be the author DID or a DID of the author's identity (P5.14, P5.15)");
    if (!LISTED_METHODS.some((m) => did.startsWith(m))) bad(`editor DID ${did} uses a method the profile does not list (P5.8)`);
    if (!wellFormedSigner(did)) bad(`editor DID ${did} is not a well-formed DID of its method, with no path, query or fragment`);
    // One identity, one grant: a did:webvh at two locations is one identity (P5.14).
    const identity = did.startsWith("did:webvh:") ? `did:webvh:${scidOfWebvh(did)}` : did;
    if (seen.has(identity)) bad(`editor DID ${did} is granted twice (one grant per identity, P5.14)`);
    seen.add(identity);
    if (typeof g.name !== "boolean" || typeof g.metadata !== "boolean" || typeof g.resource !== "boolean") {
      bad(`state.asset.editors[${i}].name, .metadata and .resource are booleans (P14.5)`);
    }
    return g as unknown as EditorGrant;
  });
}

/** Check an asset state. `authorDid` enables the grant rules that depend on it (P5.15). */
export function checkAsset(value: unknown, authorDid?: string): AssetState {
  const a = members(value, ["name", "status", "resource", "aliases"], ["metadata", "editors", "anchor"], "state.asset");
  const anchor = a.anchor === undefined ? undefined : checkAnchor(a.anchor);
  if (typeof a.name !== "string" || a.name.length === 0 || a.name.length > ORIGINALS_LIMITS.nameLength) {
    invalid("STATE_NAME", `the name must be a string of 1 to ${ORIGINALS_LIMITS.nameLength} UTF-16 code units (P14.5)`);
  }
  if (a.metadata !== undefined && !isJsonObject(a.metadata)) invalid("STATE_METADATA", "metadata must be an object when present");
  if (a.status !== "active" && a.status !== "deactivated") invalid("STATE_STATUS", "status must be active or deactivated");
  // P4.1, P14.5 (originals-spec #53): exactly one resource, a descriptor, never none and never a list.
  if (!isJsonObject(a.resource)) invalid("STATE_RESOURCE", "state.asset.resource is the descriptor of the Original's one resource: an Original has exactly one (P4.1)");
  checkDescriptor(a.resource, "state.asset.resource");
  if (!Array.isArray(a.aliases) || !a.aliases.every((x) => typeof x === "string")) invalid("STATE_ALIASES", "aliases must be an array of DIDs");
  // PROVISIONAL (plan 011 PR 7b, plan 012 §3.1): at most one did:webvh alias and one did:btco alias;
  // with an `anchor` member, one did:webvh and one did:evm token alias instead, no DID of another
  // method and no DID twice (P14.5, P9.19, P3.9; originals-spec PR 59, proposed).
  let webvh = 0;
  let btco = 0;
  let evm = 0;
  if (new Set(a.aliases).size !== a.aliases.length) invalid("STATE_ALIASES", "aliases lists no DID twice (P14.5)");
  for (const alias of a.aliases) {
    if (alias.startsWith("did:btco:")) {
      if (anchor) invalid("STATE_ALIASES", "an entry with an anchor member lists no did:btco alias (P9.19)");
      parseBtcoAlias(alias);
      btco++;
      continue;
    }
    if (alias.startsWith("did:evm:")) {
      if (!anchor) invalid("STATE_ALIASES", "an Original without an anchor member lists no token alias (P9.19)");
      const t = parseEvmAlias(alias);
      if (t.chain !== anchor.chain) invalid("STATE_ALIASES", `the token alias ${alias} is not on the anchor chain ${anchor.chain} (P9.19)`);
      evm++;
      continue;
    }
    if (!alias.startsWith("did:webvh:")) invalid("STATE_ALIASES", `${alias} is not a did:webvh, did:btco or did:evm alias (P14.5)`);
    try {
      parseDidWebvh(alias);
    } catch {
      invalid("STATE_ALIASES", `${alias} is not a valid did:webvh`);
    }
    webvh++;
  }
  if (webvh > 1 || btco > 1 || evm > 1) invalid("STATE_ALIASES", "an Original lists at most one did:webvh alias and one did:btco or token alias (P14.5)");
  // P9.26: with an anchor member, no did:btco author or editor: nothing orders did:btco versions against an EVM chain.
  if (anchor) {
    if (authorDid?.startsWith("did:btco:")) invalid("STATE_ANCHOR_BTCO_SIGNER", "an entry with an anchor member names no did:btco author (P9.26)");
    if (Array.isArray(a.editors) && a.editors.some((g) => isJsonObject(g) && typeof g.did === "string" && g.did.startsWith("did:btco:"))) {
      invalid("STATE_ANCHOR_BTCO_SIGNER", "an entry with an anchor member grants no did:btco editor (P9.26)");
    }
  }
  if (a.editors !== undefined) checkEditors(a.editors, authorDid);
  return a as unknown as AssetState;
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined) => canonicalize(a ?? null) === canonicalize(b ?? null);

/**
 * P5.16, P5.17: an editor entry, checked against its parent. The grant is
 * the parent's; the author reference is the parent's; the operation is
 * update; and only the name, metadata and resource descriptor the grant
 * allows change. Grants, aliases and lifecycle are the author's.
 */
export function checkEditorEntry(editor: EditorRef, operation: string, author: AuthorRef, asset: AssetState, previous: EntryState | undefined): void {
  const authorOnly: (message: string) => never = (message) => fail("outside-grant", "EDITOR_AUTHOR_ONLY", `${message}; only an author entry may (P5.16)`);
  if (!previous) authorOnly("an editor entry cannot be the genesis entry");
  if (operation !== "update") authorOnly("an editor entry is an update; it cannot deactivate");
  const grant = previous.asset.editors?.find((g) => g.did === editor.did);
  if (!grant) fail("unauthorized-key", "EDITOR_NOT_GRANTED", `${editor.did} has no grant in the parent's state (P5.16, P5.17)`);
  if (!same(author as unknown as JsonValue, previous.author as unknown as JsonValue)) {
    invalid("EDITOR_AUTHOR_CHANGED", "an editor entry's author reference must equal its parent's (P5.16)");
  }
  const before = previous.asset;
  if (!same(asset.editors as unknown as JsonValue, before.editors as unknown as JsonValue)) authorOnly("an editor entry cannot change the editor grants");
  if (!same(asset.aliases, before.aliases)) authorOnly("an editor entry cannot change aliases");
  if (asset.status !== before.status) authorOnly("an editor entry cannot change the lifecycle status");
  const outside: (what: string) => never = (what) => fail("outside-grant", "EDITOR_OUTSIDE_GRANT", `${editor.did} is not granted ${what} (P5.16)`);
  if (asset.name !== before.name && !grant.name) outside("the name");
  if (!same(asset.metadata, before.metadata) && !grant.metadata) outside("the metadata");
  if (!same(asset.resource as unknown as JsonValue, before.resource as unknown as JsonValue) && !grant.resource) outside("the resource");
}

/**
 * The transitions an entry must list (P4.2, P4.4, P14.4; originals-spec #53):
 * `[{from: null, to}]` in the genesis entry, `[{from, to}]` in a later entry
 * that changes the resource's digest, and `[]` in any other entry, a
 * deactivation included.
 */
export function expectedTransitions(previous: AssetState | undefined, next: AssetState): Transition[] {
  if (previous && previous.resource.digest === next.resource.digest) return [];
  return [{ from: previous?.resource.digest ?? null, to: next.resource.digest }];
}

export interface EntryStateContext {
  scid: string;
  index: number;
  previous?: EntryState;
  deactivatedParameter: boolean;
  /**
   * Whether to apply the editor-entry rules here (default true). The VH-Log
   * engine applies them first, through the specialisation's editor hook
   * (`checkEditorChange`; VH-Log PR 11, "Editors from a Controller" [S25]).
   */
  editorRules?: boolean;
  /**
   * The P14.21 anchor contract pin, when the caller has one (EXPERIMENTAL; the
   * spec pins none). With it, a token alias's contract address is checked and
   * its chain list is used for move layers; without it, the address is not
   * checked here, and a verifier reports the Original unsupported (section 14).
   */
  evm?: EvmAnchorPin | null;
}

/** The members, id, operation, author reference and asset of an entry's state: what every later rule reads. */
function entryHead(state: JsonObject, ctx: EntryStateContext): { s: JsonObject; operation: string; author: AuthorRef; asset: AssetState } {
  const s = members(state, ["id", "operation", "author", "asset", "transitions"], ["editor"], "state");
  if (s.id !== `did:vh:${ctx.scid}`) invalid("STATE_ID", "state.id must be the Original's did:vh");
  const operation = s.operation;
  if (typeof operation !== "string") invalid("STATE_OPERATION", "operation must be a string");
  if (ctx.index === 0 ? operation !== "create" : operation !== "update" && operation !== "deactivate") {
    invalid("STATE_OPERATION", ctx.index === 0 ? "the first entry must be a create" : "a later entry is an update or a deactivate");
  }
  const author = checkAuthorRef(s.author);
  return { s, operation, author, asset: checkAsset(s.asset, author.did) };
}

/**
 * The editor-entry rules of P5.16 for an entry's state, after the state's
 * members, operation, author reference and asset are checked, and before
 * every other state rule: an editor's change outside its grant is reported as
 * that (outside-grant), whatever else it breaks. The Originals profile's
 * VH-Log PR 11 editor limit [S25].
 */
export function checkEditorChange(state: JsonObject, ctx: EntryStateContext): void {
  const { s, operation, author, asset } = entryHead(state, ctx);
  if (s.editor !== undefined) checkEditorEntry(checkEditorRef(s.editor), operation, author, asset, ctx.previous);
}

const sameAnchor = (a: EvmAnchor | undefined, b: EvmAnchor | undefined) => a?.chain === b?.chain && a?.minter === b?.minter;

/** Whether an entry is a move entry: it changes or removes its parent's `anchor` member (P9.28). */
export function isMoveEntry(asset: AssetState, previous: AssetState | undefined): boolean {
  return previous?.anchor !== undefined && !sameAnchor(previous.anchor, asset.anchor);
}

/**
 * P9.19, P9.28 (originals-spec PR 59, proposed, EXPERIMENTAL): the `anchor`
 * member is fixed at genesis and changed only by a move entry; a token alias
 * names the one token P14.19 derives; a move goes up a layer, is signed by
 * the author, comes after the anchoring entry, and lists the destination's
 * alias in place of the token left. Layers are judged here by the current
 * classes; a verifier that has the departure record's timestamp judges them
 * by the class that applied then (P9.28, `classAt`).
 */
function checkAnchorChange(s: JsonObject, asset: AssetState, ctx: EntryStateContext): void {
  const previous = ctx.previous?.asset;
  const id = s.id as string;
  const token = asset.aliases.find((x) => x.startsWith("did:evm:"));
  if (token !== undefined && asset.anchor) {
    const t = parseEvmAlias(token);
    if (t.tokenId !== tokenIdOf(id, asset.anchor.minter)) invalid("STATE_ANCHOR_TOKEN", `${token} is not the token P14.19 derives from this Original and its minter (P9.19)`);
    if (ctx.evm && t.contract !== ctx.evm.address) invalid("STATE_ANCHOR_TOKEN", `${token} names a contract other than the pinned anchor contract (P14.18, P14.21)`);
  }
  if (!previous) return;
  if (sameAnchor(previous.anchor, asset.anchor)) {
    const was = previous.aliases.find((x) => x.startsWith("did:evm:"));
    if (was !== undefined && token !== was) invalid("STATE_ANCHOR", "an anchored Original keeps its token alias until a move entry (P9.20, P9.28)");
    return;
  }
  if (!previous.anchor) invalid("STATE_ANCHOR", "no entry adds an anchor member to an Original whose genesis entry had none (P9.19)");
  // A move entry (P9.28).
  const fromToken = previous.aliases.find((x) => x.startsWith("did:evm:"));
  if (fromToken === undefined) invalid("STATE_MOVE_BEFORE_ANCHOR", "a move entry comes after the Original's anchoring entry: it moves only from a chain it is anchored on (P9.28)");
  if (s.editor !== undefined) fail("outside-grant", "STATE_MOVE_BY_EDITOR", "a move entry is signed by the author, not by an editor (P9.28)");
  if (s.operation !== "update") invalid("STATE_MOVE", "a move entry is an update (P9.28)");
  const fromLayer = layerOfAnchor(previous.anchor, ctx.evm ?? null);
  const toLayer = layerOfAnchor(asset.anchor, ctx.evm ?? null);
  if (toLayer === undefined) fail("unsupported-profile", "EVM_CHAIN_NOT_LISTED", `the move entry's destination ${asset.anchor!.chain} is not in this verifier's revision of P14.22: unsupported, not invalid (P9.19, P9.28)`);
  if (fromLayer !== undefined && LAYER_RANK[toLayer] <= LAYER_RANK[fromLayer]) invalid("STATE_MOVE_LAYER", `a move goes only up a layer: ${fromLayer} to ${toLayer} is not (P9.28)`);
  if (asset.aliases.includes(fromToken)) invalid("STATE_MOVE_ALIAS", "a move entry replaces the token alias with the destination's (P9.28)");
  if (asset.anchor) {
    const want = asset.aliases.find((x) => x.startsWith("did:evm:"));
    if (want === undefined) invalid("STATE_MOVE_ALIAS", "a move entry lists the destination token's alias (P9.28)");
  } else if (!asset.aliases.some((x) => x.startsWith("did:btco:"))) {
    invalid("STATE_MOVE_ALIAS", "a move to Bitcoin lists the destination sat's did:btco alias (P9.28)");
  }
}

/** The did:evm alias of the token P14.19 derives, under a pin (P14.18). */
export function derivedTokenAlias(didVh: string, anchor: EvmAnchor, pin: EvmAnchorPin): string {
  return evmAliasOf(anchor.chain, pin.address, tokenIdOf(didVh, anchor.minter));
}

/** Validate an entry's state against the Originals rules and its predecessor. */
export function checkEntryState(state: JsonObject, ctx: EntryStateContext): EntryState {
  const { s, operation, author, asset } = entryHead(state, ctx);
  if (s.editor !== undefined) {
    const editor = checkEditorRef(s.editor);
    if (ctx.editorRules !== false) checkEditorEntry(editor, operation, author, asset, ctx.previous);
  }
  // P5.15: no grant names the Original itself, its did:vh or any of its aliases (whose did:btco is the
  // anchoring sat), before or after anchoring, so holding the sat confers no edit authority (P9.12).
  for (const g of asset.editors ?? []) {
    if (g.did === s.id || asset.aliases.includes(g.did)) invalid("STATE_EDITORS", `editor DID ${g.did} names this Original itself (P5.15, P9.12)`);
  }

  // PROVISIONAL (plan 011, PR 7b): layers move one way. An Original starts local, and
  // once published keeps a did:webvh alias, moving only within that alias's SCID (P9.3).
  if (ctx.index === 0 && asset.aliases.length > 0) invalid("STATE_ALIASES", "an Original starts local: genesis lists no alias");
  const webOf = (aliases: string[]) => aliases.find((x) => x.startsWith("did:webvh:"));
  const satOf = (aliases: string[]) => aliases.find((x) => x.startsWith("did:btco:"));
  const before = ctx.previous ? webOf(ctx.previous.asset.aliases) : undefined;
  const now = webOf(asset.aliases);
  // A did:btco author DID's own sat is never the anchoring sat of an Original naming it (P5.13).
  const anchoring = satOf(asset.aliases);
  const authorDid = (s.author as { did?: unknown }).did;
  if (anchoring !== undefined && typeof authorDid === "string" && authorDid.startsWith("did:btco:")) {
    const a = parseBtcoAlias(anchoring);
    try {
      const b = parseBtcoAlias(authorDid);
      if (a.network === b.network && a.sat === b.sat) invalid("STATE_ANCHOR", "the anchoring sat is the author DID's own sat (P5.13)");
    } catch (error) {
      if (error instanceof OriginalsError && error.code === "STATE_ANCHOR") throw error;
    }
  }
  checkAnchorChange(s, asset, ctx);
  const tokenOf = (aliases: string[]) => aliases.find((x) => x.startsWith("did:evm:"));
  const anchoredTo = ctx.previous ? satOf(ctx.previous.asset.aliases) ?? tokenOf(ctx.previous.asset.aliases) : undefined;
  if (anchoredTo !== undefined) {
    // Anchoring is terminal on Bitcoin (P9.10): once the did:btco alias is listed it never changes or goes.
    // On an EVM chain the token alias changes only in a move entry (P9.20, P9.28), checked above.
    if (anchoredTo.startsWith("did:btco:") && satOf(asset.aliases) !== anchoredTo) invalid("STATE_ANCHOR", "an anchored Original names its sat for good (P9.10)");
    // After anchoring no entry adds or replaces a did:webvh alias, even within its SCID (P9.10, D7).
    // The one the anchoring state lists may stay or go; with at most one listed and none added
    // since, an alias absent from the previous state was never listed or has been removed, and
    // either way may not come (back). This keeps C12-35's case: anchored without one, never one.
    if (now !== undefined && now !== before) invalid("STATE_ANCHOR", "after anchoring, no did:webvh alias may be added, replaced or added again (P9.10)");
  } else if (before !== undefined) {
    if (now === undefined) invalid("STATE_ALIASES", "a published Original keeps its did:webvh alias");
    if (parseDidWebvh(now).scid !== parseDidWebvh(before).scid) invalid("STATE_ALIASES", "a did:webvh alias moves only within its own SCID (P9.3)");
  }

  // Deactivation agrees in both directions (P6.5).
  const deactivating = operation === "deactivate";
  if (deactivating !== ctx.deactivatedParameter || deactivating !== (asset.status === "deactivated")) {
    invalid("STATE_DEACTIVATION", "operation deactivate, status deactivated and VH deactivated: true must agree");
  }

  // P4.1 (originals-spec #53): the one resource is checked with the asset (`checkAsset`); a change
  // to its bytes is its next version. mediaType and size change only with the digest (P14.6).
  const previous = ctx.previous?.asset;
  if (previous) {
    const was = previous.resource;
    const now = asset.resource;
    if (was.digest === now.digest && (was.mediaType !== now.mediaType || was.size !== now.size)) {
      invalid("STATE_RESOURCE", "the resource's mediaType and size change only with its digest (P14.6)");
    }
  }

  if (!Array.isArray(s.transitions)) invalid("STATE_MEMBERS", "state.transitions must be an array");
  s.transitions.forEach((t, i) => {
    const m = members(t, ["from", "to"], [], `state.transitions[${i}]`);
    if (m.from !== null) checkDigest(m.from, `state.transitions[${i}].from`);
    checkDigest(m.to, `state.transitions[${i}].to`);
  });
  if (deactivating && s.transitions.length > 0) invalid("STATE_TRANSITIONS", "a deactivation changes no resource");
  if (canonicalize(s.transitions) !== canonicalize(expectedTransitions(previous, asset) as unknown as JsonValue)) {
    invalid("STATE_TRANSITIONS", "transitions are [{from: null, to}] at genesis, [{from, to}] when the resource's digest changes, and [] otherwise (P14.4)");
  }
  return s as unknown as EntryState;
}
