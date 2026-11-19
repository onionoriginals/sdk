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
import { checkScope, type GrantScope } from "./scope.js";
import { parseBtcoAlias } from "./btco.js";

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
  /** Bytes in a preview (P9.30, P14.13; owner decision, 18 November 2026). */
  previewBytes: 8_192,
  /**
   * Members of a signer set (`authors.dids`; P5.19, P7.7,
   * P14.13).
   */
  authors: 32,
  /** Nested parent Originals, from a child to its furthest ancestor (P5.25, P7.7, P14.13; provisional). */
  parents: 8,
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
  /**
   * Narrows what `resource: true` allows (P5.28, P14.5): a `type` and the
   * members its scope type defines (P14.23). Never with `resource: false`.
   */
  scope?: GrantScope;
}

/**
 * A parent Original (P5.24, P14.5): its did:vh, set at genesis and never
 * changed, and the pin, a versionId of the parent's asset log that each entry
 * names and that never goes backwards. PROVISIONAL member names (D4).
 */
export interface ParentRef {
  did: string;
  versionId: string;
}

/**
 * A preview of the resource version an entry names, for an inscription
 * (P9.30, P14.5): exactly `{mediaType, size, digest}`, as a resource
 * descriptor (P14.6, P14.7), of 1 to 8,192 bytes. The member name and shape
 * are PROVISIONAL (D4, D6). A preview is not a resource version: it does not
 * advance the version (P4.4) and is not in the derived DID document (P14.9).
 */
export type PreviewDescriptor = ResourceDescriptor;

/**
 * A signer set (P5.19; owner decision of 19 November 2026). The
 * Original is governed by these DIDs, `threshold` of them together, instead of
 * one author. `dids` are sorted by code unit order and unique, each of a P5.8
 * method, at most `ORIGINALS_LIMITS.authors`; 1 ≤ threshold ≤ dids.length.
 * PROVISIONAL member names (P14.5, D4).
 */
export interface AuthorSet {
  threshold: number;
  dids: string[];
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
   * The preview of `resource` an inscription carries as its body (P9.17,
   * P9.30), allowed only once `aliases` list a did:btco DID (P14.5).
   */
  preview?: PreviewDescriptor;
  /**
   * The signer set of a set Original (P5.19). Absent for a
   * single-author Original. Once present it is never removed, and only an
   * author entry changes it (P5.16, P5.20; PROVISIONAL).
   */
  authors?: AuthorSet;
  /** The parent Original and the pin (P5.24); set only at genesis, and only the pin changes. */
  parent?: ParentRef;
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
  /**
   * The author reference (P5.1), or, exactly when `asset.authors` is present,
   * the signer references of a set Original: sorted by `did`, unique, one per
   * proof in the same order (P5.22; PROVISIONAL). An editor
   * entry carries its parent's unchanged (P5.16).
   */
  author: AuthorRef | AuthorRef[];
  /** Present only in an editor entry (P5.16). */
  editor?: EditorRef;
  asset: AssetState;
  transitions: Transition[];
}

/** The author references an entry names: its one author, or each signer of a set Original (P5.19). */
export function authorRefsOf(state: Pick<EntryState, "author">): AuthorRef[] {
  return Array.isArray(state.author) ? state.author : [state.author];
}

/**
 * The identities that sign an entry, in proof order: its editor for an editor
 * entry, otherwise its author, or each signer of a set Original's author entry
 * (P5.2, P5.16; P5.22).
 */
export function signersOf(state: Pick<EntryState, "author" | "editor">): { role: "author" | "editor"; refs: AuthorRef[] } {
  return state.editor ? { role: "editor", refs: [state.editor] } : { role: "author", refs: authorRefsOf(state) };
}

/**
 * The identity that signs an entry: its editor for an editor entry, otherwise
 * its author (P5.2, P5.16). An author entry of a set Original has several
 * signers: use `signersOf`; this names the first.
 */
export function signerOf(state: EntryState): { role: "author" | "editor"; ref: AuthorRef } {
  const { role, refs } = signersOf(state);
  return { role, ref: refs[0] };
}

/**
 * The members that govern an Original at an entry: its signer set, or its one
 * author as a set of one with threshold 1, which behaves exactly like it (W1).
 */
