/**
 * The signer contract (P5.11). A signer receives the complete unsigned entry,
 * the proof options, a summary of what is being approved and the text to show
 * the person whose key signs: the author for an author entry, the editor for
 * an editor entry (P5.16). It returns the cryptosuite signature. It must parse
 * the entry and refuse anything that is not a well-formed Originals entry for
 * its own key; `keySigner` does, checks that the summary states the entry
 * truly, and recomputes the signed bytes itself rather than trusting the
 * caller's.
 */
import { OriginalsError } from "@originals/vh";
import { localSigner, proofHashData, type CryptosuiteName, type DataIntegrityProof, type KeyType } from "@originals/vh/crypto";
import { canonicalize, type JsonObject, type JsonValue } from "@originals/vh/json";
import type { UnsignedEntry } from "@originals/vh/log";
import { ORIGINALS_METHOD, type AuthorRef, type EntryState, type Operation, type Transition } from "@originals/vh/originals";

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
  /** Resource changes: the prior and new digest of each changed resource. */
  changes: Transition[];
  nameChanged: boolean;
  metadataChanged: boolean;
  /** The editor grants change (author entries only, P5.16). */
  editorsChanged: boolean;
  versionTime: string;
}

export type ProofOptions = Omit<DataIntegrityProof, "proofValue">;

export interface SigningRequest {
  entry: UnsignedEntry;
  proofOptions: ProofOptions;
  summary: EntrySummary;
  /** `describeEntry(summary)`: what to show the person whose key signs (P5.11). */
  display: string;
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
  for (const c of summary.changes) lines.push(`Resource ${c.resource}: ${c.from ?? "(new)"} -> ${c.to}`);
  if (summary.nameChanged) lines.push("Name: changed");
  if (summary.metadataChanged) lines.push("Metadata: changed");
  if (summary.editorsChanged) lines.push("Editor grants: changed");
  return lines.join("\n");
}

function refuse(message: string): never {
  throw new OriginalsError("invalid-evidence", "SIGNER_REFUSED", message);
}

/**
 * Refuse input that is not a well-formed Originals entry for `verificationMethod`,
 * or whose summary does not state the entry truly (P5.11).
 */
function checkRequest(request: SigningRequest, verificationMethod: string, cryptosuite: CryptosuiteName): void {
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
      checkRequest(request, options.verificationMethod, cryptosuite);
      if (options.confirm && !(await options.confirm(describeEntry(request.summary), request.summary))) refuse("the signer declined");
      return key.sign(proofHashData(request.entry, request.proofOptions));
    },
  };
}
