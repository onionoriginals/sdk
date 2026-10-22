/**
 * Building asset log entries. The builders apply the operation contract's
 * value rules (P4.1, P4.4, P4.6) and validate the result with the same checks
 * the verifier uses, so they never produce an entry the verifier rejects for
 * its state. Signing is the caller's: `sign` receives the complete unsigned
 * entry (P5.11 asks the signer to show it to the author first).
 */
import { fail } from "../errors.js";
import type { JsonObject } from "../json/index.js";
import { prepareGenesis, prepareNext, signEntry, SCID_PLACEHOLDER, type EntrySigner, type LogEntry, type UnsignedEntry } from "../log/index.js";
import {
  ORIGINALS_METHOD,
  checkDescriptor,
  checkEntryState,
  expectedTransitions,
  type AssetState,
  type AuthorRef,
  type EditorGrant,
  type EditorRef,
  type EntryState,
  type ResourceDescriptor,
} from "./state.js";

export interface PrepareCreateInput {
  versionTime: string;
  name: string;
  metadata?: JsonObject;
  resources: ResourceDescriptor[];
  author: AuthorRef;
  /** Editor grants from genesis (P5.15). Genesis is always an author entry (P5.16). */
  editors?: EditorGrant[];
}

export interface CreateOriginalInput extends PrepareCreateInput {
  sign: EntrySigner;
}

export interface PrepareUpdateInput {
  versionTime: string;
  /** Omitted keeps the name; null is rejected (P4.6). */
  name?: string;
  /** Omitted keeps the metadata; null removes it (P4.6). */
  metadata?: JsonObject | null;
  /**
   * New descriptors by id. One for an existing resource replaces it; one with
   * a new id adds that resource, appended after the existing ones in the order
   * given (P4.1, P14.5). Only an author entry may add a resource (P5.16).
   */
  resources?: ResourceDescriptor[];
  /**
   * ResourceIDs to remove. At least one resource must remain, and no grant may
   * still name a removed resource (P4.1, P5.15). Author entries only (P5.16).
   * A removed resource's earlier versions stay in history.
   */
  remove?: string[];
  /**
   * Every resourceID the Original has used, from its verified history, so a
   * reused id is refused before signing (P4.1). Without it only the parent's
   * resources are known; the verifier rejects a reuse either way.
   */
  usedResourceIds?: Iterable<string>;
  /**
   * The author reference. Required for an author entry. An editor entry
   * carries its parent's unchanged (P5.16): omit it, or give exactly that.
   */
  author?: AuthorRef;
  /**
   * Sign as a granted editor (P5.16): the editor DID, its verification method
   * and exact versionId. The grant in the parent's state must cover the change.
   */
  editor?: EditorRef;
  /** Replaces the aliases: listing a did:webvh alias publishes the Original (PROVISIONAL, plan 011 PR 7b). Author entries only. */
  aliases?: string[];
  /** Replaces the editor grants (P5.15); null or [] removes them all. Author entries only (P5.16). */
  editors?: EditorGrant[] | null;
}

export interface UpdateOriginalInput extends PrepareUpdateInput {
  sign: EntrySigner;
}

function invalidInput(code: string, message: string): never {
  return fail("invalid-evidence", code, message);
}

function stateOf(entry: UnsignedEntry): EntryState {
  return entry.state as unknown as EntryState;
}