export function governingSet(state: Pick<EntryState, "author" | "asset">): AuthorSet {
  if (state.asset.authors) return state.asset.authors;
  const refs = authorRefsOf(state);
  return { threshold: 1, dids: refs.map((r) => r.did) };
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

/**
 * A set Original's signer references (P5.19, P14.4): a non-empty
 * array of author references, sorted by `did` in code unit order, each DID
 * once, at most `ORIGINALS_LIMITS.authors`.
 */
export function checkAuthorRefs(value: unknown): AuthorRef[] {
  if (!Array.isArray(value) || value.length === 0) invalid("STATE_AUTHOR", "state.author of a set Original is a non-empty array of signer references");
  if (value.length > ORIGINALS_LIMITS.authors) fail("limit-exceeded", "STATE_TOO_MANY_AUTHORS", `at most ${ORIGINALS_LIMITS.authors} signers (P7.7)`);
  const refs = value.map((v) => checkRef(v, "author"));
  for (let i = 1; i < refs.length; i++) {
    if (!(refs[i - 1].did < refs[i].did)) invalid("STATE_AUTHOR", "a set Original's signer references are sorted by did and name each DID once (P5.22)");
  }
  return refs;
}

/** The author member of an entry's state: one reference, or a set Original's array (P5.19). */
export function checkAuthorMember(value: unknown): AuthorRef | AuthorRef[] {
  return Array.isArray(value) ? checkAuthorRefs(value) : checkAuthorRef(value);
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
function checkEditors(value: unknown, authorDids: readonly string[], set = false): EditorGrant[] {
  const bad: (message: string) => never = (message) => invalid("STATE_EDITORS", message);
  if (!Array.isArray(value)) bad("state.asset.editors must be an array of grants");
  if (value.length === 0) bad("state.asset.editors is omitted when there are no editors (PROVISIONAL)");
  if (value.length > ORIGINALS_LIMITS.editors) fail("limit-exceeded", "STATE_TOO_MANY_EDITORS", `at most ${ORIGINALS_LIMITS.editors} editor grants (P7.7)`);
  const seen = new Set<string>();
  const authorScids = authorDids.filter((d) => d.startsWith("did:webvh:")).map(scidOfWebvh).filter((x) => x !== undefined);
  return value.map((item, i) => {
    let g: JsonObject;
    try {
      g = members(item, ["did", "name", "metadata", "resource"], ["scope"], `state.asset.editors[${i}]`);
    } catch (error) {
      if (error instanceof OriginalsError) bad(`state.asset.editors[${i}]: ${error.message}`);
      throw error;
    }
    if (typeof g.did !== "string" || !/^did:[a-z0-9]+:\S+$/.test(g.did)) bad(`state.asset.editors[${i}].did is not a DID`);
    const did = g.did;
    // The author's DID with a path, query or fragment still names the author's identity.
    const bare = did.replace(/[?#/].*$/, "");
    // A set Original's members are its authors: an editor is not a member at the same entry (P5.19).
    if (authorDids.includes(bare) || authorScids.includes(scidOfWebvh(bare) ?? "\u0000")) {
      bad(set ? "an editor cannot be a member of the signer set or a DID of a member's identity (P5.14, P5.15)" : "an editor cannot be the author DID or a DID of the author's identity (P5.14, P5.15)");
    }
    if (!LISTED_METHODS.some((m) => did.startsWith(m))) bad(`editor DID ${did} uses a method the profile does not list (P5.8)`);
    if (!wellFormedSigner(did)) bad(`editor DID ${did} is not a well-formed DID of its method, with no path, query or fragment`);
    // One identity, one grant: a did:webvh at two locations is one identity (P5.14).
    const identity = did.startsWith("did:webvh:") ? `did:webvh:${scidOfWebvh(did)}` : did;
    if (seen.has(identity)) bad(`editor DID ${did} is granted twice (one grant per identity, P5.14)`);
    seen.add(identity);
    if (typeof g.name !== "boolean" || typeof g.metadata !== "boolean" || typeof g.resource !== "boolean") {
      bad(`state.asset.editors[${i}].name, .metadata and .resource are booleans (P14.5)`);
    }
    // P5.28 (C12-418): a scope narrows `resource: true`, so it never comes with `resource: false`.
    if (g.scope !== undefined) {
      if (g.resource !== true) bad(`state.asset.editors[${i}] has a scope with resource: false (P5.28, P14.5)`);
      checkScope(g.scope);
    }
    return g as unknown as EditorGrant;
  });
}

/**
 * A signer set (P5.19; PROVISIONAL member names, P14.5): exactly
 * `{threshold, dids}`; `dids` sorted by code unit order, unique by identity
 * (a did:webvh at two locations is one, P5.14), each a well-formed DID of a
 * listed method (P5.8), 1 to `ORIGINALS_LIMITS.authors` of them (P7.7); and
 * an integer threshold from 1 to their number.
 */
export function checkAuthors(value: unknown): AuthorSet {
  const bad: (message: string) => never = (message) => invalid("STATE_AUTHORS", message);
  let a: JsonObject;
  try {
    a = members(value, ["threshold", "dids"], [], "state.asset.authors");
  } catch (error) {
    if (error instanceof OriginalsError) bad(`${error.message}: a signer set is exactly {threshold, dids} (P5.19)`);
    throw error;
  }
  const dids = a.dids;
  if (!Array.isArray(dids) || dids.length === 0 || !dids.every((d) => typeof d === "string")) bad("state.asset.authors.dids is a non-empty array of DIDs");
  if (dids.length > ORIGINALS_LIMITS.authors) fail("limit-exceeded", "STATE_TOO_MANY_AUTHORS", `at most ${ORIGINALS_LIMITS.authors} members in a signer set (P7.7)`);
  const seen = new Set<string>();
  dids.forEach((did, i) => {
    if (!LISTED_METHODS.some((m) => did.startsWith(m))) bad(`member DID ${did} uses a method the profile does not list (P5.8)`);
    if (!wellFormedSigner(did)) bad(`member DID ${did} is not a well-formed DID of its method, with no path, query or fragment`);
    if (i > 0 && !(dids[i - 1] < did)) bad("state.asset.authors.dids are sorted by code unit order and unique (P5.19)");
    const identity = did.startsWith("did:webvh:") ? `did:webvh:${scidOfWebvh(did)}` : did;
    if (seen.has(identity)) bad(`member DID ${did} is listed twice (one identity, P5.14)`);
    seen.add(identity);
  });
  const t = a.threshold;
  if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > dids.length) bad("state.asset.authors.threshold is an integer from 1 to the number of members (P5.19)");
  return a as unknown as AuthorSet;
}

const VERSION_ID = /^[1-9]\d*-Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/**
 * P14.5: a `parent` member, exactly `{did, versionId}`: the parent Original's
 * did:vh and a versionId of its asset log, `<number>-<entry hash>` (P5.24).
 */
export function checkParent(value: unknown): ParentRef {
  const bad: (message: string) => never = (message) => invalid("STATE_PARENT", message);
  let p: JsonObject;
  try {
    p = members(value, ["did", "versionId"], [], "state.asset.parent");
  } catch (error) {
    if (error instanceof OriginalsError) bad(`${error.message}: a parent is exactly {did, versionId} (P14.5)`);
    throw error;
  }
  if (typeof p.did !== "string" || !DID_VH.test(p.did)) bad("state.asset.parent.did is the parent Original's did:vh (P5.24, P14.5)");
  if (typeof p.versionId !== "string" || !VERSION_ID.test(p.versionId)) bad("state.asset.parent.versionId is a versionId of the parent's asset log (P5.24, P14.5)");
  return p as unknown as ParentRef;
}

/**
 * Check an asset state. `authorDid` enables the grant rules that depend on it
 * (P5.15); for a set Original the members in `authors` are used instead.
 */
export function checkAsset(value: unknown, authorDid?: string | readonly string[]): AssetState {
  const a = members(value, ["name", "status", "resource", "aliases"], ["metadata", "editors", "preview", "authors", "parent"], "state.asset");
  if (typeof a.name !== "string" || a.name.length === 0 || a.name.length > ORIGINALS_LIMITS.nameLength) {
    invalid("STATE_NAME", `the name must be a string of 1 to ${ORIGINALS_LIMITS.nameLength} UTF-16 code units (P14.5)`);
  }
  if (a.metadata !== undefined && !isJsonObject(a.metadata)) invalid("STATE_METADATA", "metadata must be an object when present");
  if (a.status !== "active" && a.status !== "deactivated") invalid("STATE_STATUS", "status must be active or deactivated");
  // P4.1, P14.5 (originals-spec #53): exactly one resource, a descriptor, never none and never a list.
  if (!isJsonObject(a.resource)) invalid("STATE_RESOURCE", "state.asset.resource is the descriptor of the Original's one resource: an Original has exactly one (P4.1)");
  checkDescriptor(a.resource, "state.asset.resource");
  if (!Array.isArray(a.aliases) || !a.aliases.every((x) => typeof x === "string")) invalid("STATE_ALIASES", "aliases must be an array of DIDs");
  // PROVISIONAL (plan 011 PR 7b, plan 012 §3.1): at most one did:webvh alias and one did:btco alias.
  let webvh = 0;
  let btco = 0;
  if (new Set(a.aliases).size !== a.aliases.length) invalid("STATE_ALIASES", "aliases lists no DID twice (P14.5)");
  for (const alias of a.aliases) {
    if (alias.startsWith("did:btco:")) {
      parseBtcoAlias(alias);
      btco++;
      continue;
    }
    if (!alias.startsWith("did:webvh:")) invalid("STATE_ALIASES", `${alias} is not a did:webvh or did:btco alias`);
    try {
      parseDidWebvh(alias);
    } catch {
      invalid("STATE_ALIASES", `${alias} is not a valid did:webvh`);
    }
    webvh++;
  }
  if (webvh > 1 || btco > 1) invalid("STATE_ALIASES", "an Original lists at most one did:webvh and one did:btco alias");
  const set = a.authors === undefined ? undefined : checkAuthors(a.authors);
  const given = authorDid === undefined ? [] : typeof authorDid === "string" ? [authorDid] : [...authorDid];
  if (a.editors !== undefined) checkEditors(a.editors, set ? [...set.dids, ...given] : given, set !== undefined);
  if (a.preview !== undefined) checkPreview(a.preview, a.resource as unknown as ResourceDescriptor, btco > 0);
  if (a.parent !== undefined) checkParent(a.parent);
  return a as unknown as AssetState;
}

/**
 * Whether a `mediaType` is an `image/` type: its type, before the `/`, is
 * `image`, compared ASCII case-insensitively (P9.30, P14.14). This includes
 * `image/svg+xml`, which a writer rasterises.
 */
export function isImageMediaType(mediaType: string): boolean {
  const slash = mediaType.indexOf("/");
  return slash > 0 && mediaType.slice(0, slash).toLowerCase() === "image";
}

/** The only media type a preview of an `image/` version may have (P9.30). */
export const IMAGE_PREVIEW_MEDIA_TYPE = "image/webp";

/**
 * P9.30, P14.5: a `preview` member. Exactly `{mediaType, size, digest}`, each
 * as for a resource descriptor (P14.6, P14.7); 1 to 8,192 bytes (P14.13); only
 * in an entry whose `aliases` list a did:btco DID, so never before the
 * anchoring entry; and `image/webp` for a version of an `image/` type.
 * PROVISIONAL: a preview's `image/webp` is compared ASCII case-insensitively,
 * as media types are (RFC 6838); the spec writes it in lower case.
 */
export function checkPreview(value: unknown, resource: ResourceDescriptor, prepared: boolean): PreviewDescriptor {
  const bad: (message: string) => never = (message) => invalid("STATE_PREVIEW", message);
  if (!prepared) bad("only an entry whose aliases list a did:btco DID may name a preview: previews are made for Bitcoin, from the anchoring entry on (P9.30, P14.5)");
  let p: PreviewDescriptor;
  try {
    p = checkDescriptor(value, "state.asset.preview");
  } catch (error) {
    if (error instanceof OriginalsError && error.code === "STATE_RESOURCE") bad(error.message.replace("a resource descriptor", "a preview"));
    throw error;
  }
  if (p.size < 1) bad("a preview is at least 1 byte (P9.30, P14.5)");
  if (p.size > ORIGINALS_LIMITS.previewBytes) fail("limit-exceeded", "STATE_PREVIEW_TOO_LARGE", `a preview is at most ${ORIGINALS_LIMITS.previewBytes} bytes (P9.30, P14.13)`);
  if (isImageMediaType(resource.mediaType) && p.mediaType.toLowerCase() !== IMAGE_PREVIEW_MEDIA_TYPE) {
    bad(`the preview of an image version is ${IMAGE_PREVIEW_MEDIA_TYPE}, not ${p.mediaType} (P9.30)`);
  }
  return p;
}

const same = (a: JsonValue | undefined, b: JsonValue | undefined) => canonicalize(a ?? null) === canonicalize(b ?? null);

/** Which grant authorized an editor entry (P5.24): one in its parent entry's state, or one inherited from the parent Original at its pin. */
export type GrantSource = "direct" | "inherited";

/**
 * What `grant` does not allow in an editor's change from `before` to `asset`,
 * or null when it allows all of it (P5.16): the name, the metadata, the
 * resource, and the preview that goes with a new version under a grant that
 * allows the resource (P9.30).
 */
export function outsideGrant(grant: EditorGrant, asset: AssetState, before: AssetState): string | null {
  if (asset.name !== before.name && !grant.name) return "is not granted the name";
  if (!same(asset.metadata, before.metadata) && !grant.metadata) return "is not granted the metadata";
  if (!same(asset.resource as unknown as JsonValue, before.resource as unknown as JsonValue) && !grant.resource) return "is not granted the resource";
  // P5.16, P9.30: naming the preview of a new version is part of the change to the resource its grant
  // allows; an editor entry that does not change the resource carries its parent's preview unchanged.
  if (!same(asset.preview as unknown as JsonValue, before.preview as unknown as JsonValue)) {
    if (asset.resource.digest === before.resource.digest) return "may change or remove the preview only with a new version of the resource (P9.30)";
    if (!grant.resource) return "is not granted the resource, so not its preview";
  }
  return null;
}

/**
 * P5.16, P5.17, P5.24: an editor entry, checked against its parent. The
 * author reference is the parent's; the operation is update; grants, aliases,
 * the signer set and lifecycle are the author's; and only the name, metadata
 * and resource descriptor that one grant allows change, never a combination
 * of grants. The grant is the parent entry's (`direct`), or `inherited`, the
 * grant the parent Original's state at the entry's pin holds for this editor
 * (P5.24); a direct grant that allows the change is the one reported.
 * Advancing the pin is not a change a grant must allow (P5.16); the pin rules
 * are `checkEntryState`'s.
 */
export function checkEditorEntry(editor: EditorRef, operation: string, author: AuthorRef | AuthorRef[], asset: AssetState, previous: EntryState | undefined, inherited?: EditorGrant): GrantSource {
  const authorOnly: (message: string) => never = (message) => fail("outside-grant", "EDITOR_AUTHOR_ONLY", `${message}; only an author entry may (P5.16)`);
  if (!previous) authorOnly("an editor entry cannot be the genesis entry");
  if (operation !== "update") authorOnly("an editor entry is an update; it cannot deactivate");
  const direct = previous.asset.editors?.find((g) => g.did === editor.did);
  if (!direct && !inherited) fail("unauthorized-key", "EDITOR_NOT_GRANTED", `${editor.did} has no grant in the parent's state, nor one inherited from a parent Original (P5.16, P5.17, P5.24)`);
  if (!same(author as unknown as JsonValue, previous.author as unknown as JsonValue)) {
    invalid("EDITOR_AUTHOR_CHANGED", "an editor entry's author reference must equal its parent's (P5.16)");
  }
  const before = previous.asset;
  if (!same(asset.editors as unknown as JsonValue, before.editors as unknown as JsonValue)) authorOnly("an editor entry cannot change the editor grants");
  if (!same(asset.aliases, before.aliases)) authorOnly("an editor entry cannot change aliases");
  if (!same(asset.authors as unknown as JsonValue, before.authors as unknown as JsonValue)) authorOnly("an editor entry cannot change the signer set");
  if (asset.status !== before.status) authorOnly("an editor entry cannot change the lifecycle status");
  const byDirect = direct ? outsideGrant(direct, asset, before) : "has no direct grant";
  if (byDirect === null) return "direct";
  const byInherited = inherited ? outsideGrant(inherited, asset, before) : undefined;
  if (byInherited === null) return "inherited";
  fail("outside-grant", "EDITOR_OUTSIDE_GRANT", `${editor.did} ${direct ? byDirect : byInherited} (P5.16${inherited ? ", P5.24: one grant, direct or inherited, must allow the whole change" : ""})`);
}

/**
 * P9.30: the preview an entry names against its parent's. An entry that
 * changes the resource's digest names a preview of the new version, or none,
 * never its parent's unchanged. The anchoring entry, the first whose aliases
 * list a did:btco DID, may name one. Any other entry that keeps the digest,
 * a deactivation included, carries its parent's preview unchanged or none,
 * and once none is carried no later entry names one until the digest changes.
 * That an entry before the anchoring entry names none is `checkPreview`'s.
 */
export function checkPreviewTransition(asset: AssetState, previous: AssetState | undefined): void {
  if (!previous || asset.preview === undefined) return;
  const parent = previous.preview;
  const unchanged = parent !== undefined && same(asset.preview as unknown as JsonValue, parent as unknown as JsonValue);
  if (asset.resource.digest !== previous.resource.digest) {
    if (unchanged) invalid("STATE_PREVIEW", "an entry that changes the resource names a preview of the new version, or none, never its parent's unchanged (P9.30)");
    return;
  }
  const anchoring = !previous.aliases.some((a) => a.startsWith("did:btco:"));
  if (!anchoring && !unchanged) {
    invalid("STATE_PREVIEW", parent === undefined
      ? "an entry that does not change the resource names no preview when its parent named none (P9.30)"
      : "an entry that does not change the resource carries its parent's preview unchanged, or none (P9.30)");
  }
}

function unauthorized(code: string, message: string): never {
  return fail("unauthorized-key", code, message);
}

/**
 * Who may sign an author entry (P5.19–P5.21),
 * judged on the state alone, before any signer evidence is looked up, so a
 * signer outside the set is rejected, never reported as missing evidence:
 *
 * - P5.19: the genesis of a set Original names every member as a signer.
 * - P5.20: a later author entry is signed by at least the parent's threshold
 *   of the parent's members, and by every member it adds; no one else signs.
 * - P5.21: an author entry of a single-author Original may introduce
 *   `authors`, which must contain the author; the author's set of one, with
 *   threshold 1, is the parent's.
 * - `authors` is never removed once present.
 *
 * A single-author entry after a single-author parent changes nothing here:
 * its author DID is fixed at genesis (P5.8), checked with its key.
 */
export function checkSigners(author: AuthorRef | AuthorRef[], asset: AssetState, previous: EntryState | undefined): void {
  if (previous?.asset.authors && !asset.authors) invalid("STATE_AUTHORS", "a set Original's `authors` is never removed (P5.19)");
  if (Array.isArray(author) !== (asset.authors !== undefined)) {
    invalid("STATE_AUTHOR", "state.author is an array of signer references exactly when the asset has `authors` (P5.19)");
  }
  const signers = (Array.isArray(author) ? author : [author]).map((r) => r.did);
  const next = asset.authors;
  if (!previous) {
    if (!next) return;
    const outside = signers.find((d) => !next.dids.includes(d));
    if (outside) unauthorized("SIGNER_NOT_MEMBER", `${outside} is not a member of the signer set (P5.19)`);
    const missing = next.dids.filter((d) => !signers.includes(d));
    if (missing.length > 0) unauthorized("AUTHORS_MEMBER_NOT_SIGNED", `the genesis of a set Original is signed by every member; ${missing.join(", ")} did not sign (P5.19)`);
    return;
  }
  const before = previous.asset.authors;
  if (!before && !next) return;
  if (before && !next) invalid("STATE_AUTHORS", "a set Original's `authors` is never removed (P5.19)");
  const parent = governingSet(previous);
  if (!before && !next!.dids.includes(parent.dids[0])) {
    invalid("STATE_AUTHORS", "converting a single-author Original: the signer set must contain the author (P5.21)");
  }
  const added = next!.dids.filter((d) => !parent.dids.includes(d));
  const outside = signers.find((d) => !parent.dids.includes(d) && !added.includes(d));
  if (outside) unauthorized("SIGNER_NOT_MEMBER", `${outside} is not a member of the parent's signer set, nor added by this entry (P5.20)`);
  const counted = signers.filter((d) => parent.dids.includes(d)).length;
  if (counted < parent.threshold) {
    unauthorized("AUTHORS_THRESHOLD_NOT_MET", `an author entry is signed by at least ${parent.threshold} of the parent's members; ${counted} signed (P5.20)`);
  }
  const unsigned = added.filter((d) => !signers.includes(d));
  if (unsigned.length > 0) unauthorized("AUTHORS_MEMBER_NOT_SIGNED", `every member an entry adds signs it; ${unsigned.join(", ")} did not (P5.20, P5.21)`);
}

/**
 * `checkSigners` on an entry's raw state, for the profile's key hook: the
 * author member, the asset and the parent's state, checked as they are read.
 */
export function checkEntrySigners(state: JsonObject, previous: EntryState | undefined): void {
  const author = checkAuthorMember(state.author);
  const single = Array.isArray(author) ? undefined : author.did;
  checkSigners(author, checkAsset(state.asset, single), previous);
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
  /** The grant for this entry's editor in the parent Original's state at the entry's pin, if any (P5.24). */
  inherited?: EditorGrant;
}

/** The members, id, operation, author reference and asset of an entry's state: what every later rule reads. */
function entryHead(state: JsonObject, ctx: EntryStateContext): { s: JsonObject; operation: string; author: AuthorRef | AuthorRef[]; asset: AssetState } {
  const s = members(state, ["id", "operation", "author", "asset", "transitions"], ["editor"], "state");
  if (s.id !== `did:vh:${ctx.scid}`) invalid("STATE_ID", "state.id must be the Original's did:vh");
  const operation = s.operation;
  if (typeof operation !== "string") invalid("STATE_OPERATION", "operation must be a string");
  if (ctx.index === 0 ? operation !== "create" : operation !== "update" && operation !== "deactivate") {
    invalid("STATE_OPERATION", ctx.index === 0 ? "the first entry must be a create" : "a later entry is an update or a deactivate");
  }
  const author = checkAuthorMember(s.author);
  const asset = checkAsset(s.asset, Array.isArray(author) ? undefined : author.did);
  if (ctx.previous?.asset.authors && !asset.authors) invalid("STATE_AUTHORS", "a set Original's `authors` is never removed (P5.19)");
  if (Array.isArray(author) !== (asset.authors !== undefined)) {
    invalid("STATE_AUTHOR", "state.author is an array of signer references exactly when the asset has `authors` (P5.19)");
  }
  return { s, operation, author, asset };
}

/**
 * The editor-entry rules of P5.16 for an entry's state, after the state's
 * members, operation, author reference and asset are checked, and before
 * every other state rule: an editor's change outside its grant is reported as
 * that (outside-grant), whatever else it breaks. The Originals profile's
 * VH-Log PR 11 editor limit [S25].
 */
export function checkEditorChange(state: JsonObject, ctx: EntryStateContext): GrantSource | undefined {
  const { s, operation, author, asset } = entryHead(state, ctx);
  return s.editor === undefined ? undefined : checkEditorEntry(checkEditorRef(s.editor), operation, author, asset, ctx.previous, ctx.inherited);
}

/** Validate an entry's state against the Originals rules and its predecessor. */
export function checkEntryState(state: JsonObject, ctx: EntryStateContext): EntryState {
  const { s, operation, author, asset } = entryHead(state, ctx);
  if (s.editor !== undefined) {
    const editor = checkEditorRef(s.editor);
    if (ctx.editorRules !== false) checkEditorEntry(editor, operation, author, asset, ctx.previous, ctx.inherited);
  }
  // P5.15: no grant names the Original itself, its did:vh or any of its aliases (whose did:btco is the
  // anchoring sat), before or after anchoring, so holding the sat confers no edit authority (P9.12).
  for (const g of asset.editors ?? []) {
    if (g.did === s.id || asset.aliases.includes(g.did)) invalid("STATE_EDITORS", `editor DID ${g.did} names this Original itself (P5.15, P9.12)`);
  }
  // P5.24 (C12-405): only the genesis entry sets `parent`, never to the Original itself, and no
  // entry adds, removes or retargets it; only the pin moves, which `checkPin` judges against the
  // parent's log. P5.15, P5.19: the parent's did:vh is never an editor or a member.
  const parent = asset.parent;
  if (parent && parent.did === s.id) invalid("STATE_PARENT", "an Original cannot name itself as its parent (P5.24)");
  if (ctx.previous && (ctx.previous.asset.parent === undefined) !== (parent === undefined)) invalid("STATE_PARENT", "only the genesis entry sets `parent`, and no entry removes it (P5.24)");
  if (ctx.previous?.asset.parent && parent && parent.did !== ctx.previous.asset.parent.did) invalid("STATE_PARENT", "no entry changes `parent.did` (P5.24)");
  if (parent && (asset.editors ?? []).some((g) => g.did === parent.did)) invalid("STATE_EDITORS", "the parent Original's did:vh is never an editor (P5.15)");
  if (parent && (asset.authors?.dids ?? []).includes(parent.did)) invalid("STATE_AUTHORS", "the parent Original's did:vh is never a member (P5.19)");
  // P5.19 (C12-393): no member of the signer set is the Original's did:vh or any of its aliases; a
  // did:btco member whose sat is the anchoring sat is refused below with the author DIDs (P5.13).
  for (const did of asset.authors?.dids ?? []) {
    if (did === s.id || asset.aliases.includes(did)) invalid("STATE_AUTHORS", `member DID ${did} names this Original itself (P5.19, P9.12)`);
  }
  // P5.19–P5.21: who may sign an author entry of a set Original. An
  // editor entry carries its parent's author member and set unchanged (checkEditorEntry).
  if (s.editor === undefined) checkSigners(author, asset, ctx.previous);

  // PROVISIONAL (plan 011, PR 7b): layers move one way. An Original starts local, and
  // once published keeps a did:webvh alias, moving only within that alias's SCID (P9.3).
  if (ctx.index === 0 && asset.aliases.length > 0) invalid("STATE_ALIASES", "an Original starts local: genesis lists no alias");
  const webOf = (aliases: string[]) => aliases.find((x) => x.startsWith("did:webvh:"));
  const satOf = (aliases: string[]) => aliases.find((x) => x.startsWith("did:btco:"));
  const before = ctx.previous ? webOf(ctx.previous.asset.aliases) : undefined;
  const now = webOf(asset.aliases);
  // A did:btco author DID's own sat is never the anchoring sat of an Original naming it (P5.13).
  const anchoring = satOf(asset.aliases);
  // For a set Original, every member and every signer is an author DID (P5.19).
  const authorDids = [...new Set([...authorRefsOf({ author }).map((r) => r.did), ...(asset.authors?.dids ?? [])])];
  for (const authorDid of authorDids) {
    if (anchoring === undefined || !authorDid.startsWith("did:btco:")) continue;
    const a = parseBtcoAlias(anchoring);
    try {
      const b = parseBtcoAlias(authorDid);
      if (a.network === b.network && a.sat === b.sat) invalid("STATE_ANCHOR", "the anchoring sat is the author DID's own sat (P5.13)");
    } catch (error) {
      if (error instanceof OriginalsError && error.code === "STATE_ANCHOR") throw error;
    }
  }
  const anchoredTo = ctx.previous ? satOf(ctx.previous.asset.aliases) : undefined;
  if (anchoredTo !== undefined) {
    // Anchoring is terminal (P9.10): once the did:btco alias is listed it never changes or goes.
    if (satOf(asset.aliases) !== anchoredTo) invalid("STATE_ANCHOR", "an anchored Original names its sat for good (P9.10)");
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

  checkPreviewTransition(asset, ctx.previous?.asset);

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
