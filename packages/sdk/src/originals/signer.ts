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
 *
 * Signer sets (P5.19–P5.23): an author entry of a set
 * Original names several signers. Each signs the same entry with its own key
 * and is asked separately; its request's summary names it as `signer`, and
 * lists every signer and the signer set after the entry, so each member sees
 * who else signs and what the set becomes.
 */
import { OriginalsError } from "@originals/vh";
import { localSigner, proofHashData, type CryptosuiteName, type DataIntegrityProof, type KeyType } from "@originals/vh/crypto";
import { canonicalize, isJsonObject, type JsonObject, type JsonValue } from "@originals/vh/json";
import { parseVersionTime, vhHash, type UnsignedEntry } from "@originals/vh/log";
import {
  ORIGINALS_METHOD,
  authorRefsOf,
  checkAsset,
  checkAuthorMember,
  checkDigest,
  checkEditorRef,
  type AuthorRef,
  type AuthorSet,
  type EditorGrant,
  type EntryState,
  type Operation,
  type Transition,
} from "@originals/vh/originals";

/** Who signs an entry: the author, or a granted editor (P5.16). */
export interface SignerIdentity extends AuthorRef {
  role: "author" | "editor";
}

export interface EntrySummary {
  original: string;
  operation: Operation;
  name: string;
  /**
   * The Original's author, which every entry names (P5.8); for a set
   * Original, the entry's signer references (P5.19).
   */
  author: AuthorRef | AuthorRef[];
  /** The identity whose key signs this entry (P5.11): the author, the editor of an editor entry, or this member of a set Original's signers. */
  signer: SignerIdentity;
  /** Every identity that signs this entry, in proof order (P5.19): one, except a set Original's author entry. */
  signers?: AuthorRef[];
  /** The signer set after this entry, for a set Original (P5.19). */
  authors?: AuthorSet;
  /** The signer set changes, or is introduced (author entries only; P5.16, P5.20). */
  authorsChanged?: boolean;
  /**
   * The resource change, as the entry's transitions: at most one, the prior
   * and new digest of the Original's one resource, `from: null` at genesis
   * (P4.1, P14.4; originals-spec #53).
   */
  changes: Transition[];
  nameChanged: boolean;
  metadataChanged: boolean;
  /** The editor grants change (author entries only, P5.16). */
  editorsChanged: boolean;
  /** The editor grants after this entry: each editor DID and what it may change (P5.15). */
  editors: EditorGrant[];
  versionTime: string;
  /**
   * The preview the entry names for its inscription, when it names one
   * (P9.30): it is signed with the entry. Absent when it names none.
   */
  preview?: { mediaType: string; size: number; digest: string; changed: boolean };
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

/**
 * What an entry changes, for the person whose key signs it (P5.11). For a set
 * Original's author entry, `verificationMethod` picks which signer the
 * summary is for; by default the first.
 */
export function summarize(entry: UnsignedEntry, previous?: EntryState, verificationMethod?: string): EntrySummary {
  const state = entry.state as unknown as EntryState;
  const refs = state.editor ? [state.editor] : authorRefsOf(state);
  const signer = refs.find((r) => r.verificationMethod === verificationMethod) ?? refs[0];
  const set = state.asset.authors !== undefined || previous?.asset.authors !== undefined;
  return {
    original: state.id,
    operation: state.operation,
    name: state.asset.name,
    author: state.author,
    signer: { role: state.editor ? "editor" : "author", did: signer.did, verificationMethod: signer.verificationMethod, versionId: signer.versionId },
    // Only a set Original's summary carries these, so a single-author one is exactly as before.
    ...(set ? {
      signers: refs,
      ...(state.asset.authors ? { authors: state.asset.authors } : {}),
      authorsChanged: previous ? !same(previous.asset.authors, state.asset.authors) : true,
    } : {}),
    changes: state.transitions,
    nameChanged: previous ? previous.asset.name !== state.asset.name : true,
    metadataChanged: previous ? !same(previous.asset.metadata, state.asset.metadata) : state.asset.metadata !== undefined,
    editorsChanged: previous ? !same(previous.asset.editors, state.asset.editors) : state.asset.editors !== undefined,
    editors: state.asset.editors ?? [],
    versionTime: entry.versionTime,
    ...(state.asset.preview ? { preview: { ...state.asset.preview, changed: !same(previous?.asset.preview, state.asset.preview) } } : {}),
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
  ];
  // A set Original (P5.19): who signs this entry, and the set it governs by.
  if (Array.isArray(summary.author)) {
    const signers = summary.author.map((r) => r.did).join(", ");
    lines.push(s.role === "editor" ? `Authors: ${signers} (unchanged; an editor entry carries its parent's signers)` : `Signers: ${signers}`);
  } else {
    lines.push(`Author: ${summary.author.did}${s.role === "editor" ? " (unchanged; an editor entry carries its parent's author)" : ""}`);
  }
  if (summary.authors) {
    const set = `${summary.authors.threshold} of ${summary.authors.dids.length}: ${summary.authors.dids.join(", ")}`;
    lines.push(summary.authorsChanged ? `Signer set: changed to ${set}` : `Signer set: ${set}`);
  }
  // One resource per Original (P4.1, P14.4; originals-spec #53): at most one transition.
  if (summary.changes.length === 0) lines.push("Resource: no new version");
  for (const c of summary.changes) {
    if (c.from === null) lines.push(`Resource: first version ${c.to}`);
    else lines.push(`Resource: new version ${c.from} -> ${c.to}`);
  }
  if (summary.nameChanged) lines.push(`Name: changed to ${JSON.stringify(summary.name)}`);
  if (summary.metadataChanged) lines.push("Metadata: changed");
  if (summary.editorsChanged) {
    const grants = summary.editors ?? [];
    lines.push(`Editor grants: changed${grants.length === 0 ? " (none remain)" : ""}`);
    for (const g of grants) lines.push(`  ${g.did}: name ${g.name ? "yes" : "no"}, metadata ${g.metadata ? "yes" : "no"}, resource ${g.resource ? "yes" : "no"}`);
  }
  if (summary.preview) {
    const p = summary.preview;
    lines.push(`Preview for Bitcoin: ${p.changed ? "" : "unchanged, "}${p.mediaType}, ${p.size} bytes, ${p.digest}`);
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

const exactly = (value: JsonObject, keys: string[]) => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && [...keys].sort().every((k, i) => own[i] === k);
};

/**
 * P5.11: the entry on its own is a well-formed Originals entry: exactly the
 * unsigned VH-Log members, with no proof yet; a versionTime as P14.2 writes
 * it; parameters exactly as P14.1 allows, with no null value; and a state
 * with exactly the defined members, whose author and editor references,
 * asset (P14.5, P14.6) and transitions (P14.4) are well formed. Rules that
 * need the parent, such as what an editor may change, are
 * the verifier's; the writer already applied them (`prepareUpdateOriginal`).
 */
function checkWellFormed(entry: UnsignedEntry, number: number): void {
  if (!isJsonObject(entry) || !exactly(entry, ["versionId", "versionTime", "parameters", "state"])) {
    refuse("not an unsigned VH log entry: exactly versionId, versionTime, parameters and state");
  }
  if (typeof entry.versionTime !== "string" || !entry.versionTime.endsWith("Z")) refuse("the versionTime is not P14.2's");
  try {
    parseVersionTime(entry.versionTime, 3);
  } catch {
    refuse("the versionTime is not P14.2's");
  }
  const parameters = entry.parameters as unknown as JsonValue;
  if (!isJsonObject(parameters)) refuse("not a VH log entry: parameters is not an object");
  if (Object.values(parameters).some((v) => v === null)) refuse("a parameter value is null (P14.1)");
  const genesis = number === 1;
  const parametersOk = genesis
    ? exactly(parameters, ["method", "scid"]) && parameters.method === ORIGINALS_METHOD && typeof parameters.scid === "string"
    : exactly(parameters, []) || (exactly(parameters, ["deactivated"]) && parameters.deactivated === true);
  if (!parametersOk) refuse(genesis ? "not an Originals genesis entry: its parameters are exactly method and scid (P14.1)" : "an entry's parameters are {} or, for a deactivation, {\"deactivated\": true} (P14.1)");
  const state = entry.state as unknown as JsonValue;
  if (!isJsonObject(state)) refuse("not an Originals asset state");
  if (!exactly(state, ["id", "operation", "author", "asset", "transitions"]) && !exactly(state, ["id", "operation", "author", "editor", "asset", "transitions"])) {
    refuse("not an Originals asset state: exactly id, operation, author, asset and transitions, and editor in an editor entry");
  }
  if (genesis ? state.operation !== "create" || state.id !== `did:vh:${parameters.scid as string}` : state.operation === "create") refuse("the operation does not fit the entry's place in the log");
  if ((state.operation === "deactivate") !== (parameters.deactivated === true)) refuse("operation deactivate and deactivated: true go together (P6.5)");
  try {
    const author = checkAuthorMember(state.author);
    if (state.editor !== undefined) checkEditorRef(state.editor);
    const asset = checkAsset(state.asset, Array.isArray(author) ? undefined : author.did);
    // A set Original names its signers as an array exactly when its asset has `authors` (P5.19).
    if (Array.isArray(author) !== (asset.authors !== undefined)) refuse("the author member does not fit the asset's signer set (P5.19)");
    if (genesis && asset.aliases.length > 0) refuse("a genesis entry lists no alias");
    if (!Array.isArray(state.transitions) || state.transitions.length > 1) refuse("an entry lists at most one resource transition (P14.4)");
    for (const t of state.transitions) {
      if (!isJsonObject(t) || !exactly(t, ["from", "to"])) refuse("a transition is exactly {from, to} (P14.4)");
      if (t.from !== null) checkDigest(t.from);
      if ((t.from === null) !== genesis || t.to !== asset.resource.digest) refuse("the transition does not name the resource's version (P14.4)");
    }
    if (genesis && state.transitions.length !== 1) refuse("a genesis entry lists its resource's first version (P14.4)");
  } catch (error) {
    if (error instanceof OriginalsError && error.code === "SIGNER_REFUSED") throw error;
    refuse(`not a well-formed Originals entry: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  if (!Number.isInteger(number) || number < 1 || typeof entry.versionTime !== "string") refuse("not a VH log entry");
  checkWellFormed(entry, number);
  const state = entry.state;
  const author = state?.author as JsonObject | JsonObject[] | undefined;
  const editor = state?.editor as JsonObject | undefined;
  if (typeof state?.id !== "string" || !state.id.startsWith("did:vh:") || !["create", "update", "deactivate"].includes(state.operation as string)) {
    refuse("not an Originals asset state");
  }
  // P5.2: the key signs as the identity the entry names for its signer; one of a set Original's signers (P5.22).
  const signer = editor ?? (Array.isArray(author) ? author.find((r) => isJsonObject(r) && r.verificationMethod === verificationMethod) : author);
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
  const derived = summarize(entry, parent === "unknown" ? undefined : parent, verificationMethod);
  const checked: Array<keyof EntrySummary> = [
    "name", "editors", "versionTime", "signers", "authors",
    ...(parent === "unknown" ? [] : (["nameChanged", "metadataChanged", "editorsChanged", "authorsChanged"] as const)),
  ];
  for (const field of checked) {
    if (!same(summary[field], derived[field])) refuse(`the summary does not state this entry: ${field}`);
  }
  // With no parent, what changed is unknown: show it all.
  return parent === "unknown" ? { ...derived, nameChanged: true, metadataChanged: true, editorsChanged: true, ...(derived.authorsChanged !== undefined ? { authorsChanged: true } : {}) } : derived;
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
