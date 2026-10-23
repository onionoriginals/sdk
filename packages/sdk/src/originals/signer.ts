/**
 * The signer contract (P5.11). A signer receives the complete unsigned entry,
 * the proof options, a summary of what is being approved and the text to show
 * the person whose key signs: the author for an author entry, the editor for
 * an editor entry (P5.16). It returns the cryptosuite signature. It must parse
 * the entry and refuse anything that is not a well-formed Originals entry for
 * its own key; `keySigner` does, checks that the summary states the entry
 * truly, and recomputes the signed bytes itself rather than trusting the
 * caller's.
 *
 * What a change changes depends on the parent's state. A request carries the
 * parent entry, which `keySigner` checks chains to the entry (VH-Log
 * versionIds), so a caller cannot misstate it. `keySigner` derives the text it
 * shows from the entry and that parent, never from the caller's summary, and
 * refuses a summary that differs (editors PR review A3). Without a parent it
 * cannot tell what changed, so it shows the name, metadata and every grant.
 */
import { OriginalsError } from "@originals/vh";
import { localSigner, proofHashData, type CryptosuiteName, type DataIntegrityProof, type KeyType } from "@originals/vh/crypto";
import { canonicalize, isJsonObject, type JsonObject, type JsonValue } from "@originals/vh/json";
import { vhHash, type UnsignedEntry } from "@originals/vh/log";
import { ORIGINALS_METHOD, type AuthorRef, type EditorGrant, type EntryState, type Operation, type Transition } from "@originals/vh/originals";

/** Who signs an entry: the author, or a granted editor (P5.16). */
export interface SignerIdentity extends AuthorRef {
  role: "author" | "editor";
}

export interface EntrySummary {
  original: string;
  operation: Operation;
  name: string;
  /** The Original's author, which every entry names (P5.8). */
  author: AuthorRef;
  /** The identity whose key signs this entry (P5.11): the author, or the editor of an editor entry. */
  signer: SignerIdentity;
  /**
   * Resource changes, as the entry's transitions: the prior and new digest of
   * each changed resource, `from: null` for an added one and `to: null` for a
   * removed one (P4.1, P14.4).
   */
  changes: Transition[];
  nameChanged: boolean;
  metadataChanged: boolean;
  /** The editor grants change (author entries only, P5.16). */
  editorsChanged: boolean;
  /** The editor grants after this entry: each editor DID and what it may change (P5.15). */
  editors: EditorGrant[];
  versionTime: string;
}

export type ProofOptions = Omit<DataIntegrityProof, "proofValue">;

export interface SigningRequest {
  entry: UnsignedEntry;
  proofOptions: ProofOptions;
  summary: EntrySummary;
  /** `describeEntry(summary)`: what to show the person whose key signs (P5.11). */
  display: string;
  /**
   * The parent entry, for an entry after genesis, so a signer can tell what
   * the entry changes; `predecessor` is the parent's own parent versionId
   * (absent when the parent is the genesis entry). The SDK supplies it.
   */
  parent?: { entry: UnsignedEntry; predecessor?: string };
}

export interface OriginalsSigner {
  /** The signer's verification method, an absolute DID URL: an author key, or an editor key for editor entries. */
  readonly verificationMethod: string;
  readonly cryptosuite: CryptosuiteName;
  /** Return the signature over the request's entry, or reject to refuse. */
  sign(request: SigningRequest): Promise<Uint8Array>;
}

const same = (a: unknown, b: unknown) => canonicalize((a ?? null) as JsonValue) === canonicalize((b ?? null) as JsonValue);

export function summarize(entry: UnsignedEntry, previous?: EntryState): EntrySummary {
  const state = entry.state as unknown as EntryState;
  const signer = state.editor ?? state.author;
  return {
    original: state.id,
    operation: state.operation,
    name: state.asset.name,
    author: state.author,
    signer: { role: state.editor ? "editor" : "author", did: signer.did, verificationMethod: signer.verificationMethod, versionId: signer.versionId },
    changes: state.transitions,
    nameChanged: previous ? previous.asset.name !== state.asset.name : true,
    metadataChanged: previous ? !same(previous.asset.metadata, state.asset.metadata) : state.asset.metadata !== undefined,
    editorsChanged: previous ? !same(previous.asset.editors, state.asset.editors) : state.asset.editors !== undefined,
    editors: state.asset.editors ?? [],
    versionTime: entry.versionTime,
  };
}

