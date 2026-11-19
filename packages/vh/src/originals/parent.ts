/**
 * Parent Originals (P5.24–P5.27; originals-spec #66, owner decision of 19
 * November 2026). A child Original names a parent Original in its asset
 * state's `parent` member and pins a versionId of the parent's log in every
 * entry. An editor entry of the child may rely on a grant in the parent's
 * `editors` at the version it pins, an inherited grant. The parent gives
 * nothing else: its author, signer set, editors and sat holder have no
 * authority over the child by those roles.
 *
 * A `ParentView` is what a verifier knows of one parent Original: the
 * verified branches of its log, whether it is anchored, its latest verified
 * state and, when anchored, where Bitcoin accepted each entry. The child's
 * rules read it through `lookupPin` and `pinOrder`. Missing evidence is
 * never a pass or a rejection: it is incomplete (P5.25, P7.4).
 */
import { fail } from "../errors.js";
import type { VerifiedEntry } from "../log/index.js";
import { chainOrder, type ChainPosition } from "./btco.js";
import { ORIGINALS_LIMITS, authorRefsOf, type AssetState, type EditorGrant, type EntryState, type ParentRef } from "./state.js";
import { parseDidWebvh } from "../webvh/index.js";

/** What a verifier knows of one parent Original (P5.25). */
export interface ParentView {
  did: string;
  /**
   * The verified branches of the parent's log, each a chain from genesis: the
   * supplied log first, then each copy. For an anchored parent, the one
   * history Bitcoin accepted (P9.13); copies form no competing branch.
   */
  branches: VerifiedEntry[][];
  /** Whether the parent is anchored on Bitcoin (P9.10). */
  anchored: boolean;
  /** Divergent valid branches: the parent has no latest state (P6.6, P5.26). */
  forked: boolean;
  /** The parent's latest verified state, or null when it is forked or nothing verified (P5.26). */
  latest: EntryState | null;
  /** How the parent's own verification ended (P5.25). */
  status: "verified" | "incomplete" | "invalid" | "limit-exceeded";
  /** Parent Originals from this one to its furthest ancestor, itself included (P7.7, P14.13). */
  depth: number;
  /** A did:btco alias any held state of the parent names: its anchoring sat (P5.27). */
  sat?: string;
  /** For an anchored parent: the anchoring entry, then each accepted entry, with its chain position (P5.27). */
  accepted?: Array<{ versionId: string; position: ChainPosition }>;
}

/** The parent's state at a pin, or why it cannot be known or is refused (P5.25). */
export type PinLookup =
  | { kind: "found"; state: EntryState; number: number }
  | { kind: "missing-evidence" }
  | { kind: "missing-version" }
  | { kind: "outside-accepted" }
  | { kind: "limit-exceeded" };

/** Where to look a parent Original up, by did:vh; undefined when the verifier holds no evidence of it. */
export type ParentViews = (did: string) => ParentView | undefined;

const numberOf = (versionId: string) => Number(versionId.slice(0, versionId.indexOf("-")));

/**
 * P5.25: the parent's state at `pin`. A pin is found in any verified branch.
 * Not found: for an anchored parent whose accepted history reaches the pin's
 * version number, it is rejected (entries not on the sat form no competing
 * branch); otherwise the pinned version is missing evidence, even when a held
 * branch passes that number, because it may be on a branch not obtained (P6.6).
 */
export function lookupPin(view: ParentView | undefined, pin: string): PinLookup {
  if (!view) return { kind: "missing-evidence" };
  if (view.depth > ORIGINALS_LIMITS.parents) return { kind: "limit-exceeded" };
  for (const branch of view.branches) {
    const found = branch.find((v) => v.entry.versionId === pin);
    if (found) return { kind: "found", state: found.entry.state as unknown as EntryState, number: found.versionNumber };
  }
  if (view.anchored && (view.branches[0]?.length ?? 0) >= numberOf(pin)) return { kind: "outside-accepted" };
  return { kind: "missing-version" };
}

/**
 * P5.24: how `to` stands to `from` in the parent's log. `forward` when a held
 * branch holds both and `to` is `from` or follows it; `backward` when one
 * holds both and `to` comes first; `other-branch` when each is held but no
 * branch holds both; `unknown` when either is not held.
 */
