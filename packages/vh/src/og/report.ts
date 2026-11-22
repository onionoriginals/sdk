/**
 * The verification report (P7.17–P7.23, P14.25), as data. Every member and
 * label here is PROVISIONAL (21 November 2026) with P14.25.
 */
import { resourceDigest } from "./log.js";
import type { MissingItem } from "./package.js";
import type { BitcoinNetwork } from "./state.js";

// ---------------------------------------------------------------------------
// Evidence set (P7.17)

export interface Tip {
  height: number;
  hash: string;
}

/** One inscription as an index reported it at the evidence set's tip (P9.31). */
export interface InscriptionRead {
  id: string;
  /** The sat the index reports it on, in decimal. */
  sat: string;
  height: number;
  txIndex: number;
  inscriptionIndex: number;
  /** 0 while unconfirmed (P9.5). */
  confirmations: number;
  /** The ord envelope, from OP_FALSE OP_IF to OP_ENDIF (P14.12). */
  envelope: Uint8Array;
  /** The metaprotocol the index reports, when it reports one; checked against the envelope. */
  metaprotocol?: string | null;
  /** The content type the index reports, when it reports one; checked against the envelope. */
  contentType?: string | null;
}

/** Everything one index read for one sat at the tip (P9.31). */
export interface SatRead {
  /** The did:btco DID of the sat. */
  sat: string;
  /** Which index made the read (P9.11). */
  index: string;
  /** True when this is the sat's complete inscription list at the tip (P9.35). */
  complete: boolean;
  inscriptions: InscriptionRead[];
  /** The address holding the sat at the tip, when the read includes it (P9.11). */
  holder?: string | null;
}

export type EvidenceInput =
  | { kind: "log"; source: string; bytes: Uint8Array }
  | { kind: "package"; source: string; bytes: Uint8Array }
  | { kind: "signer-history"; source: string; bytes: Uint8Array; did?: string; witness?: Uint8Array }
  | { kind: "resource"; source: string; bytes: Uint8Array }
  /** One inscription; `source` is `index:<inscription id>`. The sat reads carry the placement. */
  | { kind: "inscription"; source: string; bytes: Uint8Array }
  /** A raw transaction's bytes, as a block explorer serves them (prior-format fixture). */
  | { kind: "transaction"; source: string; bytes: Uint8Array };

/** Metadata about a signer history in the evidence set: where and when it was obtained (P7.8). */
export interface SignerHistoryNote {
  did: string;
  /** The source of the input that holds it, or `package` for a history inside a supplied package. */
  source: string;
  obtained?: string;
}

export interface EvidenceSet {
  original: string;
  /** A target checkpoint named by the caller (P3.2), or null. */
  checkpoint?: string | null;
  inputs: EvidenceInput[];
  signerHistories?: SignerHistoryNote[];
  network?: BitcoinNetwork | null;
  tip?: Tip | null;
  depth?: number | null;
  /** The sats the index read (P9.18): the anchoring sat and each did:btco signer's. */
  sats?: SatRead[];
  /** A prior result for the same Original (P7.17). */
  prior?: Report | null;
}

// ---------------------------------------------------------------------------
// Report (P14.25)

export type Outcome = "verified" | "incomplete" | "invalid" | "unsupported";
export interface Axes {
  outcome: Outcome;
  binding: "bound" | "unbound";
  history: "valid" | "limit-exceeded" | "invalid";
  identity: "complete" | "incomplete" | "failed";
  authority: "current" | "historical";
  state: "current" | "valid-as-of" | "historical-checkpoint" | "conflict" | "none";
  availability: "complete" | "partial" | "none";
  offline: "self-contained" | "needs-external";
  bitcoin: "not-anchored" | "anchored" | "undetermined" | "missing-evidence" | "not-read";
}

export type EntryAuthority = "current-key" | "key-removed-since" | "did-deactivated-since";
export type Ordering = "claimed" | "existed-by-block" | "chain-ordered";

export type EntryLabel =
  | { versionId: string; status: "accepted"; authority: EntryAuthority; endorsed: boolean; ordering: Ordering; block?: number }
  | { versionId: string; status: "rejected"; rule: string }
  | { versionId: string; status: "unchecked" | "unverifiable" | "waiting" | "ignored" | "conflicting" };

