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
  type EntryState,
  type ResourceDescriptor,
} from "./state.js";

export interface PrepareCreateInput {
  versionTime: string;
  name: string;
  metadata?: JsonObject;
  resources: ResourceDescriptor[];
  author: AuthorRef;
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
  /** New descriptors for existing resources, by id. Others are unchanged. */
  resources?: ResourceDescriptor[];
  author: AuthorRef;
  /** Replaces the aliases: listing a did:webvh alias publishes the Original (PROVISIONAL, plan 011 PR 7b). */
  aliases?: string[];
  /** Sets the VH witness parameter: the author DID's declaration at `author.versionId` (P9.9). */
  witness?: JsonObject;
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
  const resources = input.resources.map((r, i) => checkDescriptor(r, `resources[${i}]`));
  const asset: AssetState = {
    name: input.name,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    status: "active",
    resources,
    aliases: [],
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
  const changes = new Map((input.resources ?? []).map((r) => [r.id, r]));
  for (const id of changes.keys()) {
    if (!previous.resources.some((r) => r.id === id)) invalidInput("STATE_RESOURCE_SET", `resource ${id} is not in the genesis resource set (P4.1)`);
  }
  const { metadata: _old, ...rest } = previous;
  const metadata = input.metadata === undefined ? previous.metadata : input.metadata;
  return {
    ...rest,
    name: input.name ?? previous.name,
    ...(metadata !== null && metadata !== undefined ? { metadata } : {}),
    resources: previous.resources.map((r) => changes.get(r.id) ?? r),
    aliases: input.aliases ?? previous.aliases,
  };
}

function next(previous: UnsignedEntry, operation: "update" | "deactivate", asset: AssetState, input: { versionTime: string; author: AuthorRef; witness?: JsonObject }): UnsignedEntry {
  const before = stateOf(previous);
  const state = {
    id: before.id,
    operation,
    author: input.author,
    asset,
    transitions: expectedTransitions(before.asset, asset),
  } as unknown as JsonObject;
  const scid = before.id.slice("did:vh:".length);
  checkEntryState(state, { scid, index: 1, previous: before, deactivatedParameter: operation === "deactivate" });
  const parameters: JsonObject = {
    ...(operation === "deactivate" ? { deactivated: true } : {}),
    ...(input.witness !== undefined ? { witness: input.witness } : {}),
  };
  return prepareNext(previous, { versionTime: input.versionTime, parameters, state });
}

/** An unsigned update entry after `previous`. */
export function prepareUpdateOriginal(previous: UnsignedEntry, input: PrepareUpdateInput): UnsignedEntry {
  return next(previous, "update", nextAsset(stateOf(previous).asset, input), input);
}

/** An unsigned deactivation entry after `previous` (P6.5). */
export function prepareDeactivateOriginal(previous: UnsignedEntry, input: { versionTime: string; author: AuthorRef; witness?: JsonObject }): UnsignedEntry {
  return next(previous, "deactivate", { ...stateOf(previous).asset, status: "deactivated" }, input);
}

/** A signed update entry after `previous`. */
export async function updateOriginal(previous: LogEntry, input: UpdateOriginalInput): Promise<LogEntry> {
  return signEntry(prepareUpdateOriginal(previous, input), input.sign);
}

/** The signed, terminal deactivation entry after `previous`. */
export async function deactivateOriginal(previous: LogEntry, input: { versionTime: string; author: AuthorRef; sign: EntrySigner }): Promise<LogEntry> {
  return signEntry(prepareDeactivateOriginal(previous, input), input.sign);
}
