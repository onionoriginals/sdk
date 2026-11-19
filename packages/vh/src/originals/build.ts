/**
 * Building asset log entries. The builders apply the operation contract's
 * value rules (P4.1, P4.4, P4.6; one resource per Original, originals-spec #53) and validate the result with the same checks
 * the verifier uses, so they never produce an entry the verifier rejects for
 * its state. Signing is the caller's: `sign` receives the complete unsigned
 * entry (P5.11 asks the signer to show it to the author first).
 *
 * Signer sets (P5.19–P5.23): an Original governed by
 * `authors: {threshold, dids}` names its signers as an array of author
 * references, and carries one proof per signer in the same order (P5.22).
 * `sign` may then be one `EntrySigner` per signer, or the signers sign in
 * turn: `cosignEntry` adds one signer's proof to a prepared entry, in any
 * order and at any time, and `finalizeEntry` orders the proofs by the signer
 * references once every signer it names has signed.
 */
import type { DataIntegrityProof } from "../crypto/index.js";
import { fail } from "../errors.js";
import type { JsonObject } from "../json/index.js";
import { prepareGenesis, prepareNext, SCID_PLACEHOLDER, type EntrySigner, type LogEntry, type UnsignedEntry } from "../log/index.js";
import {
  ORIGINALS_METHOD,
  authorRefsOf,
  checkAuthors,
  checkDescriptor,
  checkEntryState,
  expectedTransitions,
  type AssetState,
  type AuthorRef,
  type AuthorSet,
  type EditorGrant,
  type EditorRef,
  type EntryState,
  type ParentRef,
  type PreviewDescriptor,
  type ResourceDescriptor,
} from "./state.js";

export interface PrepareCreateInput {
  versionTime: string;
  name: string;
  metadata?: JsonObject;
  /** The descriptor of the Original's one resource, its first version (P4.1). */
  resource: ResourceDescriptor;
  /**
   * The author reference; for a set Original, the reference of every member,
   * since every member signs its genesis (P5.19). Sorted by DID here.
   */
  author: AuthorRef | AuthorRef[];
  /** A signer set instead of one author (P5.19). Its DIDs are sorted here. */
  authors?: AuthorSet;
  /** Editor grants from genesis (P5.15). Genesis is always an author entry (P5.16). */
  editors?: EditorGrant[];
  /**
   * A parent Original whose editor grants this one inherits, and the pin, a
   * versionId of its log (P5.24). Set only at genesis; only the pin moves.
   */
  parent?: ParentRef;
}

/** One signer, or one per signer reference of a set Original's author entry, in any order (P5.22). */
export type EntrySigners = EntrySigner | EntrySigner[];

export interface CreateOriginalInput extends PrepareCreateInput {
  sign: EntrySigners;
}

export interface PrepareUpdateInput {
  versionTime: string;
  /** Omitted keeps the name; null is rejected (P4.6). */
  name?: string;
  /** Omitted keeps the metadata; null removes it (P4.6). */
  metadata?: JsonObject | null;
  /**
   * The resource's next version (P4.1): omitted keeps the current one. A
   * descriptor with the current digest leaves the version unchanged (P4.4).
   * An editor needs a grant with `resource: true` (P5.16).
   */
  resource?: ResourceDescriptor;
  /**
   * The author reference, or a set Original's signer references (P5.19,
   * P5.20; sorted by DID here). Required for an author entry. An editor entry
   * carries its parent's unchanged (P5.16): omit it, or give exactly that.
   */
  author?: AuthorRef | AuthorRef[];
  /**
   * Replaces the signer set, or introduces one in a single-author Original
   * (P5.20, P5.21). Author entries only; never removed.
   */
  authors?: AuthorSet;
  /**
   * Sign as a granted editor (P5.16): the editor DID, its verification method
   * and exact versionId. The grant in the parent's state must cover the change.
   */
  editor?: EditorRef;
  /** Replaces the aliases: listing a did:webvh alias publishes the Original (PROVISIONAL, plan 011 PR 7b). Author entries only. */
  aliases?: string[];
  /** Replaces the editor grants (P5.15); null or [] removes them all. Author entries only (P5.16). */
  editors?: EditorGrant[] | null;
  /**
   * The preview an inscription of this entry carries (P9.30, P14.5): allowed
   * only when the entry's aliases list a did:btco DID. Omitted, an entry that
   * keeps the resource's digest carries its parent's preview, and one that
   * changes it names none; null names none. A new preview goes with a new
   * version, or with the anchoring entry.
   */
  preview?: PreviewDescriptor | null;
  /**
   * Move the pin to this versionId of the parent Original's log (P5.24): the
   * same or a later version. Author and editor entries alike may advance it,
   * which no grant needs to allow (P5.16). Omitted keeps the parent entry's.
   */
  pin?: string;
  /**
   * For an editor entry relying on an inherited grant (P5.24): the grant the
   * parent Original's state at the pin holds for this editor. A verifier
   * finds it in the parent's log; the builder is given it.
   */
  inherited?: EditorGrant;
}