/** The unsigned genesis entry of a new Original: `did:vh:{SCID}` until the SCID is computed. */
export function prepareCreateOriginal(input: PrepareCreateInput): UnsignedEntry {
  if ((input as { editor?: unknown }).editor !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor entry cannot be the genesis entry; only an author entry may (P5.16)");
  const resources = input.resources.map((r, i) => checkDescriptor(r, `resources[${i}]`));
  const asset: AssetState = {
    name: input.name,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    status: "active",
    resources,
    aliases: [],
    ...(input.editors !== undefined && input.editors.length > 0 ? { editors: input.editors } : {}),
  };
  const state = {
    id: `did:vh:${SCID_PLACEHOLDER}`,
    operation: "create",
    author: input.author,
    asset,
    transitions: expectedTransitions(undefined, asset),
  } as unknown as JsonObject;
  // Validate with a stand-in SCID; the real one is computed from this entry.
  checkEntryState({ ...state, id: "did:vh:placeholder" }, { scid: "placeholder", index: 0, deactivatedParameter: false });
  return prepareGenesis({ versionTime: input.versionTime, parameters: { method: ORIGINALS_METHOD, scid: SCID_PLACEHOLDER }, state });
}

/** The signed genesis entry of a new Original. */
export async function createOriginal(input: CreateOriginalInput): Promise<LogEntry> {
  return signEntry(prepareCreateOriginal(input), input.sign);
}

function nextAsset(previous: AssetState, input: Omit<PrepareUpdateInput, "versionTime" | "author">): AssetState {
  if (input.name === null) invalidInput("STATE_NAME", "the name cannot be null (P4.6)");
  const given = input.resources ?? [];
  const changes = new Map(given.map((r) => [r.id, r]));
  if (changes.size !== given.length) invalidInput("STATE_RESOURCE", "a resource is given twice");
  const remove = new Set(input.remove ?? []);
  if (remove.size !== (input.remove ?? []).length) invalidInput("STATE_RESOURCE_SET", "a resource is removed twice");
  for (const id of remove) {
    if (!previous.resources.some((r) => r.id === id)) invalidInput("STATE_RESOURCE_SET", `resource ${id} is not in the resource set, so it cannot be removed (P4.1)`);
    if (changes.has(id)) invalidInput("STATE_RESOURCE_SET", `resource ${id} cannot be both changed and removed`);
  }
  // Existing resources keep their place; new ids are appended in the order given (P4.1, P14.5).
  const added = given.filter((r) => !previous.resources.some((p) => p.id === r.id));
  const { metadata: _old, editors: _editors, ...rest } = previous;
  const metadata = input.metadata === undefined ? previous.metadata : input.metadata;
  const editors = input.editors === undefined ? previous.editors : input.editors;
  return {
    ...rest,
    name: input.name ?? previous.name,
    ...(metadata !== null && metadata !== undefined ? { metadata } : {}),
    resources: [...previous.resources.filter((r) => !remove.has(r.id)).map((r) => changes.get(r.id) ?? r), ...added],
    aliases: input.aliases ?? previous.aliases,
    ...(editors !== null && editors !== undefined && editors.length > 0 ? { editors } : {}),
  };
}

interface NextInput {
  versionTime: string;
  author?: AuthorRef;
  editor?: EditorRef;
  aliases?: string[];
  editors?: EditorGrant[] | null;
  usedResourceIds?: Iterable<string>;
}

function next(previous: UnsignedEntry, operation: "update" | "deactivate", asset: AssetState, input: NextInput): UnsignedEntry {
  const before = stateOf(previous);
  if (input.editor !== undefined) {
    // P5.16: an editor entry is an update, carries its parent's author reference, and changes no
    // grant or alias. The state rules check the rest against the grant in the parent's state.
    if (input.editors !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor entry cannot change the editor grants; only an author entry may (P5.16)");
    if (input.aliases !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor entry cannot change aliases; only an author entry may (P5.16)");
  } else if (input.author === undefined) {
    invalidInput("STATE_AUTHOR", "an author entry needs the author reference");
  }
  const author = input.editor !== undefined ? (input.author ?? before.author) : input.author;
  const state = {
    id: before.id,
    operation,
    author,
    ...(input.editor !== undefined ? { editor: input.editor } : {}),
    asset,
    transitions: expectedTransitions(before.asset, asset),
  } as unknown as JsonObject;
  const scid = before.id.slice("did:vh:".length);
  checkEntryState(state, {
    scid, index: 1, previous: before, deactivatedParameter: operation === "deactivate",
    ...(input.usedResourceIds !== undefined ? { usedResourceIds: input.usedResourceIds } : {}),
  });
  const parameters: JsonObject = operation === "deactivate" ? { deactivated: true } : {};
  return prepareNext(previous, { versionTime: input.versionTime, parameters, state });
}

/** An unsigned update entry after `previous`. */
export function prepareUpdateOriginal(previous: UnsignedEntry, input: PrepareUpdateInput): UnsignedEntry {
  if (input.editor !== undefined) {
    // P4.1, P5.16: only an author entry adds or removes a resource, whatever the grant names.
    const current = stateOf(previous).asset.resources;
    const adds = (input.resources ?? []).find((r) => !current.some((c) => c.id === r.id));
    if (adds) fail("outside-grant", "EDITOR_AUTHOR_ONLY", `an editor entry cannot add a resource (${adds.id}); only an author entry may (P4.1, P5.16)`);
    if ((input.remove ?? []).length > 0) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor entry cannot remove a resource; only an author entry may (P4.1, P5.16)");
  }
  return next(previous, "update", nextAsset(stateOf(previous).asset, input), input);
}

/** An unsigned deactivation entry after `previous` (P6.5). Only the author deactivates (P5.16). */
export function prepareDeactivateOriginal(previous: UnsignedEntry, input: { versionTime: string; author: AuthorRef }): UnsignedEntry {
  if ((input as { editor?: unknown }).editor !== undefined) fail("outside-grant", "EDITOR_AUTHOR_ONLY", "an editor cannot deactivate; only an author entry may (P5.16)");
  return next(previous, "deactivate", { ...stateOf(previous).asset, status: "deactivated" }, { versionTime: input.versionTime, author: input.author });
}

/** A signed update entry after `previous`. */
export async function updateOriginal(previous: LogEntry, input: UpdateOriginalInput): Promise<LogEntry> {
  return signEntry(prepareUpdateOriginal(previous, input), input.sign);
}

/** The signed, terminal deactivation entry after `previous`. */
export async function deactivateOriginal(previous: LogEntry, input: { versionTime: string; author: AuthorRef; sign: EntrySigner }): Promise<LogEntry> {
  return signEntry(prepareDeactivateOriginal(previous, input), input.sign);
}