export interface SignerLabel {
  did: string;
  role: "author" | "editor";
  latestVersionId: string;
  source: string;
  obtained?: string | null;
  freshness: "established" | "not-established";
}

export interface ReportInput {
  kind: string;
  source: string;
  digest: string;
}

export interface Report {
  type: "OriginalsVerificationReport";
  profile: string;
  original: string | null;
  checkpoint: string | null;
  evidence: { inputs: ReportInput[]; network: BitcoinNetwork | null; tip: Tip | null; depth: number | null };
  axes: Axes | { outcome: "unsupported" };
  entries?: EntryLabel[];
  signers?: SignerLabel[];
  missing?: MissingItem[];
  dependencies?: Array<{ kind: string; did: string }>;
  bitcoin?: {
    sat: string;
    holder: { address: string | null; uniqueness: "provisional" | { "established-through": number } };
    conflictingAnchors: Array<{ sat: string; inscription: string }>;
    unverifiable: Array<{ inscription: string; did: string; versionId: string }>;
    waiting: Array<{ inscription: string; waitsOn: string }>;
  };
  /** PROVISIONAL (finding F10): the change of head against a prior result (P9.36, P6.6). */
  headChange?: { from: string | null; to: string | null };
  /** PROVISIONAL (finding F7): why no checkpoint is reported, or that the report is a writer's local copy. */
  reason?: string;
}

/** P14.25: a report's `evidence.inputs`, each `{kind, source, digest}` with the input's bytes in P14.7's encoding. */
export function reportInputs(evidence: EvidenceSet): ReportInput[] {
  return evidence.inputs.map((i) => ({ kind: i.kind, source: i.source, digest: resourceDigest(i.bytes) }));
}

/** P7.18: the outcome follows from the other axes. */
export function outcomeOf(a: Omit<Axes, "outcome">): Outcome {
  if (a.history === "invalid" || a.binding === "unbound" || a.identity === "failed") return "invalid";
  if (a.identity === "incomplete" || a.bitcoin === "missing-evidence" || a.bitcoin === "undetermined") return "incomplete";
  return "verified";
}

/** P7.22: the default acceptance check. */
export function defaultCheck(report: Report): boolean {
  const a = report.axes as Axes;
  return a.outcome === "verified" && a.history === "valid" && a.authority === "current" && (a.state === "current" || a.state === "valid-as-of");
}

/** P7.22: the transfer check, for a buyer or recipient of the anchoring sat. */
export function transferCheck(report: Report): boolean {
  const a = report.axes as Axes;
  return defaultCheck(report) && a.bitcoin === "anchored" && !!report.bitcoin &&
    report.bitcoin.unverifiable.length === 0 && report.bitcoin.waiting.length === 0 && report.bitcoin.conflictingAnchors.length === 0;
}

const AXIS_VALUES: Record<keyof Axes, readonly string[]> = {
  outcome: ["verified", "incomplete", "invalid", "unsupported"],
  binding: ["bound", "unbound"],
  history: ["valid", "limit-exceeded", "invalid"],
  identity: ["complete", "incomplete", "failed"],
  authority: ["current", "historical"],
  state: ["current", "valid-as-of", "historical-checkpoint", "conflict", "none"],
  availability: ["complete", "partial", "none"],
  offline: ["self-contained", "needs-external"],
  bitcoin: ["not-anchored", "anchored", "undetermined", "missing-evidence", "not-read"],
};

/** P7.18, P7.23 (T7-048): every applicable axis present, each from its closed list. */
export function checkAxes(axes: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (axes.outcome === "unsupported") return Object.keys(axes).length === 1 ? [] : ["an unsupported report carries the outcome only (PROVISIONAL, F2)"];
  for (const [axis, values] of Object.entries(AXIS_VALUES)) {
    if (!(axis in axes)) problems.push(`axis ${axis} is missing`);
    else if (!values.includes(axes[axis] as string)) problems.push(`axis ${axis} has value ${JSON.stringify(axes[axis])} outside its list`);
  }
  for (const k of Object.keys(axes)) if (!(k in AXIS_VALUES)) problems.push(`${k} is not an axis`);
  return problems;
}