export interface UpdateOriginalInput extends PrepareUpdateInput {
  sign: EntrySigners;
}

function invalidInput(code: string, message: string): never {
  return fail("invalid-evidence", code, message);
}

function stateOf(entry: UnsignedEntry): EntryState {
  return entry.state as unknown as EntryState;
}

const byDid = <T extends { did: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));

/** A set Original's signer references are sorted by DID (P5.22); one author is kept as given. */
function authorMember(author: AuthorRef | AuthorRef[]): AuthorRef | AuthorRef[] {
  return Array.isArray(author) ? byDid(author) : author;
}

/** A signer set with its DIDs sorted by code unit order (P5.19); everything else is checked as given. */
function sortedSet(authors: AuthorSet): AuthorSet {
  if (authors === null || typeof authors !== "object" || !Array.isArray(authors.dids)) return checkAuthors(authors);
  return { ...authors, dids: [...authors.dids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
}

/** The unsigned genesis entry of a new Original: `did:vh:{SCID}` until the SCID is computed. */
export function prepareCreateOriginal(input: PrepareCreateInput): UnsignedEntry {
  if ((input as { editor?: unknown }).editor !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor entry cannot be the genesis entry; only an author entry may (P5.16)");
  if ((input as { resources?: unknown }).resources !== undefined) invalidInput("STATE_RESOURCE", "an Original has exactly one resource: give `resource`, not `resources` (P4.1)");
  const resource = checkDescriptor(input.resource, "resource");
  const asset: AssetState = {
    name: input.name,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    status: "active",
    resource,
    aliases: [],
    ...(input.editors !== undefined && input.editors.length > 0 ? { editors: input.editors } : {}),
    ...(input.authors !== undefined ? { authors: sortedSet(input.authors) } : {}),
    ...(input.parent !== undefined ? { parent: { did: input.parent.did, versionId: input.parent.versionId } } : {}),
  };
  const state = {
    id: `did:vh:${SCID_PLACEHOLDER}`,
    operation: "create",
    author: authorMember(input.author),
    asset,
    transitions: expectedTransitions(undefined, asset),
  } as unknown as JsonObject;
  // Validate with a stand-in SCID; the real one is computed from this entry.
  checkEntryState({ ...state, id: "did:vh:placeholder" }, { scid: "placeholder", index: 0, deactivatedParameter: false });
  return prepareGenesis({ versionTime: input.versionTime, parameters: { method: ORIGINALS_METHOD, scid: SCID_PLACEHOLDER }, state });
}

/** The signed genesis entry of a new Original. */
export async function createOriginal(input: CreateOriginalInput): Promise<LogEntry> {
  return signOriginal(prepareCreateOriginal(input), input.sign);
}

function nextAsset(previous: AssetState, input: Omit<PrepareUpdateInput, "versionTime" | "author">): AssetState {
  if (input.name === null) invalidInput("STATE_NAME", "the name cannot be null (P4.6)");
  const legacy = input as { resources?: unknown; remove?: unknown };
  if (legacy.resources !== undefined || legacy.remove !== undefined) {
    invalidInput("STATE_RESOURCE", "an Original has exactly one resource, never added or removed: give its next version as `resource` (P4.1)");
  }
  const resource = input.resource === undefined ? previous.resource : checkDescriptor(input.resource, "resource");
  const { metadata: _old, editors: _editors, preview: _preview, authors: _authors, ...rest } = previous;
  const metadata = input.metadata === undefined ? previous.metadata : input.metadata;
  const editors = input.editors === undefined ? previous.editors : input.editors;
  // P9.30: by default a new version drops the parent's preview, and the same version keeps it.
  const preview = input.preview === undefined ? (resource.digest === previous.resource.digest ? previous.preview : undefined) : input.preview;
  const authors = input.authors === undefined ? previous.authors : sortedSet(input.authors);
  if (input.pin !== undefined && previous.parent === undefined) invalidInput("STATE_PARENT", "only an Original that names a parent pins a version of it (P5.24)");
  const parent = previous.parent && input.pin !== undefined ? { did: previous.parent.did, versionId: input.pin } : previous.parent;
  return {
    ...rest,
    name: input.name ?? previous.name,
    ...(metadata !== null && metadata !== undefined ? { metadata } : {}),
    resource,
    aliases: input.aliases ?? previous.aliases,
    ...(editors !== null && editors !== undefined && editors.length > 0 ? { editors } : {}),
    ...(preview !== null && preview !== undefined ? { preview } : {}),
    ...(authors !== undefined ? { authors } : {}),
    ...(parent !== undefined ? { parent } : {}),
  };
}

interface NextInput {
  versionTime: string;
  author?: AuthorRef | AuthorRef[];
  editor?: EditorRef;
  aliases?: string[];
  editors?: EditorGrant[] | null;
  authors?: AuthorSet;
  inherited?: EditorGrant;
}

function next(previous: UnsignedEntry, operation: "update" | "deactivate", asset: AssetState, input: NextInput): UnsignedEntry {
  const before = stateOf(previous);
  if (input.editor !== undefined) {
    // P5.16: an editor entry is an update, carries its parent's author reference, and changes no
    // grant or alias. The state rules check the rest against the grant in the parent's state.
    if (input.editors !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor entry cannot change the editor grants; only an author entry may (P5.16)");
    if (input.aliases !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor entry cannot change aliases; only an author entry may (P5.16)");
    if (input.authors !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor entry cannot change the signer set; only an author entry may (P5.16)");
  } else if (input.author === undefined) {
    invalidInput("STATE_AUTHOR", "an author entry needs the author reference");
  }
  const author = input.editor !== undefined ? (input.author !== undefined ? authorMember(input.author) : before.author) : authorMember(input.author!);
  const state = {
    id: before.id,
    operation,
    author,
    ...(input.editor !== undefined ? { editor: input.editor } : {}),
    asset,
    transitions: expectedTransitions(before.asset, asset),
  } as unknown as JsonObject;
  const scid = before.id.slice("did:vh:".length);
  checkEntryState(state, { scid, index: 1, previous: before, deactivatedParameter: operation === "deactivate", ...(input.inherited ? { inherited: input.inherited } : {}) });
  const parameters: JsonObject = operation === "deactivate" ? { deactivated: true } : {};
  return prepareNext(previous, { versionTime: input.versionTime, parameters, state });
}

/** An unsigned update entry after `previous`. */
export function prepareUpdateOriginal(previous: UnsignedEntry, input: PrepareUpdateInput): UnsignedEntry {
  return next(previous, "update", nextAsset(stateOf(previous).asset, input), input);
}

/**
 * An unsigned deactivation entry after `previous` (P6.5). Only the author, or
 * a threshold of a set's members, deactivates (P5.16). It carries
 * its parent's preview, or none with `preview: null` (P9.30).
 */
export function prepareDeactivateOriginal(previous: UnsignedEntry, input: { versionTime: string; author: AuthorRef | AuthorRef[]; preview?: null }): UnsignedEntry {
  if ((input as { editor?: unknown }).editor !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor cannot deactivate; only an author entry may (P5.16)");
  const { preview: _preview, ...asset } = stateOf(previous).asset;
  const keep = input.preview === undefined && _preview !== undefined ? { preview: _preview } : {};
  return next(previous, "deactivate", { ...asset, ...keep, status: "deactivated" }, { versionTime: input.versionTime, author: input.author });
}

/** A signed update entry after `previous`. */
export async function updateOriginal(previous: LogEntry, input: UpdateOriginalInput): Promise<LogEntry> {
  return signOriginal(prepareUpdateOriginal(previous, input), input.sign);
}

/** The signed, terminal deactivation entry after `previous`. */
export async function deactivateOriginal(previous: LogEntry, input: { versionTime: string; author: AuthorRef | AuthorRef[]; preview?: null; sign: EntrySigners }): Promise<LogEntry> {
  return signOriginal(prepareDeactivateOriginal(previous, input), input.sign);
}

// ---------------------------------------------------------------------------- signing

/**
 * A prepared entry with the proofs collected so far, in the order they came
 * (P5.19). Not a log entry until `finalizeEntry` orders its proofs.
 */
export type PartiallySignedEntry = UnsignedEntry & { proof: DataIntegrityProof[] };

/** The references whose proofs an entry needs, in proof order (P5.2, P5.16, P5.22). */
function expectedSigners(entry: UnsignedEntry): AuthorRef[] {
  const state = stateOf(entry);
  return state.editor ? [state.editor] : authorRefsOf(state);
}

function signingError(code: string, message: string): never {
  return fail("invalid-evidence", code, message);
}

/**
 * Add one signer's proof to a prepared entry (P5.19): `sign` produces it
 * over the unsigned entry, exactly as for a one-signer entry. The proof must
 * be by a verification method the entry names as a signer, and not one that
 * has already signed. Signers may cosign in any order, at different times.
 */
export async function cosignEntry(entry: UnsignedEntry | PartiallySignedEntry, sign: EntrySigner): Promise<PartiallySignedEntry> {
  const { proof: had = [], ...unsigned } = entry as PartiallySignedEntry;
  const named = expectedSigners(unsigned).map((r) => r.verificationMethod);
  const added = await sign(unsigned);
  const proof = [...had];
  for (const p of added) {
    if (!named.includes(p.verificationMethod)) signingError("SIGNER_NOT_NAMED", `${p.verificationMethod} is not a signer this entry names (P5.22)`);
    if (proof.some((q) => q.verificationMethod === p.verificationMethod)) signingError("PROOF_DUPLICATE", `${p.verificationMethod} has already signed this entry`);
    proof.push(p);
  }
  return { ...unsigned, proof };
}

/**
 * The log entry, once every signer the entry names has signed: one proof per
 * signer reference, in the same order, sorted by DID (P5.22). A
 * signer still missing is refused; the threshold decides which signers an
 * entry names, never which of them may be left out.
 */
export function finalizeEntry(entry: PartiallySignedEntry): LogEntry {
  const { proof, ...unsigned } = entry;
  const refs = expectedSigners(unsigned);
  const ordered = refs.map((r) => {
    const found = proof.filter((p) => p.verificationMethod === r.verificationMethod);
    if (found.length === 0) signingError("PROOF_MISSING", `${r.did} (${r.verificationMethod}) has not signed this entry yet`);
    if (found.length > 1) signingError("PROOF_DUPLICATE", `${r.verificationMethod} signed this entry more than once`);
    return found[0];
  });
  if (ordered.length !== proof.length) signingError("SIGNER_NOT_NAMED", "a proof is by a verification method this entry does not name as a signer (P5.22)");
  return { ...unsigned, proof: ordered };
}

/**
 * Sign a prepared Original entry. One signer signs a single-author or editor
 * entry as before: its proofs are the entry's, unchanged. Several sign a set
 * Original's author entry in turn, and the proofs are ordered by DID.
 */
export async function signOriginal(entry: UnsignedEntry, sign: EntrySigners): Promise<LogEntry> {
  if (!Array.isArray(sign)) return { ...entry, proof: await sign(entry) };
  let partial: PartiallySignedEntry = { ...entry, proof: [] };
  for (const s of sign) partial = await cosignEntry(partial, s);
  return finalizeEntry(partial);
}