/**
 * The text a signer shows before signing (P5.11): whose key signs, as author
 * or editor, the Original, the operation and the resource changes. A pure
 * function of the summary, so a signer can recompute it. PROVISIONAL wording.
 */
export function describeEntry(summary: EntrySummary): string {
  const s = summary.signer;
  const lines = [
    `Signing as ${s.role} ${s.did} with ${s.verificationMethod} (DID version ${s.versionId})`,
    `Original: ${summary.original} "${summary.name}"`,
    `Operation: ${summary.operation}`,
    `Author: ${summary.author.did}${s.role === "editor" ? " (unchanged; an editor entry carries its parent's author)" : ""}`,
  ];
  if (summary.changes.length === 0) lines.push("Resources: no change");
  // Additions and removals are named as such (P4.1, P5.11): a removal leaves the resource's history.
  for (const c of summary.changes) {
    if (c.from === null) lines.push(`Resource ${c.resource}: added ${c.to}`);
    else if (c.to === null) lines.push(`Resource ${c.resource}: removed (was ${c.from}; its earlier versions stay in history)`);
    else lines.push(`Resource ${c.resource}: ${c.from} -> ${c.to}`);
  }
  if (summary.nameChanged) lines.push(`Name: changed to ${JSON.stringify(summary.name)}`);
  if (summary.metadataChanged) lines.push("Metadata: changed");
  if (summary.editorsChanged) {
    const grants = summary.editors ?? [];
    lines.push(`Editor grants: changed${grants.length === 0 ? " (none remain)" : ""}`);
    for (const g of grants) lines.push(`  ${g.did}: name ${g.name ? "yes" : "no"}, metadata ${g.metadata ? "yes" : "no"}, resources ${g.resources.length > 0 ? g.resources.join(", ") : "none"}`);
  }
  return lines.join("\n");
}

function refuse(message: string): never {
  throw new OriginalsError("invalid-evidence", "SIGNER_REFUSED", message);
}

const VERSION_ID = /^(\d+)-(.+)$/;

/** True when `entry`'s versionId is its hash over `predecessor`, as VH-Log chains entries. */
function chainsTo(entry: UnsignedEntry, predecessor: unknown): boolean {
  const id = VERSION_ID.exec(String(entry?.versionId));
  if (!id || typeof predecessor !== "string") return false;
  const { proof: _proof, ...unsigned } = entry as UnsignedEntry & { proof?: unknown };
  try {
    return vhHash({ ...(unsigned as unknown as JsonObject), versionId: predecessor }) === id[2];
  } catch {
    return false;
  }
}

/**
 * The parent's state when the request's parent is bound to the entry by its
 * versionId chain (refused otherwise), or "unknown" when there is none.
 */
function parentState(request: SigningRequest, number: number): EntryState | undefined | "unknown" {
  if (number === 1) return undefined;
  const parent = request.parent;
  if (!parent) return "unknown";
  const p = parent.entry;
  const pid = VERSION_ID.exec(String(p?.versionId));
  if (!pid || Number(pid[1]) !== number - 1 || !chainsTo(request.entry, p.versionId)) refuse("the parent does not chain to this entry");
  const predecessor = Number(pid[1]) === 1 ? (isJsonObject(p.parameters) ? p.parameters.scid : undefined) : parent.predecessor;
  if (!chainsTo(p, predecessor)) refuse("the parent is not the entry its versionId names");
  return p.state as unknown as EntryState;
}

/**
 * Refuse input that is not a well-formed Originals entry for `verificationMethod`,
 * or whose summary does not state the entry truly (P5.11). Returns the
 * summary derived from the entry and its parent, which is what is shown.
 */
