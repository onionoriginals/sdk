/**
 * Building asset log entries. The builders apply the operation contract's
 * value rules (P4.1, P4.4, P4.6) and validate the result with the same checks
 * the verifier uses, so they never produce an entry the verifier rejects for
 * its state. Signing is the caller's: `sign` receives the complete unsigned
 * entry (P5.11 asks the signer to show it to the author first).
 */
import { fail } from "../errors.js";
import type { JsonObject } from "../json/index.js";
import { appendEntry, createLog, SCID_PLACEHOLDER, type EntrySigner, type LogEntry } from "../log/index.js";
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

export interface CreateOriginalInput {
  versionTime: string;
  name: string;
  metadata?: JsonObject;
  resources: ResourceDescriptor[];
  author: AuthorRef;
  sign: EntrySigner;
}

export interface UpdateOriginalInput {
  versionTime: string;
  /** Omitted keeps the name; null is rejected (P4.6). */
  name?: string;
  /** Omitted keeps the metadata; null removes it (P4.6). */
  metadata?: JsonObject | null;
  /** New descriptors for existing resources, by id. Others are unchanged. */
  resources?: ResourceDescriptor[];
  author: AuthorRef;
  sign: EntrySigner;
}

function invalidInput(code: string, message: string): never {
  return fail("invalid-evidence", code, message);
}

function stateOf(entry: LogEntry): EntryState {
  return entry.state as unknown as EntryState;
}

/** The genesis entry of a new Original: `did:vh:{SCID}` until the SCID is computed. */
export async function createOriginal(input: CreateOriginalInput): Promise<LogEntry> {
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
  return createLog({ versionTime: input.versionTime, parameters: { method: ORIGINALS_METHOD, scid: SCID_PLACEHOLDER }, state, sign: input.sign });
}

function nextAsset(previous: AssetState, input: Omit<UpdateOriginalInput, "versionTime" | "author" | "sign">): AssetState {
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
  };
}

async function next(previous: LogEntry, operation: "update" | "deactivate", asset: AssetState, input: { versionTime: string; author: AuthorRef; sign: EntrySigner }): Promise<LogEntry> {
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
  const parameters: JsonObject = operation === "deactivate" ? { deactivated: true } : {};
  return appendEntry(previous, { versionTime: input.versionTime, parameters, state, sign: input.sign });
}

/** An update entry after `previous`. */
export async function updateOriginal(previous: LogEntry, input: UpdateOriginalInput): Promise<LogEntry> {
  return await next(previous, "update", nextAsset(stateOf(previous).asset, input), input);
}

/** The terminal deactivation entry after `previous` (P6.5). */
export async function deactivateOriginal(previous: LogEntry, input: { versionTime: string; author: AuthorRef; sign: EntrySigner }): Promise<LogEntry> {
  return await next(previous, "deactivate", { ...stateOf(previous).asset, status: "deactivated" }, input);
}