export function pinOrder(view: ParentView, from: string, to: string): "forward" | "backward" | "other-branch" | "unknown" {
  let sawFrom = false;
  let sawTo = false;
  for (const branch of view.branches) {
    const i = branch.findIndex((v) => v.entry.versionId === from);
    const j = branch.findIndex((v) => v.entry.versionId === to);
    if (i >= 0 && j >= 0) return j >= i ? "forward" : "backward";
    sawFrom ||= i >= 0;
    sawTo ||= j >= 0;
  }
  return sawFrom && sawTo ? "other-branch" : "unknown";
}

/** The pin rules' failures, as a verifier reports them (P5.24, P5.25). */
export function pinFailure(lookup: Exclude<PinLookup, { kind: "found" }>, parent: ParentRef): never {
  const details = { did: parent.did, versionId: parent.versionId, role: "parent" };
  switch (lookup.kind) {
    case "missing-evidence":
      return fail("incomplete-evidence", "PARENT_EVIDENCE_MISSING", `no verified log of the parent Original ${parent.did} through ${parent.versionId} (P5.25)`, details);
    case "missing-version":
      return fail("incomplete-evidence", "PARENT_VERSION_MISSING", `the pinned version ${parent.versionId} is not in any held log of the parent Original ${parent.did} (P5.25)`, details);
    case "outside-accepted":
      return fail("invalid-evidence", "PARENT_PIN_NOT_ACCEPTED", `the pin ${parent.versionId} is not in the anchored parent ${parent.did}'s accepted history (P5.25)`, details);
    case "limit-exceeded":
      return fail("limit-exceeded", "PARENT_DEPTH", `more than ${ORIGINALS_LIMITS.parents} nested parent Originals (P7.7, P14.13)`, details);
  }
}

/** P5.24: check an entry's pin against its parent entry's, in the parent's log. */
export function checkPin(view: ParentView | undefined, parent: ParentRef, previous: ParentRef | undefined): EntryState {
  const found = lookupPin(view, parent.versionId);
  if (found.kind !== "found") pinFailure(found, parent);
  if (previous && previous.versionId !== parent.versionId) {
    const order = pinOrder(view!, previous.versionId, parent.versionId);
    if (order === "backward") fail("invalid-evidence", "PARENT_PIN_BACKWARDS", `the pin ${parent.versionId} is older than its parent entry's, ${previous.versionId} (P5.24)`);
    if (order === "other-branch") fail("invalid-evidence", "PARENT_PIN_OTHER_BRANCH", `the pin ${parent.versionId} is on another branch of the parent's log than ${previous.versionId} (P5.24)`);
  }
  return found.state;
}

function scid(did: string): string | undefined {
  try {
    return did.startsWith("did:webvh:") ? parseDidWebvh(did).scid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * P5.24: the grant `editor` inherits from the parent's state at the pin, or
 * undefined. Only the parent's own `editors` are inherited, never grants the
 * parent inherits itself; a deactivated parent grants nothing at its
 * deactivation; and a grant to a DID the child's own state could not grant
 * under P5.15 (the child's author or a member, a DID of their identity, the
 * child's did:vh or an alias, including its anchoring sat) authorizes nothing.
 */
export function inheritedGrant(parentState: EntryState, editor: string, child: { id: string; author: EntryState["author"]; asset: AssetState }): EditorGrant | undefined {
  if (parentState.asset.status === "deactivated") return undefined;
  const grant = parentState.asset.editors?.find((g) => g.did === editor);
  if (!grant) return undefined;
  const authors = [...authorRefsOf(child).map((r) => r.did), ...(child.asset.authors?.dids ?? [])];
  const scids = authors.map(scid).filter((x) => x !== undefined);
  const own = scid(editor);
  if (authors.includes(editor) || (own !== undefined && scids.includes(own))) return undefined;
  if (editor === child.id || child.asset.aliases.includes(editor)) return undefined;
  return grant;
}

/**
 * P5.27: the version number of the parent's accepted head at a chain
 * position: its anchoring entry or the last entry accepted on its sat before
 * that position. Undefined when the parent is not anchored there.
 */
export function acceptedHeadAt(view: ParentView, at: ChainPosition): number | undefined {
  const accepted = view.accepted ?? [];
  if (accepted.length === 0 || chainOrder(accepted[0].position, at) >= 0) return undefined;
  let head = accepted[0].versionId;
  for (const a of accepted.slice(1)) if (chainOrder(a.position, at) < 0) head = a.versionId;
  return numberOf(head);
}

/** The version number of a versionId, `<number>-<hash>`. */
export const pinNumber = numberOf;