function checkRequest(request: SigningRequest, verificationMethod: string, cryptosuite: CryptosuiteName): EntrySummary {
  const { entry, proofOptions } = request;
  if (proofOptions.verificationMethod !== verificationMethod || proofOptions.cryptosuite !== cryptosuite || proofOptions.proofPurpose !== "assertionMethod") {
    refuse("the proof options are not this key's");
  }
  const number = Number(/^(\d+)-/.exec(String(entry?.versionId))?.[1] ?? NaN);
  const parameters = (entry?.parameters ?? {});
  if (!Number.isInteger(number) || typeof entry.versionTime !== "string") refuse("not a VH log entry");
  if (number === 1 ? parameters.method !== ORIGINALS_METHOD : parameters.method !== undefined && parameters.method !== ORIGINALS_METHOD) {
    refuse("not an Originals entry");
  }
  const state = entry.state;
  const author = state?.author as JsonObject | undefined;
  const editor = state?.editor as JsonObject | undefined;
  if (typeof state?.id !== "string" || !state.id.startsWith("did:vh:") || !["create", "update", "deactivate"].includes(state.operation as string)) {
    refuse("not an Originals asset state");
  }
  // P5.2: the key signs as the identity the entry names for its signer.
  const signer = editor ?? author;
  if (signer?.verificationMethod !== verificationMethod) refuse(`the entry names another ${editor ? "editor" : "author"} key`);
  const summary = request.summary as Partial<EntrySummary> | undefined;
  const role = editor ? "editor" : "author";
  if (
    !summary || summary.original !== state.id || summary.operation !== state.operation ||
    summary.signer?.role !== role || !same({ did: summary.signer.did, verificationMethod: summary.signer.verificationMethod, versionId: summary.signer.versionId }, signer) ||
    !same(summary.author, author) || !same(summary.changes, state.transitions)
  ) {
    refuse("the summary does not state this entry: who signs, the Original, the operation or the resource changes");
  }
  // Everything else is derived from the entry and its bound parent, and the summary must agree.
  const parent = parentState(request, number);
  const derived = summarize(entry, parent === "unknown" ? undefined : parent);
  const checked: Array<keyof EntrySummary> = ["name", "editors", "versionTime", ...(parent === "unknown" ? [] : (["nameChanged", "metadataChanged", "editorsChanged"] as const))];
  for (const field of checked) {
    if (!same(summary[field], derived[field])) refuse(`the summary does not state this entry: ${field}`);
  }
  // With no parent, what changed is unknown: show it all.
  return parent === "unknown" ? { ...derived, nameChanged: true, metadataChanged: true, editorsChanged: true } : derived;
}

export interface KeySignerOptions {
  keyType: KeyType;
  secretKey: Uint8Array;
  /** The verification method this key is, e.g. `did:webvh:…#orig-1`: an author key, or an editor key. */
  verificationMethod: string;
  /**
   * Show the person whose key signs what they are signing (P5.11): the text
   * of `describeEntry`, recomputed by the signer, and the summary. Returning
   * false refuses. Without it, the key signs any well-formed entry for it.
   */
  confirm?: (display: string, summary: EntrySummary) => boolean | Promise<boolean>;
}

/** A signer holding raw key bytes. For tests and local custody. */
export function keySigner(options: KeySignerOptions): OriginalsSigner {
  if (!/^did:[a-z0-9]+:[^#]+#[^#]+$/.test(options.verificationMethod)) {
    throw new OriginalsError("invalid-evidence", "SIGNER_INVALID", "verificationMethod must be an absolute DID URL with a fragment");
  }
  const key = localSigner(options.keyType, options.secretKey);
  const cryptosuite: CryptosuiteName = options.keyType === "Ed25519" ? "eddsa-jcs-2022" : "bip340-jcs-2025";
  return {
    verificationMethod: options.verificationMethod,
    cryptosuite,
    sign: async (request) => {
      const derived = checkRequest(request, options.verificationMethod, cryptosuite);
      if (options.confirm && !(await options.confirm(describeEntry(derived), derived))) refuse("the signer declined");
      return key.sign(proofHashData(request.entry, request.proofOptions));
    },
  };
}
