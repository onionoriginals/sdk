/**
 * The published `originals:1.0` entry points that could take an EVM anchor
 * contract pin. EVM anchoring (originals-spec PR 59) is built and tested but
 * unreleased until the spec pins an audited anchor contract (P14.21; owner
 * decision, 14 November 2026), so a pin never enters through a published entry
 * point: these drop it, and the full versions are only in the internal
 * `@originals/vh/internal/evm` entry, reachable under the private
 * `originals-internal` export condition.
 *
 * Without a pin an Original whose genesis entry has an `anchor` member
 * verifies as unsupported, never invalid (section 14, P9.19), and a writer
 * refuses to write an `anchor` member (EVM_NO_ANCHOR_CONTRACT, P14.21).
 */
import type { LogEntry, Specialisation, UnsignedEntry } from "../log/index.js";
import type { JsonObject } from "../json/index.js";
import type { AliasEvidence } from "./alias.js";
import type { AuthorHistory } from "./author.js";
import * as build from "./build.js";
import * as carried from "./carried.js";
import * as profile from "./profile.js";
import * as state from "./state.js";
import * as verify from "./verify.js";

/** The options without their EVM member. */
function withoutEvm<T extends object>(options: T): T {
  if (options === null || typeof options !== "object" || !("evm" in options)) return options;
  const { evm: _evm, ...rest } = options as T & { evm?: unknown };
  return rest as T;
}

/** A report without its EVM sections: the published report type has none. */
function publicReport(report: verify.OriginalsReport): verify.OriginalsReport {
  const r = report as Partial<verify.OriginalsReport>;
  delete r.evm;
  if (report.retain) {
    delete report.retain.evm;
    delete report.retain.evmCheckpoints;
    delete report.retain.discardOriginal;
  }
  for (const v of report.resources?.versions ?? []) delete v.onEvm;
  return report;
}

/** Fresh verification of an Original (P3.2). An `anchor` member is unsupported, not invalid (section 14). */
export async function verifyOriginal(options: verify.VerifyOriginalOptions): Promise<verify.OriginalsReport> {
  return publicReport(await verify.verifyOriginal(withoutEvm(options)));
}

/** Verification through a confirmed did:webvh alias (P3.6). An `anchor` member is unsupported, not invalid. */
export async function verifyOriginalByAlias(options: verify.VerifyOriginalOptions & { alias: AliasEvidence }): Promise<verify.OriginalsReport> {
  try {
    return publicReport(await verify.verifyOriginalByAlias(withoutEvm(options)));
  } catch (e) {
    const report = (e as { details?: { report?: verify.OriginalsReport } } | null)?.details?.report;
    if (report) publicReport(report);
    throw e;
  }
}

/** The unsigned genesis entry of a new Original. Refuses an `anchor` member: P14.21 pins no anchor contract. */
export function prepareCreateOriginal(input: build.PrepareCreateInput): UnsignedEntry {
  return build.prepareCreateOriginal(withoutEvm(input));
}

/** The signed genesis entry of a new Original. Refuses an `anchor` member: P14.21 pins no anchor contract. */
export async function createOriginal(input: build.CreateOriginalInput): Promise<LogEntry> {
  return build.createOriginal(withoutEvm(input));
}

/** An unsigned update entry after `previous`. Refuses a move entry (P9.28): P14.21 pins no anchor contract. */
export function prepareUpdateOriginal(previous: UnsignedEntry, input: build.PrepareUpdateInput): UnsignedEntry {
  return build.prepareUpdateOriginal(previous, withoutEvm(input));
}

/** A signed update entry after `previous`. Refuses a move entry (P9.28): P14.21 pins no anchor contract. */
export async function updateOriginal(previous: LogEntry, input: build.UpdateOriginalInput): Promise<LogEntry> {
  return build.updateOriginal(previous, withoutEvm(input));
}

/** Read a carried version (P7.11-P7.16). A log with an `anchor` member is unsupported, not invalid. */
export async function readCarriedFile(file: Uint8Array, options: carried.ReadCarriedOptions = {}): Promise<carried.CarriedFileReport> {
  const report = await carried.readCarriedFile(file, withoutEvm(options));
  if (report.report) publicReport(report.report);
  return report;
}

/** The Originals state rules for the VH-Log engine. */
export function originalsRules(authors: Iterable<AuthorHistory>): Omit<Specialisation, "versions" | "versionParameter"> {
  return profile.originalsRules(authors);
}

/** The Originals specialisation of the VH-Log engine. */
export function originalsSpecialisation(authors: Iterable<AuthorHistory>): Specialisation {
  return profile.originalsSpecialisation(authors);
}

/** The editor-entry rules of P5.16 for an entry's state. */
export function checkEditorChange(entryState: JsonObject, ctx: state.EntryStateContext): void {
  state.checkEditorChange(entryState, withoutEvm(ctx));
}

/** Validate an entry's state against the Originals rules and its predecessor. */
export function checkEntryState(entryState: JsonObject, ctx: state.EntryStateContext): state.EntryState {
  return state.checkEntryState(entryState, withoutEvm(ctx));
}
